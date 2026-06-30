const fsp = require("node:fs/promises");
const path = require("node:path");
const { FEATURE_ROOT, ROOT, WORKSPACE_COPY_EXCLUDES } = require("./config");
const {
  branchArtifactFolder,
  branchWorkspaceFolder,
  getFeatureArtifactFolderPath,
  getLegacyFeatureArtifactFolderPaths,
  getFeatureWorkspaceFolderPath,
} = require("./feature-artifacts");
const { commitFeatureWorkspace } = require("./git");
const { httpError } = require("./http");
const { createId } = require("./ids");
const { saveState, slugify, state } = require("./state");
const { updateFeatureCost } = require("./pricing");
const { formatDateTime } = require("./time");
const { readFeatureEnvironment, stopFeatureEnvironment } = require("./environment");
const {
  clampFeatureStep,
  featureStep,
  loadSdlcSnapshot,
} = require("./workflow");

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
  const sdlc = loadSdlcSnapshot(ROOT, `${relativeWorkspace}/SDLC.yaml`);
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
    sdlc,
    step: 0,
    updated: timestamp,
    activeRunId: null,
    environmentUrl: null,
    environmentCommands: [],
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

async function cloneFeature(sourceFeature) {
  const promptArtifact = sourceFeature.artifacts.find(
    (artifact) => artifact.name === "prompt.md",
  );
  const prompt = String(promptArtifact?.content ?? "");
  if (!prompt.trim()) {
    throw httpError(409, "The selected feature does not have a prompt to clone.");
  }
  return createFeature({
    title: sourceFeature.name,
    prompt,
  });
}

async function resetFeatureToMain(feature, body = {}) {
  if (body.confirmReset !== true) {
    throw httpError(400, "Feature reset confirmation is required.");
  }
  if (feature.activeRunId) {
    throw httpError(409, "Cancel the active run before resetting the feature.");
  }

  const promptArtifact = feature.artifacts.find((artifact) => artifact.name === "prompt.md");
  const prompt = String(promptArtifact?.content ?? "");
  if (!prompt.trim()) {
    throw httpError(409, "The selected feature does not have a prompt to preserve.");
  }

  const featureDir = getFeatureWorkspaceFolderPath(feature);
  assertResettableWorkspace(featureDir);
  const sdlc = loadSdlcSnapshot(ROOT, `${feature.workspace}/SDLC.yaml`);
  const previousCommit = feature.headCommit ?? null;
  const previousEnvironment = await readFeatureEnvironment(feature);
  const environment = await stopEnvironmentForReset(previousEnvironment);

  await fsp.rm(featureDir, { recursive: true, force: true });
  await seedFeatureWorkspace(featureDir);

  const timestamp = formatDateTime();
  feature.sdlc = {
    ...sdlc,
    source: `${sdlc.source}:reset`,
  };
  feature.step = 0;
  feature.activeRunId = null;
  feature.environmentUrl = null;
  feature.environmentCommands = [];
  feature.runs = [];
  feature.stepCommits = {};
  feature.cost = null;
  feature.headCommit = null;
  feature.artifacts = [
    {
      name: "prompt.md",
      path: `${feature.artifactFolder}/prompt.md`,
      availableAtStep: 0,
      createdAt: promptArtifact?.createdAt ?? timestamp,
      updated: timestamp,
      content: prompt,
    },
  ];

  await saveFeatureFiles(feature);
  const commit = await commitFeatureWorkspace(
    feature,
    `Reset feature from repository template: ${feature.name}`,
  );
  feature.headCommit = commit.sha;
  feature.stepCommits["0"] = commit.sha;
  feature.artifacts[0].commitSha = commit.sha;
  feature.restoreHistory = [
    ...(feature.restoreHistory ?? []),
    {
      id: createId(),
      createdAt: formatDateTime(),
      targetStep: 0,
      targetLabel: "Repository template",
      targetSource: "repository-template",
      commitSha: commit.sha,
      previousCommit,
      reason: "",
      reasonArtifact: null,
      environment,
      reset: true,
    },
  ].slice(-50);
  feature.updated = formatDateTime();
  await saveState();
  return { feature, reset: { environment } };
}

function assertResettableWorkspace(featureDir) {
  const relative = path.relative(FEATURE_ROOT, featureDir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw httpError(422, "Feature workspace is outside the configured feature home.");
  }
}

async function stopEnvironmentForReset(previousEnvironment) {
  try {
    await stopFeatureEnvironment(previousEnvironment);
    return {
      status: "stopped",
      message: "Feature environment stopped for reset.",
    };
  } catch (error) {
    return {
      status: "failed",
      message: `Feature environment stop failed during reset: ${error.message}`,
    };
  }
}

