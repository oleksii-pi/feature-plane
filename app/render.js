import { elements, showToast } from "./dom.js";
import {
  escapeHtml,
  formatDateTime,
  formatDuration,
  formatLogSize,
  markdownToHtml,
} from "./format.js";
import {
  currentAgentStepRequiresRun,
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

  elements.timeline.innerHTML = state.workflow
    .map((step, actualIndex) => {
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
      const menu = restoreStepMenuMarkup(feature, actualIndex);
      const item =
        actualIndex <= feature.step
          ? `<a class="${classes}" href="${viewUrl(feature.id, actualIndex)}" data-step-index="${actualIndex}"${selected ? ' aria-current="page"' : ""}>${escapeHtml(name)}</a>`
          : `<span class="${classes}">${escapeHtml(name)}</span>`;

      return `<span class="timeline-entry">${item}${menu}</span>`;
    })
    .join("");
}

function restoreStepMenuMarkup(feature, stepIndex) {
  const step = state.workflow[stepIndex] ?? {};
  const agentStep = isAgentStep(step);
  const hasRunForStep = (feature.runs ?? []).some(
    (run) => run.step === stepIndex,
  );
  if (agentStep && !hasRunForStep) return "";
  const commit = agentStep
    ? commitBeforeStep(feature, stepIndex)
    : commitForStep(feature, stepIndex);
  if (!commit || feature.activeRunId || stepIndex > feature.step) return "";
  return restoreMenuMarkup({
    className: "timeline-menu",
    kind: "step",
    label: agentStep
      ? `${step.agent ?? step.state ?? "Agent"} run`
      : step.state ?? `Step ${stepIndex + 1}`,
    detail: agentStep
      ? `Step ${stepIndex + 1} · reset to ${shortCommit(commit)}`
      : `Step ${stepIndex + 1} · ${shortCommit(commit)}`,
    attrs: agentStep
      ? `data-revert-step="${stepIndex}" data-revert-rerun="true"`
      : `data-revert-step="${stepIndex}"`,
    actionLabel: agentStep ? "Rerun" : "Revert to state",
  });
}

function restoreRunMenuMarkup(feature, run) {
  if (feature.activeRunId || run.status !== "succeeded") return "";
  const step = state.workflow[run.step] ?? {};
  if (isAgentStep(step)) {
    const commit = commitBeforeStep(feature, run.step);
    if (!commit) return "";
    return restoreMenuMarkup({
      className: "artifact-card-menu",
      kind: "run",
      label: `${displayRunTitle(step)} run`,
      detail: `Step ${run.step + 1} · reset to ${shortCommit(commit)}`,
      attrs: `data-revert-run-id="${escapeHtml(run.id)}" data-revert-step="${run.step}" data-revert-rerun="true"`,
      actionLabel: "Rerun",
    });
  }
  if (!run.commitSha) return "";
  return restoreMenuMarkup({
    className: "artifact-card-menu",
    kind: "run",
    label: `${displayRunTitle(step)} run`,
    detail: `${run.agent} · ${shortCommit(run.commitSha)}`,
    attrs: `data-revert-run-id="${escapeHtml(run.id)}"`,
  });
}

function restoreArtifactMenuMarkup(feature, artifact, sourceIndex) {
  const commit = artifact.commitSha ?? commitForStep(feature, artifact.availableAtStep ?? 0);
  if (!commit || feature.activeRunId || commitsMatch(commit, feature.headCommit)) return "";
  return restoreMenuMarkup({
    className: "artifact-card-menu",
    kind: "artifact",
    label: artifact.name,
    detail: `Step ${(artifact.availableAtStep ?? 0) + 1} · ${shortCommit(commit)}`,
    attrs: `data-revert-artifact-index="${sourceIndex}"`,
  });
}

function restoreMenuMarkup({ className, kind, label, detail, attrs, actionLabel = "Revert to state" }) {
  return `
    <div class="menu ${className}" data-menu>
      <button class="menu-button" type="button" aria-label="State actions" aria-haspopup="menu" aria-expanded="false">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="5" r="1.75" />
          <circle cx="12" cy="12" r="1.75" />
          <circle cx="12" cy="19" r="1.75" />
        </svg>
      </button>
      <div class="menu-popover" role="menu" hidden>
        <button
          class="revert-state-button"
          type="button"
          role="menuitem"
          data-revert-kind="${kind}"
          data-revert-label="${escapeHtml(label)}"
          data-revert-detail="${escapeHtml(detail)}"
          ${attrs}
        >${escapeHtml(actionLabel)}</button>
      </div>
    </div>
  `;
}

