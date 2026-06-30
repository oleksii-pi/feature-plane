#!/usr/bin/env node

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { requiredEnv } = require("./control-plane-env");

const VERIFY_ATTEMPTS = 60;
const VERIFY_DELAY_MS = 1000;
const VERIFY_TIMEOUT_MS = 2000;

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const context = getContext();
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
    dir,
    artifact: requiredEnv("CONTROL_PLANE_ARTIFACT_PATH"),
    log: path.join(dir, "environment.log"),
    pid: path.join(dir, "environment.pid"),
    runEventUrl: requiredEnv("CONTROL_PLANE_RUN_EVENT_URL"),
    workspace: requiredEnv("CONTROL_PLANE_WORKSPACE_PATH"),
  };
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
