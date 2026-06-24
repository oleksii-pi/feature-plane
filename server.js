const http = require("node:http");
const { PORT } = require("./server/config");
const { configureFeatures, saveFeatureFiles } = require("./server/features");
const { configureRunEvents } = require("./server/run-events");
const { startRun } = require("./server/runs");
const { configureState, ensureStorage, saveState } = require("./server/state");
const { handle } = require("./server/router");
const { resolveConfiguredFeatureRunCommand, validateRepository } = require("./server/validation");

configureFeatures({ startRun });
configureRunEvents({ saveFeatureFiles, saveState });
configureState({ saveFeatureFiles, validateRepository });

ensureStorage()
  .then(() => {
    http.createServer(handle).listen(PORT, "127.0.0.1", () => {
      console.log(`Control Plane PoC listening on http://127.0.0.1:${PORT}`);
      const { command, unresolved } = resolveConfiguredFeatureRunCommand();
      if (command && !unresolved.length) {
        console.log(`Configured feature_run_command: ${command}`);
      } else if (unresolved.length) {
        console.warn(`feature_run_command has unresolved placeholder(s): ${unresolved.join(", ")}`);
      }
    });
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
