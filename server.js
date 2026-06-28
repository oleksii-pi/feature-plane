const http = require("node:http");
const { PORT } = require("./server/config");
const { configureFeatures, saveFeatureFiles } = require("./server/features");
const { configureRunEvents } = require("./server/run-events");
const { startRun } = require("./server/runs");
const { configureState, ensureStorage, saveState } = require("./server/state");
const { configureRevert } = require("./server/revert");
const { handle } = require("./server/router");
const { validateRepository } = require("./server/validation");
const { stopAllConfiguredRuns } = require("./server/configured-runner");

function formatLocalDateTime(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

configureFeatures({ startRun });
configureRevert({ saveFeatureFiles, startRun });
configureRunEvents({ saveFeatureFiles, saveState });
configureState({ saveFeatureFiles, validateRepository });

ensureStorage()
  .then(() => {
    const server = http.createServer(handle);
    configureShutdown(server);
    server.listen(PORT, "127.0.0.1", () => {
      console.log(`${formatLocalDateTime()} Control Plane PoC listening on http://127.0.0.1:${PORT}`);
    });
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

function configureShutdown(server) {
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopAllConfiguredRuns();
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => {
      process.exit(0);
    }, 6000).unref();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
