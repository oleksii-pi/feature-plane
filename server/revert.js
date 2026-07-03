const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  getFeatureArtifactFolder,
  getFeatureArtifactFolderPath,
  getLegacyFeatureArtifactFolderPaths,
} = require("./feature-artifacts");
const { commitFeatureWorkspace, resetFeatureWorkspace } = require("./git");
const { httpError } = require("./http");
const { createId } = require("./ids");
const { updateFeatureCost } = require("./pricing");
const { archiveFeatureRuns } = require("./run-history");
const { saveState } = require("./state");
const { formatDateTime } = require("./time");
const {
  readFeatureEnvironment,
  reconcileFeatureEnvironment,
  stopFeatureEnvironment,
} = require("./environment");
const { featureStep, featureWorkflow } = require("./workflow");

let saveFeatureFiles;
let startRun;

function configureRevert(dependencies) {
  saveFeatureFiles = dependencies.saveFeatureFiles;
  startRun = dependencies.startRun;
}

async function revertFeatureToState(feature, body = {}) {
  if (body.confirmHardReset !== true) {
    throw httpError(400, "Hard reset confirmation is required.");
  }
  if (feature.activeRunId) {
    throw httpError(409, "Cancel the active run before reverting state.");
  }

  if (body.rerun === true) {
    if (body.changeRequest !== undefined) {
      throw httpError(400, "Use /features/:id/change-requests to add a change request without reverting state.");
    }
    return rerunAgentStep(feature, body);
  }

  const target = resolveRestoreTarget(feature, body);
  if (!target.commitSha) {
    throw httpError(409, "The selected state does not have a recorded commit.");
  }

  const reason = normalizeReason(body.reason);
  const previousCommit = feature.headCommit ?? null;
  const previousEnvironment = await readFeatureEnvironment(feature);
  const commitSha = await resetFeatureWorkspace(feature, target.commitSha);
  const timestamp = formatDateTime();

  const { keptRuns, removedRuns } = partitionRunsForTarget(feature.runs, target);
  archiveFeatureRuns(feature, removedRuns, `reverted to ${target.label}`);
  feature.runs = keptRuns;
  feature.stepCommits = filterStepCommits(feature.stepCommits, target.step);
  feature.stepCommits[String(target.step)] = commitSha;
  feature.step = target.step;
  feature.statusChangedAt = timestamp;
  feature.headCommit = commitSha;
  feature.activeRunId = null;
  await reloadArtifactsFromWorkspace(feature, target.step);
  feature.updated = timestamp;
  updateFeatureCost(feature);

  let reasonArtifact = null;
  if (reason) {
    reasonArtifact = await writeReasonArtifact(
      feature,
      target,
      previousCommit,
      commitSha,
      reason,
    );
    await saveFeatureFiles(feature);
    const reasonCommit = await commitFeatureWorkspace(
      feature,
      `Record revert reason: ${target.label}`,
    );
    reasonArtifact.commitSha = reasonCommit.sha;
    feature.headCommit = reasonCommit.sha;
  }

  const environment = await settleEnvironmentAfterRestore(
    feature,
    previousEnvironment,
  );

  const restoreEvent = {
    id: createId(),
    createdAt: timestamp,
    targetStep: target.step,
    targetLabel: target.label,
    targetSource: target.source,
    commitSha,
    previousCommit,
    reason,
    reasonArtifact: reasonArtifact?.name ?? null,
    environment,
  };
  feature.restoreHistory = [...(feature.restoreHistory ?? []), restoreEvent].slice(-50);
  feature.updated = timestamp;

  await saveFeatureFiles(feature);
  await saveState();
  return { feature, restore: restoreEvent };
}