function commitsMatch(left, right) {
  if (!left || !right) return false;
  return String(left).startsWith(String(right)) || String(right).startsWith(String(left));
}

function commitBeforeStep(feature, stepIndex) {
  if (stepIndex <= 0) return null;
  return commitForStep(feature, stepIndex - 1);
}

export function commitForStep(feature, stepIndex) {
  const commits = feature.stepCommits ?? {};
  if (commits[String(stepIndex)]) return commits[String(stepIndex)];
  for (let index = stepIndex; index >= 0; index -= 1) {
    if (commits[String(index)]) return commits[String(index)];
  }
  const run = [...(feature.runs ?? [])]
    .reverse()
    .find((item) => item.status === "succeeded" && item.step <= stepIndex && item.commitSha);
  if (run) return run.commitSha;
  const artifact = [...(feature.artifacts ?? [])]
    .reverse()
    .find((item) => (item.availableAtStep ?? 0) <= stepIndex && item.commitSha);
  return artifact?.commitSha ?? feature.headCommit ?? null;
}

function shortCommit(commit) {
  return String(commit ?? "").slice(0, 7);
}

function displayRunDetails(run) {
  const usage = run.usage ?? {};
  const cost = run.cost ?? "TBD";
  const cachedDetails = usage.cachedInputTokens
    ? ` (${usage.cachedInputTokens} cached)`
    : "";
  const tokenDetails = usage.totalTokens
    ? `IN=${usage.inputTokens ?? 0}${cachedDetails} OUT=${usage.outputTokens ?? 0}`
    : "token usage unavailable";
  const changeDetails = displayFileChanges(run.fileChanges);
  return [`price ${cost}`, `tokens: ${tokenDetails}`, changeDetails]
    .filter(Boolean)
    .join(", ");
}

function displayFileChanges(fileChanges) {
  const changes = [
    ["added", fileChanges?.added],
    ["edited", fileChanges?.edited],
    ["deleted", fileChanges?.deleted],
  ]
    .filter(([, count]) => Number(count) > 0)
    .map(
      ([label, count]) => `${label} ${count} ${count === 1 ? "file" : "files"}`,
    );
  return changes.length ? `Changed files: ${changes.join(", ")}` : "";
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
  const summaryEventIndex = isActiveRun
    ? -1
    : events.findLastIndex((event) => {
        const status = String(event.status ?? "");
        return status !== "stdout" && status !== "stderr";
      });
  const runDetails = summaryEventIndex >= 0 ? displayRunDetails(run) : "";
  const runDuration = formatDuration(run.startedAt, run.finishedAt);
  return events.map((event, index) => {
    const timestamp = formatDateTime(event.timestamp);
    const status = String(event.status ?? "");
    const isOutput = status === "stdout" || status === "stderr";
    const isActiveEvent = index === activeEventIndex;
    const baseMessage = isOutput
      ? event.message
      : `${status}${status ? ": " : ""}${event.message}`;
    const message =
      index === summaryEventIndex &&
      status === "Done" &&
      event.message === "Done."
        ? `${status} in ${runDuration}, ${runDetails}`
        : index === summaryEventIndex
          ? `${baseMessage} ${runDetails}`
          : baseMessage;
    return `<span class="run-event ${isActiveEvent ? "active" : ""} ${isOutput ? "output" : ""}">${escapeHtml(`${timestamp} ${message}`)}</span>`;
  });
}

function runLabel(run) {
  if (run.status === "running" || run.status === "queued") return "Running";
  return run.status.charAt(0).toUpperCase() + run.status.slice(1);
}

