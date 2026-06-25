const fsp = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { ROOT, WORKSPACE_COPY_EXCLUDES, workflow } = require("./config");
const {
  branchArtifactFolder,
  branchWorkspaceFolder,
  getFeatureArtifactFolderPath,
} = require("./feature-artifacts");
const { httpError } = require("./http");
const { allocateAvailablePort } = require("./ports");
const { clampStep, saveState, slugify, state } = require("./state");

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
  const usedPorts = new Set(state.features.map((feature) => feature.appPort).filter(Boolean));
  const appPort = await allocateAvailablePort(usedPorts);
  await seedFeatureWorkspace(featureDir);
  await fsp.mkdir(artifactDir, { recursive: true });
  await fsp.writeFile(path.join(artifactDir, "prompt.md"), prompt);

  const feature = {
    id: `feature-${randomUUID()}`,
    name: title,
    slug,
    branch,
    appPort,
    workspace: relativeWorkspace,
    artifactFolder,
    step: 0,
    updated: new Date().toISOString(),
    activeRunId: null,
    cost: null,
    artifacts: [
      {
        name: "prompt.md",
        path: `${artifactFolder}/prompt.md`,
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
  const featureDir = getFeatureArtifactFolderPath(feature);
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

function currentStep(feature) {
  return workflow[feature.step];
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

async function discardNextSteps(feature, editedStep) {
  if (feature.activeRunId) {
    throw httpError(409, "Cancel the active run before discarding next steps.");
  }

  const removedArtifacts = feature.artifacts.filter(
    (artifact) => (artifact.availableAtStep ?? 0) > editedStep,
  );
  const removedRuns = feature.runs.filter((run) => run.step > editedStep);
  feature.artifacts = feature.artifacts.filter(
    (artifact) => (artifact.availableAtStep ?? 0) <= editedStep,
  );
  feature.runs = feature.runs.filter((run) => run.step <= editedStep);
  feature.step = Math.min(feature.step, editedStep);

  await Promise.all(
    removedArtifacts.map((artifact) =>
      fsp.rm(path.join(getFeatureArtifactFolderPath(feature), artifact.name), { force: true }),
    ),
  );
  await removeRunLogEntries(feature, removedRuns);
}

async function removeRunLogEntries(feature, removedRuns) {
  if (!removedRuns.length) return;

  const removedRunIds = new Set(removedRuns.map((run) => run.id));
  const affectedAgents = new Set(removedRuns.map((run) => run.agent).filter(Boolean));
  const featureDir = getFeatureArtifactFolderPath(feature);

  await Promise.all(
    [...affectedAgents].map(async (agent) => {
      const logPath = path.join(featureDir, `${agent}.agent.log`);
      let content;
      try {
        content = await fsp.readFile(logPath, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }

      const keptLines = content
        .split("\n")
        .filter((line) => {
          if (!line.trim()) return false;
          try {
            return !removedRunIds.has(JSON.parse(line).run_id);
          } catch {
            return true;
          }
        });

      if (keptLines.length) {
        await fsp.writeFile(logPath, `${keptLines.join("\n")}\n`);
      } else {
        await fsp.rm(logPath, { force: true });
      }
    }),
  );
}

async function updateArtifact(feature, index, content, options = {}) {
  const artifact = feature.artifacts[index];
  if (!artifact) throw httpError(404, "Unknown artifact.");
  const editedStep = artifact.availableAtStep ?? 0;
  artifact.content = content;
  artifact.updated = new Date().toISOString();
  if (options.discardNextSteps) {
    await discardNextSteps(feature, editedStep);
  }
  feature.updated = new Date().toISOString();
  await fsp.writeFile(path.join(getFeatureArtifactFolderPath(feature), artifact.name), content);
  await saveFeatureFiles(feature);
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
