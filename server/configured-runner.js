const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { spawn } = require("node:child_process");
const path = require("node:path");
const {
  appendRunLogOutput,
  logConfiguredAgentRunStart,
  queueRunEvent,
} = require("./run-events");
const {
  buildAgentContext,
  expandCommandTemplate,
  isInteractiveCodexCommand,
} = require("./agent-command");

const runProcesses = new Map();

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
    await logConfiguredAgentRunStart(feature, run, command, context.workspace_path);
    child = spawn(command, {
      cwd: context.workspace_path,
      env: childEnv,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    await handlers.failRun(feature, run, `Failed to launch agent command: ${error.message}`);
    return;
  }

  runProcesses.set(run.id, child);
  await queueRunEvent(feature, run, "Executing", "Executing configured agent command.");

  const stdoutState = { buffer: "" };
  const stderrState = { buffer: "" };

  child.stdout?.on("data", (chunk) => consumeChunk(feature, run, "stdout", stdoutState, chunk));
  child.stderr?.on("data", (chunk) => consumeChunk(feature, run, "stderr", stderrState, chunk));

  child.once("error", (error) => {
    void (async () => {
      runProcesses.delete(run.id);
      if (run.status === "cancelled") return;
      await handlers.failRun(feature, run, `Agent command failed to start: ${error.message}`);
    })().catch((handlerError) => {
      console.error(handlerError);
    });
  });

  child.once("close", (code, signal) => {
    void handleClose(feature, run, code, signal, stdoutState, stderrState, handlers).catch((handlerError) => {
      console.error(handlerError);
    });
  });
}

function buildChildEnv(feature, run, context) {
  return {
    ...process.env,
    CONTROL_PLANE_AGENT: run.agent,
    CONTROL_PLANE_APP_PORT: String(context.app_port),
    CONTROL_PLANE_ARTIFACT: run.artifact,
    CONTROL_PLANE_ARTIFACT_FOLDER: context.artifact_folder,
    CONTROL_PLANE_ARTIFACT_FOLDER_PATH: context.artifact_folder_path,
    CONTROL_PLANE_ARTIFACT_PATH: context.artifact_path,
    CONTROL_PLANE_BRANCH: feature.branch,
    CONTROL_PLANE_CONTEXT_FOLDER: context.context_folder,
    CONTROL_PLANE_CONTEXT_FOLDER_PATH: context.context_folder_path,
    CONTROL_PLANE_FEATURE_ID: feature.id,
    CONTROL_PLANE_FEATURE_NAME: feature.name,
    CONTROL_PLANE_FEATURE_SLUG: feature.slug,
    CONTROL_PLANE_FEATURE_WORKSPACE: feature.workspace,
    CONTROL_PLANE_INSTRUCTION_PATH: context.instruction_path,
    CONTROL_PLANE_PROMPT_PATH: context.prompt_path,
    CONTROL_PLANE_REQUIRED_ARTIFACT: run.artifact,
    CONTROL_PLANE_RUN_ID: run.id,
    CONTROL_PLANE_STATE: context.state,
    CONTROL_PLANE_WORKSPACE_PATH: context.workspace_path,
  };
}

function consumeChunk(feature, run, streamName, streamState, chunk) {
  if (run.status === "cancelled") return;
  streamState.buffer += chunk.toString("utf8");
  const lines = streamState.buffer.split(/\r?\n/);
  streamState.buffer = lines.pop() ?? "";
  lines.forEach((line) => {
    if (!line.trim()) return;
    void appendRunLogOutput(feature, run, streamName, line).catch((error) => {
      console.error(error);
    });
  });
}

async function handleClose(feature, run, code, signal, stdoutState, stderrState, handlers) {
  runProcesses.delete(run.id);
  if (stdoutState.buffer.trim()) {
    await appendRunLogOutput(feature, run, "stdout", stdoutState.buffer.trimEnd());
    stdoutState.buffer = "";
  }
  if (stderrState.buffer.trim()) {
    await appendRunLogOutput(feature, run, "stderr", stderrState.buffer.trimEnd());
    stderrState.buffer = "";
  }

  if (run.status === "cancelled") return;
  if (code !== 0) {
    await handlers.failRun(
      feature,
      run,
      `Agent command exited with code ${code}${signal ? ` (${signal})` : ""}.`,
    );
    return;
  }

  await handlers.completeConfiguredRun(feature, run);
}

function stopConfiguredRun(runId) {
  const child = runProcesses.get(runId);
  if (!child) return false;
  try {
    child.kill("SIGTERM");
  } catch {
    // Ignore best-effort cancellation failures.
  }
  runProcesses.delete(runId);
  return true;
}

function forgetConfiguredRun(runId) {
  runProcesses.delete(runId);
}

module.exports = {
  forgetConfiguredRun,
  startConfiguredAgentRun,
  stopConfiguredRun,
};
