import {
  api,
  loadState,
  restoreStateFromClipboard,
  saveStateToClipboard,
} from "./api.js";
import { closeMenus, elements, showToast } from "./dom.js";
import { currentDateTime } from "./format.js";
import { render } from "./render.js";
import {
  currentAgentStepRequiresRun,
  isAgentStep,
  localState,
  selectedFeature,
  setView,
  state,
} from "./state.js";

export { restoreStateFromClipboard, saveStateToClipboard };

export async function moveToStep(feature, nextStep) {
  await api(`/features/${feature.id}/steps/${nextStep}`, { method: "PATCH" });
  await loadState({ preserveView: true });
  const updated = selectedFeature();
  setView(updated.id, Math.min(nextStep, updated.step));
  showToast(
    isAgentStep(state.workflow[nextStep])
      ? `${state.workflow[nextStep].agent} queued`
      : `Moved to ${state.workflow[nextStep].state}`,
  );
}

export async function runCurrentStep(feature) {
  if (!currentAgentStepRequiresRun(feature)) return;
  await api(`/features/${feature.id}/runs`, { method: "POST" });
  await loadState({ preserveView: true });
  const updated = selectedFeature();
  if (updated) setView(updated.id, updated.step);
  showToast(`${state.workflow[feature.step].agent} queued`);
}

export function openFeatureDialog() {
  closeMenus();
  elements.form.reset();
  elements.dialog.showModal();
  elements.nameInput.focus();
}

export function openFeatureSettings() {
  closeMenus();
  const feature = selectedFeature();
  if (!feature) return;
  elements.settingsFeatureName.textContent = feature.name;
  elements.settingsFeatureName.hidden = false;
  elements.settingsFeatureNameInput.value = feature.name;
  elements.settingsFeatureNameInput.hidden = true;
  elements.editFeatureTitleButton.hidden = false;
  elements.branchInput.value = feature.branch;
  elements.settingsDialog.showModal();
  elements.branchInput.focus();
}

export function setFeaturesPanelHidden(hidden) {
  state.featuresPanelHidden = hidden;
  localState.save({ featuresPanelHidden: state.featuresPanelHidden });
  const button = document.querySelector("#hide-features-button");
  button.innerHTML = hidden ? "S<u>h</u>ow" : "<u>H</u>ide";
  button.setAttribute("aria-label", hidden ? "Show features" : "Hide features");
  closeMenus();
  render();
}

export function setWorkflowVisible(visible) {
  state.workflowVisible = visible;
  localState.save({ workflowVisible: state.workflowVisible });
  closeMenus();
  render();
}

export function openArtifactSaveDialog(card) {
  const sourceIndex = Number(card.dataset.sourceIndex);
  const feature = selectedFeature();
  if (!feature || !Number.isInteger(sourceIndex)) return;
  state.pendingArtifactSaveCard = card;
  elements.artifactSaveName.textContent =
    feature.artifacts[sourceIndex]?.name ?? "this artifact";
  elements.artifactSaveDialog.showModal();
  document.querySelector("#discard-next-steps-button").focus();
}

export function closeArtifactSaveDialog() {
  state.pendingArtifactSaveCard = null;
  if (elements.artifactSaveDialog.open) elements.artifactSaveDialog.close();
}

export async function savePendingArtifact({ discardNextSteps }) {
  const card = state.pendingArtifactSaveCard;
  closeArtifactSaveDialog();
  if (!card) return;
  await updateArtifact(card, { discardNextSteps });
}

function featureHasNextStepEntries(feature, editedStep) {
  return (
    feature.artifacts.some(
      (artifact) => (artifact.availableAtStep ?? 0) > editedStep,
    ) ||
    feature.runs.some((run) => run.step > editedStep) ||
    feature.step > editedStep
  );
}

async function ensureNextStepsDiscarded(featureId, editedStep) {
  const feature = state.features.find((item) => item.id === featureId);
  if (!feature || !featureHasNextStepEntries(feature, editedStep)) return;

  feature.artifacts = feature.artifacts.filter(
    (artifact) => (artifact.availableAtStep ?? 0) <= editedStep,
  );
  feature.runs = feature.runs.filter((run) => run.step <= editedStep);
  feature.step = Math.min(feature.step, editedStep);
  feature.activeRunId = null;
  feature.updated = currentDateTime();

  await api("/state", {
    method: "PUT",
    body: JSON.stringify({ features: state.features }),
  });
  await loadState({ preserveView: true });
}

export async function updateArtifact(card, { discardNextSteps = false } = {}) {
  const feature = selectedFeature();
  const sourceIndex = Number(card.dataset.sourceIndex);
  const value = card.querySelector(".artifact-editor").value.trim();
  if (!feature || !Number.isInteger(sourceIndex) || !value) return;
  const artifactName = feature.artifacts[sourceIndex]?.name ?? "Artifact";
  const editedStep = feature.artifacts[sourceIndex]?.availableAtStep ?? 0;
  await api(`/features/${feature.id}/artifacts/${sourceIndex}`, {
    method: "PATCH",
    body: JSON.stringify({ content: value, discardNextSteps }),
  });
  await loadState({ preserveView: true });
  if (discardNextSteps) await ensureNextStepsDiscarded(feature.id, editedStep);
  const suffix = discardNextSteps ? " and next steps discarded" : "";
  showToast(`${artifactName} saved${suffix}`);
}
