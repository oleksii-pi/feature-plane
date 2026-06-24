const fs = require("node:fs");
const path = require("node:path");
const { FEATURE_ROOT, FEATURES_HOME, PORT, ROOT, getFeatureRunCommand, sdlcConfig, workflow } = require("./config");
const { expandCommandTemplate } = require("./agent-command");

function validateRepository() {
  const featureRunCommand = getFeatureRunCommand();
  const instructionFilesPresent = (sdlcConfig.agents ?? []).every((agent) =>
    fs.existsSync(path.join(ROOT, ".instructions", `${agent}.agent.md`)),
  );
  const checks = [
    {
      name: "Feature artifact folders",
      status: fs.existsSync(FEATURE_ROOT) ? "passed" : "failed",
      message: `${path.relative(ROOT, FEATURE_ROOT)} stores feature prompts, artifacts, and agent logs.`,
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
      message: "Run logs are appended as <agent>.agent.log under the matching feature artifact folder.",
    },
    {
      name: "Feature run command",
      status: featureRunCommand ? "passed" : "warning",
      message: featureRunCommand
        ? "feature_run_command is configured in .env."
        : "feature_run_command is not configured in .env.",
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
    completedAt: new Date().toLocaleString(),
  };
}

function resolveConfiguredFeatureRunCommand() {
  const template = getFeatureRunCommand();
  if (!template) return { command: "", unresolved: [] };
  return expandCommandTemplate(template, { server_port: PORT });
}

module.exports = {
  resolveConfiguredFeatureRunCommand,
  validateRepository,
};
