import {
  api,
  loadState,
  restoreStateFromClipboard,
  saveStateToClipboard,
} from "./api.js";
import {
  closeArtifactSaveDialog,
  closeRevertDialog,
  beginArtifactEdit,
  cancelArtifactEdit,
  confirmPendingRevert,
  closeEnvironmentPanel,
  moveToStep,
  openEnvironmentPanel,
  openFeatureDialog,
  openFeatureSettings,
  openRevertDialog,
  runCurrentStep,
  saveArtifactFromCard,
  savePendingArtifact,
  setFeaturesPanelHidden,
  setWorkflowVisible,
  updateArtifactDraftFromCard,
} from "./actions.js";
import {
  closeMenus,
  elements,
  openMenu,
  openMenuByShortcut,
  openMenuElement,
  showToast,
} from "./dom.js";
import {
  artifactIndexForStep,
  entriesForFeature,
  render,
  renderArtifacts,
  renderDetails,
  renderFeatureList,
  renderRepositoryWorkflow,
  renderValidation,
} from "./render.js";
import {
  currentAgentStepRequiresRun,
  localState,
  restoreViewFromUrl,
  selectedFeature,
  setView,
  setTimelineCardExpandedByCard,
  state,
  workflowForFeature,
} from "./state.js";

function clampDialogPosition(dialog, left, top) {
  const margin = 10;
  const width = dialog.offsetWidth;
  const height = dialog.offsetHeight;
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  const maxTop = Math.max(margin, window.innerHeight - height - margin);

  return {
    left: Math.min(Math.max(left, margin), maxLeft),
    top: Math.min(Math.max(top, margin), maxTop),
  };
}

function centerDialog(dialog) {
  const next = clampDialogPosition(
    dialog,
    (window.innerWidth - dialog.offsetWidth) / 2,
    (window.innerHeight - dialog.offsetHeight) / 2,
  );

  dialog.style.left = `${next.left}px`;
  dialog.style.top = `${next.top}px`;
}

function bindMovableDialog(dialog, handle) {
  let drag = null;

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button")) return;
    const rect = dialog.getBoundingClientRect();
    drag = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  handle.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const next = clampDialogPosition(
      dialog,
      event.clientX - drag.offsetX,
      event.clientY - drag.offsetY,
    );
    dialog.style.left = `${next.left}px`;
    dialog.style.top = `${next.top}px`;
  });

  handle.addEventListener("pointerup", (event) => {
    if (!drag) return;
    drag = null;
    handle.releasePointerCapture(event.pointerId);
  });

  handle.addEventListener("pointercancel", () => {
    drag = null;
  });

  window.addEventListener("resize", () => {
    if (dialog.open) centerDialog(dialog);
  });
}

function isTextEntryTarget(target) {
  return target.closest("input, textarea, select, [contenteditable='true']");
}

function hasOpenModalDialog() {
  return Boolean(document.querySelector("dialog[open]"));
}

function visibleFeatures() {
  const term = state.searchTerm.toLowerCase();
  return state.features.filter((feature) =>
    feature.name.toLowerCase().includes(term),
  );
}

function isFeaturePanelTarget(target) {
  return Boolean(target?.closest(".features-panel"));
}

function scrollFeatureCardIntoView(featureId) {
  const card = Array.from(
    elements.featureList.querySelectorAll("[data-feature-id]"),
  ).find((item) => item.dataset.featureId === featureId);
  card?.scrollIntoView({ block: "nearest" });
}

function focusFeatureCard(featureId) {
  const card = Array.from(
    elements.featureList.querySelectorAll("[data-feature-id]"),
  ).find((item) => item.dataset.featureId === featureId);
  card?.focus({ preventScroll: true });
}

function selectFeatureFromList(direction, { focusSelected = false } = {}) {
  const features = visibleFeatures();
  if (!features.length) return;

  const currentIndex = features.findIndex(
    (feature) => feature.id === state.selectedFeatureId,
  );
  const baseIndex = currentIndex >= 0 ? currentIndex : direction < 0 ? features.length : -1;
  const nextFeature = features[baseIndex + direction];
  if (!nextFeature) return;

  setView(nextFeature.id, nextFeature.step);
  render();
  if (focusSelected) focusFeatureCard(nextFeature.id);
  requestAnimationFrame(() => {
    scrollFeatureCardIntoView(nextFeature.id);
  });
}