async function rerunAgentStep(feature, body) {
  if (typeof startRun !== "function") {
    throw httpError(500, "Agent rerun is not configured.");
  }

  const target = resolveAgentStepRerunTarget(feature, Number(body.step));
  const reason = normalizeReason(body.reason);
  const previousCommit = feature.headCommit ?? null;
  const previousEnvironment = await readFeatureEnvironment(feature);
  const commitSha = await resetFeatureWorkspace(feature, target.commitSha);
  const timestamp = formatDateTime();

  const removedRuns = (feature.runs ?? []).filter(
    (run) => (run.step ?? 0) >= target.step,
  );
  archiveFeatureRuns(feature, removedRuns, `reran ${target.label}`);
  feature.runs = (feature.runs ?? []).filter((run) => (run.step ?? 0) < target.step);
  feature.stepCommits = filterStepCommits(feature.stepCommits, target.step - 1);
  feature.step = target.step;
  feature.statusChangedAt = timestamp;
  feature.headCommit = commitSha;
  feature.activeRunId = null;
  await reloadArtifactsFromWorkspace(feature, target.step - 1);
  feature.updated = timestamp;
  updateFeatureCost(feature);

  const environment = await settleEnvironmentAfterRestore(
    feature,
    previousEnvironment,
  );

  const restoreEvent = {
    id: createId(),
    createdAt: timestamp,
    targetStep: target.step,
    targetLabel: target.label,
    targetSource: target.source,
    commitSha,
    previousCommit,
    reason,
    reasonArtifact: null,
    environment,
    rerun: true,
  };
  feature.restoreHistory = [...(feature.restoreHistory ?? []), restoreEvent].slice(-50);
  feature.updated = timestamp;

  await saveFeatureFiles(feature);
  await saveState();
  const rerunFeature = await startRun(feature);
  return { feature: rerunFeature, restore: restoreEvent, rerun: true };
}

function resolveRestoreTarget(feature, body) {
  if (body.runId) return resolveRunTarget(feature, String(body.runId));
  if (Number.isInteger(Number(body.artifactIndex))) {
    return resolveArtifactTarget(feature, Number(body.artifactIndex));
  }
  return resolveStepTarget(feature, Number(body.step));
}

function resolveRunTarget(feature, runId) {
  const runIndex = feature.runs.findIndex((item) => item.id === runId);
  const run = feature.runs[runIndex];
  if (!run) throw httpError(404, "Unknown run.");
  const step = clampRestoreStep(feature, run.step);
  const label = `${run.agent ?? featureStep(feature, step)?.state ?? "Agent"} run`;
  return {
    source: "run",
    run,
    runIndex,
    step,
    commitSha: run.commitSha ?? stepCommitFor(feature, step),
    label,
    reasonBase: `${safeFilePart(run.agent ?? "agent")}-${safeFilePart(run.id)}`,
  };
}

function resolveArtifactTarget(feature, artifactIndex) {
  const artifact = feature.artifacts[artifactIndex];
  if (!artifact) throw httpError(404, "Unknown artifact.");
  const step = clampRestoreStep(feature, artifact.availableAtStep);
  const runIndex = findProducingRunIndex(feature, artifact, step);
  const run = runIndex >= 0 ? feature.runs[runIndex] : null;
  return {
    source: "artifact",
    artifact,
    run,
    runIndex: runIndex >= 0 ? runIndex : null,
    step,
    commitSha: artifact.commitSha ?? run?.commitSha ?? stepCommitFor(feature, step),
    label: artifact.name,
    reasonBase: run
      ? `${safeFilePart(run.agent ?? "agent")}-${safeFilePart(run.id)}`
      : `${safeFilePart(artifact.name.replace(/\.md$/i, ""))}-step-${step + 1}`,
  };
}

function resolveStepTarget(feature, stepIndex) {
  const step = clampRestoreStep(feature, stepIndex);
  const workflowStep = featureStep(feature, step) ?? {};
  return {
    source: "step",
    step,
    commitSha: stepCommitFor(feature, step),
    label: workflowStep.state ?? `Step ${step + 1}`,
    reasonBase: `${safeFilePart(workflowStep.agent ?? workflowStep.state ?? "step")}-step-${step + 1}`,
  };
}

