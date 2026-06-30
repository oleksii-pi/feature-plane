import { loadState } from "./api.js";
import { formatDuration } from "./format.js";
import { renderDetails, renderFeatureList } from "./render.js";
import {
  findRunById,
  RUN_LOG_PREVIEW_LINE_LIMIT,
  state,
  TERMINAL_RUN_STATUSES,
} from "./state.js";

export function scheduleRunStreamRender(runId) {
  if (state.runStreamRenderPending) return;
  state.runStreamRenderPending = true;
  window.requestAnimationFrame(() => {
    state.runStreamRenderPending = false;
    const feature = runId ? findFeatureByRunId(runId) : null;
    renderFeatureList();
    if (!runId || feature?.id === state.selectedFeatureId) renderDetails();
  });
}

function eventKey(event) {
  return [
    event?.timestamp ?? "",
    event?.status ?? "",
    event?.level ?? "",
    event?.message ?? "",
  ].join("\u0000");
}

function appendPreviewEvent(run, payload) {
  const events = run.events ?? [];
  const nextKey = eventKey(payload);
  if (payload.replay && events.some((event) => eventKey(event) === nextKey)) {
    return;
  }
  run.events = [...events, payload].slice(-RUN_LOG_PREVIEW_LINE_LIMIT);
}

function findFeatureByRunId(runId) {
  return (
    state.features.find((feature) =>
      feature.runs?.some((run) => run.id === runId),
    ) ?? null
  );
}

function updateActiveRunDurations() {
  document.querySelectorAll(".run-log[data-run-id]").forEach((card) => {
    const run = findRunById(card.dataset.runId);
    if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return;
    const duration = card.querySelector(".execution-duration");
    if (duration) duration.textContent = formatDuration(run.startedAt);
  });
}

function syncRunDurationTimer(activeRunIds) {
  if (!activeRunIds.size) {
    if (state.runDurationTimer) {
      window.clearInterval(state.runDurationTimer);
      state.runDurationTimer = null;
    }
    return;
  }

  if (state.runDurationTimer) return;
  state.runDurationTimer = window.setInterval(updateActiveRunDurations, 1000);
}

export function syncRunStreams() {
  const activeRunIds = new Set(
    state.features.flatMap((feature) =>
      feature.activeRunId ? [feature.activeRunId] : [],
    ),
  );
  syncRunDurationTimer(activeRunIds);
  state.eventSources.forEach((source, runId) => {
    if (!activeRunIds.has(runId)) {
      source.close();
      state.eventSources.delete(runId);
    }
  });
  activeRunIds.forEach((runId) => {
    if (state.eventSources.has(runId)) return;
    const source = new EventSource(`/runs/${runId}/events`);
    source.onmessage = async (event) => {
      const payload = JSON.parse(event.data);
      const run = findRunById(payload.run_id);
      if (run) {
        const feature = findFeatureByRunId(payload.run_id);
        if (feature && payload.feature_environment_url) {
          feature.environmentUrl = payload.feature_environment_url;
        }
        run.status = payload.run_status ?? run.status;
        run.logSizeBytes = payload.log_size_bytes ?? run.logSizeBytes ?? 0;
        run.cost = payload.run_cost ?? run.cost ?? "";
        run.usage = payload.run_usage ?? run.usage ?? null;
        run.pricing = payload.run_pricing ?? run.pricing ?? null;
        if (feature && payload.feature_cost !== undefined) {
          feature.cost = payload.feature_cost;
        }
        if (payload.preview !== false) {
          appendPreviewEvent(run, payload);
        }
        scheduleRunStreamRender(payload.run_id);
      } else {
        await loadState({ preserveView: true });
      }
      if (TERMINAL_RUN_STATUSES.has(payload.run_status)) {
        source.close();
        state.eventSources.delete(runId);
        await loadState({ preserveView: true });
      }
    };
    source.onerror = () => {
      source.close();
      state.eventSources.delete(runId);
      window.setTimeout(() => loadState({ preserveView: true }), 1000);
    };
    state.eventSources.set(runId, source);
  });
}
