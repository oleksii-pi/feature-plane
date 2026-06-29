const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const {
  formatShellCommand,
  recordEnvironmentCommand,
} = require("./command-history");
const {
  getFeatureArtifactFolderPath,
  getFeatureWorkspaceFolderPath,
} = require("./feature-artifacts");

const execFileAsync = promisify(execFile);
const VERIFY_ATTEMPTS = 30;
const VERIFY_DELAY_MS = 500;
const VERIFY_TIMEOUT_MS = 2000;

async function readFeatureEnvironment(feature) {
  const artifactDir = getFeatureArtifactFolderPath(feature);
  const artifact =
    feature.artifacts?.find((item) => item.name === "environment-state.md") ??
    feature.artifacts?.find((item) => String(item.content ?? "").includes("URL:")) ??
    null;
  const content = await readEnvironmentContent(artifactDir, artifact);
  const pidPath = path.join(artifactDir, "environment.pid");
  const url = feature.environmentUrl || matchLine(content, "URL");
  const pid = normalizePid(matchLine(content, "PID") || (await readPidFile(pidPath)));
  const logPath = matchLine(content, "Log") || path.join(artifactDir, "environment.log");
  return {
    content,
    logPath,
    pid,
    pidPath,
    url,
  };
}

async function readEnvironmentContent(artifactDir, artifact) {
  const candidates = [
    artifact?.name ? path.join(artifactDir, artifact.name) : "",
    path.join(artifactDir, "environment-state.md"),
  ].filter(Boolean);
  for (const filePath of candidates) {
    try {
      return await fsp.readFile(filePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return String(artifact?.content ?? "");
}

function matchLine(content, label) {
  const match = String(content ?? "").match(new RegExp(`^${label}:\\s*(.+?)\\s*$`, "im"));
  return match ? match[1].trim() : "";
}

async function readPidFile(pidPath) {
  try {
    return await fsp.readFile(pidPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function normalizePid(value) {
  const pid = Number(String(value ?? "").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function reconcileFeatureEnvironment(feature, previousEnvironment) {
  const currentEnvironment = await readFeatureEnvironment(feature);
  const environment = {
    ...currentEnvironment,
    pid: previousEnvironment?.pid ?? currentEnvironment.pid,
    url: currentEnvironment.url || previousEnvironment?.url || "",
    logPath: currentEnvironment.logPath || previousEnvironment?.logPath,
    pidPath: currentEnvironment.pidPath || previousEnvironment?.pidPath,
  };

  if (!environment.url) {
    await stopFeatureEnvironment(previousEnvironment);
    return {
      status: "none",
      message: "No feature environment is recorded for this state.",
    };
  }

  const command = environment.pid ? await processCommand(environment.pid) : "";
  if (environment.pid && isAlive(environment.pid) && isWatchCommand(command)) {
    await waitForApplication(environment.url);
    return {
      status: "verified",
      mode: "watch",
      message: "Watch environment verified after restore.",
    };
  }

  if (environment.pid && isAlive(environment.pid)) {
    await stopPid(environment.pid);
  }

  const restarted = await restartFeatureEnvironment(feature, environment);
  if (!restarted) {
    return {
      status: "unverified",
      message: "No restartable feature server was found for this restored state.",
    };
  }
  await waitForApplication(environment.url);
  return {
    status: "restarted",
    mode: "node",
    message: "Feature environment restarted after restore.",
  };
}

async function stopFeatureEnvironment(environment) {
  if (environment?.pid && isAlive(environment.pid)) {
    await stopPid(environment.pid);
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function processCommand(pid) {
  if (process.platform === "win32") return "";
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], {
      timeout: VERIFY_TIMEOUT_MS,
    });
    return String(stdout ?? "").trim();
  } catch {
    return "";
  }
}

function isWatchCommand(command) {
  return /\s--watch(?:\s|=|$)/.test(` ${command} `);
}

async function stopPid(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  await delay(1000);
  if (!isAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Process may have exited between checks.
  }
}

async function restartFeatureEnvironment(feature, environment) {
  const port = portFromUrl(environment.url);
  if (!port) return false;
  const workspace = getFeatureWorkspaceFolderPath(feature);
  const serverPath = path.join(workspace, "server.js");
  try {
    await fsp.access(serverPath, fs.constants.R_OK);
  } catch {
    return false;
  }

  await fsp.mkdir(path.dirname(environment.logPath), { recursive: true });
  const logHandle = fs.openSync(environment.logPath, "a");
  let child;
  try {
    child = spawn(process.execPath, ["server.js", String(port)], {
      cwd: workspace,
      detached: true,
      stdio: ["ignore", logHandle, logHandle],
    });
  } finally {
    fs.closeSync(logHandle);
  }
  child.unref();
  recordEnvironmentCommand(
    feature,
    `${formatShellCommand("cd", [workspace])} && ${formatShellCommand(process.execPath, ["server.js", String(port)])}`,
  );
  await fsp.writeFile(environment.pidPath, `${child.pid}\n`);
  return true;
}

function portFromUrl(value) {
  try {
    const url = new URL(String(value));
    return url.port || (url.protocol === "https:" ? "443" : "80");
  } catch {
    return "";
  }
}

async function waitForApplication(url) {
  let lastError = null;
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
    try {
      await verifyUrl(url);
      return;
    } catch (error) {
      lastError = error;
      await delay(VERIFY_DELAY_MS);
    }
  }
  throw new Error(
    `Feature environment did not respond after restore: ${lastError?.message ?? "unknown error"}`,
  );
}

async function verifyUrl(url) {
  const stateUrl = new URL("/state", String(url));
  try {
    await getOk(stateUrl.href);
    return;
  } catch {
    await getOk(url);
  }
}

function getOk(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: VERIFY_TIMEOUT_MS }, (res) => {
      res.resume();
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 400) {
          resolve();
          return;
        }
        reject(new Error(`HTTP ${res.statusCode}`));
      });
    });
    req.on("timeout", () => req.destroy(new Error("Request timed out.")));
    req.on("error", reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  readFeatureEnvironment,
  reconcileFeatureEnvironment,
  stopFeatureEnvironment,
};
