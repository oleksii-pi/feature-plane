const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { loadSdlcConfig } = require("./sdlc");

const ROOT = __dirname;
const ENV_FILE = path.join(ROOT, ".env");
loadDotEnv(ENV_FILE);
const sdlcConfig = loadSdlcConfig();
const PORT = resolvePort(process.argv.slice(2), sdlcConfig.app_port);
const FEATURES_HOME = resolveFeaturesHome(process.env.features_home);
const FEATURE_ROOT = path.join(ROOT, FEATURES_HOME);
const LEGACY_FEATURE_ROOTS = ["feature", ".features"].filter((entry) => entry !== FEATURES_HOME);
const STATE_FILE = path.join(FEATURE_ROOT, "state.json");
const { workflow } = sdlcConfig;
const WORKSPACE_COPY_EXCLUDES = new Set([FEATURES_HOME, ...LEGACY_FEATURE_ROOTS, ".git", ".env"]);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const state = {
  features: [],
};

const timers = new Map();
const runProcesses = new Map();
const runQueues = new Map();
const eventClients = new Map();

async function ensureStorage() {
  const migratedLegacyRoot = await migrateLegacyFeatureRoot();
  await fsp.mkdir(FEATURE_ROOT, { recursive: true });
  try {
    const saved = JSON.parse(await fsp.readFile(STATE_FILE, "utf8"));
    if (migratedLegacyRoot) rewriteLegacyFeatureState(saved);
    const needsRewrite = migratedLegacyRoot || savedFeatureMetadataNeedsRewrite(saved);
    if (Array.isArray(saved.features)) state.features = saved.features.map(normalizeFeature);
    if (needsRewrite) {
      await Promise.all(state.features.map(saveFeatureFiles));
      await saveState();
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await saveState();
  }
  recoverInterruptedRuns();
}

async function migrateLegacyFeatureRoot() {
  try {
    const featureStat = await fsp.stat(FEATURE_ROOT);
    if (featureStat.isDirectory()) return false;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  for (const legacyRootName of LEGACY_FEATURE_ROOTS) {
    const legacyRoot = path.join(ROOT, legacyRootName);
    try {
      const legacyStat = await fsp.stat(legacyRoot);
      if (!legacyStat.isDirectory()) continue;
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }

    await fsp.rename(legacyRoot, FEATURE_ROOT);
    return true;
  }

  return false;
}

function rewriteLegacyFeatureState(state) {
  if (!state || typeof state !== "object") return;
  if (!Array.isArray(state.features)) return;
  state.features = state.features.map(rewriteLegacyFeaturePaths);
}

function rewriteLegacyFeaturePaths(feature) {
  if (!feature || typeof feature !== "object") return feature;
  const rewritten = { ...feature };
  if (typeof rewritten.workspace === "string") rewritten.workspace = rewriteLegacyWorkspacePath(rewritten.workspace);
  if (Array.isArray(rewritten.artifacts)) {
    rewritten.artifacts = rewritten.artifacts.map((artifact) => {
      if (!artifact || typeof artifact !== "object") return artifact;
      const next = { ...artifact };
      if (typeof next.path === "string") next.path = rewriteLegacyWorkspacePath(next.path);
      return next;
    });
  }
  return rewritten;
}

function rewriteLegacyWorkspacePath(value) {
  for (const legacyRootName of LEGACY_FEATURE_ROOTS) {
    const legacyPrefix = `${legacyRootName}/`;
    if (value.startsWith(legacyPrefix)) {
      return `${FEATURES_HOME}/${value.slice(legacyPrefix.length)}`;
    }
  }
  return value;
}

function savedFeatureMetadataNeedsRewrite(saved) {
  if (!saved || typeof saved !== "object") return false;
  if (!Array.isArray(saved.features)) return false;
  return saved.features.some((feature) => feature && typeof feature === "object" && "prompt" in feature);
}

function loadDotEnv(filePath) {
  let source;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return;
  }

  source
    .replace(/\r\n/g, "\n")
    .split("\n")
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;

      const entry = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
      const equalsIndex = entry.indexOf("=");
      if (equalsIndex < 0) return;

      const key = entry.slice(0, equalsIndex).trim();
      if (!key || process.env[key] !== undefined) return;

      const rawValue = entry.slice(equalsIndex + 1).trim();
      process.env[key] = parseDotEnvValue(rawValue);
    });
}

