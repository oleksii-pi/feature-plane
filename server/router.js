const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { RUN_LOG_ROOT, workflow } = require("./config");
const {
  branchArtifactFolder,
  branchWorkspaceFolder,
  getFeatureWorkspaceFolderPath,
} = require("./feature-artifacts");
const { httpError, readJson, sendJson, sendNoContent } = require("./http");
const { serveStatic } = require("./static");
const { normalizeFeature, publicState, saveState, state } = require("./state");
const { createFeature, findFeature, moveFeature, saveFeatureFiles, updateArtifact } = require("./features");
const { cancelRun, findRun, startRun } = require("./runs");
const { streamRunEvents } = require("./run-events");
const { validateRepository } = require("./validation");

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (req.method === "GET" && url.pathname === "/state") {
    sendJson(res, 200, publicState());
    return;
  }

  if (req.method === "PUT" && url.pathname === "/state") {
    const body = await readJson(req);
    if (!Array.isArray(body.features)) throw httpError(400, "features must be an array.");
    state.features = body.features.map(normalizeFeature);
    await Promise.all(state.features.map(saveFeatureFiles));
    await saveState();
    sendJson(res, 200, publicState());
    return;
  }

  if (req.method === "GET" && url.pathname === "/repository/validation") {
    sendJson(res, 200, validateRepository());
    return;
  }

  if (req.method === "GET" && url.pathname === "/workspaces") {
    sendJson(res, 200, publicState().workspaces);
    return;
  }

  if (req.method === "POST" && parts[0] === "workspaces" && parts[2] === "cleanup") {
    sendJson(res, 200, { id: parts[1], cleaned: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/features") {
    sendJson(res, 200, state.features);
    return;
  }

  if (req.method === "POST" && url.pathname === "/features") {
    const body = await readJson(req);
    const feature = await createFeature({
      title: String(body.title ?? body.name ?? "").trim(),
      prompt: String(body.prompt ?? "").trim(),
    });
    sendJson(res, 201, feature);
    return;
  }

  if (parts[0] === "features" && parts[1]) {
    const feature = findFeature(parts[1]);

    if (req.method === "GET" && parts.length === 2) {
      sendJson(res, 200, feature);
      return;
    }

    if (req.method === "PATCH" && parts.length === 2) {
      const body = await readJson(req);
      if (body.branch) {
        const branch = String(body.branch);
        if (!branch.startsWith("feature/")) {
          throw httpError(422, "Feature branches must live under feature/.");
        }
        feature.branch = branch;
        feature.workspace = branchWorkspaceFolder(branch, feature.slug);
        feature.artifactFolder = branchArtifactFolder(branch, feature.slug);
      }
      if (body.name) feature.name = String(body.name);
      feature.updated = new Date().toISOString();
      await saveFeatureFiles(feature);
      await saveState();
      sendJson(res, 200, feature);
      return;
    }

    if (req.method === "DELETE" && parts.length === 2) {
      state.features = state.features.filter((item) => item.id !== feature.id);
      await fsp.rm(getFeatureWorkspaceFolderPath(feature), { recursive: true, force: true });
      await saveState();
      sendNoContent(res);
      return;
    }

    if (req.method === "GET" && parts[2] === "steps") {
      sendJson(res, 200, workflow);
      return;
    }

    if (req.method === "PATCH" && parts[2] === "steps" && parts[3]) {
      const updated = await moveFeature(feature, Number(parts[3]));
      sendJson(res, 200, updated);
      return;
    }

    if (req.method === "PATCH" && parts[2] === "artifacts" && parts[3]) {
      const body = await readJson(req);
      const artifact = await updateArtifact(feature, Number(parts[3]), String(body.content ?? ""), {
        discardNextSteps: Boolean(body.discardNextSteps),
      });
      sendJson(res, 200, artifact);
      return;
    }

    if (req.method === "GET" && parts[2] === "runs") {
      sendJson(res, 200, feature.runs);
      return;
    }

    if (req.method === "POST" && parts[2] === "runs") {
      const updated = await startRun(feature);
      sendJson(res, 201, updated);
      return;
    }
  }

  if (parts[0] === "runs" && parts[1]) {
    const { run } = findRun(parts[1]);

    if (req.method === "GET" && parts.length === 2) {
      sendJson(res, 200, run);
      return;
    }

    if (req.method === "GET" && parts[2] === "events") {
      streamRunEvents(req, res, run);
      return;
    }

    if (req.method === "GET" && parts[2] === "log" && parts[3] === "view") {
      sendRunLogView(res, run);
      return;
    }

    if (req.method === "GET" && parts[2] === "log") {
      const logPath = path.join(RUN_LOG_ROOT, `${run.id}.log`);
      try {
        const stat = await fsp.stat(logPath);
        run.logSizeBytes = stat.size;
      } catch (error) {
        if (error.code === "ENOENT") throw httpError(404, "Run log not found.");
        throw error;
      }
      const disposition = url.searchParams.has("download") ? "attachment" : "inline";
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `${disposition}; filename="${run.id}.log"`,
      });
      fs.createReadStream(logPath).pipe(res);
      return;
    }

    if (req.method === "POST" && parts[2] === "cancel") {
      const cancelled = await cancelRun(run.id);
      sendJson(res, 200, cancelled);
      return;
    }
  }

  await serveStatic(url.pathname, res);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sendRunLogView(res, run) {
  const logUrl = `/runs/${encodeURIComponent(run.id)}/log`;
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(run.id)} log</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      background: #0f141c;
      color: #e7edf7;
      font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    header {
      position: sticky;
      top: 0;
      display: flex;
      justify-content: space-between;
      gap: 16px;
      padding: 10px 14px;
      border-bottom: 1px solid #263244;
      background: #111824;
    }
    strong { color: #ffffff; }
    a { color: #8cc8ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    pre {
      box-sizing: border-box;
      min-height: calc(100vh - 42px);
      margin: 0;
      padding: 14px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <header>
    <span><strong>${escapeHtml(run.agent ?? "run")}</strong> ${escapeHtml(run.status)}</span>
    <a href="${logUrl}?download=1" download>Download</a>
  </header>
  <pre id="log">Loading...</pre>
  <script>
    const logUrl = ${JSON.stringify(logUrl)};
    const log = document.getElementById("log");
    async function refreshLog() {
      const pinnedToBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 24;
      const response = await fetch(logUrl + "?_=" + Date.now(), { cache: "no-store" });
      if (!response.ok) {
        log.textContent = "Log not available yet.";
        return;
      }
      const text = await response.text();
      if (log.textContent !== text) {
        log.textContent = text || "No log output yet.";
        if (pinnedToBottom) window.scrollTo(0, document.body.scrollHeight);
      }
    }
    refreshLog();
    window.setInterval(refreshLog, 1000);
  </script>
</body>
</html>`);
}

async function handle(req, res) {
  try {
    await route(req, res);
  } catch (error) {
    const status = error.status ?? 500;
    sendJson(res, status, { message: status === 500 ? "Internal server error." : error.message });
    if (status === 500) console.error(error);
  }
}

module.exports = {
  handle,
};
