const STORAGE_KEY = "control-plane-poc-ui-state";
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

let workflow = [];
let features = [];
let workspaces = [];
let selectedFeatureId = null;
let selectedStepIndex = 0;
let selectedArtifactIndex = null;
let searchTerm = "";
let featuresPanelHidden = false;
let workflowVisible = false;
let validation = null;
let toastTimer;
let eventSources = new Map();

const elements = {
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
  backStepButton: document.querySelector("#back-step-button"),
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
  repositoryWorkflowDialog: document.querySelector("#repository-workflow-dialog"),
  workflowSource: document.querySelector("#workflow-source"),
  repositoryWorkflowSteps: document.querySelector("#repository-workflow-steps"),
  validationDialog: document.querySelector("#repository-validation-dialog"),
  validationTitle: document.querySelector("#validation-title"),
  validationContext: document.querySelector("#validation-context"),
  validationSummary: document.querySelector("#validation-summary"),
  validationList: document.querySelector("#validation-list"),
  toast: document.querySelector("#toast"),
};

const localState = {
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

function selectedFeature() {
  return features.find((feature) => feature.id === selectedFeatureId) ?? null;
}

function selectedStep() {
  return workflow[selectedStepIndex] ?? null;
}

function isAgentStep(step) {
  return Boolean(step?.agent);
}

function stepSlug(step) {
  return step.state
    .replace(/^@/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function viewUrl(featureId, stepIndex) {
  const url = new URL(window.location.href);
  if (featureId) url.searchParams.set("featureId", featureId);
  if (workflow[stepIndex]) url.searchParams.set("step", stepSlug(workflow[stepIndex]));
  return `${url.pathname}${url.search}${url.hash}`;
}

function setView(featureId, stepIndex, { replace = false } = {}) {
  selectedFeatureId = featureId;
  selectedStepIndex = stepIndex;
  selectedArtifactIndex = null;
  localState.save({ selectedFeatureId, selectedStepIndex });
  if (!featureId || !workflow[stepIndex]) return;
  const method = replace ? "replaceState" : "pushState";
  window.history[method](null, "", viewUrl(featureId, stepIndex));
}

function restoreViewFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const saved = localState.load();
  const feature =
    features.find((item) => item.id === params.get("featureId")) ??
    features.find((item) => item.id === saved.selectedFeatureId) ??
    features[0] ??
    null;

  selectedFeatureId = feature?.id ?? null;
  selectedArtifactIndex = null;
  if (!feature) {
    selectedStepIndex = 0;
    return;
  }

  const requestedStep = workflow.findIndex(
    (step) => stepSlug(step) === params.get("step"),
  );
  const savedStep = Number.isInteger(saved.selectedStepIndex)
    ? saved.selectedStepIndex
    : feature.step;
  selectedStepIndex = Math.min(
    requestedStep >= 0 ? requestedStep : savedStep,
    feature.step,
  );
}

function displayStep(feature) {
  if (!feature) return "";
  const step = workflow[feature.step];
  if (!step) return "";
  if (feature.activeRunId) {
    const run = feature.runs.find((item) => item.id === feature.activeRunId);
    if (run && !TERMINAL_RUN_STATUSES.has(run.status)) {
      return `Agent Run: ${step.agent}`;
    }
  }
  return step.state;
}

function latestRun(feature) {
  return feature?.runs?.at(-1) ?? null;
}

function latestCost(feature) {
  return feature?.cost ?? latestRun(feature)?.cost ?? "TBD";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function markdownToHtml(content) {
  const lines = escapeHtml(content).split("\n");
  let html = "";
  let inList = false;

  lines.forEach((line) => {
    if (line.startsWith("## ")) {
      if (inList) html += "</ul>";
      inList = false;
      html += `<h4>${line.slice(3)}</h4>`;
    } else if (/^\d+\. /.test(line) || line.startsWith("- ")) {
      if (!inList) html += "<ul>";
      inList = true;
      html += `<li>${line.replace(/^\d+\. |^- /, "")}</li>`;
    } else if (line.trim()) {
      if (inList) html += "</ul>";
      inList = false;
      html += `<p>${line}</p>`;
    }
  });

  if (inList) html += "</ul>";
  return html;
}

async function api(path, options = {}) {
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

async function loadState({ preserveView = true } = {}) {
  const state = await api("/state");
  workflow = state.workflow;
  features = state.features;
  workspaces = state.workspaces;
  validation = state.validation;

  const saved = localState.load();
  featuresPanelHidden = Boolean(saved.featuresPanelHidden);
  workflowVisible = Boolean(saved.workflowVisible);
  searchTerm = saved.searchTerm ?? "";
  elements.featureSearch.value = searchTerm;

  if (preserveView && selectedFeature()) {
    selectedStepIndex = Math.min(selectedStepIndex, selectedFeature().step);
  } else {
    restoreViewFromUrl();
  }
  syncRunStreams();
  render();
}

function renderFeatureList() {
  const visibleFeatures = features.filter((feature) =>
    feature.name.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  if (!visibleFeatures.length) {
    elements.featureList.innerHTML =
      '<div class="empty-state">No features yet. Add one to create a feature workspace.</div>';
    return;
  }

  elements.featureList.innerHTML = visibleFeatures
    .map((feature) => {
      const progress = Math.round((feature.step / (workflow.length - 1)) * 100);
      const run = latestRun(feature);
      const status = run ? `Last run: ${run.status}` : "No runs yet";
      return `
        <a
          class="feature-card ${feature.id === selectedFeatureId ? "selected" : ""} ${feature.activeRunId ? "running" : ""}"
          href="${viewUrl(feature.id, feature.step)}"
          data-feature-id="${feature.id}"
        >
          <span class="feature-name">${escapeHtml(feature.name)}</span>
          <span class="feature-info">
            <span class="feature-info-row">
              <span class="feature-state">${escapeHtml(displayStep(feature))}</span>
              <span class="feature-price">${escapeHtml(latestCost(feature))}</span>
            </span>
            <span class="feature-run-status">${escapeHtml(status)}</span>
            <span class="feature-progress" aria-label="${progress}% complete"><span style="width:${progress}%"></span></span>
          </span>
        </a>
      `;
    })
    .join("");
}

function renderTimeline(feature) {
  if (!feature) {
    elements.timeline.innerHTML = "";
    return;
  }
  const start = Math.max(0, selectedStepIndex - 3);
  const end = Math.min(workflow.length, Math.max(selectedStepIndex + 3, 6));

  elements.timeline.innerHTML = workflow
    .slice(start, end)
    .map((step, index) => {
      const actualIndex = start + index;
      const state =
        actualIndex < feature.step
          ? "done"
          : actualIndex === feature.step
            ? "current"
            : "";
      const running = actualIndex === feature.step && feature.activeRunId ? "running" : "";
      const selected = actualIndex === selectedStepIndex ? "selected" : "";
      const name = running ? displayStep(feature) : step.state;
      const classes = `timeline-item ${state} ${running} ${selected}`;

      if (actualIndex <= feature.step) {
        return `<a class="${classes}" href="${viewUrl(feature.id, actualIndex)}" data-step-index="${actualIndex}"${selected ? ' aria-current="page"' : ""}>${escapeHtml(name)}</a>`;
      }

      return `<span class="${classes}">${escapeHtml(name)}</span>`;
    })
    .join("");
}

function displayEvents(run) {
  return (run.events ?? []).map((event) => {
    const timestamp = new Date(event.timestamp);
    const time = Number.isNaN(timestamp.valueOf())
      ? ""
      : timestamp.toLocaleTimeString([], { hour12: false });
    const state = TERMINAL_RUN_STATUSES.has(run.status) ? run.status : "active";
    return `
      <div class="run-event ${state}">
        <span>${escapeHtml(time)}</span>
        <span class="event-dot"></span>
        <span>${escapeHtml(event.status)}: ${escapeHtml(event.message)}</span>
      </div>
    `;
  });
}

function runLabel(run) {
  if (run.status === "running" || run.status === "queued") return "Running";
  return run.status.charAt(0).toUpperCase() + run.status.slice(1);
}

function renderRunLog(run, index, isExpanded, feature) {
  const step = workflow[run.step] ?? selectedStep();
  const eventMarkup = displayEvents(run).join("");
  return `
    <article class="artifact-card run-log ${run.status} ${isExpanded ? "expanded" : ""}" data-artifact-index="${index}">
      <button class="artifact-header" type="button" aria-expanded="${isExpanded}">
        <span class="artifact-label">${escapeHtml(runLabel(run))}</span>
        <span class="artifact-title">
          <strong>${escapeHtml(step?.agent ?? step?.state ?? "Run")}</strong>
          <span>${escapeHtml(run.status)} · ${escapeHtml(feature.workspace)}</span>
        </span>
        <span class="artifact-chevron">⌃</span>
      </button>
      <div class="artifact-body"><div class="run-events">${eventMarkup || "<p>No events recorded.</p>"}</div></div>
    </article>
  `;
}

function entriesForFeature(feature) {
  if (!feature) return [];
  const artifacts = feature.artifacts.map((artifact, index) => ({
    kind: "artifact",
    artifact,
    sourceIndex: index,
    order: artifact.availableAtStep ?? 0,
  }));
  const runs = feature.runs.map((run, index) => ({
    kind: "run",
    run,
    sourceIndex: index,
    order: run.step,
  }));
  return [...artifacts, ...runs]
    .filter((entry) => entry.order <= selectedStepIndex)
    .sort((a, b) => a.order - b.order || a.kind.localeCompare(b.kind));
}

function artifactIndexForStep(feature) {
  const entries = entriesForFeature(feature);
  if (
    selectedArtifactIndex !== null &&
    entries.some((_, index) => index === selectedArtifactIndex)
  ) {
    return selectedArtifactIndex;
  }
  return entries.length ? entries.length - 1 : null;
}

function renderArtifacts(feature) {
  const entries = entriesForFeature(feature);
  const expandedArtifactIndex = artifactIndexForStep(feature);

  if (!entries.length) {
    elements.artifactList.innerHTML =
      '<div class="empty-state">No artifacts are available for this step.</div>';
    return;
  }

  elements.artifactList.innerHTML = entries
    .map((entry, visibleIndex) => {
      const isExpanded = visibleIndex === expandedArtifactIndex;
      if (entry.kind === "run") {
        return renderRunLog(entry.run, visibleIndex, isExpanded, feature);
      }

      const artifact = entry.artifact;
      const isLatest = visibleIndex === entries.length - 1;
      return `
        <article class="artifact-card ${isLatest ? "latest" : ""} ${isExpanded ? "expanded" : ""}" data-artifact-index="${visibleIndex}" data-source-index="${entry.sourceIndex}">
          <button class="artifact-header" type="button" aria-expanded="${isExpanded}">
            <span class="artifact-title"><strong>${escapeHtml(artifact.name)}</strong><span>Updated ${escapeHtml(artifact.updated)} · ${escapeHtml(artifact.path)}</span></span>
            ${isLatest ? '<span class="artifact-label">Latest</span>' : ""}
            <span class="artifact-chevron">⌃</span>
          </button>
          <div class="artifact-body">
            <div class="artifact-preview">${markdownToHtml(artifact.content)}</div>
            <div class="artifact-edit" hidden>
              <textarea class="artifact-editor" aria-label="Edit ${escapeHtml(artifact.name)}">${escapeHtml(artifact.content)}</textarea>
              <div class="artifact-toolbar">
                <button class="secondary-button cancel-edit-button" type="button">Cancel</button>
                <button class="primary-button save-artifact-button" type="button">Save changes</button>
              </div>
            </div>
            <div class="artifact-toolbar preview-toolbar">
              <button class="secondary-button edit-artifact-button" type="button">Edit artifact</button>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderDetails() {
  const feature = selectedFeature();
  if (!feature) {
    elements.featureTitle.textContent = "No feature selected";
    elements.featureMeta.textContent = "";
    elements.stateBadge.textContent = "";
    elements.advanceButton.disabled = true;
    elements.backStepButton.disabled = true;
    elements.retryRunButton.classList.remove("visible");
    elements.cancelRunButton.classList.remove("visible");
    elements.artifactList.innerHTML =
      '<div class="empty-state">Create a feature to start the workflow.</div>';
    renderTimeline(null);
    return;
  }

  elements.featureTitle.textContent = feature.name;
  elements.featureMeta.replaceChildren();
  const branchLink = document.createElement("a");
  branchLink.href = `#${feature.branch}`;
  branchLink.textContent = feature.branch;
  elements.featureMeta.append(branchLink, ` · ${feature.updated} · ${feature.workspace}`);
  elements.stateBadge.textContent = displayStep(feature);
  elements.stateBadge.classList.toggle("running", Boolean(feature.activeRunId));
  elements.advanceButton.disabled =
    Boolean(feature.activeRunId) || feature.step === workflow.length - 1;
  elements.advanceButton.textContent =
    feature.step === workflow.length - 1 ? "Feature complete" : "Move to next step";
  elements.backStepButton.disabled = Boolean(feature.activeRunId) || feature.step === 0;
  const run = latestRun(feature);
  elements.retryRunButton.classList.toggle(
    "visible",
    Boolean(run && TERMINAL_RUN_STATUSES.has(run.status) && isAgentStep(workflow[feature.step])),
  );
  elements.cancelRunButton.classList.toggle("visible", Boolean(feature.activeRunId));
  renderTimeline(feature);
  renderArtifacts(feature);
}

function renderRepositoryWorkflow() {
  elements.workflowSource.innerHTML = `
    <span><strong>Source</strong><code>server.js</code></span>
    <span><strong>Workspace root</strong><code>feature/</code></span>
    <span><strong>Features</strong>${features.length}</span>
  `;
  elements.repositoryWorkflowSteps.innerHTML = workflow
    .map((step, index) => {
      const owner = isAgentStep(step) ? "Agent" : "Human";
      const details = step.artifact
        ? isAgentStep(step)
          ? `<code>${escapeHtml(step.agent)}</code> produces <code>${escapeHtml(step.artifact)}</code>`
          : `Requires <code>${escapeHtml(step.artifact)}</code>`
        : "Approval checkpoint";
      return `
        <li class="repository-workflow-step ${isAgentStep(step) ? "agent-step" : "human-step"}">
          <span class="workflow-step-number">${index + 1}</span>
          <div><strong>${escapeHtml(step.state)}</strong><span class="workflow-step-detail">${details}</span></div>
          <span class="workflow-owner ${isAgentStep(step) ? "agent-owner" : "human-owner"}">${owner}</span>
        </li>
      `;
    })
    .join("");
}

function renderValidation() {
  if (!validation) return;
  elements.validationTitle.textContent = validation.ok
    ? "Repository is compliant"
    : "Repository needs attention";
  elements.validationContext.innerHTML = `
    <span><strong>Workspace root</strong><code>${escapeHtml(validation.workspaceRoot)}</code></span>
    <span><strong>Completed</strong>${escapeHtml(validation.completedAt)}</span>
  `;
  elements.validationSummary.innerHTML = `
    <span class="validation-score">${validation.passed} of ${validation.checks.length} checks passed</span>
    <span>${validation.errors} errors · ${validation.warnings} warnings</span>
  `;
  elements.validationList.innerHTML = validation.checks
    .map((check) => `
      <article class="validation-check ${escapeHtml(check.status)}">
        <span class="check-icon" aria-hidden="true">${check.status === "passed" ? "✓" : check.status === "warning" ? "!" : "×"}</span>
        <div><strong>${escapeHtml(check.name)}</strong><p>${escapeHtml(check.message)}</p></div>
        <span class="check-status">${escapeHtml(check.status)}</span>
      </article>
    `)
    .join("");
}

function render() {
  elements.workspace.classList.toggle("features-collapsed", featuresPanelHidden);
  elements.timeline.hidden = !workflowVisible;
  elements.workflowButton.setAttribute("aria-checked", String(workflowVisible));
  renderFeatureList();
  renderDetails();
  renderRepositoryWorkflow();
  renderValidation();
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  toastTimer = window.setTimeout(
    () => elements.toast.classList.remove("visible"),
    2600,
  );
}

function closeMenus(except = null) {
  document.querySelectorAll("[data-menu]").forEach((menu) => {
    if (menu === except) return;
    menu.querySelector(".menu-popover").hidden = true;
    menu.querySelector(".menu-button").setAttribute("aria-expanded", "false");
  });
}

function openFeatureDialog() {
  closeMenus();
  elements.form.reset();
  elements.dialog.showModal();
  elements.nameInput.focus();
}

function openFeatureSettings() {
  closeMenus();
  const feature = selectedFeature();
  if (!feature) return;
  elements.settingsFeatureName.textContent = feature.name;
  elements.branchInput.value = feature.branch;
  elements.settingsDialog.showModal();
  elements.branchInput.focus();
}

function setFeaturesPanelHidden(hidden) {
  featuresPanelHidden = hidden;
  localState.save({ featuresPanelHidden });
  const button = document.querySelector("#hide-features-button");
  button.innerHTML = hidden ? "S<u>h</u>ow" : "<u>H</u>ide";
  button.setAttribute("aria-label", hidden ? "Show features" : "Hide features");
  closeMenus();
  render();
}

function setWorkflowVisible(visible) {
  workflowVisible = visible;
  localState.save({ workflowVisible });
  closeMenus();
  render();
}

function syncRunStreams() {
  const activeRunIds = new Set(
    features.flatMap((feature) => (feature.activeRunId ? [feature.activeRunId] : [])),
  );
  eventSources.forEach((source, runId) => {
    if (!activeRunIds.has(runId)) {
      source.close();
      eventSources.delete(runId);
    }
  });
  activeRunIds.forEach((runId) => {
    if (eventSources.has(runId)) return;
    const source = new EventSource(`/runs/${runId}/events`);
    source.onmessage = async (event) => {
      const payload = JSON.parse(event.data);
      await loadState({ preserveView: true });
      if (TERMINAL_RUN_STATUSES.has(payload.run_status)) {
        source.close();
        eventSources.delete(runId);
      }
    };
    source.onerror = () => {
      source.close();
      eventSources.delete(runId);
      window.setTimeout(() => loadState({ preserveView: true }), 1000);
    };
    eventSources.set(runId, source);
  });
}

function appExportState() {
  return {
    format: "control-plane-state",
    version: 1,
    features,
    workflow,
    ui: localState.load(),
  };
}

async function saveStateToClipboard() {
  try {
    await navigator.clipboard.writeText(JSON.stringify(appExportState(), null, 2));
    showToast("Application state copied to clipboard");
  } catch {
    showToast("Clipboard access was not available");
  }
}

async function restoreStateFromClipboard() {
  try {
    const state = JSON.parse(await navigator.clipboard.readText());
    if (state?.format !== "control-plane-state" || !Array.isArray(state.features)) {
      throw new Error("Invalid application state");
    }
    await api("/state", {
      method: "PUT",
      body: JSON.stringify({ features: state.features }),
    });
    if (state.ui && typeof state.ui === "object") localState.save(state.ui);
    await loadState({ preserveView: false });
    showToast("Application state restored");
  } catch {
    showToast("Clipboard does not contain valid application state");
  }
}

async function moveToStep(feature, nextStep) {
  await api(`/features/${feature.id}/steps/${nextStep}`, { method: "PATCH" });
  await loadState({ preserveView: true });
  const updated = selectedFeature();
  setView(updated.id, Math.min(nextStep, updated.step));
  showToast(isAgentStep(workflow[nextStep]) ? `${workflow[nextStep].agent} queued` : `Moved to ${workflow[nextStep].state}`);
}

async function updateArtifact(card) {
  const feature = selectedFeature();
  const sourceIndex = Number(card.dataset.sourceIndex);
  const value = card.querySelector(".artifact-editor").value.trim();
  if (!feature || !Number.isInteger(sourceIndex) || !value) return;
  await api(`/features/${feature.id}/artifacts/${sourceIndex}`, {
    method: "PATCH",
    body: JSON.stringify({ content: value }),
  });
  await loadState({ preserveView: true });
  showToast(`${feature.artifacts[sourceIndex].name} saved`);
}

elements.featureList.addEventListener("click", (event) => {
  const card = event.target.closest("[data-feature-id]");
  if (!card) return;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  const feature = features.find((item) => item.id === card.dataset.featureId);
  setView(feature.id, feature.step);
  render();
});

elements.timeline.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-step-index]");
  if (!tab) return;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  setView(selectedFeatureId, Number(tab.dataset.stepIndex));
  renderDetails();
});

document.addEventListener("keydown", (event) => {
  if (
    event.defaultPrevented ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.shiftKey ||
    event.target.closest("input, textarea, select, [contenteditable='true'], dialog[open]")
  ) {
    return;
  }

  const feature = selectedFeature();
  if (!feature) return;

  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    if (!workflowVisible) return;
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    const nextStepIndex = selectedStepIndex + direction;
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
    selectedArtifactIndex = nextIndex;
    renderArtifacts(feature);
    elements.artifactList
      .querySelector(`[data-artifact-index="${nextIndex}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
});

elements.featureSearch.addEventListener("input", (event) => {
  searchTerm = event.target.value.trim();
  localState.save({ searchTerm });
  renderFeatureList();
});

elements.advanceButton.addEventListener("click", async () => {
  const feature = selectedFeature();
  if (!feature || feature.activeRunId || feature.step >= workflow.length - 1) return;
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
    selectedArtifactIndex = Number(card.dataset.artifactIndex);
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
    await updateArtifact(card);
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

document.querySelector("#add-feature-button").addEventListener("click", openFeatureDialog);
document.querySelector("#feature-settings-button").addEventListener("click", openFeatureSettings);
document.querySelector("#hide-features-button").addEventListener("click", () => {
  setFeaturesPanelHidden(!featuresPanelHidden);
});
elements.workflowButton.addEventListener("click", () => {
  setWorkflowVisible(!workflowVisible);
});

document.querySelector("#save-state-button").addEventListener("click", () => {
  closeMenus();
  saveStateToClipboard();
});
document.querySelector("#restore-state-button").addEventListener("click", () => {
  closeMenus();
  restoreStateFromClipboard();
});
document.querySelector("#repository-workflow-button").addEventListener("click", () => {
  closeMenus();
  elements.repositoryWorkflowDialog.showModal();
  document.querySelector("#close-workflow-action").focus();
});
document.querySelector("#validate-repository-button").addEventListener("click", async () => {
  closeMenus();
  validation = await api("/repository/validation");
  renderValidation();
  elements.validationDialog.showModal();
  document.querySelector("#close-validation-action").focus();
});

document.querySelector("#close-workflow-button").addEventListener("click", () => {
  elements.repositoryWorkflowDialog.close();
});
document.querySelector("#close-workflow-action").addEventListener("click", () => {
  elements.repositoryWorkflowDialog.close();
});

document.querySelector("#close-dialog-button").addEventListener("click", () => elements.dialog.close());
document.querySelector("#cancel-dialog-button").addEventListener("click", () => elements.dialog.close());

document.querySelector("#close-settings-button").addEventListener("click", () => elements.settingsDialog.close());
document.querySelector("#cancel-settings-button").addEventListener("click", () => elements.settingsDialog.close());
document.querySelector("#request-delete-feature-button").addEventListener("click", () => {
  const feature = selectedFeature();
  if (!feature) return;
  elements.deleteFeatureName.textContent = feature.name;
  elements.settingsDialog.close();
  elements.deleteDialog.showModal();
});
document.querySelector("#close-delete-button").addEventListener("click", () => elements.deleteDialog.close());
document.querySelector("#cancel-delete-button").addEventListener("click", () => elements.deleteDialog.close());

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
  if (selectedFeatureId) setView(selectedFeatureId, selectedStepIndex, { replace: true });
  showToast(`${feature.name} deleted`);
});

document.querySelector("#close-validation-button").addEventListener("click", () => {
  elements.validationDialog.close();
});
document.querySelector("#close-validation-action").addEventListener("click", () => {
  elements.validationDialog.close();
});
document.querySelector("#rerun-validation-button").addEventListener("click", async () => {
  validation = await api("/repository/validation");
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
  selectedFeatureId = feature.id;
  selectedStepIndex = feature.step;
  searchTerm = "";
  localState.save({ selectedFeatureId, selectedStepIndex, searchTerm });
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

loadState({ preserveView: false }).catch((error) => {
  showToast(error.message);
});
