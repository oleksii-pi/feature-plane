import { loadState } from "./api.js";
import { render } from "./render.js";
import {
  findRunById,
  RUN_LOG_PREVIEW_LINE_LIMIT,
  state,
  TERMINAL_RUN_STATUSES,
} from "./state.js";

export function scheduleRunStreamRender() {
  if (state.runStreamRenderPending) return;
  state.runStreamRenderPending = true;
  window.requestAnimationFrame(() => {
    state.runStreamRenderPending = false;
    render();
  });
}

export function syncRunStreams() {
  const activeRunIds = new Set(
    state.features.flatMap((feature) =>
      feature.activeRunId ? [feature.activeRunId] : [],
    ),
  );
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
        run.status = payload.run_status ?? run.status;
        run.logSizeBytes = payload.log_size_bytes ?? run.logSizeBytes ?? 0;
        if (payload.preview !== false) {
          run.events = [...(run.events ?? []), payload].slice(
            -RUN_LOG_PREVIEW_LINE_LIMIT,
          );
        }
        scheduleRunStreamRender();
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