function resolveAgentStepRerunTarget(feature, stepIndex) {
  const step = clampRestoreStep(feature, stepIndex);
  const workflowStep = featureStep(feature, step) ?? {};
  if (!workflowStep.agent) {
    throw httpError(422, "Only agent workflow steps can be rerun.");
  }
  if (!(feature.runs ?? []).some((run) => run.step === step)) {
    throw httpError(409, "The selected agent step has not run yet.");
  }
  if (step <= 0) {
    throw httpError(409, "The selected agent step does not have a previous restore point.");
  }
  const commitSha = stepCommitFor(feature, step - 1);
  if (!commitSha) {
    throw httpError(409, "The selected agent step does not have a previous restore point.");
  }
  return {
    source: "agent-step-rerun",
    step,
    commitSha,
    label: `${workflowStep.agent} run`,
    agent: workflowStep.agent,
    reasonBase: `${safeFilePart(workflowStep.agent)}-step-${step + 1}`,
  };
}

function clampRestoreStep(feature, value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) throw httpError(422, "Restore target step is required.");
  if (numeric < 0 || numeric >= featureWorkflow(feature).length) {
    throw httpError(422, "Restore target step is outside the workflow.");
  }
  if (numeric > feature.step) {
    throw httpError(409, "Only completed workflow steps can be restored.");
  }
  return numeric;
}

function findProducingRunIndex(feature, artifact, step) {
  for (let index = feature.runs.length - 1; index >= 0; index -= 1) {
    const run = feature.runs[index];
    if (
      run.step === step &&
      run.status === "succeeded" &&
      run.artifact === artifact.name
    ) {
      return index;
    }
  }
  return -1;
}

function stepCommitFor(feature, step) {
  const commits = feature.stepCommits ?? {};
  if (commits[String(step)]) return commits[String(step)];
  for (let index = step; index >= 0; index -= 1) {
    if (commits[String(index)]) return commits[String(index)];
  }
  for (let index = (feature.runs ?? []).length - 1; index >= 0; index -= 1) {
    const run = feature.runs[index];
    if (run.status === "succeeded" && run.step <= step && run.commitSha) {
      return run.commitSha;
    }
  }
  for (let index = (feature.artifacts ?? []).length - 1; index >= 0; index -= 1) {
    const artifact = feature.artifacts[index];
    if ((artifact.availableAtStep ?? 0) <= step && artifact.commitSha) {
      return artifact.commitSha;
    }
  }
  return feature.headCommit ?? null;
}

async function reloadArtifactsFromWorkspace(feature, targetStep) {
  if (targetStep < 0) {
    feature.artifacts = [];
    feature.environmentUrl = null;
    return;
  }

  const artifactDir = getFeatureArtifactFolderPath(feature);
  const artifactFolder = getFeatureArtifactFolder(feature);
  const previousByName = new Map(
    feature.artifacts.map((artifact) => [artifact.name, artifact]),
  );
  const entries = await readWorkspaceArtifacts(feature, artifactDir);

  feature.artifacts = entries
    .map((entry) => {
      const previous = previousByName.get(entry.name) ?? {};
      const availableAtStep = inferArtifactStep(feature, entry.name, previous, targetStep);
      return {
        ...previous,
        name: entry.name,
        path: `${artifactFolder}/${entry.name}`,
        availableAtStep,
        createdAt: previous.createdAt ?? formatDateTime(entry.stat.birthtime),
        updated: formatDateTime(entry.stat.mtime),
        commitSha:
          feature.stepCommits?.[String(availableAtStep)] ??
          previous.commitSha ??
          feature.headCommit ??
          null,
        content: entry.content,
      };
    })
    .filter((artifact) => (artifact.availableAtStep ?? 0) <= targetStep)
    .sort(
      (a, b) =>
        (a.availableAtStep ?? 0) - (b.availableAtStep ?? 0) ||
        a.name.localeCompare(b.name),
    );
  feature.environmentUrl = environmentUrlFromArtifacts(feature.artifacts);
}

async function readWorkspaceArtifacts(feature, artifactDir) {
  const currentEntries = await readMarkdownArtifacts(artifactDir);
  if (currentEntries.length) return currentEntries;
  for (const legacyDir of getLegacyFeatureArtifactFolderPaths(feature)) {
    const legacyEntries = await readMarkdownArtifacts(legacyDir);
    if (legacyEntries.length) return legacyEntries;
  }
  return currentEntries;
}

