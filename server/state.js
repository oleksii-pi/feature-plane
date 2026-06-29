const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  FEATURE_ROOT,
  RUN_LOG_ROOT,
  STATE_FILE,
  workflow,
} = require("./config");
const {
  branchArtifactFolder,
  branchWorkspaceFolder,
  getFeatureArtifactFolder,
  getFeatureWorkspaceArtifactFolder,
  legacyBranchArtifactFolders,
} = require("./feature-artifacts");
const { commitFeatureWorkspace } = require("./git");
const { priceRun, updateFeatureCost } = require("./pricing");
const { addEvent, RUN_LOG_PREVIEW_LINE_LIMIT } = require("./run-events");
const { formatDateTime } = require("./time");

const state = {
  features: [],
};

let saveFeatureFiles;
let validateRepository;

function configureState(dependencies) {
  saveFeatureFiles = dependencies.saveFeatureFiles;
  validateRepository = dependencies.validateRepository;
}

async function ensureStorage() {
  await fsp.mkdir(FEATURE_ROOT, { recursive: true });
  try {
    const saved = JSON.parse(await fsp.readFile(STATE_FILE, "utf8"));
    const legacyArtifactFeatureIds = savedLegacyArtifactFeatureIds(saved);
    if (Array.isArray(saved.features)) state.features = saved.features.map(normalizeFeature);
    const repricedRuns = await repriceCompletedRuns();
    const backfilledRestorePoints = await backfillMissingRestorePoints();
    const needsRewrite =
      repricedRuns ||
      backfilledRestorePoints ||
      savedFeatureMetadataNeedsRewrite(saved) ||
      savedTimestampsNeedRewrite(saved);
    if (needsRewrite) {
      await Promise.all(state.features.map(saveFeatureFiles));
    }
    const migratedArtifactFolders = await commitMigratedArtifactFolders(legacyArtifactFeatureIds);
    if (needsRewrite || migratedArtifactFolders) await saveState();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await saveState();
  }
  recoverInterruptedRuns();
}

async function repriceCompletedRuns() {
  let changed = false;
  for (const feature of state.features) {
    let featureChanged = false;
    for (const run of feature.runs) {
      if (run.status !== "succeeded") continue;
      const before = JSON.stringify({
        usage: run.usage ?? null,
        pricing: run.pricing ?? null,
        cost: run.cost ?? null,
      });
      await priceRun(run);
      const after = JSON.stringify({
        usage: run.usage ?? null,
        pricing: run.pricing ?? null,
        cost: run.cost ?? null,
      });
      if (before !== after) featureChanged = true;
    }
    if (featureChanged) {
      updateFeatureCost(feature);
      changed = true;
    }
  }
  return changed;
}

function savedLegacyArtifactFeatureIds(saved) {
  if (!saved || typeof saved !== "object") return new Set();
  if (!Array.isArray(saved.features)) return new Set();
  return new Set(
    saved.features
      .filter(isLegacyArtifactFolder)
      .map((feature) => String(feature.id ?? ""))
      .filter(Boolean),
  );
}

async function commitMigratedArtifactFolders(featureIds) {
  if (!(featureIds instanceof Set) || !featureIds.size) return false;
  let changed = false;
  for (const feature of state.features) {
    if (!featureIds.has(feature.id)) continue;
    const commit = await commitFeatureWorkspace(
      feature,
      `Move artifacts into workspace branch: ${feature.name}`,
    );
    if (!commit.changed) continue;
    feature.headCommit = commit.sha;
    feature.stepCommits = {
      ...(feature.stepCommits ?? {}),
      [String(feature.step)]: commit.sha,
    };
    feature.artifacts.forEach((artifact) => {
      artifact.commitSha = commit.sha;
    });
    changed = true;
  }
  return changed;
}

async function backfillMissingRestorePoints() {
  let changed = false;
  for (const feature of state.features) {
    if (feature.headCommit && feature.stepCommits?.["0"]) continue;
    await saveFeatureFiles(feature);
    const commit = await commitFeatureWorkspace(
      feature,
      `Create restore baseline: ${feature.name}`,
    );
    feature.headCommit = commit.sha;
    feature.stepCommits = {
      ...(feature.stepCommits ?? {}),
      "0": commit.sha,
    };
    feature.artifacts.forEach((artifact) => {
      if (!artifact.commitSha) artifact.commitSha = commit.sha;
      const step = String(artifact.availableAtStep ?? 0);
      if (!feature.stepCommits[step]) feature.stepCommits[step] = commit.sha;
    });
    changed = true;
  }
  return changed;
}

function savedFeatureMetadataNeedsRewrite(saved) {
  if (!saved || typeof saved !== "object") return false;
  if (!Array.isArray(saved.features)) return false;
  return saved.features.some(
    (feature) =>
      feature &&
      typeof feature === "object" &&
      ("prompt" in feature ||
        typeof feature.artifactFolder !== "string" ||
        feature.artifactFolder === feature.workspace ||
        isLegacyArtifactFolder(feature) ||
        artifactsNeedCreationMetadata(feature.artifacts)),
  );
}

function artifactsNeedCreationMetadata(artifacts) {
  return (
    Array.isArray(artifacts) &&
    artifacts.some((artifact) => artifact && typeof artifact === "object" && !artifact.createdAt)
  );
}

function isLegacyArtifactFolder(feature) {
  if (!feature || typeof feature !== "object") return false;
  const slug = String(feature.slug ?? slugify(feature.name ?? feature.title ?? "feature"));
  const branch = String(feature.branch ?? `feature/${slug}`);
  const artifactFolder = String(feature.artifactFolder ?? "");
  return legacyBranchArtifactFolders(branch, slug).includes(artifactFolder);
}

