const { execFile } = require("node:child_process");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const {
  formatShellCommand,
  recordEnvironmentCommand,
} = require("./command-history");
const { getFeatureWorkspaceFolderPath } = require("./feature-artifacts");

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 10 * 1024 * 1024;
const COMMITTER_NAME = "Control Plane";
const COMMITTER_EMAIL = "control-plane@local.invalid";
const WORKSPACE_EXCLUDES = [
  ".artifacts/*.log",
  ".artifacts/*.pid",
  "features/**/artifacts/*.log",
  "features/**/artifacts/*.pid",
];

async function runGit(feature, args, options = {}) {
  const cwd = getFeatureWorkspaceFolderPath(feature);
  recordEnvironmentCommand(feature, formatShellCommand("git", ["-C", cwd, ...args]));
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], {
      maxBuffer: MAX_GIT_OUTPUT,
      ...options,
    });
    return {
      stdout: String(result.stdout ?? "").trim(),
      stderr: String(result.stderr ?? "").trim(),
    };
  } catch (error) {
    error.message = formatGitError(error, args);
    throw error;
  }
}

function formatGitError(error, args) {
  const stdout = String(error.stdout ?? "").trim();
  const stderr = String(error.stderr ?? "").trim();
  const detail = stderr || stdout || error.message;
  return `git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`;
}

async function ensureWorkspaceGit(feature) {
  const cwd = getFeatureWorkspaceFolderPath(feature);
  await fsp.mkdir(cwd, { recursive: true });
  if (!(await isGitRepository(feature))) {
    await runGit(feature, ["init"]);
  }
  await ensureGitExcludes(feature);
  await checkoutFeatureBranch(feature);
}

async function isGitRepository(feature) {
  const cwd = getFeatureWorkspaceFolderPath(feature);
  if (!(await hasOwnGitDirectory(cwd))) return false;
  try {
    const { stdout } = await runGit(feature, ["rev-parse", "--is-inside-work-tree"]);
    return stdout === "true";
  } catch {
    return false;
  }
}

async function hasOwnGitDirectory(cwd) {
  try {
    const stat = await fsp.stat(path.join(cwd, ".git"));
    return stat.isDirectory() || stat.isFile();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function ensureGitExcludes(feature) {
  const excludePath = await getGitPath(feature, "info/exclude");
  let source = "";
  try {
    source = await fsp.readFile(excludePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const lines = source.split(/\r?\n/);
  const missing = WORKSPACE_EXCLUDES.filter((entry) => !lines.includes(entry));
  if (!missing.length) return;
  const prefix = source && !source.endsWith("\n") ? "\n" : "";
  await fsp.mkdir(path.dirname(excludePath), { recursive: true });
  await fsp.appendFile(excludePath, `${prefix}${missing.join("\n")}\n`);
}

async function getGitPath(feature, gitPath) {
  const cwd = getFeatureWorkspaceFolderPath(feature);
  const { stdout } = await runGit(feature, ["rev-parse", "--git-path", gitPath]);
  return path.isAbsolute(stdout) ? stdout : path.join(cwd, stdout);
}

async function checkoutFeatureBranch(feature) {
  if (await hasHead(feature)) {
    try {
      await runGit(feature, ["checkout", feature.branch]);
      return;
    } catch {
      await runGit(feature, ["checkout", "-B", feature.branch]);
      return;
    }
  }
  await runGit(feature, ["checkout", "-B", feature.branch]);
}

async function hasHead(feature) {
  try {
    await runGit(feature, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

async function currentCommit(feature) {
  const { stdout } = await runGit(feature, ["rev-parse", "HEAD"]);
  return stdout;
}

async function commitFeatureWorkspace(feature, message, options = {}) {
  await ensureWorkspaceGit(feature);
  await runGit(feature, ["add", "-A"]);
  const { stdout: status } = await runGit(feature, ["status", "--porcelain"]);
  if (!status && !options.allowEmpty) {
    const sha = await currentCommit(feature);
    feature.headCommit = sha;
    return { sha, changed: false };
  }

  const args = [
    "-c",
    `user.name=${COMMITTER_NAME}`,
    "-c",
    `user.email=${COMMITTER_EMAIL}`,
    "commit",
  ];
  if (!status && options.allowEmpty) args.push("--allow-empty");
  args.push("-m", normalizeCommitMessage(message));
  await runGit(feature, args);
  const sha = await currentCommit(feature);
  feature.headCommit = sha;
  return { sha, changed: Boolean(status) };
}

function normalizeCommitMessage(message) {
  const normalized = String(message ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || "Update feature workspace";
}

async function resolveCommit(feature, commitSha) {
  const value = String(commitSha ?? "").trim();
  if (!/^[0-9a-f]{7,40}$/i.test(value)) {
    throw new Error("Restore target does not have a valid commit SHA.");
  }
  const { stdout } = await runGit(feature, [
    "rev-parse",
    "--verify",
    `${value}^{commit}`,
  ]);
  return stdout;
}

async function resetFeatureWorkspace(feature, commitSha) {
  await ensureWorkspaceGit(feature);
  const targetCommit = await resolveCommit(feature, commitSha);
  await checkoutFeatureBranch(feature);
  await runGit(feature, ["reset", "--hard", targetCommit]);
  await runGit(feature, ["clean", "-fdx"]);
  feature.headCommit = targetCommit;
  return targetCommit;
}

module.exports = {
  commitFeatureWorkspace,
  currentCommit,
  ensureWorkspaceGit,
  resetFeatureWorkspace,
};