function parseDotEnvValue(rawValue) {
  if (!rawValue) return "";

  const quoted =
    (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"));
  if (quoted) {
    const body = rawValue.slice(1, -1);
    if (rawValue.startsWith('"')) {
      return body.replace(/\\(["\\nrt])/g, (_, escaped) => {
        switch (escaped) {
          case '"':
            return '"';
          case "\\":
            return "\\";
          case "n":
            return "\n";
          case "r":
            return "\r";
          case "t":
            return "\t";
          default:
            return escaped;
        }
      });
    }
    return body;
  }

  const commentIndex = rawValue.search(/\s#/);
  const value = commentIndex >= 0 ? rawValue.slice(0, commentIndex).trimEnd() : rawValue;
  return value;
}

function getAgentRunCommand() {
  return String(process.env.agent_run_command ?? "").trim();
}

function getFeatureRunCommand() {
  return String(process.env.feature_run_command ?? "").trim();
}

function resolveFeaturesHome(rawValue) {
  const fallback = "feature";
  const original = String(rawValue ?? fallback).trim();
  if (!original || original === "." || path.isAbsolute(original)) return fallback;

  const normalized = original
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+|\/+$/g, "");

  if (!normalized || normalized === ".") return fallback;
  return normalized;
}

function isInteractiveCodexCommand(command) {
  const normalized = String(command ?? "").trim();
  return /^codex(?:\s|$)/.test(normalized) && !/^codex\s+exec(?:\s|$)/.test(normalized);
}

function getFeatureWorkspacePath(feature) {
  return path.join(ROOT, feature.workspace);
}

function getAgentInstructionPath(feature, agent) {
  return path.join(getFeatureWorkspacePath(feature), ".instructions", `${agent}.agent.md`);
}

function buildAgentContext(feature, run) {
  const step = workflow[run.step] ?? {};
  return {
    agent: run.agent,
    artifact: run.artifact,
    artifact_path: path.join(getFeatureWorkspacePath(feature), run.artifact),
    branch: feature.branch,
    default_branch: String(process.env.default_branch ?? ""),
    feature_id: feature.id,
    feature_name: feature.name,
    feature_slug: feature.slug,
    feature_title: feature.name,
    instruction_path: getAgentInstructionPath(feature, run.agent),
    llm_model_name: String(process.env.llm_model_name ?? ""),
    prompt_path: path.join(getFeatureWorkspacePath(feature), "prompt.md"),
    run_id: run.id,
    server_port: PORT,
    state: step.state,
    workspace: feature.workspace,
    workspace_path: getFeatureWorkspacePath(feature),
  };
}

function shellEscape(value) {
  const text = String(value ?? "");
  if (!text.length) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return "'" + text.split("'").join("'\"'\"'") + "'";
}

function expandCommandTemplate(template, context) {
  const aliases = Object.create(null);
  Object.entries(context).forEach(([key, value]) => {
    aliases[String(key).toLowerCase().replace(/-/g, "_")] = value;
  });
  const unresolved = [];
  const command = String(template).replace(
    /%([a-zA-Z0-9_-]+)%|\$\{([a-zA-Z0-9_-]+)\}/g,
    (match, percentKey, braceKey) => {
      const key = String(percentKey ?? braceKey ?? "")
        .toLowerCase()
        .replace(/-/g, "_");
      if (!key || !Object.prototype.hasOwnProperty.call(aliases, key)) {
        unresolved.push(match);
        return match;
      }
      return shellEscape(aliases[key]);
    },
  );

  return { command, unresolved };
}

function enqueueRunTask(runId, task) {
  const previous = runQueues.get(runId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => task())
    .catch((error) => {
      console.error(error);
    });
  runQueues.set(runId, next);
  next.finally(() => {
    if (runQueues.get(runId) === next) runQueues.delete(runId);
  });
  return next;
}

function flushRunQueue(runId) {
  return runQueues.get(runId) ?? Promise.resolve();
}

async function appendRunLog(feature, run, event) {
  const logPath = path.join(FEATURE_ROOT, feature.slug, `${run.agent}.log`);
  await fsp.mkdir(path.dirname(logPath), { recursive: true });
  await fsp.appendFile(logPath, `${JSON.stringify(event)}\n`);
}

async function appendRunLogOutput(feature, run, streamName, message) {
  const entry = {
    timestamp: new Date().toISOString(),
    run_id: run.id,
    level: streamName === "stderr" ? "error" : "info",
    status: streamName,
    message,
  };
  await appendRunLog(feature, run, entry);
}

async function logConfiguredAgentRunStart(feature, run, command, cwd) {
  const message = `Executing agent_run_command: ${command}`;
  console.log(
    `[agent_run_command] feature=${feature.slug} run=${run.id} agent=${run.agent} cwd=${cwd} command=${command}`,
  );
  await appendRunLog(feature, run, {
    timestamp: new Date().toISOString(),
    run_id: run.id,
    level: "info",
    status: "command",
    message,
    cwd,
    command,
  });
}

function createRunEvent(run, status, message, level = "info") {
  return {
    timestamp: new Date().toISOString(),
    run_id: run.id,
    level,
    status,
    message,
  };
}

function isVerboseRunEvent(event) {
  const status = String(event?.status ?? "").toLowerCase();
  return status === "stdout" || status === "stderr";
}

async function persistRunEvent(feature, run, event, options = {}) {
  run.events.push(event);
  if (options.appendLog !== false) {
    await appendRunLog(feature, run, event);
  }
  if (options.saveState !== false) {
    await saveFeatureFiles(feature);
    await saveState();
  }
  if (options.broadcast !== false) broadcastRunEvent(run, event);
  return event;
}

async function addEvent(feature, run, status, message, level = "info", options = {}) {
  const event = createRunEvent(run, status, message, level);
  return persistRunEvent(feature, run, event, {
    appendLog: options.persist !== false,
    broadcast: options.broadcast !== false,
    saveState: options.persist !== false,
  });
}

function resolvePort(argv, fallbackPort) {
  const cliPort = parsePort(argv[0]);
  if (cliPort !== null) return cliPort;

  const envPort = parsePort(process.env.PORT ?? process.env.port);
  if (envPort !== null) return envPort;

  const sdlcPort = parsePort(fallbackPort);
  if (sdlcPort !== null) return sdlcPort;

  return 8765;
}

function parsePort(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) return null;
  return parsed;
}

function normalizeFeature(feature) {
  const slug = String(feature.slug ?? slugify(feature.name ?? feature.title ?? "feature"));
  return {
    id: String(feature.id),
    name: String(feature.name ?? feature.title ?? "Untitled feature"),
    slug,
    branch: String(feature.branch ?? `feature/${slug}`),
    workspace: rewriteLegacyWorkspacePath(String(feature.workspace ?? `${FEATURES_HOME}/${slug}`)),
    step: clampStep(feature.step),
    updated: String(feature.updated ?? new Date().toISOString()),
    activeRunId: feature.activeRunId ?? null,
    cost: feature.cost ?? null,
    artifacts: Array.isArray(feature.artifacts) ? feature.artifacts : [],
    runs: Array.isArray(feature.runs)
      ? feature.runs.map((run) => ({
          ...run,
          events: Array.isArray(run.events) ? run.events.filter((event) => !isVerboseRunEvent(event)) : [],
        }))
      : [],
  };
}

function recoverInterruptedRuns() {
  state.features.forEach((feature) => {
    feature.runs.forEach((run) => {
      if (run.status === "queued" || run.status === "running") {
        run.status = "failed";
        addEvent(feature, run, "Failed", "Server restarted before the run completed.", "error", {
          persist: false,
          broadcast: false,
        });
      }
    });
    feature.activeRunId = null;
  });
}

async function saveState() {
  await fsp.mkdir(FEATURE_ROOT, { recursive: true });
  await fsp.writeFile(STATE_FILE, JSON.stringify({ features: state.features }, null, 2));
}

function slugify(value) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return slug || "feature";
}

