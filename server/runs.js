const fsp = require("node:fs/promises");
const path = require("node:path");
const { getAgentRunCommand, workflow } = require("./config");
const { getFeatureArtifactFolder, getFeatureArtifactFolderPath } = require("./feature-artifacts");
const { createWorkspaceSnapshot, summarizeWorkspaceChanges } = require("./file-changes");
const { httpError } = require("./http");
const { createId } = require("./ids");
const { state, saveState } = require("./state");
const { currentStep, saveFeatureFiles } = require("./features");
const { addEvent, queueRunEvent } = require("./run-events");
const {
  forgetConfiguredRun,
  startConfiguredAgentRun,
  stopConfiguredRun,
} = require("./configured-runner");
const { priceRun, updateFeatureCost } = require("./pricing");
const { formatDateTime } = require("./time");

const timers = new Map();

function findRun(id) {
  for (const feature of state.features) {
    const run = feature.runs.find((item) => item.id === id);
    if (run) return { feature, run };
  }
  throw httpError(404, "Unknown run.");
}

function assertAgentStep(feature) {
  const step = currentStep(feature);
  if (!step?.agent)
    throw httpError(409, "The current workflow step is not an agent step.");
  if (feature.activeRunId)
    throw httpError(409, "This feature already has an active run.");
  return step;
}

async function startRun(feature) {
  const step = assertAgentStep(feature);
  const run = {
    id: createId("run"),
    featureId: feature.id,
    step: feature.step,
    agent: step.agent,
    artifact: step.artifact,
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
  run.status = "running";

  const commandTemplate = getAgentRunCommand();
  if (commandTemplate) {
    await startConfiguredAgentRun(feature, run, commandTemplate, {
      completeConfiguredRun,
      failRun,
    });
  } else {
    startSimulatedRun(feature, run);
  }

  return feature;
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
  const step = workflow[run.step];
  const content = renderArtifact(feature, run, step);
  const featureDir = getFeatureArtifactFolderPath(feature);
  const artifactPath = path.join(featureDir, step.artifact);
  await fsp.writeFile(artifactPath, content);
  await updateCompletedRun(feature, run, step, content);
  await addEvent(feature, run, status, message);
}

async function completeConfiguredRun(feature, run) {
  const step = workflow[run.step];
  const artifactPath = path.join(
    getFeatureArtifactFolderPath(feature),
    step.artifact,
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
      `Required artifact ${step.artifact} was not created.`,
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
    (artifact) => artifact.name === step.artifact,
  );
  const artifact = {
    name: step.artifact,
    path: `${getFeatureArtifactFolder(feature)}/${step.artifact}`,
    availableAtStep: run.step,
    updated: formatDateTime(),
    content,
  };
  if (existing) Object.assign(existing, artifact);
  else feature.artifacts.push(artifact);

  run.status = "succeeded";
  run.finishedAt = formatDateTime();
  run.fileChanges = await summarizeWorkspaceChanges(feature, run.fileBaseline);
  delete run.fileBaseline;
  await priceRun(run);
  updateFeatureCost(feature);
  feature.activeRunId = null;
  feature.step = Math.min(run.step + 1, workflow.length - 1);
  feature.updated = formatDateTime();
}

function renderArtifact(feature, run, step) {
  const title = step.artifact.replace(/\.md$/, "").replaceAll("-", " ");
  return [
    `## ${title.charAt(0).toUpperCase()}${title.slice(1)}`,
    "",
    `Feature: ${feature.name}`,
    `Agent: ${run.agent}`,
    `Artifact folder: ${getFeatureArtifactFolder(feature)}`,
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