async function reorderSelectedFeature(direction, { focusSelected = false } = {}) {
  const currentIndex = state.features.findIndex(
    (feature) => feature.id === state.selectedFeatureId,
  );
  if (currentIndex < 0) return;

  const nextIndex = currentIndex + direction;
  if (nextIndex < 0 || nextIndex >= state.features.length) return;

  const nextFeatures = state.features.slice();
  [nextFeatures[currentIndex], nextFeatures[nextIndex]] = [
    nextFeatures[nextIndex],
    nextFeatures[currentIndex],
  ];

  await api("/state", {
    method: "PUT",
    body: JSON.stringify({ features: nextFeatures }),
  });
  await loadState({ preserveView: true });
  if (focusSelected) focusFeatureCard(state.selectedFeatureId);
  requestAnimationFrame(() => {
    scrollFeatureCardIntoView(state.selectedFeatureId);
  });
}

function setFeatureTitleEditMode(editing) {
  elements.settingsFeatureName.hidden = editing;
  elements.settingsFeatureNameInput.hidden = !editing;
  elements.editFeatureTitleButton.hidden = editing;
  if (!editing) return;
  const length = elements.settingsFeatureNameInput.value.length;
  elements.settingsFeatureNameInput.focus();
  elements.settingsFeatureNameInput.setSelectionRange(length, length);
}

function toggleMenuFromButton(event, button) {
  const menu = button.closest("[data-menu]");
  if (!menu) return;
  event.preventDefault();
  event.stopPropagation();
  const popover = menu.querySelector(".menu-popover");
  const opening = popover.hidden;
  closeMenus(opening ? menu : null);
  if (opening) openMenu(menu);
}

function revertTargetFromButton(button) {
  const kind = button.dataset.revertKind;
  const target = {
    kind,
    label: button.dataset.revertLabel,
    detail: button.dataset.revertDetail,
    rerun: button.dataset.revertRerun === "true",
    changeRequest: button.classList.contains("change-request-button"),
  };
  if (button.dataset.revertStep !== undefined) {
    target.step = Number(button.dataset.revertStep);
  }
  if (kind === "run") target.runId = button.dataset.revertRunId;
  else if (kind === "artifact") {
    target.artifactIndex = Number(button.dataset.revertArtifactIndex);
  } else {
    target.step = Number(button.dataset.revertStep);
  }
  return target;
}

function updateRevertConfirmState() {
  const requiresChangeRequest = Boolean(state.pendingRevertTarget?.changeRequest);
  elements.confirmRevertButton.disabled =
    !elements.revertConfirmCheckbox.checked ||
    (requiresChangeRequest && !elements.revertReasonInput.value.trim());
}

function setArtifactExpanded(card, expanded, { persist = false } = {}) {
  card.classList.toggle("expanded", expanded);
  card
    .querySelectorAll(".artifact-header, .artifact-toggle")
    .forEach((element) => element.setAttribute("aria-expanded", String(expanded)));
  if (persist) setTimelineCardExpandedByCard(card, expanded);
}

function caretRangeFromPoint(x, y) {
  if (document.caretPositionFromPoint) {
    const position = document.caretPositionFromPoint(x, y);
    if (!position) return null;
    const range = document.createRange();
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
    return range;
  }
  if (document.caretRangeFromPoint) {
    return document.caretRangeFromPoint(x, y);
  }
  return null;
}

function focusEditablePreview(preview, point = null) {
  preview.focus();
  const selection = window.getSelection();
  if (!selection) return;
  const range = point
    ? caretRangeFromPoint(point.clientX, point.clientY)
    : null;
  const fallbackRange = document.createRange();
  fallbackRange.selectNodeContents(preview);
  fallbackRange.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range && preview.contains(range.startContainer) ? range : fallbackRange);
}

const ARTIFACT_EDIT_DOUBLE_CLICK_MS = 330;
let pendingArtifactEditClick = null;