function uniqueSlug(title) {
  const base = slugify(title);
  const used = new Set(state.features.map((feature) => feature.slug));
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base}_v${index}`)) index += 1;
  return `${base}_v${index}`;
}

function clampStep(value) {
  return Math.max(0, Math.min(workflow.length - 1, Number(value) || 0));
}

function publicState() {
  return {
    workflow,
    features: state.features,
    workspaces: state.features.map((feature) => ({
      id: feature.slug,
      featureId: feature.id,
      path: feature.workspace,
      activeRunId: feature.activeRunId,
    })),
    validation: validateRepository(),
  };
}

async function seedFeatureWorkspace(featureDir) {
  await fsp.mkdir(featureDir, { recursive: true });
  const entries = await fsp.readdir(ROOT, { withFileTypes: true });

  await Promise.all(
    entries
      .filter((entry) => !WORKSPACE_COPY_EXCLUDES.has(entry.name))
      .map((entry) =>
        fsp.cp(path.join(ROOT, entry.name), path.join(featureDir, entry.name), {
          recursive: true,
          force: true,
          preserveTimestamps: true,
        }),
      ),
  );
}

async function createFeature({ title, prompt }) {
  if (!title || !prompt) throw httpError(400, "Feature title and prompt are required.");
  const slug = uniqueSlug(title);
  const featureDir = path.join(FEATURE_ROOT, slug);
  const relativeWorkspace = `${FEATURES_HOME}/${slug}`;
  await seedFeatureWorkspace(featureDir);
  await fsp.writeFile(path.join(featureDir, "prompt.md"), prompt);

  const feature = {
    id: `feature-${randomUUID()}`,
    name: title,
    slug,
    branch: `feature/${slug}`,
    workspace: relativeWorkspace,
    step: 0,
    updated: new Date().toISOString(),
    activeRunId: null,
    cost: null,
    artifacts: [
      {
        name: "prompt.md",
        path: `${relativeWorkspace}/prompt.md`,
        availableAtStep: 0,
        updated: new Date().toISOString(),
        content: prompt,
      },
    ],
    runs: [],
  };
  state.features.unshift(feature);
  await saveFeatureFiles(feature);
  await saveState();
  return feature;
}

async function saveFeatureFiles(feature) {
  const featureDir = path.join(FEATURE_ROOT, feature.slug);
  await fsp.mkdir(featureDir, { recursive: true });
  await Promise.all(
    feature.artifacts.map((artifact) =>
      fsp.writeFile(path.join(featureDir, artifact.name), artifact.content ?? ""),
    ),
  );
  await fsp.writeFile(path.join(featureDir, "feature.json"), JSON.stringify(feature, null, 2));
}

function findFeature(id) {
  const feature = state.features.find((item) => item.id === id);
  if (!feature) throw httpError(404, "Unknown feature.");
  return feature;
}

function findRun(id) {
  for (const feature of state.features) {
    const run = feature.runs.find((item) => item.id === id);
    if (run) return { feature, run };
  }
  throw httpError(404, "Unknown run.");
}

function currentStep(feature) {
  return workflow[feature.step];
}

function assertAgentStep(feature) {
  const step = currentStep(feature);
  if (!step?.agent) throw httpError(409, "The current workflow step is not an agent step.");
  if (feature.activeRunId) throw httpError(409, "This feature already has an active run.");
  return step;
}

async function moveFeature(feature, nextStep) {
  nextStep = clampStep(nextStep);
  feature.step = nextStep;
  feature.updated = new Date().toISOString();
  const step = currentStep(feature);
  await saveFeatureFiles(feature);
  await saveState();
  if (step?.agent) {
    return startRun(feature);
  }
  return feature;
}

async function startRun(feature) {
  const step = assertAgentStep(feature);
  const run = {
    id: `run-${randomUUID()}`,
    featureId: feature.id,
    step: feature.step,
    agent: step.agent,
    artifact: step.artifact,
    status: "queued",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    cost: null,
    events: [],
  };
  feature.runs.push(run);
  feature.activeRunId = run.id;
  feature.updated = new Date().toISOString();
  await saveFeatureFiles(feature);
  await saveState();

  await addEvent(feature, run, "Starting", "Agent run queued.");
  run.status = "running";
  await addEvent(feature, run, "Analyzing", "Reading prompt and workflow context.");

  const commandTemplate = getAgentRunCommand();
  if (commandTemplate) {
    await startConfiguredAgentRun(feature, run, commandTemplate);
  } else {
    startSimulatedRun(feature, run);
  }

  return feature;
}

function startSimulatedRun(feature, run) {
  const sequence = [
    ["Implementing", "Writing the required artifact."],
    ["Verifying", "Checking that the artifact exists."],
    ["Completed", "Agent run completed successfully."],
  ];

  let delay = 1200;
  sequence.forEach(([status, message], index) => {
    const timer = setTimeout(async () => {
      timers.delete(`${run.id}:${index}`);
      if (run.status === "cancelled") return;
      if (status === "Completed") {
        await completeSimulatedRun(feature, run, status, message);
      } else {
        await addEvent(feature, run, status, message);
      }
    }, delay);
    timers.set(`${run.id}:${index}`, timer);
    delay += 1400;
  });
}

async function startConfiguredAgentRun(feature, run, commandTemplate) {
  const context = buildAgentContext(feature, run);
  try {
    await fsp.access(context.instruction_path, fs.constants.R_OK);
  } catch {
    await failRun(feature, run, `Missing agent instructions: ${path.relative(context.workspace_path, context.instruction_path)}.`);
    return;
  }
  const { command, unresolved } = expandCommandTemplate(commandTemplate, context);
  if (unresolved.length) {
    await failRun(feature, run, `Unknown placeholder(s) in agent_run_command: ${unresolved.join(", ")}.`);
    return;
  }
  if (isInteractiveCodexCommand(command)) {
    await failRun(
      feature,
      run,
      "agent_run_command uses interactive `codex`, which requires a TTY. Use `codex exec ...` for workflow runs.",
    );
    return;
  }

  const childEnv = {
    ...process.env,
    CONTROL_PLANE_AGENT: run.agent,
    CONTROL_PLANE_ARTIFACT: run.artifact,
    CONTROL_PLANE_ARTIFACT_PATH: context.artifact_path,
    CONTROL_PLANE_BRANCH: feature.branch,
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
    await failRun(feature, run, `Failed to launch agent command: ${error.message}`);
    return;
  }

  runProcesses.set(run.id, child);
  await queueRunEvent(feature, run, "Implementing", "Executing configured agent command.");

  const stdoutState = { buffer: "" };
  const stderrState = { buffer: "" };

  const consumeChunk = (streamName, state, chunk) => {
    if (run.status === "cancelled") return;
    state.buffer += chunk.toString("utf8");
    const lines = state.buffer.split(/\r?\n/);
    state.buffer = lines.pop() ?? "";
    lines.forEach((line) => {
      if (!line.trim()) return;
      void appendRunLogOutput(feature, run, streamName, line).catch((error) => {
        console.error(error);
      });
    });
  };

  child.stdout?.on("data", (chunk) => consumeChunk("stdout", stdoutState, chunk));
  child.stderr?.on("data", (chunk) => consumeChunk("stderr", stderrState, chunk));

  child.once("error", (error) => {
    void (async () => {
      runProcesses.delete(run.id);
      if (run.status === "cancelled") return;
      await failRun(feature, run, `Agent command failed to start: ${error.message}`);
    })().catch((handlerError) => {
      console.error(handlerError);
    });
  });

  child.once("close", (code, signal) => {
    void (async () => {
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
        await failRun(
          feature,
          run,
          `Agent command exited with code ${code}${signal ? ` (${signal})` : ""}.`,
        );
        return;
      }

      await completeConfiguredRun(feature, run);
    })().catch((handlerError) => {
      console.error(handlerError);
    });
  });
}

async function queueRunEvent(feature, run, status, message, level = "info") {
  return enqueueRunTask(run.id, () => {
    if (run.status !== "queued" && run.status !== "running") return null;
    return persistRunEvent(feature, run, createRunEvent(run, status, message, level), {
      appendLog: true,
      broadcast: true,
      saveState: false,
    });
  });
}

async function completeSimulatedRun(feature, run, status, message) {
  const step = workflow[run.step];
  const content = renderArtifact(feature, run, step);
  const featureDir = path.join(FEATURE_ROOT, feature.slug);
  const artifactPath = path.join(featureDir, step.artifact);
  await fsp.writeFile(artifactPath, content);

  const existing = feature.artifacts.find((artifact) => artifact.name === step.artifact);
  const artifact = {
    name: step.artifact,
    path: `${feature.workspace}/${step.artifact}`,
    availableAtStep: run.step,
    updated: new Date().toISOString(),
    content,
  };
  if (existing) Object.assign(existing, artifact);
  else feature.artifacts.push(artifact);

  run.status = "succeeded";
  run.finishedAt = new Date().toISOString();
  run.cost = "$0.00";
  feature.cost = "$0.00";
  feature.activeRunId = null;
  feature.step = Math.min(run.step + 1, workflow.length - 1);
  feature.updated = new Date().toISOString();
  await addEvent(feature, run, status, message);
}

async function completeConfiguredRun(feature, run) {
  const step = workflow[run.step];
  const artifactPath = path.join(getFeatureWorkspacePath(feature), step.artifact);
  await queueRunEvent(feature, run, "Verifying", "Checking required artifact on disk.");

  let content;
  try {
    content = await fsp.readFile(artifactPath, "utf8");
  } catch {
    await failRun(feature, run, `Required artifact ${step.artifact} was not created.`);
    return;
  }

  const existing = feature.artifacts.find((artifact) => artifact.name === step.artifact);
  const artifact = {
    name: step.artifact,
    path: `${feature.workspace}/${step.artifact}`,
    availableAtStep: run.step,
    updated: new Date().toISOString(),
    content,
  };
  if (existing) Object.assign(existing, artifact);
  else feature.artifacts.push(artifact);

  run.status = "succeeded";
  run.finishedAt = new Date().toISOString();
  run.cost = "$0.00";
  feature.cost = "$0.00";
  feature.activeRunId = null;
  feature.step = Math.min(run.step + 1, workflow.length - 1);
  feature.updated = new Date().toISOString();
  await addEvent(feature, run, "Completed", "Agent run completed successfully.");
}

function renderArtifact(feature, run, step) {
  const title = step.artifact.replace(/\.md$/, "").replaceAll("-", " ");
  return [
    `## ${title.charAt(0).toUpperCase()}${title.slice(1)}`,
    "",
    `Feature: ${feature.name}`,
    `Agent: ${run.agent}`,
    `Workspace: ${feature.workspace}`,
    "",
    "- Generated by the local Control Plane PoC server.",
    "- Replace this content with real agent output when wiring the configured command.",
  ].join("\n");
}

