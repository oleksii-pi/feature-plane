import { elements } from "./dom.js";
import {
  escapeHtml,
  formatDateTime,
  formatDateTimeParts,
  formatLogSize,
  markdownToHtml,
} from "./format.js";
import {
  displayStep,
  isAgentStep,
  latestCost,
  latestRun,
  RUN_LOG_PREVIEW_LINE_LIMIT,
  selectedFeature,
  selectedStep,
  state,
  TERMINAL_RUN_STATUSES,
  viewUrl,
} from "./state.js";

export function renderFeatureList() {
  const visibleFeatures = state.features.filter((feature) =>
    feature.name.toLowerCase().includes(state.searchTerm.toLowerCase()),
  );

  if (!visibleFeatures.length) {
    elements.featureList.innerHTML =
      '<div class="empty-state">No features yet. Add one to create a feature workspace.</div>';
    return;
  }

  elements.featureList.innerHTML = visibleFeatures
    .map((feature) => {
      const progress = Math.round(
        (feature.step / (state.workflow.length - 1)) * 100,
      );
      const run = latestRun(feature);
      const status = run ? `Last run: ${run.status}` : "No runs yet";
      return `
        <a
          class="feature-card ${feature.id === state.selectedFeatureId ? "selected" : ""} ${feature.activeRunId ? "running" : ""}"
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

export function renderTimeline(feature) {
  if (!feature) {
    elements.timeline.innerHTML = "";
    return;
  }
  const start = Math.max(0, state.selectedStepIndex - 3);
  const end = Math.min(
    state.workflow.length,
    Math.max(state.selectedStepIndex + 3, 6),
  );

  elements.timeline.innerHTML = state.workflow
    .slice(start, end)
    .map((step, index) => {
      const actualIndex = start + index;
      const stepState =
        actualIndex < feature.step
          ? "done"
          : actualIndex === feature.step
            ? "current"
            : "";
      const running =
        actualIndex === feature.step && feature.activeRunId ? "running" : "";
      const selected =
        actualIndex === state.selectedStepIndex ? "selected" : "";
      const name = running ? displayStep(feature) : step.state;
      const classes = `timeline-item ${stepState} ${running} ${selected}`;

      if (actualIndex <= feature.step) {
        return `<a class="${classes}" href="${viewUrl(feature.id, actualIndex)}" data-step-index="${actualIndex}"${selected ? ' aria-current="page"' : ""}>${escapeHtml(name)}</a>`;
      }

      return `<span class="${classes}">${escapeHtml(name)}</span>`;
    })
    .join("");
}

function displayEvents(run) {
  const events = (run.events ?? []).slice(-RUN_LOG_PREVIEW_LINE_LIMIT);
  const isActiveRun = !TERMINAL_RUN_STATUSES.has(run.status);
  const activeEventIndex = isActiveRun
    ? events.findLastIndex((event) => {
        const status = String(event.status ?? "");
        return status !== "stdout" && status !== "stderr";
      })
    : -1;
  return events.map((event, index) => {
    const timestamp = formatDateTimeParts(event.timestamp);
    const status = String(event.status ?? "");
    const isOutput = status === "stdout" || status === "stderr";
    const isActiveEvent = index === activeEventIndex;
    const message = isOutput
      ? event.message
      : `${status}${status ? ": " : ""}${event.message}`;
    return `
      <div class="run-event ${isActiveEvent ? "active" : ""} ${isOutput ? "output" : ""}">
        <span class="run-event-time"><span>${escapeHtml(timestamp.date)}</span><span>${escapeHtml(timestamp.time)}</span></span>
        ${isActiveEvent ? '<span class="event-dot"></span>' : '<span aria-hidden="true"></span>'}
        <span>${escapeHtml(message)}</span>
      </div>
    `;
  });
}

function runLabel(run) {
  if (run.status === "running" || run.status === "queued") return "Running";
  return run.status.charAt(0).toUpperCase() + run.status.slice(1);
}

function renderRunLog(run, index, isExpanded) {
  const step = state.workflow[run.step] ?? selectedStep();
  const eventMarkup = displayEvents(run).join("");
  const logPath = `.features/run-logs/${run.id}.log`;
  const eventCount = run.events?.length ?? 0;
  const hiddenCount = Math.max(0, eventCount - RUN_LOG_PREVIEW_LINE_LIMIT);
  const previewNote = hiddenCount
    ? `<p class="run-log-note">Showing last ${RUN_LOG_PREVIEW_LINE_LIMIT} lines. ${hiddenCount} earlier lines are available in the full log.</p>`
    : "";
  const logUrl = `/runs/${encodeURIComponent(run.id)}/log`;
  const logViewUrl = `${logUrl}/view`;
  return `
    <article class="artifact-card run-log ${run.status} ${isExpanded ? "expanded" : ""}" data-artifact-index="${index}">
      <div class="artifact-header">
        <button class="artifact-toggle" type="button" aria-expanded="${isExpanded}">
          <span class="artifact-label">${escapeHtml(runLabel(run))}</span>
          <span class="artifact-title">
            <strong>${escapeHtml(step?.agent ?? step?.state ?? "Run")}</strong>
            <span>${escapeHtml(run.status)} · ${escapeHtml(logPath)}</span>
          </span>
        </button>
        <span class="artifact-header-actions">
          <a class="artifact-log-link" href="${logViewUrl}" target="_blank" rel="noopener">View logs</a>
          <a class="artifact-log-link" href="${logUrl}?download=1" download>Download</a>
        </span>
        <button class="artifact-chevron-button" type="button" aria-label="Toggle run log" aria-expanded="${isExpanded}">
          <span class="artifact-chevron">⌃</span>
        </button>
      </div>
      <div class="artifact-body">
        ${previewNote}
        <div class="run-events">${eventMarkup || "<p>No events recorded.</p>"}</div>
        <p class="run-log-size">${escapeHtml(formatLogSize(run.logSizeBytes))} of logs</p>
      </div>
    </article>
  `;
}

export function entriesForFeature(feature) {
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
    .filter((entry) => entry.order <= state.selectedStepIndex)
    .sort((a, b) => a.order - b.order || a.kind.localeCompare(b.kind));
}

export function artifactIndexForStep(feature) {
  const entries = entriesForFeature(feature);
  if (
    state.selectedArtifactIndex !== null &&
    entries.some((_, index) => index === state.selectedArtifactIndex)
  ) {
    return state.selectedArtifactIndex;
  }
  return entries.length ? entries.length - 1 : null;
}

export function renderArtifacts(feature) {
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
        return renderRunLog(entry.run, visibleIndex, isExpanded);
      }

      const artifact = entry.artifact;
      const isLatest = visibleIndex === entries.length - 1;
      return `
        <article class="artifact-card ${isLatest ? "latest" : ""} ${isExpanded ? "expanded" : ""}" data-artifact-index="${visibleIndex}" data-source-index="${entry.sourceIndex}">
          <button class="artifact-header" type="button" aria-expanded="${isExpanded}">
            <span class="artifact-title"><strong>${escapeHtml(artifact.name)}</strong><span>Updated ${escapeHtml(formatDateTime(artifact.updated))} · ${escapeHtml(artifact.path)}</span></span>
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

export function renderDetails() {
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
  elements.featureMeta.append(
    branchLink,
    ` · ${formatDateTime(feature.updated)} · ${feature.artifactFolder || feature.workspace}`,
  );
  elements.stateBadge.textContent = displayStep(feature);
  elements.stateBadge.classList.toggle("running", Boolean(feature.activeRunId));
  elements.advanceButton.disabled =
    Boolean(feature.activeRunId) || feature.step === state.workflow.length - 1;
  elements.advanceButton.textContent =
    feature.step === state.workflow.length - 1
      ? "Feature complete"
      : "Move to next step";
  elements.backStepButton.disabled =
    Boolean(feature.activeRunId) || feature.step === 0;
  const run = latestRun(feature);
  elements.retryRunButton.classList.toggle(
    "visible",
    Boolean(
      run &&
        TERMINAL_RUN_STATUSES.has(run.status) &&
        isAgentStep(state.workflow[feature.step]),
    ),
  );
  elements.cancelRunButton.classList.toggle(
    "visible",
    Boolean(feature.activeRunId),
  );
  renderTimeline(feature);
  renderArtifacts(feature);
}

export function renderRepositoryWorkflow() {
  elements.workflowSource.innerHTML = `
    <span><strong>Source</strong><code>server.js</code></span>
    <span><strong>Artifact root</strong><code>feature/</code></span>
    <span><strong>Features</strong>${state.features.length}</span>
  `;
  elements.repositoryWorkflowSteps.innerHTML = state.workflow
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

export function renderValidation() {
  if (!state.validation) return;
  elements.validationTitle.textContent = state.validation.ok
    ? "Repository is compliant"
    : "Repository needs attention";
  elements.validationContext.innerHTML = `
    <span><strong>Workspace root</strong><code>${escapeHtml(state.validation.workspaceRoot)}</code></span>
    <span><strong>Completed</strong>${escapeHtml(formatDateTime(state.validation.completedAt))}</span>
  `;
  elements.validationSummary.innerHTML = `
    <span class="validation-score">${state.validation.passed} of ${state.validation.checks.length} checks passed</span>
    <span>${state.validation.errors} errors · ${state.validation.warnings} warnings</span>
  `;
  elements.validationList.innerHTML = state.validation.checks
    .map(
      (check) => `
      <article class="validation-check ${escapeHtml(check.status)}">
        <span class="check-icon" aria-hidden="true">${check.status === "passed" ? "✓" : check.status === "warning" ? "!" : "×"}</span>
        <div><strong>${escapeHtml(check.name)}</strong><p>${escapeHtml(check.message)}</p></div>
        <span class="check-status">${escapeHtml(check.status)}</span>
      </article>
    `,
    )
    .join("");
}

export function render() {
  elements.workspace.classList.toggle(
    "features-collapsed",
    state.featuresPanelHidden,
  );
  elements.timeline.hidden = !state.workflowVisible;
  elements.workflowButton.setAttribute(
    "aria-checked",
    String(state.workflowVisible),
  );
  renderFeatureList();
  renderDetails();
  renderRepositoryWorkflow();
  renderValidation();
}
