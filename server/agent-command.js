const path = require("node:path");
const { PORT, workflow } = require("./config");
const {
  getFeatureArtifactFolder,
  getFeatureArtifactFolderPath,
  getFeatureWorkspaceFolderPath,
} = require("./feature-artifacts");

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
  const step = workflow[run.step] ?? {};
  const artifactFolder = getFeatureArtifactFolder(feature);
  const artifactFolderPath = getFeatureArtifactFolderPath(feature);
  return {
    agent: run.agent,
    artifact: run.artifact,
    artifact_folder: artifactFolder,
    artifact_folder_path: artifactFolderPath,
    artifact_path: path.join(artifactFolderPath, run.artifact),
    branch: feature.branch,
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
    run_id: run.id,
    server_port: PORT,
    state: step.state,
    workspace: feature.workspace,
    workspace_path: getFeatureWorkspacePath(feature),
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
