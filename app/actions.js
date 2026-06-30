import {
  api,
  loadState,
  restoreStateFromClipboard,
  saveStateToClipboard,
} from "./api.js";
import { closeMenus, elements, showToast } from "./dom.js";
import { currentDateTime } from "./format.js";
import { render, renderEnvironmentPanel } from "./render.js";
import {
  currentAgentStepRequiresRun,
  isAgentStep,
  localState,
  selectedFeature,
  setView,
  stepForFeature,
  state,
} from "./state.js";

export { restoreStateFromClipboard, saveStateToClipboard };

export async function moveToStep(feature, nextStep) {
  await api(`/features/${feature.id}/steps/${nextStep}`, { method: "PATCH" });
  await loadState({ preserveView: true });
  const updated = selectedFeature();
  setView(updated.id, Math.min(nextStep, updated.step));
  const step = stepForFeature(updated, nextStep);
  showToast(
    isAgentStep(step)
      ? `${step.agent} queued`
      : `Moved to ${step?.state ?? "next step"}`,
  );
}

export async function runCurrentStep(feature) {
  if (!currentAgentStepRequiresRun(feature)) return;
  await api(`/features/${feature.id}/runs`, { method: "POST" });
  await loadState({ preserveView: true });
  const updated = selectedFeature();
  if (updated) setView(updated.id, updated.step);
  showToast(`${stepForFeature(feature)?.agent ?? "Agent"} queued`);
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
  elements.resetFeatureButton.disabled = Boolean(feature.activeRunId);
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

export async function openEnvironmentPanel() {
  closeMenus();
  const feature = selectedFeature();
  if (!feature) return;
  state.environmentPanelOpen = true;
  state.environmentPanelFeatureId = feature.id;
  state.environmentCommands = [];
  state.environmentCommandsError = "";
  state.environmentCommandsLoading = true;
  renderEnvironmentPanel();

  try {
    const payload = await api(`/features/${feature.id}/environment`);
    if (state.environmentPanelFeatureId !== feature.id) return;
    state.environmentCommands = payload.commands ?? [];
  } catch (error) {
    if (state.environmentPanelFeatureId !== feature.id) return;
    state.environmentCommandsError = error.message;
  } finally {
    if (state.environmentPanelFeatureId === feature.id) {
      state.environmentCommandsLoading = false;
      renderEnvironmentPanel();
      elements.environmentCommandList.focus();
    }
  }
}

export function closeEnvironmentPanel() {
  state.environmentPanelOpen = false;
  state.environmentCommandsLoading = false;
  state.environmentCommandsError = "";
  renderEnvironmentPanel();
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

function artifactStep(feature, sourceIndex) {
  const artifact = feature?.artifacts?.[sourceIndex];
  return artifact ? artifact.availableAtStep ?? 0 : null;
}

function featureHasLaterGeneratedWork(feature, editedStep) {
  return (
    (feature.artifacts ?? []).some(
      (artifact) => (artifact.availableAtStep ?? 0) > editedStep,
    ) || (feature.runs ?? []).some((run) => run.step > editedStep)
  );
}

export async function saveArtifactFromCard(card) {
  const feature = selectedFeature();
  const sourceIndex = Number(card.dataset.sourceIndex);
  const editedStep = artifactStep(feature, sourceIndex);
  if (
    feature &&
    Number.isInteger(sourceIndex) &&
    editedStep !== null &&
    featureHasLaterGeneratedWork(feature, editedStep)
  ) {
    openArtifactSaveDialog(card);
    return;
  }

  await updateArtifact(card);
}

export function openRevertDialog(target) {
  closeMenus();
  const feature = selectedFeature();
  if (!feature || feature.activeRunId) return;
  const rerun = Boolean(target.rerun);
  state.pendingRevertTarget = {
    ...target,
    featureId: feature.id,
  };
  elements.revertTargetName.textContent = target.label ?? "this state";
  elements.revertDialogTitle.textContent = rerun
    ? "Rerun agent step?"
    : "Revert to state?";
  elements.revertDialogCopy.replaceChildren(
    rerun
      ? "This will reset the feature workspace and branch to before "
      : "This will reset the feature workspace and branch to ",
    elements.revertTargetName,
    rerun
      ? ", remove artifacts and runs from this step onward, then queue the agent again."
      : ". Files not present in that commit will be removed.",
  );
  elements.revertTargetDetail.textContent =
    target.detail ??
    "The feature workspace will be hard reset to the selected commit.";
  elements.revertConfirmLabel.textContent = rerun
    ? "I understand this will discard this agent run and later workflow work, then queue a new run."
    : "I understand this will run a hard reset and clean the feature workspace.";
  elements.confirmRevertButton.textContent = rerun
    ? "Rerun"
    : "Revert to state";
  elements.revertReasonInput.value = "";
  elements.revertConfirmCheckbox.checked = false;
  elements.confirmRevertButton.disabled = true;
  elements.revertDialog.showModal();
  elements.revertConfirmCheckbox.focus();
}

export function closeRevertDialog() {
  state.pendingRevertTarget = null;
  if (elements.revertDialog.open) elements.revertDialog.close();
}

export async function savePendingArtifact({ discardNextSteps }) {
  const card = state.pendingArtifactSaveCard;
  closeArtifactSaveDialog();
  if (!card) return;
  await updateArtifact(card, { discardNextSteps });
}

export async function confirmPendingRevert() {
  const target = state.pendingRevertTarget;
  if (!target?.featureId || !elements.revertConfirmCheckbox.checked) return;
  const body = {
    confirmHardReset: true,
    reason: elements.revertReasonInput.value.trim(),
  };
  if (target.rerun) {
    body.rerun = true;
    body.step = target.step;
  } else if (target.kind === "run") body.runId = target.runId;
  else if (target.kind === "artifact") body.artifactIndex = target.artifactIndex;
  else body.step = target.step;

  const result = await api(`/features/${target.featureId}/revert`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  closeRevertDialog();
  await loadState({ preserveView: true });
  const updated = state.features.find((feature) => feature.id === target.featureId);
  if (updated) setView(updated.id, updated.step, { replace: true });
  const environmentMessage = result.restore?.environment?.message;
  const actionMessage = target.rerun ? "Agent rerun queued" : "State restored";
  showToast(environmentMessage ? `${actionMessage}. ${environmentMessage}` : actionMessage);
}

function featureHasNextStepEntries(feature, editedStep) {
  return (
    featureHasLaterGeneratedWork(feature, editedStep) ||
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
  const preview = card.querySelector(".artifact-preview");
  const value = preview?.innerText ?? preview?.textContent ?? "";
  if (!feature || !Number.isInteger(sourceIndex) || !value.trim()) return;
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