async function failRun(feature, run, message, level = "error") {
  if (run.status === "failed" || run.status === "succeeded" || run.status === "cancelled") return run;
  run.status = "failed";
  run.finishedAt = new Date().toISOString();
  feature.activeRunId = null;
  feature.updated = new Date().toISOString();
  runProcesses.delete(run.id);
  await addEvent(feature, run, "Failed", message, level);
  return run;
}

function broadcastRunEvent(run, event) {
  const clients = eventClients.get(run.id);
  if (!clients) return;
  const payload = JSON.stringify({ ...event, run_status: run.status });
  clients.forEach((res) => res.write(`data: ${payload}\n\n`));
}

async function cancelRun(runId) {
  const { feature, run } = findRun(runId);
  if (run.status !== "queued" && run.status !== "running") return run;
  for (const [key, timer] of timers) {
    if (key.startsWith(`${run.id}:`)) {
      clearTimeout(timer);
      timers.delete(key);
    }
  }
  const child = runProcesses.get(run.id);
  if (child) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Ignore best-effort cancellation failures.
    }
    runProcesses.delete(run.id);
  }
  run.status = "cancelled";
  run.finishedAt = new Date().toISOString();
  feature.activeRunId = null;
  feature.updated = new Date().toISOString();
  await addEvent(feature, run, "Cancelled", "Agent run cancelled by user.", "info");
  return run;
}

