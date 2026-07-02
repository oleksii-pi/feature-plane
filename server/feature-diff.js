const { execFile } = require("node:child_process");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { ROOT, WORKSPACE_COPY_EXCLUDES } = require("./config");
const { getFeatureWorkspaceFolderPath } = require("./feature-artifacts");
const { ensureWorkspaceGit, runGit } = require("./git");
const { httpError } = require("./http");
const { formatDateTime } = require("./time");

const execFileAsync = promisify(execFile);
const MAX_DIFF_OUTPUT = 10 * 1024 * 1024;

async function readFeatureDiff(feature) {
  const snapshotRoot = await fsp.mkdtemp(
    path.join(os.tmpdir(), "control-plane-diff-"),
  );
  const mainDir = path.join(snapshotRoot, "main");
  const headDir = path.join(snapshotRoot, "head");
  const workingDir = path.join(snapshotRoot, "working");

  try {
    await ensureWorkspaceGit(feature);
    try {
      await runGit(feature, ["rev-parse", "--verify", "HEAD"]);
    } catch (error) {
      throw httpError(409, `Feature diff is unavailable: ${error.message}`);
    }

    await Promise.all([
      copySnapshot(ROOT, mainDir),
      copySnapshot(getFeatureWorkspaceFolderPath(feature), workingDir),
      exportHeadSnapshot(feature, headDir),
    ]);

    const [committed, uncommitted] = await Promise.all([
      buildDiffSection({
        cwd: snapshotRoot,
        leftName: "main",
        rightName: "head",
        title: "Committed changes",
        description:
          "Feature branch HEAD compared with the current repository snapshot on disk.",
      }),
      buildDiffSection({
        cwd: snapshotRoot,
        leftName: "head",
        rightName: "working",
        title: "Uncommitted changes",
        description:
          "Workspace working tree compared with the feature branch HEAD commit.",
      }),
    ]);

    return {
      featureId: feature.id,
      featureName: feature.name,
      branch: feature.branch,
      generatedAt: formatDateTime(),
      summary: {
        files:
          committed.summary.files +
          uncommitted.summary.files,
        additions:
          committed.summary.additions +
          uncommitted.summary.additions,
        deletions:
          committed.summary.deletions +
          uncommitted.summary.deletions,
      },
      committed,
      uncommitted,
    };
  } finally {
    await fsp.rm(snapshotRoot, { recursive: true, force: true });
  }
}

async function copySnapshot(sourceRoot, targetRoot) {
  await fsp.mkdir(targetRoot, { recursive: true });
  await copyDirectory(sourceRoot, targetRoot, "");
}

async function copyDirectory(sourceRoot, targetRoot, relativeDir) {
  const sourceDir = path.join(sourceRoot, relativeDir);
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });

  await Promise.all(
    entries
      .filter((entry) => !shouldSkipSnapshotEntry(relativeDir, entry.name))
      .map(async (entry) => {
        const relativePath = relativeDir
          ? path.join(relativeDir, entry.name)
          : entry.name;
        const sourcePath = path.join(sourceRoot, relativePath);
        const targetPath = path.join(targetRoot, relativePath);

        if (entry.isDirectory()) {
          await fsp.mkdir(targetPath, { recursive: true });
          await copyDirectory(sourceRoot, targetRoot, relativePath);
          return;
        }

        if (entry.isSymbolicLink()) {
          await fsp.mkdir(path.dirname(targetPath), { recursive: true });
          const linkTarget = await fsp.readlink(sourcePath);
          await fsp.symlink(linkTarget, targetPath);
          return;
        }

        if (!entry.isFile()) return;
        await fsp.mkdir(path.dirname(targetPath), { recursive: true });
        await fsp.copyFile(sourcePath, targetPath);
      }),
  );
}

function shouldSkipSnapshotEntry(relativeDir, entryName) {
  const relativePath = relativeDir
    ? `${relativeDir}/${entryName}`
    : entryName;
  const normalizedPath = relativePath.replace(/\\/g, "/");
  if (!relativeDir && WORKSPACE_COPY_EXCLUDES.has(entryName)) return true;
  return (
    /^\.artifacts\/.+\.(?:log|pid)$/.test(normalizedPath) ||
    /^features\/.+\/artifacts\/.+\.(?:log|pid)$/.test(normalizedPath)
  );
}

