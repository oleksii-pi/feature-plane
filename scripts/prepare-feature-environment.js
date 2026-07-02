#!/usr/bin/env node

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { requiredEnv } = require("./control-plane-env");

const VERIFY_ATTEMPTS = 60;
const VERIFY_DELAY_MS = 1000;
const VERIFY_TIMEOUT_MS = 2000;
const MAX_GIT_OUTPUT = 10 * 1024 * 1024;
const MAIN_BRANCH = "main";
const COMMITTER_NAME = "Control Plane";
const COMMITTER_EMAIL = "control-plane@local.invalid";
const execFileAsync = promisify(execFile);

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

async function main() {
  const context = getContext();
  await rebaseWorkspaceFromMain(context);
  await fsp.mkdir(context.dir, { recursive: true });
  await Promise.all([context.log, context.pid, context.artifact].map((file) => fsp.rm(file, { force: true })));

  const port = await findPort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--watch", "--watch-path=server", "server.js", String(port)], {
    cwd: context.workspace,
    detached: true,
    stdio: ["ignore", fs.openSync(context.log, "a"), fs.openSync(context.log, "a")],
  });
  child.unref();
  await fsp.writeFile(context.pid, `${child.pid}\n`);

  try {
    await waitForState(url, child.pid);
  } catch (error) {
    await stop(child.pid);
    throw error;
  }

  await publish(context.runEventUrl, url);
  const content = [`URL: ${url}`, `PID: ${child.pid}`, `Log: ${context.log}`, ""].join("\n");
  await fsp.writeFile(
    context.artifact,
    content,
  );
  process.stdout.write(content);
}

function getContext() {
  const dir = requiredEnv("CONTROL_PLANE_ARTIFACT_FOLDER_PATH");
  return {
    artifactFolder: requiredEnv("CONTROL_PLANE_ARTIFACT_FOLDER"),
    dir,
    artifact: requiredEnv("CONTROL_PLANE_ARTIFACT_PATH"),
    branch: requiredEnv("CONTROL_PLANE_BRANCH"),
    featureName: requiredEnv("CONTROL_PLANE_FEATURE_NAME"),
    log: path.join(dir, "environment.log"),
    pid: path.join(dir, "environment.pid"),
    repositoryRoot: requiredEnv("CONTROL_PLANE_REPOSITORY_ROOT"),
    runEventUrl: requiredEnv("CONTROL_PLANE_RUN_EVENT_URL"),
    workspace: requiredEnv("CONTROL_PLANE_WORKSPACE_PATH"),
  };
}

async function rebaseWorkspaceFromMain(context) {
  await ensureCleanWorkspace(context.workspace);
  const previousCommit = await currentCommit(context.workspace);
  const baselineCommit = await rootCommit(context.workspace);
  await refreshMainSnapshotBranch(context, baselineCommit);
  await runGit(context.workspace, ["checkout", context.branch]);
  try {
    await runGit(context.workspace, ["rebase", "-X", "ours", MAIN_BRANCH]);
  } catch (error) {
    try {
      if (!(await rebaseInProgress(context.workspace))) throw error;
      await continueMainFavoringRebase(context.workspace);
    } catch (rebaseError) {
      await rollbackFailedRebase(context.workspace, context.branch, previousCommit);
      throw new Error(`Rebase from ${MAIN_BRANCH} failed: ${rebaseError.message}`);
    }
  }
}

async function ensureCleanWorkspace(cwd) {
  const { stdout } = await runGit(cwd, ["status", "--porcelain"]);
  if (!stdout) return;
  throw new Error("Workspace has uncommitted changes. Commit or discard them before preparing the environment.");
}

async function currentCommit(cwd) {
  const { stdout } = await runGit(cwd, ["rev-parse", "HEAD"]);
  return stdout;
}

async function rootCommit(cwd) {
  const { stdout } = await runGit(cwd, ["rev-list", "--max-parents=0", "--reverse", "HEAD"]);
  const commit = stdout.split(/\r?\n/).find(Boolean);
  if (!commit) throw new Error("Workspace does not have a baseline commit.");
  return commit;
}

