const fsp = require("node:fs/promises");
const path = require("node:path");
const { ROOT, WORKSPACE_COPY_EXCLUDES, workflow } = require("./config");
const {
  branchArtifactFolder,
  branchWorkspaceFolder,
  getFeatureArtifactFolderPath,
} = require("./feature-artifacts");
const { commitFeatureWorkspace } = require("./git");
const { httpError } = require("./http");
const { createId } = require("./ids");
const { clampStep, saveState, slugify, state } = require("./state");
const { updateFeatureCost } = require("./pricing");
const { formatDateTime } = require("./time");

let startRun;

function configureFeatures(dependencies) {
  startRun = dependencies.startRun;
}

function uniqueSlug(title) {
  const base = slugify(title);
  const used = new Set(state.features.map((feature) => feature.slug));
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base}_v${index}`)) index += 1;
  return `${base}_v${index}`;
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
  const branch = `feature/${slug}`;
  const relativeWorkspace = branchWorkspaceFolder(branch, slug);
  const artifactFolder = branchArtifactFolder(branch, slug);
  const featureDir = path.join(ROOT, relativeWorkspace);
  const artifactDir = path.join(ROOT, artifactFolder);
  const timestamp = formatDateTime();
  await seedFeatureWorkspace(featureDir);
  await fsp.mkdir(artifactDir, { recursive: true });
  await fsp.writeFile(path.join(artifactDir, "prompt.md"), prompt);

  const feature = {
    id: createId(),
    name: title,
    slug,
    branch,
    workspace: relativeWorkspace,
    artifactFolder,
    step: 0,
    updated: timestamp,
    activeRunId: null,
    environmentUrl: null,
    cost: null,
    headCommit: null,
    stepCommits: {},
    restoreHistory: [],
    artifacts: [
      {
        name: "prompt.md",
        path: `${artifactFolder}/prompt.md`,
        availableAtStep: 0,
        createdAt: timestamp,
        updated: timestamp,
        content: prompt,
      },
    ],
    runs: [],
  };
  await saveFeatureFiles(feature);
  const commit = await commitFeatureWorkspace(feature, `Create feature: ${title}`);
  feature.headCommit = commit.sha;
  feature.stepCommits["0"] = commit.sha;
  feature.artifacts[0].commitSha = commit.sha;
  state.features.unshift(feature);
  await saveState();
  return feature;
}

async function saveFeatureFiles(feature) {
  const featureDir = getFeatureArtifactFolderPath(feature);
  await fsp.mkdir(featureDir, { recursive: true });
  await removeStaleMarkdownArtifacts(feature, featureDir);
  await Promise.all(
    feature.artifacts.map((artifact) =>
      fsp.writeFile(path.join(featureDir, artifact.name), artifact.content ?? ""),
    ),
  );
}

async function removeStaleMarkdownArtifacts(feature, featureDir) {
  const expected = new Set(feature.artifacts.map((artifact) => artifact.name));
  let entries;
  try {
    entries = await fsp.readdir(featureDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !expected.has(entry.name))
      .map((entry) => fsp.rm(path.join(featureDir, entry.name), { force: true })),
  );
}

function findFeature(id) {
  const feature = state.features.find((item) => item.id === id);
  if (!feature) throw httpError(404, "Unknown feature.");
  return feature;
}

function currentStep(feature) {
  return workflow[feature.step];
}

function hasSuccessfulRunForStep(feature, stepIndex) {
  return Boolean(
    feature.runs?.some(
      (run) => run.step === stepIndex && run.status === "succeeded",
    ),
  );
}

async function moveFeature(feature, nextStep) {
  nextStep = clampStep(nextStep);
  if (feature.activeRunId) {
    throw httpError(409, "Cancel the active run before changing steps.");
  }

  const currentStepIndex = feature.step;
  const currentWorkflowStep = currentStep(feature);
  if (
    nextStep > currentStepIndex &&
    currentWorkflowStep?.agent &&
    !hasSuccessfulRunForStep(feature, currentStepIndex)
  ) {
    throw httpError(409, "Run the current agent step before moving to the next step.");
  }

  feature.step = nextStep;
  feature.updated = formatDateTime();
  const step = currentStep(feature);
  await saveFeatureFiles(feature);
  await saveState();
  if (step?.agent) {
    return startRun(feature);
  }
  return feature;
}

async function discardNextSteps(feature, editedStep) {
  if (feature.activeRunId) {
    throw httpError(409, "Cancel the active run before discarding next steps.");
  }

  const removedArtifacts = feature.artifacts.filter(
    (artifact) => (artifact.availableAtStep ?? 0) > editedStep,
  );
  feature.artifacts = feature.artifacts.filter(
    (artifact) => (artifact.availableAtStep ?? 0) <= editedStep,
  );
  feature.runs = feature.runs.filter((run) => run.step <= editedStep);
  feature.stepCommits = Object.fromEntries(
    Object.entries(feature.stepCommits ?? {}).filter(([step]) => Number(step) <= editedStep),
  );
  updateFeatureCost(feature);
  feature.step = Math.min(feature.step, editedStep);

  await Promise.all(
    removedArtifacts.map((artifact) =>
      fsp.rm(path.join(getFeatureArtifactFolderPath(feature), artifact.name), { force: true }),
    ),
  );
}

async function updateArtifact(feature, index, content, options = {}) {
  const artifact = feature.artifacts[index];
  if (!artifact) throw httpError(404, "Unknown artifact.");
  const editedStep = artifact.availableAtStep ?? 0;
  artifact.content = content;
  artifact.updated = formatDateTime();
  if (options.discardNextSteps) {
    await discardNextSteps(feature, editedStep);
  }
  feature.updated = formatDateTime();
  await fsp.writeFile(path.join(getFeatureArtifactFolderPath(feature), artifact.name), content);
  await saveFeatureFiles(feature);
  const commit = await commitFeatureWorkspace(
    feature,
    `Update artifact: ${artifact.name}`,
  );
  artifact.commitSha = commit.sha;
  feature.headCommit = commit.sha;
  feature.stepCommits = {
    ...(feature.stepCommits ?? {}),
    [String(editedStep)]: commit.sha,
  };
  await saveState();
  return artifact;
}

module.exports = {
  configureFeatures,
  createFeature,
  currentStep,
  findFeature,
  moveFeature,
  saveFeatureFiles,
  updateArtifact,
};