async function updateArtifact(feature, index, content) {
  const artifact = feature.artifacts[index];
  if (!artifact) throw httpError(404, "Unknown artifact.");
  artifact.content = content;
  artifact.updated = new Date().toISOString();
  feature.updated = new Date().toISOString();
  await fsp.writeFile(path.join(ROOT, artifact.path), content);
  await saveFeatureFiles(feature);
  await saveState();
  return artifact;
}

function validateRepository() {
  const featureRunCommand = getFeatureRunCommand();
  const instructionFilesPresent = (sdlcConfig.agents ?? []).every((agent) =>
    fs.existsSync(path.join(ROOT, ".instructions", `${agent}.agent.md`)),
  );
  const checks = [
    {
      name: "Feature storage",
      status: fs.existsSync(FEATURE_ROOT) ? "passed" : "failed",
      message: `${path.relative(ROOT, FEATURE_ROOT)} exists and stores all feature branches.`,
    },
    {
      name: "Workflow structure",
      status: workflow[0]?.artifact === "prompt.md" && workflow.at(-1)?.state === "Done" ? "passed" : "failed",
      message: "The workflow starts with prompt.md and ends at Done.",
    },
    {
      name: "Agent artifacts",
      status: workflow.filter((step) => step.agent).every((step) => step.artifact?.endsWith(".md"))
        ? "passed"
        : "failed",
      message: "Every agent step has a Markdown artifact.",
    },
    {
      name: "Agent instructions",
      status: instructionFilesPresent ? "passed" : "failed",
      message: "Every configured agent has a matching .instructions/<agent>.agent.md file.",
    },
    {
      name: "Run logs",
      status: "passed",
      message: "Run logs are appended under the matching feature branch folder.",
    },
    {
      name: "Feature run command",
      status: featureRunCommand ? "passed" : "warning",
      message: featureRunCommand
        ? "feature_run_command is configured in .env."
        : "feature_run_command is not configured in .env.",
    },
  ];
  const passed = checks.filter((check) => check.status === "passed").length;
  const warnings = checks.filter((check) => check.status === "warning").length;
  const errors = checks.filter((check) => check.status === "failed").length;
  return {
    ok: errors === 0,
    checks,
    passed,
    warnings,
    errors,
    workspaceRoot: `${FEATURES_HOME}/`,
    completedAt: new Date().toLocaleString(),
  };
}