async function refreshMainSnapshotBranch(context, baselineCommit) {
  await runGit(context.workspace, ["checkout", "-B", MAIN_BRANCH, baselineCommit]);
  await replaceWorkspaceWithRepositorySnapshot(context);
  await restoreFeatureArtifactBaseline(context.workspace, baselineCommit, context.artifactFolder);
  await commitCurrentBranch(
    context.workspace,
    `Refresh ${MAIN_BRANCH} snapshot for ${context.featureName}`,
  );
}

async function replaceWorkspaceWithRepositorySnapshot(context) {
  const workspaceEntries = await fsp.readdir(context.workspace, { withFileTypes: true });
  await Promise.all(
    workspaceEntries
      .filter((entry) => entry.name !== ".git")
      .map((entry) =>
        fsp.rm(path.join(context.workspace, entry.name), { recursive: true, force: true }),
      ),
  );

  const repositoryEntries = await fsp.readdir(context.repositoryRoot, { withFileTypes: true });
  await Promise.all(
    repositoryEntries
      .filter((entry) => !workspaceCopyExcludes().has(entry.name))
      .map((entry) =>
        fsp.cp(path.join(context.repositoryRoot, entry.name), path.join(context.workspace, entry.name), {
          recursive: true,
          force: true,
          preserveTimestamps: true,
        }),
      ),
  );
}

function workspaceCopyExcludes() {
  const excludes = new Set([".git", ".env", ".features"]);
  const configured = normalizeFeaturesHome(process.env.features_home);
  if (configured) excludes.add(configured);
  return excludes;
}

function normalizeFeaturesHome(value) {
  const fallback = ".features";
  const original = String(value ?? fallback).trim();
  if (!original || original === "." || path.isAbsolute(original)) return fallback;
  return original
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+|\/+$/g, "");
}

async function restoreFeatureArtifactBaseline(cwd, baselineCommit, artifactFolder) {
  try {
    await runGit(cwd, ["checkout", baselineCommit, "--", artifactFolder]);
  } catch {
    // Older feature baselines may not have an artifact folder yet.
  }
}

async function commitCurrentBranch(cwd, message) {
  await runGit(cwd, ["add", "-A"]);
  const { stdout: status } = await runGit(cwd, ["status", "--porcelain"]);
  if (!status) return currentCommit(cwd);
  await runGit(cwd, ["commit", "-m", normalizeCommitMessage(message)]);
  return currentCommit(cwd);
}