function displayRunTitle(step) {
  const title = String(step?.agent ?? step?.state ?? "Run");
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function displayRunPrice(run) {
  return run.cost ?? "TBD";
}

function displayRunProducedMarkup(run) {
  if (run.status !== "succeeded" || !run.artifact) return "";
  return `<span class="run-produced-text">produced <strong>${escapeHtml(run.artifact)}</strong></span>`;
}

function updatedArtifactForRun(run, feature) {
  if (run.status !== "succeeded" || !run.artifact) return "";
  return feature?.artifacts?.find(
    (item) => item.name === run.artifact && (item.availableAtStep ?? 0) === run.step,
  );
}

function displayRunUpdatedMarkup(run, feature) {
  const artifact = updatedArtifactForRun(run, feature);
  if (!artifact?.updated) return "";
  const updatedTime = displayArtifactUpdatedTime(artifact.updated);
  const updatedTitle = displayArtifactUpdatedTitle(artifact.updated);
  return `<span class="artifact-updated" title="${escapeHtml(updatedTitle)}">${escapeHtml(updatedTime)}</span>`;
}

function displayRunDuration(run) {
  return formatDuration(run.startedAt, run.finishedAt);
}

function renderRunLog(run, index, isExpanded, feature) {
  const step = state.workflow[run.step] ?? selectedStep();
  const eventMarkup = displayEvents(run).join("\n");
  const eventCount = run.events?.length ?? 0;
  const hiddenCount = Math.max(0, eventCount - RUN_LOG_PREVIEW_LINE_LIMIT);
  const previewNote = hiddenCount
    ? `<p class="run-log-note">Showing last ${RUN_LOG_PREVIEW_LINE_LIMIT} lines. ${hiddenCount} earlier lines are available in the full log.</p>`
    : "";
  const logUrl = `/runs/${encodeURIComponent(run.id)}/log`;
  const logViewUrl = `${logUrl}/view`;
  return `
    <article class="artifact-card run-log ${run.status} ${isExpanded ? "expanded" : ""}" data-artifact-index="${index}" data-run-id="${escapeHtml(run.id)}">
      <div class="artifact-header">
        ${displayRunUpdatedMarkup(run, feature)}
        <button class="artifact-toggle" type="button" aria-expanded="${isExpanded}">
          <span class="artifact-title">
            <span class="artifact-title-main">
              <strong>${escapeHtml(displayRunTitle(step))}</strong>
              <span class="artifact-label">${escapeHtml(runLabel(run))}</span>
              <span class="execution-duration">${escapeHtml(displayRunDuration(run))}</span>
              <span class="execution-price">${escapeHtml(displayRunPrice(run))}</span>
              ${displayRunProducedMarkup(run)}
            </span>
          </span>
        </button>
        ${restoreRunMenuMarkup(feature, run)}
        <button class="artifact-chevron-button" type="button" aria-label="Toggle run log" aria-expanded="${isExpanded}">
          <span class="artifact-chevron">⌃</span>
        </button>
      </div>
      <div class="artifact-body">
        ${previewNote}
        <pre class="run-events" tabindex="0">${eventMarkup || "No events recorded."}</pre>
        <div class="run-log-footer">
          <span class="run-log-size">${escapeHtml(formatLogSize(run.logSizeBytes))} of logs</span>
          <a class="artifact-log-link" href="${logViewUrl}" target="_blank" rel="noopener">View logs</a>
        </div>
      </div>
    </article>
  `;
}

function creationOrderValue(entry) {
  if (entry.kind === "run") return entry.run.startedAt ?? "";
  return entry.artifact.createdAt ?? entry.artifact.updated ?? "";
}

export function entriesForFeature(feature) {
  if (!feature) return [];
  const artifacts = feature.artifacts.map((artifact, index) => ({
    kind: "artifact",
    artifact,
    sourceIndex: index,
    order: artifact.availableAtStep ?? 0,
    createdOrder: index * 2 + 1,
  }));
  const runs = feature.runs.map((run, index) => ({
    kind: "run",
    run,
    sourceIndex: index,
    order: run.step,
    createdOrder: index * 2,
  }));
  return [...artifacts, ...runs]
    .filter((entry) => entry.order <= state.selectedStepIndex)
    .sort(
      (a, b) =>
        creationOrderValue(a).localeCompare(creationOrderValue(b)) ||
        a.order - b.order ||
        a.createdOrder - b.createdOrder,
    );
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

function isEntryExpandedByDefault(entry) {
  if (entry.kind === "artifact") return true;
  return !TERMINAL_RUN_STATUSES.has(entry.run.status);
}

function displayArtifactUpdatedTime(value) {
  const updated = formatDateTime(value);
  const match = updated.match(/\b(\d{2}:\d{2})(?::\d{2})?$/);
  return match ? match[1] : updated;
}

function displayArtifactUpdatedTitle(value) {
  return `Updated: ${formatDateTime(value)}`;
}

export function renderArtifacts(feature) {
  const entries = entriesForFeature(feature);

  if (!entries.length) {
    elements.artifactList.innerHTML =
      '<div class="empty-state">No artifacts are available for this step.</div>';
    return;
  }

  elements.artifactList.innerHTML = entries
    .map((entry, visibleIndex) => {
      const isExpanded = isEntryExpandedByDefault(entry);
      if (entry.kind === "run") {
        return renderRunLog(entry.run, visibleIndex, isExpanded, feature);
      }

      const artifact = entry.artifact;
      const updatedTime = displayArtifactUpdatedTime(artifact.updated);
      const updatedTitle = displayArtifactUpdatedTitle(artifact.updated);
      return `
        <article class="artifact-card ${isExpanded ? "expanded" : ""}" data-artifact-index="${visibleIndex}" data-source-index="${entry.sourceIndex}">
          <div class="artifact-header">
            <span class="artifact-updated" title="${escapeHtml(updatedTitle)}">${escapeHtml(updatedTime)}</span>
            <button class="artifact-toggle" type="button" aria-expanded="${isExpanded}">
              <span class="artifact-title">
                <strong>${escapeHtml(artifact.name)}</strong>
              </span>
            </button>
            <button class="artifact-log-link edit-artifact-button" type="button">Edit</button>
            ${restoreArtifactMenuMarkup(feature, artifact, entry.sourceIndex)}
            <button class="artifact-chevron-button" type="button" aria-label="Toggle artifact" aria-expanded="${isExpanded}">
              <span class="artifact-chevron">⌃</span>
            </button>
          </div>
          <div class="artifact-body">
            <div class="artifact-preview">${markdownToHtml(artifact.content)}</div>
            <div class="artifact-edit" hidden>
              <textarea class="artifact-editor" aria-label="Edit ${escapeHtml(artifact.name)}">${escapeHtml(artifact.content)}</textarea>
              <div class="artifact-toolbar">
                <button class="secondary-button cancel-edit-button" type="button">Cancel</button>
                <button class="primary-button save-artifact-button" type="button">Save changes</button>
              </div>
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
    elements.retryRunButton.classList.remove("visible");
    elements.cancelRunButton.classList.remove("visible");
    elements.artifactList.innerHTML =
      '<div class="empty-state">Create a feature to start the workflow.</div>';
    renderTimeline(null);
    return;
  }

  elements.featureTitle.textContent = feature.name;
  elements.featureMeta.replaceChildren();
  const branchButton = document.createElement("button");
  branchButton.className = "link-button branch-copy-button";
  branchButton.type = "button";
  branchButton.textContent = feature.branch;
  branchButton.title = "Copy branch name";
  branchButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(feature.branch);
      showToast("Branch copied to clipboard");
    } catch {
      showToast("Clipboard access was not available");
    }
  });
  elements.featureMeta.append(
    branchButton,
    ` · ${formatDateTime(feature.updated)}`,
  );
  if (feature.environmentUrl) {
    const environmentLink = document.createElement("a");
    environmentLink.className = "environment-link";
    environmentLink.href = feature.environmentUrl;
    environmentLink.target = "_blank";
    environmentLink.rel = "noopener";
    environmentLink.textContent = "Open environment";
    elements.featureMeta.append(" · ", environmentLink);
  }
  elements.stateBadge.textContent = displayStep(feature);
  elements.stateBadge.classList.toggle("running", Boolean(feature.activeRunId));
  elements.advanceButton.disabled =
    Boolean(feature.activeRunId) || feature.step === state.workflow.length - 1;
  elements.advanceButton.textContent =
    feature.step === state.workflow.length - 1
      ? "Feature complete"
      : currentAgentStepRequiresRun(feature)
        ? `Run ${state.workflow[feature.step].agent}`
      : "Move to next step";
  const run = latestRun(feature);
  elements.retryRunButton.classList.toggle(
    "visible",
    Boolean(
      run &&
      run.step === feature.step &&
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
  elements.repositoryWorkflowSteps.innerHTML = state.workflow
    .map((step, index) => {
      const owner = isAgentStep(step) ? "Agent" : "Human";
      const details = step.artifact
        ? isAgentStep(step)
          ? `produces <code>${escapeHtml(step.artifact)}</code>`
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
