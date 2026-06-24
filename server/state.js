const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  FEATURE_ROOT,
  FEATURES_HOME,
  LEGACY_FEATURE_ROOTS,
  ROOT,
  STATE_FILE,
  workflow,
} = require("./config");
const { addEvent, isVerboseRunEvent } = require("./run-events");

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

function rewriteLegacyFeatureState(saved) {
  if (!saved || typeof saved !== "object") return;
  if (!Array.isArray(saved.features)) return;
  saved.features = saved.features.map(rewriteLegacyFeaturePaths);
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

module.exports = {
  clampStep,
  configureState,
  ensureStorage,
  normalizeFeature,
  publicState,
  rewriteLegacyWorkspacePath,
  saveState,
  slugify,
  state,
};
