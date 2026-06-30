let toastTimer;

export const elements = {
  featureList: document.querySelector("#feature-list"),
  workspace: document.querySelector("#workspace"),
  featureSearch: document.querySelector("#feature-search"),
  featureTitle: document.querySelector("#feature-title"),
  featureMeta: document.querySelector("#feature-meta"),
  stateBadge: document.querySelector("#state-badge"),
  timeline: document.querySelector("#timeline"),
  workflowButton: document.querySelector("#toggle-workflow-button"),
  artifactList: document.querySelector("#artifact-list"),
  advanceButton: document.querySelector("#advance-button"),
  retryRunButton: document.querySelector("#retry-run-button"),
  cancelRunButton: document.querySelector("#cancel-run-button"),
  environmentPanelButton: document.querySelector("#environment-panel-button"),
  environmentTerminal: document.querySelector("#environment-terminal"),
  environmentCommandList: document.querySelector("#environment-command-list"),
  dialog: document.querySelector("#feature-dialog"),
  form: document.querySelector("#feature-form"),
  nameInput: document.querySelector("#new-feature-name"),
  promptInput: document.querySelector("#new-feature-prompt"),
  settingsDialog: document.querySelector("#feature-settings-dialog"),
  settingsForm: document.querySelector("#feature-settings-form"),
  settingsFeatureName: document.querySelector("#settings-feature-name"),
  settingsFeatureNameInput: document.querySelector(
    "#settings-feature-name-input",
  ),
  editFeatureTitleButton: document.querySelector("#edit-feature-title-button"),
  branchInput: document.querySelector("#feature-branch-name"),
  resetFeatureButton: document.querySelector("#request-reset-feature-button"),
  resetDialog: document.querySelector("#reset-feature-dialog"),
  resetForm: document.querySelector("#reset-feature-form"),
  resetFeatureName: document.querySelector("#reset-feature-name"),
  resetConfirmCheckbox: document.querySelector("#reset-confirm-checkbox"),
  confirmResetButton: document.querySelector("#confirm-reset-button"),
  deleteDialog: document.querySelector("#delete-feature-dialog"),
  deleteForm: document.querySelector("#delete-feature-form"),
  deleteFeatureName: document.querySelector("#delete-feature-name"),
  artifactSaveDialog: document.querySelector("#artifact-save-dialog"),
  artifactSaveName: document.querySelector("#artifact-save-name"),
  revertDialog: document.querySelector("#revert-state-dialog"),
  revertDialogTitle: document.querySelector("#revert-dialog-title"),
  revertDialogCopy: document.querySelector("#revert-dialog-copy"),
  revertTargetName: document.querySelector("#revert-target-name"),
  revertTargetDetail: document.querySelector("#revert-target-detail"),
  revertReasonInput: document.querySelector("#revert-reason-comment"),
  revertConfirmCheckbox: document.querySelector("#revert-confirm-checkbox"),
  revertConfirmLabel: document.querySelector("#revert-confirm-label"),
  confirmRevertButton: document.querySelector("#confirm-revert-button"),
  repositoryWorkflowDialog: document.querySelector(
    "#repository-workflow-dialog",
  ),
  repositoryWorkflowSteps: document.querySelector("#repository-workflow-steps"),
  validationDialog: document.querySelector("#repository-validation-dialog"),
  validationTitle: document.querySelector("#validation-title"),
  validationContext: document.querySelector("#validation-context"),
  validationSummary: document.querySelector("#validation-summary"),
  validationList: document.querySelector("#validation-list"),
  toast: document.querySelector("#toast"),
};

export function showToast(message) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  toastTimer = window.setTimeout(
    () => elements.toast.classList.remove("visible"),
    2600,
  );
}

export function closeMenus(except = null) {
  document.querySelectorAll("[data-menu]").forEach((menu) => {
    if (menu === except) return;
    menu.querySelector(".menu-popover").hidden = true;
    menu.querySelector(".menu-button").setAttribute("aria-expanded", "false");
  });
}

export function openMenu(menu) {
  const popover = menu.querySelector(".menu-popover");
  const button = menu.querySelector(".menu-button");
  closeMenus(menu);
  popover.hidden = false;
  button.setAttribute("aria-expanded", "true");
  popover.querySelector("button")?.focus();
}

export function openMenuByShortcut(code) {
  const menu = document.querySelector(`[data-menu-shortcut="${code}"]`);
  if (!menu) return false;
  openMenu(menu);
  return true;
}

export function openMenuElement() {
  return Array.from(document.querySelectorAll("[data-menu]")).find(
    (menu) => !menu.querySelector(".menu-popover").hidden,
  );
}
