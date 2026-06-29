export const STORAGE_KEY = "control-plane-poc-ui-state";
export const TERMINAL_RUN_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);
export const RUN_LOG_PREVIEW_LINE_LIMIT = 20;

export const state = {
  workflow: [],
  features: [],
  workspaces: [],
  selectedFeatureId: null,
  selectedStepIndex: 0,
  selectedArtifactIndex: null,
  searchTerm: "",
  featuresPanelHidden: false,
  workflowVisible: false,
  validation: null,
  eventSources: new Map(),
  runStreamRenderPending: false,
  runDurationTimer: null,
  pendingArtifactSaveCard: null,
  pendingRevertTarget: null,
  environmentPanelOpen: false,
  environmentPanelFeatureId: null,
  environmentCommands: [],
  environmentCommandsLoading: false,
  environmentCommandsError: "",
};

export const localState = {
  load() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
    } catch {
      return {};
    }
  },
  save(patch = {}) {
    const current = this.load();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...patch }));
  },
};

export function selectedFeature() {
  return (
    state.features.find((feature) => feature.id === state.selectedFeatureId) ??
    null
  );
}

export function selectedStep() {
  return state.workflow[state.selectedStepIndex] ?? null;
}

export function isAgentStep(step) {
  return Boolean(step?.agent);
}

export function hasSuccessfulRunForStep(feature, stepIndex) {
  return Boolean(
    feature?.runs?.some(
      (run) => run.step === stepIndex && run.status === "succeeded",
    ),
  );
}

export function currentAgentStepRequiresRun(feature) {
  return Boolean(
    feature &&
    isAgentStep(state.workflow[feature.step]) &&
    !hasSuccessfulRunForStep(feature, feature.step),
  );
}

export function viewUrl(featureId) {
  const url = new URL(window.location.href);
  if (featureId) url.searchParams.set("featureId", featureId);
  url.searchParams.delete("step");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function setView(featureId, stepIndex, { replace = false } = {}) {
  if (state.environmentPanelFeatureId && state.environmentPanelFeatureId !== featureId) {
    state.environmentPanelOpen = false;
    state.environmentPanelFeatureId = null;
    state.environmentCommands = [];
    state.environmentCommandsError = "";
  }
  state.selectedFeatureId = featureId;
  state.selectedStepIndex = stepIndex;
  state.selectedArtifactIndex = null;
  localState.save({
    selectedFeatureId: state.selectedFeatureId,
    selectedStepIndex: state.selectedStepIndex,
  });
  if (!featureId || !state.workflow[stepIndex]) return;
  const method = replace ? "replaceState" : "pushState";
  window.history[method](null, "", viewUrl(featureId));
}

export function restoreViewFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const saved = localState.load();
  const feature =
    state.features.find((item) => item.id === params.get("featureId")) ??
    state.features.find((item) => item.id === saved.selectedFeatureId) ??
    state.features[0] ??
    null;

  state.selectedFeatureId = feature?.id ?? null;
  state.selectedArtifactIndex = null;
  if (!feature) {
    state.selectedStepIndex = 0;
    return;
  }

  const savedStep = Number.isInteger(saved.selectedStepIndex)
    ? saved.selectedStepIndex
    : feature.step;
  state.selectedStepIndex = Math.min(savedStep, feature.step);

  if (params.has("step")) {
    window.history.replaceState(null, "", viewUrl(feature.id));
  }
}

export function displayStep(feature) {
  if (!feature) return "";
  const step = state.workflow[feature.step];
  if (!step) return "";
  if (feature.activeRunId) {
    const run = feature.runs.find((item) => item.id === feature.activeRunId);
    if (run && !TERMINAL_RUN_STATUSES.has(run.status)) {
      return `Agent Run: ${step.agent}`;
    }
  }
  return step.state;
}

export function latestRun(feature) {
  return feature?.runs?.at(-1) ?? null;
}

export function findRunById(runId) {
  for (const feature of state.features) {
    const run = feature.runs?.find((item) => item.id === runId);
    if (run) return run;
  }
  return null;
}

export function latestCost(feature) {
  return feature?.cost ?? latestRun(feature)?.cost ?? "TBD";
}