function setArtifactEditMode(card, point = null) {
  const feature = selectedFeature();
  const context = beginArtifactEdit(card);
  if (!feature || !context) return;
  closeMenus();
  state.selectedArtifactIndex = Number(card.dataset.artifactIndex);
  renderArtifacts(feature);
  const updatedCard = [...elements.artifactList.querySelectorAll("[data-artifact-key]")]
    .find((item) => item.dataset.artifactKey === context.draft.key);
  const preview = updatedCard?.querySelector(".artifact-preview");
  if (preview) focusEditablePreview(preview, point);
}

function shouldEnterArtifactEditMode(card, event) {
  const now = event.timeStamp;
  const key =
    card.dataset.artifactKey ??
    `${card.dataset.artifactIndex}:${card.dataset.sourceIndex}`;
  const isDoubleClick =
    pendingArtifactEditClick?.key === key &&
    now - pendingArtifactEditClick.time < ARTIFACT_EDIT_DOUBLE_CLICK_MS;
  pendingArtifactEditClick = { key, time: now };
  return isDoubleClick;
}

function enterArtifactEditModeFromEvent(event) {
  const preview = event.target.closest(".artifact-preview");
  const card = preview?.closest("[data-artifact-index]");
  if (
    !card ||
    card.classList.contains("run-log") ||
    card.classList.contains("editing") ||
    !shouldEnterArtifactEditMode(card, event)
  ) {
    return;
  }
  event.preventDefault();
  setArtifactEditMode(card, event);
}

function cancelArtifactEditFromCard(card) {
  cancelArtifactEdit(card);
  const feature = selectedFeature();
  if (feature) renderArtifacts(feature);
}

function bindMenuKeyboardShortcuts() {
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey)
      return;

    const activeMenu = openMenuElement();
    if (activeMenu && !event.shiftKey && event.key.length === 1) {
      const item = activeMenu.querySelector(
        `[data-menu-key="${event.key.toLowerCase()}"]`,
      );
      if (!item) return;
      event.preventDefault();
      closeMenus();
      item.click();
      return;
    }

    if (
      !event.shiftKey ||
      isTextEntryTarget(event.target) ||
      hasOpenModalDialog()
    ) {
      return;
    }

    if (openMenuByShortcut(event.code)) {
      event.preventDefault();
    }
  });
}

