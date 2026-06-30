const fsp = require("node:fs/promises");
const path = require("node:path");
const { getAgentRunCommand } = require("./config");
const { recordEnvironmentCommand } = require("./command-history");
const {
  getFeatureArtifactFolder,
  getFeatureArtifactFolderPath,
  getFeatureWorkspaceArtifactFolder,
} = require("./feature-artifacts");
const { createWorkspaceSnapshot, summarizeWorkspaceChanges } = require("./file-changes");
const { commitFeatureWorkspace } = require("./git");
const { httpError } = require("./http");
const { createId } = require("./ids");
const { state, saveState } = require("./state");
const { saveFeatureFiles } = require("./features");
const { addEvent, queueRunEvent } = require("./run-events");
const {
  forgetConfiguredRun,
  startConfiguredAgentRun,
  stopConfiguredRun,
} = require("./configured-runner");
const { priceRun, updateFeatureCost } = require("./pricing");
const { formatDateTime } = require("./time");
const { featureStep, featureWorkflow } = require("./workflow");

const timers = new Map();

function findRun(id) {
  for (const feature of state.features) {
    const run = feature.runs.find((item) => item.id === id);
    if (run) return { feature, run };
  }
  throw httpError(404, "Unknown run.");
}

function assertAgentStep(feature, stepIndex = feature.step) {
  const step = featureStep(feature, stepIndex);
  if (!step?.agent)
    throw httpError(409, "The current workflow step is not an agent step.");
  if (feature.activeRunId)
    throw httpError(409, "This feature already has an active run.");
  return { step, stepIndex: Number(stepIndex) };
}

async function startRun(feature, options = {}) {
  const requestedStep = Number.isInteger(Number(options.step))
    ? Number(options.step)
    : feature.step;
  const { step, stepIndex } = assertAgentStep(feature, requestedStep);
  const changeRequestArtifact =
    options.changeRequestArtifact ??
    findChangeRequestArtifact(feature, stepIndex)?.name ??
    null;
  const artifact = nextRunArtifactName(feature, step.artifact, {
    forceNew: Boolean(changeRequestArtifact),
  });
  const run = {
    id: createId(),
    featureId: feature.id,
    step: stepIndex,
    agent: step.agent,
    artifact,
    changeRequestArtifact,
    status: "queued",
    startedAt: formatDateTime(),
    finishedAt: null,
    cost: null,
    logSizeBytes: 0,
    events: [],
  };
  run.fileBaseline = await createWorkspaceSnapshot(feature);
  feature.runs.push(run);
  feature.activeRunId = run.id;
  feature.updated = formatDateTime();
  await saveFeatureFiles(feature);
  await saveState();

  await addEvent(feature, run, "Started", `${run.agent} started.`);
  if (run.changeRequestArtifact) {
    await addEvent(
      feature,
      run,
      "Context",
      `Change request attached: ${run.changeRequestArtifact}.`,
    );
  }
  run.status = "running";

  const commandTemplate = getAgentRunCommand();
  if (commandTemplate) {
    await startConfiguredAgentRun(feature, run, commandTemplate, {
      completeConfiguredRun,
      failRun,
      recordEnvironmentCommand: (command) =>
        recordFeatureEnvironmentCommand(feature, command),
    });
  } else {
    startSimulatedRun(feature, run);
  }

  return feature;
}

function findChangeRequestArtifact(feature, stepIndex = feature.step) {
  return [...(feature.artifacts ?? [])]
    .reverse()
    .find(
      (artifact) =>
        isChangeRequestArtifact(artifact.name) &&
        (artifact.availableAtStep ?? 0) <= stepIndex,
    );
}

function isChangeRequestArtifact(name) {
  return /^[a-z0-9._-]+\.change-request(?:\.v[0-9]+)?\.md$/.test(String(name ?? ""));
}

function nextRunArtifactName(feature, baseName, { forceNew = false } = {}) {
  const name = String(baseName ?? "").trim();
  if (!forceNew || !(feature.artifacts ?? []).some((artifact) => artifact.name === name)) {
    return name;
  }
  const match = name.match(/^(.*?)(\.[^.]+)?$/);
  const stem = match?.[1] || name;
  const extension = match?.[2] || "";
  const used = new Set((feature.artifacts ?? []).map((artifact) => artifact.name));
  let index = 2;
  let candidate = `${stem}-v${index}${extension}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${stem}-v${index}${extension}`;
  }
  return candidate;
}

async function recordFeatureEnvironmentCommand(feature, command) {
  recordEnvironmentCommand(feature, command);
  await saveState();
}

