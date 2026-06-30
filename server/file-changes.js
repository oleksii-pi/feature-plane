const fsp = require("node:fs/promises");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { FEATURES_HOME } = require("./config");
const { getFeatureWorkspaceFolderPath } = require("./feature-artifacts");

const GENERATED_ROOTS = new Set([FEATURES_HOME, ".artifacts", ".git"]);

async function createWorkspaceSnapshot(feature) {
  const files = await listFiles(getFeatureWorkspaceFolderPath(feature));
  const entries = await Promise.all(
    [...files.entries()].map(async ([relativePath, absolutePath]) => [
      relativePath,
      await fileHash(absolutePath),
    ]),
  );
  return Object.fromEntries(entries);
}

async function summarizeWorkspaceChanges(feature, baselineSnapshot) {
  if (!baselineSnapshot || typeof baselineSnapshot !== "object") return null;
  const baseline = new Map(Object.entries(baselineSnapshot));
  const workspaceFiles = await listFiles(getFeatureWorkspaceFolderPath(feature));
  const workspaceEntries = await Promise.all(
    [...workspaceFiles.entries()].map(async ([relativePath, absolutePath]) => [
      relativePath,
      await fileHash(absolutePath),
    ]),
  );
  const workspace = new Map(workspaceEntries);
  const counts = { added: 0, edited: 0, deleted: 0 };

  for (const [relativePath, hash] of workspace.entries()) {
    if (!baseline.has(relativePath)) {
      counts.added += 1;
      continue;
    }
    if (baseline.get(relativePath) !== hash) counts.edited += 1;
  }

  for (const relativePath of baseline.keys()) {
    if (!workspace.has(relativePath)) counts.deleted += 1;
  }

  return counts;
}

async function listFiles(root) {
  const files = new Map();
  await walk(root, "", files);
  return files;
}

async function walk(root, relativeDir, files) {
  let entries;
  try {
    entries = await fsp.readdir(path.join(root, relativeDir), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  await Promise.all(
    entries
      .filter((entry) => !isGeneratedRoot(relativeDir, entry.name))
      .map(async (entry) => {
        const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        const absolutePath = path.join(root, relativePath);
        if (entry.isDirectory()) {
          await walk(root, relativePath, files);
          return;
        }
        if (entry.isFile()) files.set(relativePath, absolutePath);
      }),
  );
}

function isGeneratedRoot(relativeDir, name) {
  return !relativeDir && GENERATED_ROOTS.has(name);
}

async function fileHash(filePath) {
  const source = await fsp.readFile(filePath);
  return createHash("sha256").update(source).digest("hex");
}

module.exports = {
  createWorkspaceSnapshot,
  summarizeWorkspaceChanges,
};
