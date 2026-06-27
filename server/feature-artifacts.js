const path = require("node:path");
const { FEATURES_HOME, ROOT } = require("./config");
const { httpError } = require("./http");

function assertSafeRelativePath(relativePath) {
  const normalized = String(relativePath ?? "").replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw httpError(422, "Feature artifact folders must be safe relative paths.");
  }
  return normalized;
}

function branchArtifactFolder(branch, slug) {
  return `${branchWorkspaceFolder(branch, slug)}/.artifacts`;
}

function branchWorkspaceFolder(branch, slug) {
  const branchName = normalizeFeatureBranch(branch, slug);
  const branchSuffix = assertSafeRelativePath(branchName.slice("feature/".length));
  return `${FEATURES_HOME}/${branchSuffix}`;
}

function normalizeFeatureBranch(branch, slug) {
  const featureBranchPrefix = "feature/";
  const branchName = String(branch ?? `feature/${slug}`).replace(/\\/g, "/");
  if (!branchName.startsWith(featureBranchPrefix)) {
    throw httpError(422, "Feature branches must live under feature/.");
  }
  assertSafeRelativePath(branchName.slice(featureBranchPrefix.length));
  return branchName;
}

function getFeatureWorkspaceFolder(feature) {
  return feature.workspace || branchWorkspaceFolder(feature.branch, feature.slug);
}

function getFeatureWorkspaceFolderPath(feature) {
  return path.join(ROOT, getFeatureWorkspaceFolder(feature));
}

function getFeatureArtifactFolder(feature) {
  return feature.artifactFolder || branchArtifactFolder(feature.branch, feature.slug);
}

function getFeatureArtifactFolderPath(feature) {
  return path.join(ROOT, getFeatureArtifactFolder(feature));
}

module.exports = {
  branchArtifactFolder,
  branchWorkspaceFolder,
  getFeatureArtifactFolder,
  getFeatureArtifactFolderPath,
  getFeatureWorkspaceFolder,
  getFeatureWorkspaceFolderPath,
};