async function exportHeadSnapshot(feature, targetRoot) {
  await fsp.mkdir(targetRoot, { recursive: true });
  const archivePath = path.join(targetRoot, "..", "head.tar");
  await runGit(feature, [
    "archive",
    "--format=tar",
    "--output",
    archivePath,
    "HEAD",
  ]);
  await execFileAsync("tar", ["-xf", archivePath, "-C", targetRoot], {
    maxBuffer: MAX_DIFF_OUTPUT,
  });
  await fsp.rm(archivePath, { force: true });
}

async function buildDiffSection({
  cwd,
  leftName,
  rightName,
  title,
  description,
}) {
  const patch = await runDirectoryDiff(cwd, leftName, rightName);
  const files = parseDiffFiles(patch, {
    leftPrefix: `${leftName}/`,
    rightPrefix: `${rightName}/`,
  });

  return {
    title,
    description,
    summary: summarizeFiles(files),
    files,
  };
}

async function runDirectoryDiff(cwd, leftName, rightName) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--unified=3",
        "--",
        leftName,
        rightName,
      ],
      {
        cwd,
        maxBuffer: MAX_DIFF_OUTPUT,
      },
    );
    return String(stdout ?? "");
  } catch (error) {
    if (error.code === 1) return String(error.stdout ?? "");
    const detail = String(error.stderr ?? error.stdout ?? error.message ?? "").trim();
    throw httpError(
      500,
      detail
        ? `Unable to build feature diff: ${detail}`
        : "Unable to build feature diff.",
    );
  }
}

function parseDiffFiles(source, prefixes) {
  const normalized = String(source ?? "").replace(/\r\n/g, "\n");
  if (!normalized.trim()) return [];

  return normalized
    .split(/^diff --git /m)
    .filter(Boolean)
    .map((chunk) => parseDiffFile(`diff --git ${chunk}`, prefixes))
    .filter(Boolean);
}

function parseDiffFile(patch, { leftPrefix, rightPrefix }) {
  const lines = patch.split("\n");
  let previousPath = null;
  let pathName = null;
  let additions = 0;
  let deletions = 0;
  let binary = false;
  let insideHunk = false;

  for (const line of lines) {
    if (line.startsWith("--- ")) {
      previousPath = normalizePatchPath(line.slice(4), leftPrefix, rightPrefix);
      insideHunk = false;
      continue;
    }

    if (line.startsWith("+++ ")) {
      pathName = normalizePatchPath(line.slice(4), leftPrefix, rightPrefix);
      insideHunk = false;
      continue;
    }

    if (line.startsWith("@@ ")) {
      insideHunk = true;
      continue;
    }

    if (line === "GIT binary patch" || line.startsWith("Binary files ")) {
      binary = true;
    }

    if (!insideHunk) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }

  const filePath = pathName ?? previousPath;
  if (!filePath) return null;

  return {
    path: filePath,
    previousPath,
    status: determineFileStatus(previousPath, pathName),
    additions,
    deletions,
    binary,
    patch: patch.trimEnd(),
  };
}

function normalizePatchPath(value, leftPrefix, rightPrefix) {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "/dev/null") return null;

  const prefixes = ["a/", "b/"];
  const withoutSide = prefixes.find((prefix) => raw.startsWith(prefix))
    ? raw.slice(2)
    : raw;

  if (withoutSide.startsWith(leftPrefix)) {
    return withoutSide.slice(leftPrefix.length);
  }
  if (withoutSide.startsWith(rightPrefix)) {
    return withoutSide.slice(rightPrefix.length);
  }
  return withoutSide;
}

function determineFileStatus(previousPath, nextPath) {
  if (!previousPath && nextPath) return "added";
  if (previousPath && !nextPath) return "deleted";
  return "modified";
}

function summarizeFiles(files) {
  return files.reduce(
    (summary, file) => ({
      files: summary.files + 1,
      additions: summary.additions + file.additions,
      deletions: summary.deletions + file.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
}

module.exports = {
  readFeatureDiff,
};
