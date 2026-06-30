export const STORAGE_KEY = "control-plane-poc-ui-state";
export const ARTIFACT_DRAFT_STORAGE_KEY =
  "control-plane-poc-artifact-drafts";
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
  artifactDrafts: new Map(),
  timelineCardExpansion: {},
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

export function artifactDraftKey(featureId, artifactName) {
  return `${featureId}::${artifactName}`;
}

export function timelineCardKeyFromCard(card) {
  if (!card) return null;
  if (card.dataset.artifactKey) return card.dataset.artifactKey;
  if (card.dataset.runId) return `run:${card.dataset.runId}`;
  return null;
}

export function timelineCardKey(featureId, entry) {
  if (entry.kind === "run") return `run:${entry.run.id}`;
  return artifactDraftKey(featureId, entry.artifact.name);
}

function sanitizeTimelineCardExpansion(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, expanded]) => typeof expanded === "boolean"),
  );
}

export function isTimelineCardExpanded(
  featureId,
  entry,
  { editing = false } = {},
) {
  if (editing) return true;
  const key = timelineCardKey(featureId, entry);
  const saved = state.timelineCardExpansion[key];
  if (typeof saved === "boolean") return saved;
  if (entry.kind === "artifact") return true;
  return !TERMINAL_RUN_STATUSES.has(entry.run.status);
}

export function setTimelineCardExpandedByCard(card, expanded) {
  const key = timelineCardKeyFromCard(card);
  if (!key) return;
  state.timelineCardExpansion = {
    ...state.timelineCardExpansion,
    [key]: expanded,
  };
  localState.save({ timelineCardExpansion: state.timelineCardExpansion });
}

function readArtifactDraftEntries() {
  if (typeof localStorage === "undefined") return [];
  try {
    const stored = JSON.parse(
      localStorage.getItem(ARTIFACT_DRAFT_STORAGE_KEY),
    );
    if (!stored || typeof stored !== "object") return [];
    return Object.entries(stored).filter(([, draft]) => draft?.editing);
  } catch {
    return [];
  }
}

export function loadArtifactDrafts() {
  state.artifactDrafts = new Map(
    readArtifactDraftEntries().map(([key, draft]) => [
      key,
      {
        key,
        featureId: String(draft.featureId ?? ""),
        artifactName: String(draft.artifactName ?? ""),
        content: String(draft.content ?? ""),
        lastSavedContent: String(draft.lastSavedContent ?? ""),
        lastSavedUpdated: draft.lastSavedUpdated ?? "",
        updated: draft.updated ?? "",
        editing: true,
      },
    ]),
  );
}

export function saveArtifactDrafts() {
  if (typeof localStorage === "undefined") return;
  const entries = [...state.artifactDrafts].filter(([, draft]) => draft.editing);
  try {
    if (!entries.length) {
      localStorage.removeItem(ARTIFACT_DRAFT_STORAGE_KEY);
      return;
    }
    localStorage.setItem(
      ARTIFACT_DRAFT_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(entries)),
    );
  } catch {
    // Drafts still remain in memory for the current page session.
  }
}

export function persistArtifactDraft(draft) {
  state.artifactDrafts.set(draft.key, draft);
  saveArtifactDrafts();
}

export function removeArtifactDraft(key) {
  state.artifactDrafts.delete(key);
  saveArtifactDrafts();
}

export function applyArtifactDrafts(features) {
  if (!state.artifactDrafts.size) return features;

  const liveKeys = new Set();
  features.forEach((feature) => {
    (feature.artifacts ?? []).forEach((artifact) => {
      const key = artifactDraftKey(feature.id, artifact.name);
      liveKeys.add(key);
      const draft = state.artifactDrafts.get(key);
      if (!draft?.editing) return;
      artifact.content = draft.content;
      if (draft.updated) artifact.updated = draft.updated;
    });
  });

  let removed = false;
  state.artifactDrafts.forEach((_, key) => {
    if (liveKeys.has(key)) return;
    state.artifactDrafts.delete(key);
    removed = true;
  });
  if (removed) saveArtifactDrafts();

  return features;
}

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

export function loadTimelineCardExpansion() {
  const saved = localState.load();
  state.timelineCardExpansion = sanitizeTimelineCardExpansion(
    saved.timelineCardExpansion,
  );
}

export function selectedFeature() {
  return (
    state.features.find((feature) => feature.id === state.selectedFeatureId) ??
    null
  );
}

export function workflowForFeature(feature) {
  return Array.isArray(feature?.sdlc?.workflow) && feature.sdlc.workflow.length
    ? feature.sdlc.workflow
    : state.workflow;
}

export function stepForFeature(feature, stepIndex = feature?.step) {
  return workflowForFeature(feature)[Number(stepIndex)] ?? null;
}

export function selectedStep() {
  return stepForFeature(selectedFeature(), state.selectedStepIndex);
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
    isAgentStep(stepForFeature(feature)) &&
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
  if (
    state.environmentPanelFeatureId &&
    state.environmentPanelFeatureId !== featureId
  ) {
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
  const feature = state.features.find((item) => item.id === featureId);
  if (!featureId || !workflowForFeature(feature)[stepIndex]) return;
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
  const step = stepForFeature(feature);
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
  return feature?.cost ?? latestRun(feature)?.cost ?? "";
}
