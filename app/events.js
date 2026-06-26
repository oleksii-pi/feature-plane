import {
  api,
  loadState,
  restoreStateFromClipboard,
  saveStateToClipboard,
} from "./api.js";
import {
  closeArtifactSaveDialog,
  moveToStep,
  openArtifactSaveDialog,
  openFeatureDialog,
  openFeatureSettings,
  savePendingArtifact,
  setFeaturesPanelHidden,
  setWorkflowVisible,
} from "./actions.js";
import { closeMenus, elements, showToast } from "./dom.js";
import {
  artifactIndexForStep,
  entriesForFeature,
  render,
  renderArtifacts,
  renderDetails,
  renderFeatureList,
  renderValidation,
} from "./render.js";
import {
  localState,
  restoreViewFromUrl,
  selectedFeature,
  setView,
  state,
} from "./state.js";

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
  });

  elements.timeline.addEventListener("click", (event) => {
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

  elements.featureSearch.addEventListener("input", (event) => {
    state.searchTerm = event.target.value.trim();
    localState.save({ searchTerm: state.searchTerm });
    renderFeatureList();
  });

  elements.advanceButton.addEventListener("click", async () => {
    const feature = selectedFeature();
    if (!feature || feature.activeRunId || feature.step >= state.workflow.length - 1)
      return;
    await moveToStep(feature, feature.step + 1);
  });

  elements.backStepButton.addEventListener("click", async () => {
    const feature = selectedFeature();
    if (!feature || feature.activeRunId || feature.step <= 0) return;
    await moveToStep(feature, feature.step - 1);
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

    if (event.target.closest(".artifact-header")) {
      state.selectedArtifactIndex = Number(card.dataset.artifactIndex);
      card.classList.toggle("expanded");
      card
        .querySelector(".artifact-header")
        .setAttribute("aria-expanded", card.classList.contains("expanded"));
      return;
    }

    const preview = card.querySelector(".artifact-preview");
    const editorWrap = card.querySelector(".artifact-edit");
    const toolbar = card.querySelector(".preview-toolbar");

    if (event.target.closest(".edit-artifact-button")) {
      preview.hidden = true;
      toolbar.hidden = true;
      editorWrap.hidden = false;
      card.querySelector(".artifact-editor").focus();
    }

    if (event.target.closest(".cancel-edit-button")) {
      editorWrap.hidden = true;
      preview.hidden = false;
      toolbar.hidden = false;
    }

    if (event.target.closest(".save-artifact-button")) {
      openArtifactSaveDialog(card);
    }
  });

  document.querySelectorAll("[data-menu]").forEach((menu) => {
    const button = menu.querySelector(".menu-button");
    const popover = menu.querySelector(".menu-popover");
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const opening = popover.hidden;
      closeMenus(opening ? menu : null);
      popover.hidden = !opening;
      button.setAttribute("aria-expanded", String(opening));
      if (opening) popover.querySelector("button")?.focus();
    });
  });

  document.addEventListener("click", () => closeMenus());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenus();
  });

  document
    .querySelector("#add-feature-button")
    .addEventListener("click", openFeatureDialog);
  document
    .querySelector("#feature-settings-button")
    .addEventListener("click", openFeatureSettings);
  document.querySelector("#hide-features-button").addEventListener("click", () => {
    setFeaturesPanelHidden(!state.featuresPanelHidden);
  });
  elements.workflowButton.addEventListener("click", () => {
    setWorkflowVisible(!state.workflowVisible);
  });

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
    .addEventListener("click", () => {
      closeMenus();
      elements.repositoryWorkflowDialog.showModal();
      document.querySelector("#close-workflow-action").focus();
    });
  document
    .querySelector("#validate-repository-button")
    .addEventListener("click", async () => {
      closeMenus();
      state.validation = await api("/repository/validation");
      renderValidation();
      elements.validationDialog.showModal();
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

  elements.settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const feature = selectedFeature();
    const branch = elements.branchInput.value.trim();
    if (!feature || !branch) return;
    await api(`/features/${feature.id}`, {
      method: "PATCH",
      body: JSON.stringify({ branch }),
    });
    elements.settingsDialog.close();
    await loadState({ preserveView: true });
    showToast("Feature settings saved");
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