async function saveFeatureFiles(feature) {
  const featureDir = getFeatureArtifactFolderPath(feature);
  await fsp.mkdir(featureDir, { recursive: true });
  await removeStaleMarkdownArtifacts(feature, featureDir);
  await removeLegacyMarkdownArtifacts(feature);
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

async function removeLegacyMarkdownArtifacts(feature) {
  await Promise.all(
    getLegacyFeatureArtifactFolderPaths(feature).map((legacyDir) =>
      removeMarkdownFiles(legacyDir),
    ),
  );
}

async function removeMarkdownFiles(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => fsp.rm(path.join(dir, entry.name), { force: true })),
  );
}

function findFeature(id) {
  const feature = state.features.find((item) => item.id === id);
  if (!feature) throw httpError(404, "Unknown feature.");
  return feature;
}

function currentStep(feature) {
  return featureStep(feature);
}

function hasSuccessfulRunForStep(feature, stepIndex) {
  return Boolean(
    feature.runs?.some(
      (run) => run.step === stepIndex && run.status === "succeeded",
    ),
  );
}

async function moveFeature(feature, nextStep) {
  nextStep = clampFeatureStep(feature, nextStep);
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

async function createChangeRequest(feature, body = {}) {
  if (feature.activeRunId) {
    throw httpError(409, "Cancel the active run before adding a change request.");
  }

  const target = resolveChangeRequestTarget(feature, body);
  const content = normalizeChangeRequest(body.content ?? body.changeRequest);
  const artifact = await createChangeRequestArtifact(feature, target, content);

  await saveFeatureFiles(feature);
  const commit = await commitFeatureWorkspace(
    feature,
    `Record change request: ${target.agent}`,
  );
  artifact.commitSha = commit.sha;
  feature.headCommit = commit.sha;
  feature.stepCommits = {
    ...(feature.stepCommits ?? {}),
    [String(target.step)]: commit.sha,
  };
  feature.updated = formatDateTime();
  await saveState();

  return { feature, changeRequestArtifact: artifact, target };
}

function resolveChangeRequestTarget(feature, body) {
  if (body.runId) {
    const run = (feature.runs ?? []).find((item) => item.id === String(body.runId));
    if (!run) throw httpError(404, "Unknown run.");
    if (run.status !== "succeeded") {
      throw httpError(409, "Change requests can only be created for completed agent runs.");
    }
    const step = featureStep(feature, run.step) ?? {};
    if (!step.agent) throw httpError(422, "The selected run is not an agent step.");
    return { step: run.step, agent: run.agent, label: `${run.agent} run` };
  }

  if (Number.isInteger(Number(body.step))) {
    const stepIndex = Number(body.step);
    const step = featureStep(feature, stepIndex) ?? {};
    if (!step.agent) throw httpError(422, "The selected workflow step is not an agent step.");
    if (!hasSuccessfulRunForStep(feature, stepIndex)) {
      throw httpError(409, "The selected agent step has not completed successfully.");
    }
    return { step: stepIndex, agent: step.agent, label: `${step.agent} run` };
  }

  if (body.agent) {
    const agent = String(body.agent);
    for (let index = (feature.runs ?? []).length - 1; index >= 0; index -= 1) {
      const run = feature.runs[index];
      if (run.agent === agent && run.status === "succeeded") {
        return { step: run.step, agent, label: `${agent} run` };
      }
    }
    throw httpError(404, "Unknown completed agent run.");
  }

  throw httpError(422, "A completed run, step, or agent is required.");
}

function normalizeChangeRequest(value) {
  const content = String(value ?? "").trim();
  if (!content) throw httpError(422, "Change request content is required.");
  return content.slice(0, 4000);
}

async function createChangeRequestArtifact(feature, target, request) {
  const name = await uniqueChangeRequestArtifactName(feature, target.agent);
  const now = formatDateTime();
  const artifact = {
    name,
    path: `${feature.artifactFolder}/${name}`,
    availableAtStep: target.step,
    createdAt: now,
    updated: now,
    content: [`# Change request for ${target.agent} agent`, "", request, ""].join("\n"),
  };
  feature.artifacts.push(artifact);
  return artifact;
}

async function uniqueChangeRequestArtifactName(feature, agent) {
  const artifactDir = getFeatureArtifactFolderPath(feature);
  const existing = new Set((feature.artifacts ?? []).map((artifact) => artifact.name));
  const base = `${safeFilePart(agent)}.change-request`;
  let name = `${base}.md`;
  let index = 2;
  while (existing.has(name) || (await fileExists(path.join(artifactDir, name)))) {
    name = `${base}.v${index}.md`;
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

function safeFilePart(value) {
  return String(value ?? "agent")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "agent";
}

module.exports = {
  cloneFeature,
  configureFeatures,
  createFeature,
  createChangeRequest,
  currentStep,
  findFeature,
  moveFeature,
  resetFeatureToMain,
  saveFeatureFiles,
  updateArtifact,
};