function startSimulatedRun(feature, run) {
  const sequence = [
    ["Executing", "Agent executing."],
    ["Validating", "Validating required artifact."],
    ["Done", "Done."],
  ];

  let delay = 1200;
  sequence.forEach(([status, message], index) => {
    const timer = setTimeout(async () => {
      timers.delete(`${run.id}:${index}`);
      if (run.status === "cancelled") return;
      if (status === "Done") {
        await completeSimulatedRun(feature, run, status, message);
      } else {
        await addEvent(feature, run, status, message);
      }
    }, delay);
    timers.set(`${run.id}:${index}`, timer);
    delay += 1400;
  });
}

async function completeSimulatedRun(feature, run, status, message) {
  const step = featureStep(feature, run.step);
  const content = renderArtifact(feature, run);
  const featureDir = getFeatureArtifactFolderPath(feature);
  const artifactPath = path.join(featureDir, run.artifact);
  await fsp.writeFile(artifactPath, content);
  await updateCompletedRun(feature, run, step, content);
  await addEvent(feature, run, status, message);
}

async function completeConfiguredRun(feature, run) {
  const step = featureStep(feature, run.step);
  const artifactPath = path.join(
    getFeatureArtifactFolderPath(feature),
    run.artifact,
  );
  await queueRunEvent(
    feature,
    run,
    "Validating",
    "Validating required artifact.",
  );

  let content;
  try {
    content = await fsp.readFile(artifactPath, "utf8");
  } catch {
    await failRun(
      feature,
      run,
      `Required artifact ${run.artifact} was not created.`,
    );
    return;
  }

  await updateCompletedRun(feature, run, step, content);
  await addEvent(
    feature,
    run,
    "Done",
    "Done.",
  );
}

async function updateCompletedRun(feature, run, step, content) {
  const existing = feature.artifacts.find(
    (artifact) => artifact.name === run.artifact,
  );
  const artifact = {
    name: run.artifact,
    path: `${getFeatureArtifactFolder(feature)}/${run.artifact}`,
    availableAtStep: run.step,
    createdAt: existing?.createdAt ?? formatDateTime(),
    updated: formatDateTime(),
    content,
  };
  if (existing) Object.assign(existing, artifact);
  else feature.artifacts.push(artifact);

  run.fileChanges = await summarizeWorkspaceChanges(feature, run.fileBaseline);
  delete run.fileBaseline;
  const commit = await commitFeatureWorkspace(
    feature,
    `Run ${run.agent}: ${run.artifact}`,
  );
  run.commitSha = commit.sha;
  artifact.commitSha = commit.sha;
  feature.headCommit = commit.sha;
  feature.stepCommits = {
    ...(feature.stepCommits ?? {}),
    [String(run.step)]: commit.sha,
  };
  run.status = "succeeded";
  run.finishedAt = formatDateTime();
  await priceRun(run);
  updateFeatureCost(feature);
  feature.activeRunId = null;
  feature.step = Math.max(
    feature.step,
    Math.min(run.step + 1, featureWorkflow(feature).length - 1),
  );
  feature.updated = formatDateTime();
}

function renderArtifact(feature, run) {
  const title = run.artifact.replace(/\.md$/, "").replaceAll("-", " ");
  return [
    `## ${title.charAt(0).toUpperCase()}${title.slice(1)}`,
    "",
    `Feature: ${feature.name}`,
    `Agent: ${run.agent}`,
    `Artifact folder: ${getFeatureWorkspaceArtifactFolder(feature)}`,
    "",
    "- Generated by the local Control Plane PoC server.",
    "- Replace this content with real agent output when wiring the configured command.",
  ].join("\n");
}

async function failRun(feature, run, message, level = "error") {
  if (
    run.status === "failed" ||
    run.status === "succeeded" ||
    run.status === "cancelled"
  )
    return run;
  run.status = "failed";
  run.finishedAt = formatDateTime();
  delete run.fileBaseline;
  feature.activeRunId = null;
  feature.updated = formatDateTime();
  forgetConfiguredRun(run.id);
  await addEvent(feature, run, "Failed", message, level);
  return run;
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
  stopConfiguredRun(run.id);
  run.status = "cancelled";
  run.finishedAt = formatDateTime();
  delete run.fileBaseline;
  feature.activeRunId = null;
  feature.updated = formatDateTime();
  await addEvent(
    feature,
    run,
    "Cancelled",
    "Agent run cancelled by user.",
    "info",
  );
  return run;
}

module.exports = {
  cancelRun,
  findRun,
  startRun,
};
