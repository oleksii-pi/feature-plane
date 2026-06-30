const path = require("node:path");
const { PORT, ROOT } = require("./config");
const {
  getFeatureArtifactFolder,
  getFeatureArtifactFolderPath,
  getFeatureWorkspaceArtifactFolder,
  getFeatureWorkspaceFolderPath,
} = require("./feature-artifacts");
const { featureStep } = require("./workflow");

function isInteractiveCodexCommand(command) {
  const normalized = String(command ?? "").trim();
  return /^codex(?:\s|$)/.test(normalized) && !/^codex\s+exec(?:\s|$)/.test(normalized);
}

function getFeatureWorkspacePath(feature) {
  return getFeatureWorkspaceFolderPath(feature);
}

function getAgentInstructionPath(feature, agent) {
  return path.join(getFeatureWorkspacePath(feature), ".instructions", `${agent}.agent.md`);
}

function buildAgentContext(feature, run) {
  const step = featureStep(feature, run.step) ?? {};
  const artifactFolder = getFeatureWorkspaceArtifactFolder(feature);
  const storedArtifactFolder = getFeatureArtifactFolder(feature);
  const artifactFolderPath = getFeatureArtifactFolderPath(feature);
  const artifactRelativePath = `${artifactFolder}/${run.artifact}`;
  const changeRequestArtifact = run.changeRequestArtifact ?? "";
  const changeRequestRelativePath = changeRequestArtifact
    ? `${artifactFolder}/${changeRequestArtifact}`
    : "";
  const promptRelativePath = `${artifactFolder}/prompt.md`;
  return {
    agent: run.agent,
    artifact: run.artifact,
    artifact_folder: artifactFolder,
    artifact_folder_path: artifactFolderPath,
    artifact_path: path.join(artifactFolderPath, run.artifact),
    artifact_relative_path: artifactRelativePath,
    branch: feature.branch,
    change_request_artifact: changeRequestArtifact,
    change_request_path: changeRequestArtifact
      ? path.join(artifactFolderPath, changeRequestArtifact)
      : "",
    change_request_relative_path: changeRequestRelativePath,
    context_folder: artifactFolder,
    context_folder_path: artifactFolderPath,
    default_branch: String(process.env.default_branch ?? ""),
    feature_id: feature.id,
    feature_name: feature.name,
    feature_slug: feature.slug,
    feature_title: feature.name,
    instruction_path: getAgentInstructionPath(feature, run.agent),
    llm_model_name: String(process.env.llm_model_name ?? ""),
    prompt_path: path.join(artifactFolderPath, "prompt.md"),
    prompt_relative_path: promptRelativePath,
    repository_root: ROOT,
    run_id: run.id,
    server_port: PORT,
    state: step.state,
    stored_artifact_folder: storedArtifactFolder,
    workspace: feature.workspace,
    workspace_path: getFeatureWorkspacePath(feature),
    workspace_artifact_folder: artifactFolder,
    workspace_artifact_path: artifactRelativePath,
  };
}

function shellEscape(value) {
  const text = String(value ?? "");
  if (!text.length) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return "'" + text.split("'").join("'\"'\"'") + "'";
}

function expandCommandTemplate(template, context) {
  const aliases = Object.create(null);
  Object.entries(context).forEach(([key, value]) => {
    aliases[String(key).toLowerCase().replace(/-/g, "_")] = value;
  });
  const unresolved = [];
  const command = String(template).replace(
    /%([a-zA-Z0-9_-]+)%|\$\{([a-zA-Z0-9_-]+)\}/g,
    (match, percentKey, braceKey) => {
      const key = String(percentKey ?? braceKey ?? "")
        .toLowerCase()
        .replace(/-/g, "_");
      if (!key || !Object.prototype.hasOwnProperty.call(aliases, key)) {
        unresolved.push(match);
        return match;
      }
      return shellEscape(aliases[key]);
    },
  );

  return { command, unresolved };
}

module.exports = {
  buildAgentContext,
  expandCommandTemplate,
  getFeatureWorkspacePath,
  isInteractiveCodexCommand,
};