function normalizeCommitMessage(message) {
  const normalized = String(message ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || "Update workspace";
}

async function continueMainFavoringRebase(cwd) {
  while (await rebaseInProgress(cwd)) {
    const conflicts = await unmergedPaths(cwd);
    if (!conflicts.length) {
      await advanceRebase(cwd);
      continue;
    }
    for (const filePath of conflicts) {
      if (await unmergedPathHasStage(cwd, filePath, 2)) {
        await runGit(cwd, ["checkout", "--ours", "--", filePath]);
        await runGit(cwd, ["add", "--", filePath]);
      } else {
        await runGit(cwd, ["rm", "-f", "--", filePath]);
      }
    }
    await advanceRebase(cwd);
  }
}

async function advanceRebase(cwd) {
  try {
    await runGit(cwd, ["rebase", "--continue"]);
  } catch (error) {
    if (await rebaseInProgress(cwd) && isEmptyRebaseStep(error)) {
      await runGit(cwd, ["rebase", "--skip"]);
      return;
    }
    throw error;
  }
}

function isEmptyRebaseStep(error) {
  const message = String(error?.message ?? "");
  return (
    /previous cherry-pick is now empty/i.test(message) ||
    /nothing to commit/i.test(message) ||
    /No changes - did you forget to use 'git add'/i.test(message)
  );
}

async function rollbackFailedRebase(cwd, branch, previousCommit) {
  try {
    await runGit(cwd, ["rebase", "--abort"]);
  } catch {
    // Best effort.
  }
  try {
    await runGit(cwd, ["checkout", "-f", branch]);
  } catch {
    // reset restores the branch state if checkout was disrupted.
  }
  await runGit(cwd, ["reset", "--hard", previousCommit]);
  await runGit(cwd, ["clean", "-fdx"]);
}

async function rebaseInProgress(cwd) {
  try {
    const { stdout } = await runGit(cwd, ["rev-parse", "--git-path", "rebase-merge"]);
    await fsp.access(path.isAbsolute(stdout) ? stdout : path.join(cwd, stdout), fs.constants.F_OK);
    return true;
  } catch {
    try {
      const { stdout } = await runGit(cwd, ["rev-parse", "--git-path", "rebase-apply"]);
      await fsp.access(path.isAbsolute(stdout) ? stdout : path.join(cwd, stdout), fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

async function unmergedPaths(cwd) {
  const { stdout } = await runGit(cwd, [
    "diff",
    "--name-only",
    "--diff-filter=U",
    "-z",
  ]);
  return stdout.split("\0").filter(Boolean);
}

async function unmergedPathHasStage(cwd, filePath, stage) {
  const { stdout } = await runGit(cwd, ["ls-files", "-u", "--", filePath]);
  return stdout.split(/\r?\n/).some((line) => new RegExp(`\\s${stage}\\t`).test(line));
}

async function runGit(cwd, args, options = {}) {
  const command = formatShellCommand("git", ["-C", cwd, ...args]);
  writeTrace(process.stdout, `$ ${command}`);
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], {
      env: gitEnv(),
      maxBuffer: MAX_GIT_OUTPUT,
      ...options,
    });
    writeCommandOutput(result.stdout, result.stderr);
    return {
      stdout: String(result.stdout ?? "").trim(),
      stderr: String(result.stderr ?? "").trim(),
    };
  } catch (error) {
    const stdout = String(error.stdout ?? "").trim();
    const stderr = String(error.stderr ?? "").trim();
    writeCommandOutput(stdout, stderr);
    const detail = stderr || stdout || error.message;
    error.message = `git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`;
    throw error;
  }
}

function gitEnv() {
  return {
    ...process.env,
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || COMMITTER_NAME,
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || COMMITTER_EMAIL,
    GIT_EDITOR: process.env.GIT_EDITOR || ":",
  };
}

function writeCommandOutput(stdout, stderr) {
  writeTrace(process.stdout, stdout);
  writeTrace(process.stderr, stderr);
}

function writeTrace(stream, value) {
  const text = String(value ?? "");
  if (!text) return;
  stream.write(text.endsWith("\n") ? text : `${text}\n`);
}

function formatShellCommand(command, args = []) {
  return [command, ...args].map(shellQuote).join(" ");
}

function shellQuote(value) {
  const text = String(value ?? "");
  if (!text.length) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return "'" + text.split("'").join("'\"'\"'") + "'";
}

async function findPort() {
  for (let port = 3100; port <= 65535; port += 1) {
    if (await isFree(port)) return port;
  }
  throw new Error("No free localhost port found.");
}

function isFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function waitForState(url, pid) {
  let lastError = null;
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
    try {
      alive(pid);
      await getJson(`${url}/state`);
      alive(pid);
      return;
    } catch (error) {
      lastError = error;
      await delay(VERIFY_DELAY_MS);
    }
  }
  throw new Error(`Server did not become ready: ${lastError?.message ?? "unknown error"}`);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    throw new Error(`Process ${pid} exited.`);
  }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: VERIFY_TIMEOUT_MS }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Request timed out.")));
    req.on("error", reject);
  });
}

function publish(runEventUrl, url) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ type: "environment", url });
    const req = http.request(
      new URL(runEventUrl),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: VERIFY_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve("published");
            return;
          }
          resolve("fallback");
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Callback timed out.")));
    req.on("error", () => {
      resolve("fallback");
    });
    req.end(body);
  });
}

async function stop(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  await delay(1000);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already stopped.
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  main,
  rebaseWorkspaceFromMain,
};
