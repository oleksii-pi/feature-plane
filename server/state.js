const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  FEATURE_ROOT,
  RUN_LOG_ROOT,
  STATE_FILE,
} = require("./config");
const { normalizeCommandHistory } = require("./command-history");
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
const {
  clampFeatureStep,
  featureWorkflow,
  loadFeatureSdlcSnapshot,
  normalizeSdlcSnapshot,
} = require("./workflow");

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
    const refreshedSdlc = refreshFeatureSdlcFromWorkspaces();
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
    if (needsRewrite || refreshedSdlc || migratedArtifactFolders) await saveState();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await saveState();
  }
  recoverInterruptedRuns();
}

function refreshFeatureSdlcFromWorkspace(feature) {
  try {
    const sdlc = loadFeatureSdlcSnapshot(feature);
    let changed = false;
    if (JSON.stringify(feature.sdlc) !== JSON.stringify(sdlc)) {
      feature.sdlc = sdlc;
      changed = true;
    }
    if (feature.sdlcError) {
      delete feature.sdlcError;
      changed = true;
    }
    return changed;
  } catch (error) {
    const message = error.message ?? String(error);
    if (feature.sdlcError === message) return false;
    feature.sdlcError = message;
    return true;
  }
}

function refreshFeatureSdlcFromWorkspaces() {
  let changed = false;
  for (const feature of state.features) {
    if (refreshFeatureSdlcFromWorkspace(feature)) changed = true;
  }
  return changed;
}

