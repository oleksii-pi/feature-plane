const { execFile } = require("node:child_process");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { FEATURE_ROOT } = require("./config");
const { getFeatureWorkspaceFolderPath } = require("./feature-artifacts");
const { httpError } = require("./http");

async function openFeatureWorkspaceFolder(feature) {
  if (process.platform !== "darwin") {
    throw httpError(501, "Opening feature workspaces is only supported on macOS.");
  }

  const workspacePath = path.resolve(getFeatureWorkspaceFolderPath(feature));
  const featureRoot = path.resolve(FEATURE_ROOT);
  if (
    workspacePath !== featureRoot &&
    !workspacePath.startsWith(`${featureRoot}${path.sep}`)
  ) {
    throw httpError(422, "Feature workspace is outside the configured feature home.");
  }

  let stat;
  try {
    stat = await fsp.stat(workspacePath);
  } catch (error) {
    if (error.code === "ENOENT") throw httpError(404, "Feature workspace folder not found.");
    throw error;
  }
  if (!stat.isDirectory()) throw httpError(422, "Feature workspace path is not a folder.");

  await openFinder(workspacePath);
  return { path: workspacePath, message: "Feature workspace folder opened" };
}

function openFinder(folderPath) {
  return new Promise((resolve, reject) => {
    execFile("open", [folderPath], (error) => {
      if (!error) {
        resolve();
        return;
      }
      reject(httpError(500, `Finder could not open the feature workspace: ${error.message}`));
    });
  });
}

module.exports = {
  openFeatureWorkspaceFolder,
};