export function bindEvents() {
  elements.featureList.addEventListener("click", (event) => {
    const card = event.target.closest("[data-feature-id]");
    if (!card) return;
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    const feature = state.features.find(
      (item) => item.id === card.dataset.featureId,
    );
    setView(feature.id, feature.step);
    render();
    focusFeatureCard(feature.id);
  });

  elements.timeline.addEventListener("click", (event) => {
    const menuButton = event.target.closest(".timeline-menu .menu-button");
    if (menuButton) {
      toggleMenuFromButton(event, menuButton);
      return;
    }

    const revertButton = event.target.closest(".timeline-menu .revert-state-button");
    if (revertButton) {
      event.preventDefault();
      event.stopPropagation();
      openRevertDialog(revertTargetFromButton(revertButton));
      return;
    }

    const tab = event.target.closest("[data-step-index]");
    if (!tab) return;
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    setView(state.selectedFeatureId, Number(tab.dataset.stepIndex));
    renderDetails();
  });

  document.addEventListener("keydown", (event) => {
    const isFeaturePanelArrowKey =
      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
      isFeaturePanelTarget(event.target);

    if (isFeaturePanelArrowKey) {
      event.preventDefault();
      const direction = event.key === "ArrowUp" ? -1 : 1;
      if (event.metaKey) {
        reorderSelectedFeature(direction, {
          focusSelected: !isTextEntryTarget(event.target),
        }).catch((error) => showToast(error.message));
      } else {
        selectFeatureFromList(direction, {
          focusSelected: !isTextEntryTarget(event.target),
        });
      }
      return;
    }

    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey ||
      event.target.closest(
        "input, textarea, select, [contenteditable='true'], dialog[open]",
      )
    ) {
      return;
    }

    const feature = selectedFeature();
    if (!feature) return;

    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (!state.workflowVisible) return;
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      const nextStepIndex = state.selectedStepIndex + direction;
      if (nextStepIndex < 0 || nextStepIndex > feature.step) return;
      event.preventDefault();
      setView(feature.id, nextStepIndex);
      renderDetails();
      return;
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const direction = event.key === "ArrowUp" ? -1 : 1;
      const entries = entriesForFeature(feature);
      const currentIndex = artifactIndexForStep(feature);
      const nextIndex = currentIndex + direction;
      if (!entries[nextIndex]) return;
      event.preventDefault();
      state.selectedArtifactIndex = nextIndex;
      renderArtifacts(feature);
      elements.artifactList
        .querySelector(`[data-artifact-index="${nextIndex}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  });

  elements.artifactList.addEventListener("input", (event) => {
    const preview = event.target.closest(
      ".artifact-preview[contenteditable='true']",
    );
    const card = preview?.closest("[data-artifact-index]");
    if (!card) return;
    updateArtifactDraftFromCard(card);
  });

  elements.featureSearch.addEventListener("input", (event) => {
    state.searchTerm = event.target.value.trim();
    localState.save({ searchTerm: state.searchTerm });
    renderFeatureList();
  });

  elements.advanceButton.addEventListener("click", async () => {
    const feature = selectedFeature();
    if (!feature || feature.activeRunId || feature.step >= workflowForFeature(feature).length - 1)
      return;
    if (currentAgentStepRequiresRun(feature)) {
      await runCurrentStep(feature);
      return;
    }
    await moveToStep(feature, feature.step + 1);
  });

  elements.retryRunButton.addEventListener("click", async () => {
    const feature = selectedFeature();
    if (!feature) return;
    await api(`/features/${feature.id}/runs`, { method: "POST" });
    await loadState({ preserveView: true });
    showToast("Agent run queued");
  });

  elements.cancelRunButton.addEventListener("click", async () => {
    const feature = selectedFeature();
    if (!feature?.activeRunId) return;
    await api(`/runs/${feature.activeRunId}/cancel`, { method: "POST" });
    await loadState({ preserveView: true });
    showToast("Agent run cancelled");
  });

  elements.artifactList.addEventListener("click", async (event) => {
    const card = event.target.closest("[data-artifact-index]");
    if (!card) return;

    const menuButton = event.target.closest(".artifact-card-menu .menu-button");
    if (menuButton) {
      toggleMenuFromButton(event, menuButton);
      return;
    }

    const revertButton = event.target.closest(".artifact-card-menu .revert-state-button");
    if (revertButton) {
      event.preventDefault();
      event.stopPropagation();
      openRevertDialog(revertTargetFromButton(revertButton));
      return;
    }

    const changeRequestButton = event.target.closest(".artifact-card-menu .change-request-button");
    if (changeRequestButton) {
      event.preventDefault();
      event.stopPropagation();
      openRevertDialog(revertTargetFromButton(changeRequestButton));
      return;
    }

    if (event.target.closest(".artifact-card-menu")) return;

    if (event.target.closest("a.artifact-log-link")) return;

    if (event.target.closest(".cancel-edit-button")) {
      cancelArtifactEditFromCard(card);
      return;
    }

    if (event.target.closest(".save-artifact-button")) {
      saveArtifactFromCard(card).catch((error) => showToast(error.message));
      return;
    }

    if (event.target.closest(".artifact-preview")) {
      enterArtifactEditModeFromEvent(event);
      return;
    }

    if (event.target.closest(".artifact-header")) {
      state.selectedArtifactIndex = Number(card.dataset.artifactIndex);
      if (!card.classList.contains("editing")) {
        setArtifactExpanded(card, !card.classList.contains("expanded"), {
          persist: true,
        });
      }
      return;
    }
  });

  elements.artifactList.addEventListener("dblclick", (event) => {
    enterArtifactEditModeFromEvent(event);
  });

  elements.artifactList.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const preview = event.target.closest(
      ".artifact-preview[contenteditable='true']",
    );
    const card = preview?.closest("[data-artifact-index]");
    if (!card) return;
    event.preventDefault();
    event.stopPropagation();
    cancelArtifactEditFromCard(card);
  });

  document.querySelectorAll("[data-menu]").forEach((menu) => {
    const button = menu.querySelector(".menu-button");
    const popover = menu.querySelector(".menu-popover");
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const opening = popover.hidden;
      closeMenus(opening ? menu : null);
      if (opening) openMenu(menu);
    });
  });

  bindMenuKeyboardShortcuts();

  document.addEventListener("click", () => closeMenus());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenus();
  });

  document
    .querySelector("#add-feature-button")
    .addEventListener("click", openFeatureDialog);
  document
    .querySelector("#clone-feature-button")
    .addEventListener("click", async () => {
      const feature = selectedFeature();
      if (!feature) return;
      closeMenus();
      try {
        const clone = await api(`/features/${feature.id}/clone`, {
          method: "POST",
        });
        state.selectedFeatureId = clone.id;
        state.selectedStepIndex = clone.step;
        state.searchTerm = "";
        localState.save({
          selectedFeatureId: state.selectedFeatureId,
          selectedStepIndex: state.selectedStepIndex,
          searchTerm: state.searchTerm,
        });
        elements.featureSearch.value = "";
        await loadState({ preserveView: true });
        setView(clone.id, clone.step);
        showToast("Feature cloned");
      } catch (error) {
        showToast(error.message);
      }
    });
  document
    .querySelector("#feature-settings-button")
    .addEventListener("click", openFeatureSettings);
  document.querySelector("#hide-features-button").addEventListener("click", () => {
    setFeaturesPanelHidden(!state.featuresPanelHidden);
  });
  elements.workflowButton.addEventListener("click", () => {
    setWorkflowVisible(!state.workflowVisible);
  });
  elements.environmentPanelButton.addEventListener("click", () => {
    openEnvironmentPanel().catch((error) => showToast(error.message));
  });
  document
    .querySelector("#close-environment-terminal-button")
    .addEventListener("click", closeEnvironmentPanel);

  document.querySelector("#save-state-button").addEventListener("click", () => {
    closeMenus();
    saveStateToClipboard();
  });
  document
    .querySelector("#restore-state-button")
    .addEventListener("click", () => {
      closeMenus();
      restoreStateFromClipboard();
    });
  document
    .querySelector("#repository-workflow-button")
    .addEventListener("click", async () => {
      closeMenus();
      const feature = selectedFeature();
      if (feature) {
        try {
          const workflow = await api(`/features/${feature.id}/steps`);
          feature.sdlc = {
            ...(feature.sdlc ?? {}),
            workflow,
          };
          renderRepositoryWorkflow();
        } catch (error) {
          showToast(error.message);
          return;
        }
      }
      elements.repositoryWorkflowDialog.showModal();
      centerDialog(elements.repositoryWorkflowDialog);
      document.querySelector("#close-workflow-action").focus();
    });
  document
    .querySelector("#validate-repository-button")
    .addEventListener("click", async () => {
      closeMenus();
      state.validation = await api("/repository/validation");
      renderValidation();
      elements.validationDialog.showModal();
      centerDialog(elements.validationDialog);
      document.querySelector("#close-validation-action").focus();
    });

  document
    .querySelector("#close-workflow-button")
    .addEventListener("click", () => {
      elements.repositoryWorkflowDialog.close();
    });
  document
    .querySelector("#close-workflow-action")
    .addEventListener("click", () => {
      elements.repositoryWorkflowDialog.close();
    });

  bindMovableDialog(
    elements.repositoryWorkflowDialog,
    document.querySelector("#workflow-dialog-handle"),
  );
  bindMovableDialog(
    elements.validationDialog,
    document.querySelector("#validation-dialog-handle"),
  );

  document
    .querySelector("#close-dialog-button")
    .addEventListener("click", () => elements.dialog.close());
  document
    .querySelector("#cancel-dialog-button")
    .addEventListener("click", () => elements.dialog.close());

  document
    .querySelector("#close-settings-button")
    .addEventListener("click", () => elements.settingsDialog.close());
  document
    .querySelector("#cancel-settings-button")
    .addEventListener("click", () => elements.settingsDialog.close());
  elements.settingsDialog.addEventListener("close", () => {
    setFeatureTitleEditMode(false);
  });
  elements.editFeatureTitleButton.addEventListener("click", () => {
    setFeatureTitleEditMode(true);
  });
  elements.mergeMainFeatureButton.addEventListener("click", () => {
    const feature = selectedFeature();
    if (!feature) return;
    elements.mergeMainFeatureName.textContent = feature.name;
    elements.mergeMainDialog.dataset.featureId = feature.id;
    elements.mergeMainConfirmCheckbox.checked = false;
    elements.confirmMergeMainButton.disabled = true;
    elements.settingsDialog.close();
    elements.mergeMainDialog.showModal();
    elements.mergeMainConfirmCheckbox.focus();
  });
  document
    .querySelector("#close-merge-main-button")
    .addEventListener("click", () => elements.mergeMainDialog.close());
  document
    .querySelector("#cancel-merge-main-button")
    .addEventListener("click", () => elements.mergeMainDialog.close());
  elements.mergeMainDialog.addEventListener("close", () => {
    elements.mergeMainDialog.dataset.featureId = "";
    elements.mergeMainConfirmCheckbox.checked = false;
    elements.confirmMergeMainButton.disabled = true;
  });
  elements.mergeMainConfirmCheckbox.addEventListener("change", () => {
    elements.confirmMergeMainButton.disabled =
      !elements.mergeMainConfirmCheckbox.checked;
  });
  elements.resetFeatureButton.addEventListener("click", () => {
    const feature = selectedFeature();
    if (!feature) return;
    elements.resetFeatureName.textContent = feature.name;
    elements.resetDialog.dataset.featureId = feature.id;
    elements.resetConfirmCheckbox.checked = false;
    elements.confirmResetButton.disabled = true;
    elements.settingsDialog.close();
    elements.resetDialog.showModal();
    elements.resetConfirmCheckbox.focus();
  });
  document
    .querySelector("#close-reset-button")
    .addEventListener("click", () => elements.resetDialog.close());
  document
    .querySelector("#cancel-reset-button")
    .addEventListener("click", () => elements.resetDialog.close());
  elements.resetDialog.addEventListener("close", () => {
    elements.resetDialog.dataset.featureId = "";
    elements.resetConfirmCheckbox.checked = false;
    elements.confirmResetButton.disabled = true;
  });
  elements.resetConfirmCheckbox.addEventListener("change", () => {
    elements.confirmResetButton.disabled = !elements.resetConfirmCheckbox.checked;
  });
  document
    .querySelector("#request-delete-feature-button")
    .addEventListener("click", () => {
      const feature = selectedFeature();
      if (!feature) return;
      elements.deleteFeatureName.textContent = feature.name;
      elements.settingsDialog.close();
      elements.deleteDialog.showModal();
    });
  document
    .querySelector("#close-delete-button")
    .addEventListener("click", () => elements.deleteDialog.close());
  document
    .querySelector("#cancel-delete-button")
    .addEventListener("click", () => elements.deleteDialog.close());
  elements.artifactSaveDialog.addEventListener("close", () => {
    state.pendingArtifactSaveCard = null;
  });
  document
    .querySelector("#close-artifact-save-button")
    .addEventListener("click", closeArtifactSaveDialog);
  document
    .querySelector("#cancel-artifact-save-button")
    .addEventListener("click", closeArtifactSaveDialog);
  document
    .querySelector("#preserve-next-steps-button")
    .addEventListener("click", () => {
      savePendingArtifact({ discardNextSteps: false }).catch((error) =>
        showToast(error.message),
      );
    });
  document
    .querySelector("#discard-next-steps-button")
    .addEventListener("click", () => {
      savePendingArtifact({ discardNextSteps: true }).catch((error) =>
        showToast(error.message),
      );
    });

  elements.revertDialog.addEventListener("close", () => {
    state.pendingRevertTarget = null;
  });
  document
    .querySelector("#close-revert-button")
    .addEventListener("click", closeRevertDialog);
  document
    .querySelector("#cancel-revert-button")
    .addEventListener("click", closeRevertDialog);
  elements.revertConfirmCheckbox.addEventListener("change", () => {
    updateRevertConfirmState();
  });
  elements.revertReasonInput.addEventListener("input", updateRevertConfirmState);
  document
    .querySelector("#revert-state-form")
    .addEventListener("submit", (event) => {
      event.preventDefault();
      confirmPendingRevert().catch((error) => showToast(error.message));
    });

  elements.settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const feature = selectedFeature();
    const name = elements.settingsFeatureNameInput.value.trim();
    const branch = elements.branchInput.value.trim();
    if (!feature || !name || !branch) return;
    await api(`/features/${feature.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name, branch }),
    });
    elements.settingsDialog.close();
    await loadState({ preserveView: true });
    showToast("Feature settings saved");
  });

  elements.mergeMainForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const featureId = elements.mergeMainDialog.dataset.featureId;
    if (!featureId || !elements.mergeMainConfirmCheckbox.checked) return;
    try {
      const result = await api(`/features/${featureId}/merge-main`, {
        method: "POST",
        body: JSON.stringify({ confirmMergeFromMain: true }),
      });
      elements.mergeMainDialog.close();
      await loadState({ preserveView: true });
      const updated = state.features.find((feature) => feature.id === featureId);
      if (updated) setView(updated.id, updated.step, { replace: true });
      const merge = result.merge ?? {};
      showToast(
        merge.changed
          ? merge.conflictsResolved
            ? "Merged main and resolved conflicts"
            : "Merged main into feature"
          : "Feature already includes main",
      );
    } catch (error) {
      showToast(error.message);
    }
  });

  elements.resetForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const featureId = elements.resetDialog.dataset.featureId;
    if (!featureId || !elements.resetConfirmCheckbox.checked) return;
    try {
      const result = await api(`/features/${featureId}/reset`, {
        method: "POST",
        body: JSON.stringify({ confirmReset: true }),
      });
      elements.resetDialog.close();
      await loadState({ preserveView: true });
      const updated = state.features.find((feature) => feature.id === featureId);
      if (updated) setView(updated.id, updated.step, { replace: true });
      const environmentMessage = result.reset?.environment?.message;
      showToast(
        environmentMessage
          ? `Feature reset. ${environmentMessage}`
          : "Feature reset",
      );
    } catch (error) {
      showToast(error.message);
    }
  });

  elements.deleteForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const feature = selectedFeature();
    if (!feature) return;
    await api(`/features/${feature.id}`, { method: "DELETE" });
    elements.deleteDialog.close();
    await loadState({ preserveView: false });
    if (state.selectedFeatureId)
      setView(state.selectedFeatureId, state.selectedStepIndex, {
        replace: true,
      });
    showToast(`${feature.name} deleted`);
  });

  document
    .querySelector("#close-validation-button")
    .addEventListener("click", () => {
      elements.validationDialog.close();
    });
  document
    .querySelector("#close-validation-action")
    .addEventListener("click", () => {
      elements.validationDialog.close();
    });
  document
    .querySelector("#rerun-validation-button")
    .addEventListener("click", async () => {
      state.validation = await api("/repository/validation");
      renderValidation();
      showToast("Repository validation completed");
    });

  elements.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = elements.nameInput.value.trim();
    const prompt = elements.promptInput.value.trim();
    if (!name || !prompt) return;

    const feature = await api("/features", {
      method: "POST",
      body: JSON.stringify({ title: name, prompt }),
    });
    state.selectedFeatureId = feature.id;
    state.selectedStepIndex = feature.step;
    state.searchTerm = "";
    localState.save({
      selectedFeatureId: state.selectedFeatureId,
      selectedStepIndex: state.selectedStepIndex,
      searchTerm: state.searchTerm,
    });
    elements.featureSearch.value = "";
    elements.dialog.close();
    await loadState({ preserveView: true });
    setView(feature.id, feature.step);
    showToast("Feature created");
  });

  window.addEventListener("popstate", () => {
    restoreViewFromUrl();
    render();
  });
}
