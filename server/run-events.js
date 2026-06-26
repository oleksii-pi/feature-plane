const fsp = require("node:fs/promises");
const path = require("node:path");
const { RUN_LOG_ROOT } = require("./config");
const { formatDateTime } = require("./time");

const runQueues = new Map();
const eventClients = new Map();
const RUN_LOG_PREVIEW_LINE_LIMIT = 50;
let persistence = null;

function configureRunEvents(nextPersistence) {
  persistence = nextPersistence;
}

function enqueueRunTask(runId, task) {
  const previous = runQueues.get(runId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => task())
    .catch((error) => {
      console.error(error);
    });
  runQueues.set(runId, next);
  next.finally(() => {
    if (runQueues.get(runId) === next) runQueues.delete(runId);
  });
  return next;
}

function formatRunLogLine(event) {
  const timestamp = formatDateTime(event.timestamp || undefined);
  const stream = event.status ?? "event";
  const message = String(event.message ?? "");
  return `[${timestamp}] [${stream}] ${message}`;
}

async function appendRunLog(feature, run, event) {
  const logPath = path.join(RUN_LOG_ROOT, `${run.id}.log`);
  await fsp.mkdir(path.dirname(logPath), { recursive: true });
  await fsp.appendFile(logPath, `${formatRunLogLine(event)}\n`);
  const stat = await fsp.stat(logPath);
  run.logSizeBytes = stat.size;
}

async function appendRunOutput(feature, run, stream, chunk) {
  const message = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
  if (!message) return;
  const logPath = path.join(RUN_LOG_ROOT, `${run.id}.log`);
  await fsp.mkdir(path.dirname(logPath), { recursive: true });
  await fsp.appendFile(
    logPath,
    `[${formatDateTime()}] [${stream}]\n${message}${message.endsWith("\n") ? "" : "\n"}`,
  );
  const stat = await fsp.stat(logPath);
  run.logSizeBytes = stat.size;
}

function createRunEvent(run, status, message, level = "info") {
  return {
    timestamp: formatDateTime(),
    run_id: run.id,
    level,
    status,
    message,
  };
}

function isVerboseRunEvent(event) {
  return false;
}

async function persistRunEvent(feature, run, event, options = {}) {
  run.events.push(event);
  if (run.events.length > RUN_LOG_PREVIEW_LINE_LIMIT) {
    run.events.splice(0, run.events.length - RUN_LOG_PREVIEW_LINE_LIMIT);
  }
  if (options.appendLog !== false) {
    await appendRunLog(feature, run, event);
  }
  if (options.saveState !== false && persistence) {
    await persistence.saveFeatureFiles(feature);
    await persistence.saveState();
  }
  if (options.broadcast !== false) broadcastRunEvent(run, event);
  return event;
}

async function addEvent(feature, run, status, message, level = "info", options = {}) {
  const event = createRunEvent(run, status, message, level);
  return persistRunEvent(feature, run, event, {
    appendLog: options.persist !== false,
    broadcast: options.broadcast !== false,
    saveState: options.persist !== false,
  });
}

async function queueRunEvent(feature, run, status, message, level = "info") {
  return enqueueRunTask(run.id, () => {
    if (run.status !== "queued" && run.status !== "running") return null;
    return persistRunEvent(feature, run, createRunEvent(run, status, message, level), {
      appendLog: true,
      broadcast: true,
      saveState: false,
    });
  });
}

async function queueRunOutput(feature, run, stream, chunk) {
  return enqueueRunTask(run.id, async () => {
    if (run.status !== "queued" && run.status !== "running") return null;
    await appendRunOutput(feature, run, stream, chunk);
    broadcastRunEvent(run, {
      timestamp: formatDateTime(),
      run_id: run.id,
      level: "info",
      status: stream,
      message: "",
      preview: false,
    });
    return null;
  });
}

function broadcastRunEvent(run, event) {
  const clients = eventClients.get(run.id);
  if (!clients) return;
  const payload = JSON.stringify({
    ...event,
    log_size_bytes: run.logSizeBytes ?? 0,
    run_status: run.status,
  });
  clients.forEach((res) => res.write(`data: ${payload}\n\n`));
}

function streamRunEvents(req, res, run) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  run.events.forEach((event) => {
    res.write(
      `data: ${JSON.stringify({
        ...event,
        log_size_bytes: run.logSizeBytes ?? 0,
        run_status: run.status,
        replay: true,
      })}\n\n`,
    );
  });
  if (run.status !== "queued" && run.status !== "running") {
    res.end();
    return;
  }
  const clients = eventClients.get(run.id) ?? new Set();
  clients.add(res);
  eventClients.set(run.id, clients);
  req.on("close", () => {
    clients.delete(res);
    if (!clients.size) eventClients.delete(run.id);
  });
}

module.exports = {
  addEvent,
  configureRunEvents,
  isVerboseRunEvent,
  queueRunEvent,
  queueRunOutput,
  RUN_LOG_PREVIEW_LINE_LIMIT,
  streamRunEvents,
};
