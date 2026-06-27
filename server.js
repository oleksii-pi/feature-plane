const http = require("node:http");
const { PORT } = require("./server/config");
const { configureFeatures, saveFeatureFiles } = require("./server/features");
const { configureRunEvents } = require("./server/run-events");
const { startRun } = require("./server/runs");
const { configureState, ensureStorage, saveState } = require("./server/state");
const { handle } = require("./server/router");
const { validateRepository } = require("./server/validation");

function formatLocalDateTime(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

configureFeatures({ startRun });
configureRunEvents({ saveFeatureFiles, saveState });
configureState({ saveFeatureFiles, validateRepository });

ensureStorage()
  .then(() => {
    http.createServer(handle).listen(PORT, "127.0.0.1", () => {
      console.log(`${formatLocalDateTime()} Control Plane PoC listening on http://127.0.0.1:${PORT}`);
    });
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
