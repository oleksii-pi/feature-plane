const path = require("node:path");
const { loadSdlcConfig } = require("../sdlc");
const { ROOT } = require("./config");
const { getFeatureWorkspaceFolderPath } = require("./feature-artifacts");
const { formatDateTime } = require("./time");

const FALLBACK_SDLC = {
  source: "fallback",
  createdAt: "1970-01-01 00:00:00",
  agents: [],
  workflow: [
    { state: "draft", artifact: "prompt.md" },
    { state: "done" },
  ],
};

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function snapshotSdlcFromConfig(sdlcConfig, source) {
  return {
    source,
    createdAt: formatDateTime(),
    agents: cloneJson(sdlcConfig.agents ?? []),
    workflow: cloneJson(sdlcConfig.workflow),
  };
}

function loadSdlcSnapshot(rootDir, source = "SDLC.yaml") {
  return snapshotSdlcFromConfig(loadSdlcConfig(rootDir), source);
}

function loadRepositorySdlcSnapshot() {
  return loadSdlcSnapshot(ROOT, "SDLC.yaml");
}

function loadFeatureSdlcSnapshot(feature) {
  const workspace = getFeatureWorkspaceFolderPath(feature);
  const relative = path.relative(ROOT, path.join(workspace, "SDLC.yaml"));
  return loadSdlcSnapshot(workspace, relative || "SDLC.yaml");
}

function normalizeSdlcSnapshot(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.workflow) || !value.workflow.length) {
    return cloneJson(FALLBACK_SDLC);
  }
  const workflow = value.workflow.map(normalizeWorkflowStep).filter(Boolean);
  if (!workflow.length) return cloneJson(FALLBACK_SDLC);
  return {
    source: String(value.source ?? "SDLC.yaml"),
    createdAt: value.createdAt ? formatDateTime(value.createdAt) : formatDateTime(),
    agents: Array.isArray(value.agents) ? value.agents.map((agent) => String(agent)) : [],
    workflow,
  };
}

function normalizeWorkflowStep(step) {
  if (!step || typeof step !== "object") return null;
  const normalized = {
    state: String(step.state ?? ""),
  };
  if (step.agent) normalized.agent = String(step.agent);
  if (step.artifact) normalized.artifact = String(step.artifact);
  return normalized.state ? normalized : null;
}

function featureSdlc(feature) {
  return normalizeSdlcSnapshot(feature?.sdlc);
}

function featureWorkflow(feature) {
  return featureSdlc(feature).workflow;
}

function featureStep(feature, index = feature?.step) {
  return featureWorkflow(feature)[Number(index)] ?? null;
}

function clampFeatureStep(feature, value) {
  const workflow = featureWorkflow(feature);
  return Math.max(0, Math.min(workflow.length - 1, Number(value) || 0));
}

module.exports = {
  clampFeatureStep,
  featureSdlc,
  featureStep,
  featureWorkflow,
  normalizeSdlcSnapshot,
  loadFeatureSdlcSnapshot,
  loadRepositorySdlcSnapshot,
  loadSdlcSnapshot,
};
