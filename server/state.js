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
} = require("./feature-artifacts");
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
    if (Array.isArray(saved.features)) state.features = saved.features.map(normalizeFeature);
    const repricedRuns = await repriceCompletedRuns();
    const needsRewrite =
      repricedRuns ||
      savedFeatureMetadataNeedsRewrite(saved) ||
      savedTimestampsNeedRewrite(saved);
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
        isLegacyNestedArtifactFolder(feature)),
  );
}

function isLegacyNestedArtifactFolder(feature) {
  if (!feature || typeof feature !== "object") return false;
  const slug = String(feature.slug ?? slugify(feature.name ?? feature.title ?? "feature"));
  const branch = String(feature.branch ?? `feature/${slug}`);
  const workspace = String(feature.workspace ?? branchWorkspaceFolder(branch, slug));
  const artifactFolder = String(feature.artifactFolder ?? "");
  return artifactFolder === `${workspace}/${branch}`;
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
    storedArtifactFolder === workspace || storedArtifactFolder === `${workspace}/${branch}`
      ? branchArtifactFolder(branch, slug)
      : storedArtifactFolder;
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
    cost: feature.cost ?? null,
    artifacts: normalizeArtifacts(feature.artifacts, artifactFolder),
    runs: Array.isArray(feature.runs) ? feature.runs.map(normalizeRun) : [],
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

function normalizeArtifacts(artifacts, artifactFolder) {
  if (!Array.isArray(artifacts)) return [];
  return artifacts.map((artifact) => {
    if (!artifact || typeof artifact !== "object") return artifact;
    const name = String(artifact.name ?? "");
    if (!name) return artifact;
    return {
      ...artifact,
      name,
      path: `${artifactFolder}/${name}`,
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