async function repriceCompletedRuns() {
  let changed = false;
  for (const feature of state.features) {
    let featureChanged = false;
    const beforeFeatureCost = feature.cost ?? null;
    for (const run of [...(feature.runs ?? []), ...(feature.archivedRuns ?? [])]) {
      if (!["succeeded", "failed", "cancelled"].includes(run.status)) continue;
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
    updateFeatureCost(feature);
    if (featureChanged || beforeFeatureCost !== (feature.cost ?? null)) {
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
        sdlcNeedsRewrite(feature.sdlc) ||
        !feature.createdAt ||
        !feature.statusChangedAt ||
        typeof feature.artifactFolder !== "string" ||
        feature.artifactFolder === feature.workspace ||
        isLegacyArtifactFolder(feature) ||
        artifactsNeedCreationMetadata(feature.artifacts)),
  );
}

function sdlcNeedsRewrite(sdlc) {
  if (!sdlc || typeof sdlc !== "object") return true;
  if (!Array.isArray(sdlc.workflow) || !sdlc.workflow.length) return true;
  if (timestampNeedsRewrite(sdlc.createdAt)) return true;
  return sdlc.workflow.some((step) => {
    if (!step || typeof step !== "object") return true;
    return !step.state;
  });
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
    if (timestampNeedsRewrite(feature.createdAt) || timestampNeedsRewrite(feature.statusChangedAt)) {
      return true;
    }
    if (timestampNeedsRewrite(feature.updated)) return true;
    if (Array.isArray(feature.artifacts)) {
      if (
        feature.artifacts.some(
          (artifact) =>
            timestampNeedsRewrite(artifact?.createdAt) ||
            timestampNeedsRewrite(artifact?.updated),
        )
      ) {
        return true;
      }
    }
    if (Array.isArray(feature.restoreHistory)) {
      if (feature.restoreHistory.some((event) => timestampNeedsRewrite(event?.createdAt))) {
        return true;
      }
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
  const archivedRuns = Array.isArray(feature.archivedRuns)
    ? feature.archivedRuns.map(normalizeRun)
    : [];
  const sdlc = normalizeSdlcSnapshot(feature.sdlc);
  const createdAt = inferFeatureCreatedAt(feature, runs, archivedRuns);
  const normalized = {
    id: String(feature.id),
    name: String(feature.name ?? feature.title ?? "Untitled feature"),
    slug,
    branch,
    workspace,
    artifactFolder,
    sdlc,
    step: 0,
    createdAt,
    statusChangedAt: inferFeatureStatusChangedAt(
      feature,
      createdAt,
      runs,
      archivedRuns,
    ),
    updated: formatDateTime(feature.updated || undefined),
    activeRunId: feature.activeRunId ?? null,
    environmentUrl:
      typeof feature.environmentUrl === "string" ? feature.environmentUrl : null,
    environmentCommands: normalizeCommandHistory(feature.environmentCommands),
    cost: feature.cost ?? null,
    headCommit: normalizeCommit(feature.headCommit),
    stepCommits: normalizeStepCommits(feature.stepCommits, sdlc.workflow.length),
    restoreHistory: Array.isArray(feature.restoreHistory)
      ? feature.restoreHistory.map(normalizeRestoreEvent)
      : [],
    artifacts: normalizeArtifacts(feature.artifacts, artifactFolder, runs),
    archivedRuns,
    runs,
  };
  normalized.step = clampFeatureStep(normalized, feature.step);
  return normalized;
}

function normalizeCommit(value) {
  const commit = String(value ?? "").trim();
  return /^[0-9a-f]{7,40}$/i.test(commit) ? commit : null;
}

function normalizeStepCommits(value, workflowLength) {
  if (!value || typeof value !== "object") return {};
  const lastStep = Math.max(0, Number(workflowLength) - 1);
  return Object.fromEntries(
    Object.entries(value)
      .map(([step, commit]) => [
        String(Math.max(0, Math.min(lastStep, Number(step) || 0))),
        normalizeCommit(commit),
      ])
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
  const { featureCost, fileBaseline, ...publicRun } = run;
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

function inferFeatureCreatedAt(feature, runs = [], archivedRuns = []) {
  const promptArtifact = Array.isArray(feature.artifacts)
    ? feature.artifacts.find((artifact) => artifact?.name === "prompt.md")
    : null;
  const timestamps = [
    feature.createdAt,
    promptArtifact?.createdAt,
    promptArtifact?.updated,
    feature.updated,
    ...artifactTimestamps(feature.artifacts),
    ...restoreEventTimestamps(feature.restoreHistory),
    ...runTimestamps(runs),
    ...runTimestamps(archivedRuns),
  ];
  return earliestTimestamp(timestamps) ?? formatDateTime();
}

function inferFeatureStatusChangedAt(
  feature,
  createdAt,
  runs = [],
  archivedRuns = [],
) {
  if (feature.statusChangedAt) return formatDateTime(feature.statusChangedAt);
  const currentStep = Math.max(0, Number(feature.step) || 0);
  const timestamps = [];

  if (currentStep === 0) timestamps.push(createdAt);

  for (const event of feature.restoreHistory ?? []) {
    if (Number(event?.targetStep) === currentStep) timestamps.push(event?.createdAt);
  }

  for (const run of [...runs, ...archivedRuns]) {
    if (run?.status !== "succeeded") continue;
    if ((Number(run.step) || 0) + 1 !== currentStep) continue;
    timestamps.push(run.finishedAt ?? run.startedAt);
  }

  if (currentStep > 0 && !timestamps.length) timestamps.push(feature.updated);
  return latestTimestamp(timestamps) ?? createdAt;
}

function artifactTimestamps(artifacts = []) {
  return artifacts.flatMap((artifact) => [artifact?.createdAt, artifact?.updated]);
}

function restoreEventTimestamps(events = []) {
  return events.map((event) => event?.createdAt);
}

function runTimestamps(runs = []) {
  return runs.flatMap((run) => [run?.startedAt, run?.finishedAt]);
}

function normalizedTimestamp(value) {
  const timestamp = formatDateTime(value);
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestamp)
    ? timestamp
    : null;
}

function earliestTimestamp(values) {
  return values
    .map(normalizedTimestamp)
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))[0] ?? null;
}

function latestTimestamp(values) {
  return values
    .map(normalizedTimestamp)
    .filter(Boolean)
    .sort((left, right) => right.localeCompare(left))[0] ?? null;
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
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function publicState() {
  return {
    workflow: [],
    features: state.features,
    workspaces: state.features.map((feature) => ({
      id: feature.slug,
      featureId: feature.id,
      path: feature.workspace,
      artifactFolder: getFeatureArtifactFolder(feature),
      workspaceArtifactFolder: getFeatureWorkspaceArtifactFolder(feature),
      activeRunId: feature.activeRunId,
      workflowLength: featureWorkflow(feature).length,
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
  refreshFeatureSdlcFromWorkspace,
  refreshFeatureSdlcFromWorkspaces,
  saveState,
  slugify,
  state,
};
