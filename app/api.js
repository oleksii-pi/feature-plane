import { elements, showToast } from "./dom.js";
import { render } from "./render.js";
import { syncRunStreams } from "./runs.js";
import {
  applyArtifactDrafts,
  loadArtifactDrafts,
  loadTimelineCardExpansion,
  localState,
  restoreViewFromUrl,
  selectedFeature,
  state,
} from "./state.js";

export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message ?? `Request failed: ${response.status}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

export async function loadState({ preserveView = true } = {}) {
  const nextState = await api("/state");
  loadArtifactDrafts();
  state.workflow = nextState.workflow;
  state.features = applyArtifactDrafts(nextState.features);
  state.workspaces = nextState.workspaces;
  state.validation = nextState.validation;

  const saved = localState.load();
  loadTimelineCardExpansion();
  state.featuresPanelHidden = Boolean(saved.featuresPanelHidden);
  state.workflowVisible = Boolean(saved.workflowVisible);
  state.searchTerm = saved.searchTerm ?? "";
  elements.featureSearch.value = state.searchTerm;

  if (preserveView && selectedFeature()) {
    state.selectedStepIndex = Math.min(
      state.selectedStepIndex,
      selectedFeature().step,
    );
  } else {
    restoreViewFromUrl();
  }
  syncRunStreams();
  render();
}

export function appExportState() {
  return {
    format: "control-plane-state",
    version: 1,
    features: state.features,
    workflow: state.workflow,
    ui: localState.load(),
  };
}

export async function saveStateToClipboard() {
  try {
    await navigator.clipboard.writeText(
      JSON.stringify(appExportState(), null, 2),
    );
    showToast("Application state copied to clipboard");
  } catch {
    showToast("Clipboard access was not available");
  }
}

export async function restoreStateFromClipboard() {
  try {
    const saved = JSON.parse(await navigator.clipboard.readText());
    if (
      saved?.format !== "control-plane-state" ||
      !Array.isArray(saved.features)
    ) {
      throw new Error("Invalid application state");
    }
    await api("/state", {
      method: "PUT",
      body: JSON.stringify({ features: saved.features }),
    });
    if (saved.ui && typeof saved.ui === "object") localState.save(saved.ui);
    await loadState({ preserveView: false });
    showToast("Application state restored");
  } catch {
    showToast("Clipboard does not contain valid application state");
  }
}