function resolveConfiguredFeatureRunCommand() {
  const template = getFeatureRunCommand();
  if (!template) return { command: "", unresolved: [] };
  return expandCommandTemplate(template, { server_port: PORT });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "Malformed JSON.");
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendNoContent(res) {
  res.writeHead(204);
  res.end();
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (req.method === "GET" && url.pathname === "/state") {
    sendJson(res, 200, publicState());
    return;
  }

  if (req.method === "PUT" && url.pathname === "/state") {
    const body = await readJson(req);
    if (!Array.isArray(body.features)) throw httpError(400, "features must be an array.");
    state.features = body.features.map(normalizeFeature);
    await Promise.all(state.features.map(saveFeatureFiles));
    await saveState();
    sendJson(res, 200, publicState());
    return;
  }

  if (req.method === "GET" && url.pathname === "/repository/validation") {
    sendJson(res, 200, validateRepository());
    return;
  }

  if (req.method === "GET" && url.pathname === "/workspaces") {
    sendJson(res, 200, publicState().workspaces);
    return;
  }

  if (req.method === "POST" && parts[0] === "workspaces" && parts[2] === "cleanup") {
    sendJson(res, 200, { id: parts[1], cleaned: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/features") {
    sendJson(res, 200, state.features);
    return;
  }

  if (req.method === "POST" && url.pathname === "/features") {
    const body = await readJson(req);
    const feature = await createFeature({
      title: String(body.title ?? body.name ?? "").trim(),
      prompt: String(body.prompt ?? "").trim(),
    });
    sendJson(res, 201, feature);
    return;
  }

  if (parts[0] === "features" && parts[1]) {
    const feature = findFeature(parts[1]);

    if (req.method === "GET" && parts.length === 2) {
      sendJson(res, 200, feature);
      return;
    }

    if (req.method === "PATCH" && parts.length === 2) {
      const body = await readJson(req);
      if (body.branch) {
        const branch = String(body.branch);
        if (!branch.startsWith("feature/")) {
          throw httpError(422, "Feature branches must live under feature/.");
        }
        feature.branch = branch;
      }
      if (body.name) feature.name = String(body.name);
      feature.updated = new Date().toISOString();
      await saveFeatureFiles(feature);
      await saveState();
      sendJson(res, 200, feature);
      return;
    }

    if (req.method === "DELETE" && parts.length === 2) {
      state.features = state.features.filter((item) => item.id !== feature.id);
      await fsp.rm(path.join(FEATURE_ROOT, feature.slug), { recursive: true, force: true });
      await saveState();
      sendNoContent(res);
      return;
    }

    if (req.method === "GET" && parts[2] === "steps") {
      sendJson(res, 200, workflow);
      return;
    }

    if (req.method === "PATCH" && parts[2] === "steps" && parts[3]) {
      const updated = await moveFeature(feature, Number(parts[3]));
      sendJson(res, 200, updated);
      return;
    }

    if (req.method === "PATCH" && parts[2] === "artifacts" && parts[3]) {
      const body = await readJson(req);
      const artifact = await updateArtifact(feature, Number(parts[3]), String(body.content ?? ""));
      sendJson(res, 200, artifact);
      return;
    }

    if (req.method === "GET" && parts[2] === "runs") {
      sendJson(res, 200, feature.runs);
      return;
    }

    if (req.method === "POST" && parts[2] === "runs") {
      const updated = await startRun(feature);
      sendJson(res, 201, updated);
      return;
    }
  }

  if (parts[0] === "runs" && parts[1]) {
    const { run } = findRun(parts[1]);

    if (req.method === "GET" && parts.length === 2) {
      sendJson(res, 200, run);
      return;
    }

    if (req.method === "GET" && parts[2] === "events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      run.events.forEach((event) => {
        res.write(`data: ${JSON.stringify({ ...event, run_status: run.status })}\n\n`);
      });
      if (run.status !== "queued" && run.status !== "running") {
        res.end();
        return;
      }
      const clients = eventClients.get(run.id) ?? new Set();
      clients.add(res);
      eventClients.set(run.id, clients);
      req.on("close", () => {
        clients.delete(res);
        if (!clients.size) eventClients.delete(run.id);
      });
      return;
    }

    if (req.method === "POST" && parts[2] === "cancel") {
      const cancelled = await cancelRun(run.id);
      sendJson(res, 200, cancelled);
      return;
    }
  }

  await serveStatic(url.pathname, res);
}

async function serveStatic(requestPath, res) {
  const filePath = requestPath === "/" ? path.join(ROOT, "index.html") : path.join(ROOT, requestPath);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(ROOT)) throw httpError(404, "Not found.");
  try {
    const data = await fsp.readFile(resolved);
    const ext = path.extname(resolved);
    res.writeHead(200, { "Content-Type": contentTypes[ext] ?? "application/octet-stream" });
    res.end(data);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") throw httpError(404, "Not found.");
    throw error;
  }
}

async function handle(req, res) {
  try {
    await route(req, res);
  } catch (error) {
    const status = error.status ?? 500;
    sendJson(res, status, { message: status === 500 ? "Internal server error." : error.message });
    if (status === 500) console.error(error);
  }
}

ensureStorage()
  .then(() => {
    http.createServer(handle).listen(PORT, "127.0.0.1", () => {
      console.log(`Control Plane PoC listening on http://127.0.0.1:${PORT}`);
      const { command, unresolved } = resolveConfiguredFeatureRunCommand();
      if (command && !unresolved.length) {
        console.log(`Configured feature_run_command: ${command}`);
      } else if (unresolved.length) {
        console.warn(`feature_run_command has unresolved placeholder(s): ${unresolved.join(", ")}`);
      }
    });
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
