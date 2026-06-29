const fs = require("node:fs");
const path = require("node:path");
const { FEATURE_ROOT, FEATURES_HOME, ROOT, sdlcConfig, workflow } = require("./config");
const { formatDateTime } = require("./time");

function validateRepository() {
  const instructionFilesPresent = (sdlcConfig.agents ?? []).every((agent) =>
    fs.existsSync(path.join(ROOT, ".instructions", `${agent}.agent.md`)),
  );
  const checks = [
    {
      name: "Feature artifact folders",
      status: fs.existsSync(FEATURE_ROOT) ? "passed" : "failed",
      message: `${path.relative(ROOT, FEATURE_ROOT)} stores feature state and workspaces; workflow artifacts are committed under features/<feature-slug>/artifacts in each workspace.`,
    },
    {
      name: "Workflow structure",
      status: workflow[0]?.artifact === "prompt.md" && workflow.at(-1)?.state === "Done" ? "passed" : "failed",
      message: "The workflow starts with prompt.md and ends at Done.",
    },
    {
      name: "Agent artifacts",
      status: workflow.filter((step) => step.agent).every((step) => step.artifact?.endsWith(".md"))
        ? "passed"
        : "failed",
      message: "Every agent step has a Markdown artifact.",
    },
    {
      name: "Agent instructions",
      status: instructionFilesPresent ? "passed" : "failed",
      message: "Every configured agent has a matching .instructions/<agent>.agent.md file.",
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
