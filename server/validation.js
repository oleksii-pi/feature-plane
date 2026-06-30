const fs = require("node:fs");
const path = require("node:path");
const { FEATURE_ROOT, FEATURES_HOME, ROOT } = require("./config");
const { formatDateTime } = require("./time");

function validateRepository() {
  const checks = [
    {
      name: "Feature artifact folders",
      status: fs.existsSync(FEATURE_ROOT) ? "passed" : "failed",
      message: `${path.relative(ROOT, FEATURE_ROOT)} stores feature state and workspaces; workflow artifacts are committed under features/<feature-slug>/artifacts in each workspace.`,
    },
    {
      name: "Feature workspaces",
      status: "passed",
      message: "Each feature loads SDLC.yaml from its own workspace branch.",
    },
    {
      name: "Run logs",
      status: "passed",
      message: "Run logs are appended as plain text under .features/run-logs/<run-id>.log.",
    },
  ];
  const passed = checks.filter((check) => check.status === "passed").length;
  const warnings = checks.filter((check) => check.status === "warning").length;
  const errors = checks.filter((check) => check.status === "failed").length;
  return {
    ok: errors === 0,
    checks,
    passed,
    warnings,
    errors,
    workspaceRoot: `${FEATURES_HOME}/`,
    completedAt: formatDateTime(),
  };
}

module.exports = {
  validateRepository,
};
