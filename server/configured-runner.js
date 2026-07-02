const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { PORT } = require("./config");
const { formatShellCommand } = require("./command-history");
const {
  addEvent,
  queueFeatureEnvironmentUrl,
  queueRunEvent,
  queueRunOutput,
} = require("./run-events");
const {
  buildAgentContext,
  expandCommandTemplate,
  isInteractiveCodexCommand,
} = require("./agent-command");

const runProcesses = new Map();
const outputBuffers = new Map();
const STOP_TIMEOUT_MS = 5000;

async function startConfiguredAgentRun(feature, run, commandTemplate, handlers) {
  const context = buildAgentContext(feature, run);
  try {
    await fsp.access(context.instruction_path, fs.constants.R_OK);
  } catch {
    await handlers.failRun(
      feature,
      run,
      `Missing agent instructions: ${path.relative(context.workspace_path, context.instruction_path)}.`,
    );
    return;
  }
  const { command, unresolved } = expandCommandTemplate(commandTemplate, context);
  if (unresolved.length) {
    await handlers.failRun(feature, run, `Unknown placeholder(s) in agent_run_command: ${unresolved.join(", ")}.`);
    return;
  }
  if (isInteractiveCodexCommand(command)) {
    await handlers.failRun(
      feature,
      run,
      "agent_run_command uses interactive `codex`, which requires a TTY. Use `codex exec ...` for workflow runs.",
    );
    return;
  }

  const childEnv = buildChildEnv(feature, run, context);
  let child;
  try {
    child = spawn(command, {
      cwd: context.workspace_path,
      env: childEnv,
      detached: process.platform !== "win32",
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    await handlers.failRun(feature, run, `Failed to launch agent command: ${error.message}`);
    return;
  }

  await recordConfiguredCommand(handlers, `${formatShellCommand("cd", [context.workspace_path])} && ${command}`);
  runProcesses.set(run.id, { child, stopTimer: null });
  await addEvent(feature, run, "Context", formatRunContext(context, command));
  await queueRunEvent(feature, run, "Executing", "Agent executing.");

  child.stdout?.on("data", (chunk) => {
    handleAgentControlOutput(feature, run, chunk);
    void queueRunOutput(feature, run, "stdout", chunk);
  });
  child.stderr?.on("data", (chunk) => {
    void queueRunOutput(feature, run, "stderr", chunk);
  });

  child.once("error", (error) => {
    void (async () => {
      forgetConfiguredRun(run.id);
      outputBuffers.delete(run.id);
      if (run.status === "cancelled") return;
      await handlers.failRun(feature, run, `Agent command failed to start: ${error.message}`);
    })().catch((handlerError) => {
      console.error(handlerError);
    });
  });

  child.once("close", (code, signal) => {
    void handleClose(feature, run, code, signal, handlers).catch((handlerError) => {
      console.error(handlerError);
    });
  });
}

async function recordConfiguredCommand(handlers, command) {
  if (typeof handlers.recordEnvironmentCommand !== "function") return;
  try {
    await handlers.recordEnvironmentCommand(command);
  } catch (error) {
    console.error(error);
  }
}

function formatRunContext(context, command) {
  const lines = [
    `agent=${context.agent}`,
    `state=${context.state}`,
    `feature=${context.feature_name} (${context.feature_id})`,
    `branch=${context.branch}`,
    `workspace=${context.workspace_path}`,
    `instruction=${context.instruction_path}`,
    `prompt=${context.prompt_path}`,
    `artifact=${context.artifact_path}`,
    `repository_root=${context.repository_root}`,
    `command=${command}`,
  ];
  if (context.change_request_path) {
    lines.push(`change_request=${context.change_request_path}`);
  }
  return lines
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join("\n");
}

function buildChildEnv(feature, run, context) {
  return {
    ...process.env,
    CONTROL_PLANE_AGENT: run.agent,
    CONTROL_PLANE_ARTIFACT: run.artifact,
    CONTROL_PLANE_ARTIFACT_FOLDER: context.artifact_folder,
    CONTROL_PLANE_ARTIFACT_FOLDER_PATH: context.artifact_folder_path,
    CONTROL_PLANE_ARTIFACT_PATH: context.artifact_path,
    CONTROL_PLANE_ARTIFACT_RELATIVE_PATH: context.artifact_relative_path,
    CONTROL_PLANE_BRANCH: feature.branch,
    CONTROL_PLANE_CHANGE_REQUEST_ARTIFACT: context.change_request_artifact,
    CONTROL_PLANE_CHANGE_REQUEST_PATH: context.change_request_path,
    CONTROL_PLANE_CHANGE_REQUEST_RELATIVE_PATH: context.change_request_relative_path,
    CONTROL_PLANE_CONTEXT_FOLDER: context.context_folder,
    CONTROL_PLANE_CONTEXT_FOLDER_PATH: context.context_folder_path,
    CONTROL_PLANE_FEATURE_ID: feature.id,
    CONTROL_PLANE_FEATURE_NAME: feature.name,
    CONTROL_PLANE_FEATURE_SLUG: feature.slug,
    CONTROL_PLANE_FEATURE_WORKSPACE: feature.workspace,
    CONTROL_PLANE_INSTRUCTION_PATH: context.instruction_path,
    CONTROL_PLANE_PROMPT_PATH: context.prompt_path,
    CONTROL_PLANE_PROMPT_RELATIVE_PATH: context.prompt_relative_path,
    CONTROL_PLANE_REPOSITORY_ROOT: context.repository_root,
    CONTROL_PLANE_REQUIRED_ARTIFACT: run.artifact,
    CONTROL_PLANE_RUN_ID: run.id,
    CONTROL_PLANE_RUN_EVENT_URL: `http://127.0.0.1:${PORT}/runs/${encodeURIComponent(run.id)}/events`,
    CONTROL_PLANE_STATE: context.state,
    CONTROL_PLANE_STORED_ARTIFACT_FOLDER: context.stored_artifact_folder,
    CONTROL_PLANE_WORKSPACE_ARTIFACT_FOLDER: context.workspace_artifact_folder,
    CONTROL_PLANE_WORKSPACE_ARTIFACT_PATH: context.workspace_artifact_path,
    CONTROL_PLANE_WORKSPACE_PATH: context.workspace_path,
  };
}

async function handleClose(feature, run, code, signal, handlers) {
  forgetRunProcess(run.id);
  await flushAgentControlOutput(feature, run);
  if (run.status === "cancelled") return;
  if (code !== 0) {
    await handlers.failRun(
      feature,
      run,
      `Agent command exited with code ${code}${signal ? ` (${signal})` : ""}.`,
    );
    return;
  }

  try {
    await handlers.completeConfiguredRun(feature, run);
  } catch (error) {
    await handlers.failRun(
      feature,
      run,
      `Agent completion failed: ${error.message}`,
    );
  }
}

function handleAgentControlOutput(feature, run, chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
  if (!text) return;
  const buffer = `${outputBuffers.get(run.id) ?? ""}${text}`;
  const lines = buffer.split(/\r?\n/);
  outputBuffers.set(run.id, lines.pop() ?? "");
  lines.forEach((line) => {
    void processAgentControlLine(feature, run, line);
  });
}

function flushAgentControlOutput(feature, run) {
  const remaining = outputBuffers.get(run.id);
  outputBuffers.delete(run.id);
  return remaining ? processAgentControlLine(feature, run, remaining) : Promise.resolve();
}

function processAgentControlLine(feature, run, line) {
  const match = String(line).match(/^\s*CONTROL_PLANE_ENVIRONMENT_URL=(\S+)\s*$/);
  if (!match) return Promise.resolve();
  const url = normalizeEnvironmentUrl(match[1]);
  if (!url) return Promise.resolve();
  return queueFeatureEnvironmentUrl(feature, run, url);
}

function normalizeEnvironmentUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.href;
  } catch {
    return "";
  }
}

function stopConfiguredRun(runId) {
  const processInfo = runProcesses.get(runId);
  if (!processInfo) return false;
  if (processInfo.stopTimer) clearTimeout(processInfo.stopTimer);
  terminateRunProcess(processInfo, "SIGTERM");
  processInfo.stopTimer = setTimeout(() => {
    terminateRunProcess(processInfo, "SIGKILL");
  }, STOP_TIMEOUT_MS);
  return true;
}

function forgetConfiguredRun(runId) {
  forgetRunProcess(runId);
  outputBuffers.delete(runId);
}

function forgetRunProcess(runId) {
  const processInfo = runProcesses.get(runId);
  if (processInfo?.stopTimer) clearTimeout(processInfo.stopTimer);
  runProcesses.delete(runId);
}

function stopAllConfiguredRuns() {
  for (const runId of runProcesses.keys()) {
    stopConfiguredRun(runId);
  }
}

function terminateRunProcess(processInfo, signal) {
  const { child } = processInfo;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
      return;
    }
    child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Ignore best-effort cancellation failures.
    }
  }
}

module.exports = {
  forgetConfiguredRun,
  startConfiguredAgentRun,
  stopAllConfiguredRuns,
  stopConfiguredRun,
};