function savedTimestampsNeedRewrite(saved) {
  if (!saved || typeof saved !== "object") return false;
  if (!Array.isArray(saved.features)) return false;
  return saved.features.some((feature) => {
    if (!feature || typeof feature !== "object") return false;
    if (timestampNeedsRewrite(feature.updated)) return true;
    if (Array.isArray(feature.artifacts)) {
      if (feature.artifacts.some((artifact) => timestampNeedsRewrite(artifact?.updated))) return true;
    }
    if (Array.isArray(feature.runs)) {
      return feature.runs.some((run) => {
        if (timestampNeedsRewrite(run?.startedAt) || timestampNeedsRewrite(run?.finishedAt)) return true;
        return Array.isArray(run?.events) && run.events.some((event) => timestampNeedsRewrite(event?.timestamp));
      });
    }
    return false;
  });
}

function timestampNeedsRewrite(value) {
  return typeof value === "string" && value !== formatDateTime(value);
}

function normalizeFeature(feature) {
  const slug = String(feature.slug ?? slugify(feature.name ?? feature.title ?? "feature"));
  const branch = String(feature.branch ?? `feature/${slug}`);
  const workspace = String(feature.workspace ?? branchWorkspaceFolder(branch, slug));
  const storedArtifactFolder = String(feature.artifactFolder ?? branchArtifactFolder(branch, slug));
  const artifactFolder =
    storedArtifactFolder === workspace ||
    isLegacyArtifactFolder({
      ...feature,
      slug,
      branch,
      workspace,
      artifactFolder: storedArtifactFolder,
    })
      ? branchArtifactFolder(branch, slug)
      : storedArtifactFolder;
  const runs = Array.isArray(feature.runs) ? feature.runs.map(normalizeRun) : [];
  return {
    id: String(feature.id),
    name: String(feature.name ?? feature.title ?? "Untitled feature"),
    slug,
    branch,
    workspace,
    artifactFolder,
    step: clampStep(feature.step),
    updated: formatDateTime(feature.updated || undefined),
    activeRunId: feature.activeRunId ?? null,
    environmentUrl:
      typeof feature.environmentUrl === "string" ? feature.environmentUrl : null,
    cost: feature.cost ?? null,
    headCommit: normalizeCommit(feature.headCommit),
    stepCommits: normalizeStepCommits(feature.stepCommits),
    restoreHistory: Array.isArray(feature.restoreHistory)
      ? feature.restoreHistory.map(normalizeRestoreEvent)
      : [],
    artifacts: normalizeArtifacts(feature.artifacts, artifactFolder, runs),
    runs,
  };
}

function normalizeCommit(value) {
  const commit = String(value ?? "").trim();
  return /^[0-9a-f]{7,40}$/i.test(commit) ? commit : null;
}

function normalizeStepCommits(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([step, commit]) => [String(clampStep(step)), normalizeCommit(commit)])
      .filter(([, commit]) => commit),
  );
}

function normalizeRestoreEvent(event) {
  if (!event || typeof event !== "object") return event;
  return {
    ...event,
    createdAt: event.createdAt ? formatDateTime(event.createdAt) : formatDateTime(),
    commitSha: normalizeCommit(event.commitSha),
    previousCommit: normalizeCommit(event.previousCommit),
  };
}

function normalizeRun(run) {
  const { fileBaseline, ...publicRun } = run;
  return {
    ...publicRun,
    startedAt: run.startedAt ? formatDateTime(run.startedAt) : null,
    finishedAt: run.finishedAt ? formatDateTime(run.finishedAt) : null,
    logSizeBytes: storedRunLogSize(run),
    events: Array.isArray(run.events)
      ? run.events.slice(-RUN_LOG_PREVIEW_LINE_LIMIT).map(normalizeRunEvent)
      : [],
  };
}

function normalizeRunEvent(event) {
  return {
    ...event,
    timestamp: event.timestamp ? formatDateTime(event.timestamp) : formatDateTime(),
  };
}

function storedRunLogSize(run) {
  const storedSize = Number(run?.logSizeBytes) || 0;
  if (!run?.id) return storedSize;
  try {
    return fs.statSync(path.join(RUN_LOG_ROOT, `${run.id}.log`)).size;
  } catch (error) {
    if (error.code === "ENOENT") return storedSize;
    throw error;
  }
}

function inferArtifactCreatedAt(artifact, runs) {
  if (artifact.createdAt) return formatDateTime(artifact.createdAt);
  if ((artifact.availableAtStep ?? 0) === 0) return "1970-01-01 00:00:00";
  const producingRun = runs.find(
    (run) => run.artifact === artifact.name || run.step === artifact.availableAtStep,
  );
  return producingRun?.finishedAt || producingRun?.startedAt || formatDateTime(artifact.updated);
}

function normalizeArtifacts(artifacts, artifactFolder, runs = []) {
  if (!Array.isArray(artifacts)) return [];
  return artifacts.map((artifact) => {
    if (!artifact || typeof artifact !== "object") return artifact;
    const name = String(artifact.name ?? "");
    if (!name) return artifact;
    return {
      ...artifact,
      name,
      path: `${artifactFolder}/${name}`,
      createdAt: inferArtifactCreatedAt(artifact, runs),
      updated: artifact.updated ? formatDateTime(artifact.updated) : formatDateTime(),
    };
  });
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
      artifactFolder: getFeatureArtifactFolder(feature),
      workspaceArtifactFolder: getFeatureWorkspaceArtifactFolder(feature),
      activeRunId: feature.activeRunId,
    })),
    validation: validateRepository(),
  };
}

module.exports = {
  clampStep,
  configureState,
  ensureStorage,
  normalizeFeature,
  publicState,
  saveState,
  slugify,
  state,
};
