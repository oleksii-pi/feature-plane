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
  dialog: document.querySelector("#feature-dialog"),
  form: document.querySelector("#feature-form"),
  nameInput: document.querySelector("#new-feature-name"),
  promptInput: document.querySelector("#new-feature-prompt"),
  settingsDialog: document.querySelector("#feature-settings-dialog"),
  settingsForm: document.querySelector("#feature-settings-form"),
  settingsFeatureName: document.querySelector("#settings-feature-name"),
  branchInput: document.querySelector("#feature-branch-name"),
  deleteDialog: document.querySelector("#delete-feature-dialog"),
  deleteForm: document.querySelector("#delete-feature-form"),
  deleteFeatureName: document.querySelector("#delete-feature-name"),
  artifactSaveDialog: document.querySelector("#artifact-save-dialog"),
  artifactSaveName: document.querySelector("#artifact-save-name"),
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
