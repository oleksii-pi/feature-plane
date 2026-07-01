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
  artifactDraftKey,
  currentAgentStepRequiresRun,
  isAgentStep,
  localState,
  persistArtifactDraft,
  removeArtifactDraft,
  selectedFeature,
  setView,
  stepForFeature,
  state,
} from "./state.js";

export { restoreStateFromClipboard, saveStateToClipboard };

function waitForPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

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
  elements.mergeMainFeatureButton.disabled = Boolean(feature.activeRunId);
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

export async function openFeatureWorkspaceFolder() {
  closeMenus();
  const feature = selectedFeature();
  if (!feature) return;
  const result = await api(`/features/${feature.id}/workspace-folder`, {
    method: "POST",
  });
  showToast(result.message ?? "Feature workspace folder opened");
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
  const changeRequest = Boolean(target.changeRequest);
  state.pendingRevertTarget = {
    ...target,
    featureId: feature.id,
  };
  elements.revertDialogEyebrow.textContent = changeRequest
    ? "Change request"
    : "Hard reset";
  elements.revertDialogEyebrow.classList.toggle("danger-text", !changeRequest);
  elements.revertTargetName.textContent = target.label ?? "this state";
  elements.revertDialogTitle.textContent = changeRequest
    ? "Add change request?"
    : rerun
    ? "Rerun agent step?"
    : "Revert to state?";
  elements.revertDialogCopy.replaceChildren(
    changeRequest
      ? "This will create a change request for "
      : rerun
      ? "This will reset the feature workspace and branch to before "
      : "This will reset the feature workspace and branch to ",
    elements.revertTargetName,
    changeRequest
      ? ", preserve the current branch and run history, then queue that agent again."
      : rerun
      ? ", remove artifacts and runs from this step onward, then queue the agent again."
      : ". Files not present in that commit will be removed.",
  );
  elements.revertTargetDetail.textContent =
    changeRequest
      ? "No reset will be performed. Existing artifacts and runs stay available."
      : target.detail ??
        "The feature workspace will be hard reset to the selected commit.";
  elements.revertConfirmLabel.textContent = changeRequest
    ? "I understand this will append a new agent run without reverting or deleting existing work."
    : rerun
    ? "I understand this will discard this agent run and later workflow work, then queue a new run."
    : "I understand this will run a hard reset and clean the feature workspace.";
  elements.confirmRevertButton.textContent = changeRequest
    ? "Add change request"
    : rerun
    ? "Rerun"
    : "Revert to state";
  elements.confirmRevertButton.classList.toggle("danger-button", !changeRequest);
  elements.confirmRevertButton.classList.toggle("primary-button", changeRequest);
  elements.revertReasonLabel.textContent = changeRequest
    ? "Change request"
    : "Reason comment";
  elements.revertReasonInput.value = "";
  elements.revertReasonInput.required = changeRequest;
  elements.revertReasonInput.placeholder = changeRequest
    ? "Describe what should be fixed or changed before rerunning this agent."
    : "Optional";
  elements.revertConfirmCheckbox.checked = false;
  elements.confirmRevertButton.disabled = true;
  elements.revertDialog.showModal();
  (changeRequest ? elements.revertReasonInput : elements.revertConfirmCheckbox).focus();
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
  if (target.changeRequest) {
    const result = await api(`/features/${target.featureId}/change-requests`, {
      method: "POST",
      body: JSON.stringify({
        runId: target.runId,
        step: target.step,
        content: elements.revertReasonInput.value.trim(),
      }),
    });
    closeRevertDialog();
    await loadState({ preserveView: true });
    const updated = state.features.find((feature) => feature.id === target.featureId);
    if (updated) {
      setView(updated.id, updated.step, { replace: true });
      render();
    }
    await waitForPaint();
    await api(`/features/${target.featureId}/runs`, {
      method: "POST",
      body: JSON.stringify({
        step: result.target?.step ?? target.step,
        changeRequestArtifact: result.changeRequestArtifact?.name,
      }),
    });
    await loadState({ preserveView: true });
    const rerunFeature = state.features.find((feature) => feature.id === target.featureId);
    if (rerunFeature) {
      setView(rerunFeature.id, rerunFeature.step, { replace: true });
      render();
    }
    showToast("Change request added and agent rerun queued");
    return;
  }

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

function artifactPreviewValue(preview) {
  return preview?.innerText ?? preview?.textContent ?? "";
}

function artifactContextFromCard(card, { createDraft = true } = {}) {
  const feature = selectedFeature();
  const sourceIndex = Number(card.dataset.sourceIndex);
  const artifact = feature?.artifacts?.[sourceIndex];
  if (!feature || !artifact || !Number.isInteger(sourceIndex)) return null;

  const key = artifactDraftKey(feature.id, artifact.name);
  let draft = state.artifactDrafts.get(key);
  if (!draft && createDraft) {
    draft = {
      key,
      featureId: feature.id,
      artifactName: artifact.name,
      content: artifact.content ?? "",
      lastSavedContent: artifact.content ?? "",
      lastSavedUpdated: artifact.updated,
      updated: artifact.updated,
      editing: false,
    };
    state.artifactDrafts.set(key, draft);
  }
  if (!draft) return null;
  draft.sourceIndex = sourceIndex;
  return { feature, sourceIndex, artifact, draft };
}

function updateLocalArtifactFromDraft({ feature, artifact, draft }) {
  const timestamp = currentDateTime();
  artifact.content = draft.content;
  artifact.updated = timestamp;
  feature.updated = timestamp;
  draft.updated = timestamp;
}

export function updateArtifactDraftFromCard(card) {
  const context = artifactContextFromCard(card);
  const preview = card.querySelector(".artifact-preview");
  if (!context || !preview) return null;
  context.draft.content = artifactPreviewValue(preview);
  context.draft.editing = true;
  updateLocalArtifactFromDraft(context);
  persistArtifactDraft(context.draft);
  return context;
}

export function beginArtifactEdit(card) {
  const context = artifactContextFromCard(card);
  if (!context) return null;
  context.draft.editing = true;
  context.artifact.content = context.draft.content;
  persistArtifactDraft(context.draft);
  return context;
}

export function cancelArtifactEdit(card) {
  const context = artifactContextFromCard(card);
  if (!context) return;
  context.artifact.content = context.draft.lastSavedContent ?? "";
  context.artifact.updated = context.draft.lastSavedUpdated || context.artifact.updated;
  removeArtifactDraft(context.draft.key);
}

export async function updateArtifact(card, { discardNextSteps = false } = {}) {
  const context = updateArtifactDraftFromCard(card);
  if (!context) return;
  const artifactName = context.artifact.name ?? "Artifact";
  const content = context.draft.content;
  await api(`/features/${context.feature.id}/artifacts/${context.sourceIndex}`, {
    method: "PATCH",
    body: JSON.stringify({ content, discardNextSteps }),
  });
  removeArtifactDraft(context.draft.key);
  await loadState({ preserveView: true });
  const suffix = discardNextSteps ? " and next steps discarded" : "";
  showToast(`${artifactName} saved${suffix}`);
}
