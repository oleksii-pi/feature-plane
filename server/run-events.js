const fsp = require("node:fs/promises");
const path = require("node:path");
const { FEATURE_ROOT } = require("./config");

const runQueues = new Map();
const eventClients = new Map();
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

async function appendRunLog(feature, run, event) {
  const logPath = path.join(FEATURE_ROOT, feature.slug, `${run.agent}.log`);
  await fsp.mkdir(path.dirname(logPath), { recursive: true });
  await fsp.appendFile(logPath, `${JSON.stringify(event)}\n`);
}

async function appendRunLogOutput(feature, run, streamName, message) {
  const entry = {
    timestamp: new Date().toISOString(),
    run_id: run.id,
    level: streamName === "stderr" ? "error" : "info",
    status: streamName,
    message,
  };
  await appendRunLog(feature, run, entry);
}

async function logConfiguredAgentRunStart(feature, run, command, cwd) {
  const message = `Executing agent_run_command: ${command}`;
  console.log(
    `[agent_run_command] feature=${feature.slug} run=${run.id} agent=${run.agent} cwd=${cwd} command=${command}`,
  );
  await appendRunLog(feature, run, {
    timestamp: new Date().toISOString(),
    run_id: run.id,
    level: "info",
    status: "command",
    message,
    cwd,
    command,
  });
}

function createRunEvent(run, status, message, level = "info") {
  return {
    timestamp: new Date().toISOString(),
    run_id: run.id,
    level,
    status,
    message,
  };
}

function isVerboseRunEvent(event) {
  const status = String(event?.status ?? "").toLowerCase();
  return status === "stdout" || status === "stderr";
}

async function persistRunEvent(feature, run, event, options = {}) {
  run.events.push(event);
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

function broadcastRunEvent(run, event) {
  const clients = eventClients.get(run.id);
  if (!clients) return;
  const payload = JSON.stringify({ ...event, run_status: run.status });
  clients.forEach((res) => res.write(`data: ${payload}\n\n`));
}

function streamRunEvents(req, res, run) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  run.events.forEach((event) => {
    res.write(`data: ${JSON.stringify({ ...event, run_status: run.status })}\n\n`);
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
  appendRunLogOutput,
  configureRunEvents,
  isVerboseRunEvent,
  logConfiguredAgentRunStart,
  queueRunEvent,
  streamRunEvents,
};