async function readMarkdownArtifacts(artifactDir) {
  let dirents;
  try {
    dirents = await fsp.readdir(artifactDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const files = dirents
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map(async (entry) => {
      const filePath = path.join(artifactDir, entry.name);
      const [content, stat] = await Promise.all([
        fsp.readFile(filePath, "utf8"),
        fsp.stat(filePath),
      ]);
      return { name: entry.name, content, stat };
    });
  return Promise.all(files);
}

function inferArtifactStep(feature, name, previous, targetStep) {
  if (Number.isInteger(previous.availableAtStep)) {
    return Math.min(previous.availableAtStep, targetStep);
  }
  const workflowIndex = featureWorkflow(feature).findIndex((step) => step.artifact === name);
  if (workflowIndex >= 0) return Math.min(workflowIndex, targetStep);
  return targetStep;
}

function environmentUrlFromArtifacts(artifacts) {
  for (const artifact of artifacts) {
    const match = String(artifact.content ?? "").match(/^URL:\s*(https?:\/\/\S+)\s*$/im);
    if (match) return match[1];
  }
  return null;
}

function shouldKeepRunForTarget(run, index, target) {
  const step = run.step ?? 0;
  if (step < target.step) return true;
  if (step > target.step) return false;
  if (Number.isInteger(target.runIndex)) return index <= target.runIndex;
  return true;
}

function partitionRunsForTarget(runs, target) {
  const keptRuns = [];
  const removedRuns = [];
  (runs ?? []).forEach((run, index) => {
    (shouldKeepRunForTarget(run, index, target) ? keptRuns : removedRuns).push(
      run,
    );
  });
  return { keptRuns, removedRuns };
}

function filterStepCommits(stepCommits, targetStep) {
  return Object.fromEntries(
    Object.entries(stepCommits ?? {}).filter(([step]) => Number(step) <= targetStep),
  );
}

async function writeReasonArtifact(feature, target, previousCommit, commitSha, reason) {
  const artifactDir = getFeatureArtifactFolderPath(feature);
  await fsp.mkdir(artifactDir, { recursive: true });
  const name = await uniqueReasonArtifactName(feature, target.reasonBase);
  const now = formatDateTime();
  const content = [
    "# Revert reason",
    "",
    `Restored at: ${now}`,
    `Target: ${target.label}`,
    `Workflow step: ${target.step + 1}`,
    `Restored commit: ${commitSha}`,
    `Previous head: ${previousCommit ?? "unknown"}`,
    "",
    "## Reason",
    "",
    reason,
    "",
  ].join("\n");
  const artifact = {
    name,
    path: `${getFeatureArtifactFolder(feature)}/${name}`,
    availableAtStep: target.step,
    createdAt: now,
    updated: now,
    content,
  };
  feature.artifacts.push(artifact);
  await fsp.writeFile(path.join(artifactDir, name), content);
  return artifact;
}

async function uniqueReasonArtifactName(feature, base) {
  const artifactDir = getFeatureArtifactFolderPath(feature);
  const existing = new Set(feature.artifacts.map((artifact) => artifact.name));
  let name = `${safeFilePart(base)}-revert-reason.md`;
  let index = 2;
  while (existing.has(name) || (await fileExists(path.join(artifactDir, name)))) {
    name = `${safeFilePart(base)}-revert-reason-v${index}.md`;
    index += 1;
  }
  return name;
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function settleEnvironmentAfterRestore(feature, previousEnvironment) {
  try {
    return feature.environmentUrl
      ? await reconcileFeatureEnvironment(feature, previousEnvironment)
      : await stopEnvironment(previousEnvironment);
  } catch (error) {
    return {
      status: "failed",
      message: `Feature environment check failed after restore: ${error.message}`,
    };
  }
}

async function stopEnvironment(previousEnvironment) {
  await stopFeatureEnvironment(previousEnvironment);
  return {
    status: "stopped",
    message: "Feature environment stopped for this restored state.",
  };
}

function normalizeReason(value) {
  return String(value ?? "").trim().slice(0, 2000);
}

function safeFilePart(value) {
  const normalized = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return normalized || "state";
}

module.exports = {
  configureRevert,
  revertFeatureToState,
};
