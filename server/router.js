const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { RUN_LOG_ROOT } = require("./config");
const { normalizeCommandHistory } = require("./command-history");
const {
  branchArtifactFolder,
  branchWorkspaceFolder,
  getFeatureWorkspaceFolderPath,
} = require("./feature-artifacts");
const { httpError, readJson, sendJson, sendNoContent } = require("./http");
const { serveStatic } = require("./static");
const {
  normalizeFeature,
  publicState,
  refreshFeatureSdlcFromWorkspace,
  refreshFeatureSdlcFromWorkspaces,
  saveState,
  state,
} = require("./state");
const {
  cloneFeature,
  createChangeRequest,
  createFeature,
  findFeature,
  mergeFeatureFromMain,
  moveFeature,
  resetFeatureToMain,
  saveFeatureFiles,
  updateArtifact,
} = require("./features");
const { revertFeatureToState } = require("./revert");
const { cancelRun, findRun, startRun } = require("./runs");
const { queueFeatureEnvironmentUrl, streamRunEvents } = require("./run-events");
const { formatDateTime } = require("./time");
const { validateRepository } = require("./validation");
const { openFeatureWorkspaceFolder } = require("./workspace-folder");
const { featureWorkflow } = require("./workflow");
const { readFeatureDiff } = require("./feature-diff");

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (req.method === "GET" && url.pathname === "/state") {
    if (refreshFeatureSdlcFromWorkspaces()) await saveState();
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

    if (req.method === "POST" && parts[2] === "clone") {
      const clone = await cloneFeature(feature);
      sendJson(res, 201, clone);
      return;
    }

    if (req.method === "POST" && parts[2] === "reset") {
      const body = await readJson(req);
      const result = await resetFeatureToMain(feature, body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && parts[2] === "merge-main") {
      const body = await readJson(req);
      const result = await mergeFeatureFromMain(feature, body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && parts[2] === "workspace-folder") {
      const result = await openFeatureWorkspaceFolder(feature);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && parts[2] === "environment") {
      sendJson(res, 200, {
        featureId: feature.id,
        commands: normalizeCommandHistory(feature.environmentCommands),
      });
      return;
    }

    if (req.method === "GET" && parts[2] === "diff" && parts[3] === "view") {
      sendFeatureDiffView(res, feature);
      return;
    }

    if (req.method === "GET" && parts[2] === "diff") {
      const result = await readFeatureDiff(feature);
      sendJson(res, 200, result);
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
      feature.updated = formatDateTime();
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
      if (refreshFeatureSdlcFromWorkspace(feature)) await saveState();
      sendJson(res, 200, featureWorkflow(feature));
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

    if (req.method === "POST" && parts[2] === "revert") {
      const body = await readJson(req);
      const result = await revertFeatureToState(feature, body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && parts[2] === "change-requests") {
      const body = await readJson(req);
      const result = await createChangeRequest(feature, body);
      sendJson(res, 201, result);
      return;
    }

    if (req.method === "GET" && parts[2] === "runs") {
      sendJson(res, 200, feature.runs);
      return;
    }

    if (req.method === "POST" && parts[2] === "runs") {
      const body = await readJson(req);
      const updated = await startRun(feature, {
        step: body.step,
        changeRequestArtifact: body.changeRequestArtifact,
      });
      sendJson(res, 201, updated);
      return;
    }
  }

  if (parts[0] === "runs" && parts[1]) {
    const { feature, run } = findRun(parts[1]);

    if (req.method === "GET" && parts.length === 2) {
      sendJson(res, 200, run);
      return;
    }

    if (req.method === "GET" && parts[2] === "events") {
      streamRunEvents(req, res, run);
      return;
    }

    if (req.method === "POST" && parts[2] === "events") {
      const body = await readJson(req);
      if (body.type !== "environment") {
        throw httpError(400, "Unsupported run event type.");
      }
      const environmentUrl = normalizeEnvironmentUrl(body.url);
      if (!environmentUrl) throw httpError(422, "Environment URL must be http or https.");
      await queueFeatureEnvironmentUrl(feature, run, environmentUrl);
      sendJson(res, 202, { environmentUrl });
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

function normalizeEnvironmentUrl(value) {
  try {
    const parsed = new URL(String(value));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.href;
  } catch {
    return "";
  }
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
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 10px 14px;
      border-bottom: 1px solid #263244;
      background: #111824;
    }
    strong { color: #ffffff; }
    nav {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    a,
    button {
      color: #8cc8ff;
      text-decoration: none;
    }
    button {
      padding: 0;
      border: 0;
      background: transparent;
      font: inherit;
      cursor: pointer;
    }
    a:hover,
    button:hover { text-decoration: underline; }
    #log {
      box-sizing: border-box;
      min-height: calc(100vh - 42px);
      margin: 0;
      padding: 14px;
      overflow-x: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      tab-size: 2;
      user-select: text;
    }
    .log-empty {
      margin: 0;
      color: #9fb0c6;
    }
  </style>
</head>
<body>
  <header>
    <span><strong>${escapeHtml(run.agent ?? "run")}</strong> ${escapeHtml(run.status)}</span>
    <nav>
      <button id="copy-log" type="button">Copy</button>
      <a href="${logUrl}?download=1" download>Download</a>
    </nav>
  </header>
  <pre id="log" tabindex="0">Loading...</pre>
  <script>
    const logUrl = ${JSON.stringify(logUrl)};
    const log = document.getElementById("log");
    const copyButton = document.getElementById("copy-log");
    function renderLog(text) {
      if (!text) {
        log.className = "log-empty";
        log.textContent = "No log output yet.";
        return;
      }
      log.className = "";
      log.textContent = text;
    }
    async function refreshLog() {
      const pinnedToBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 24;
      const response = await fetch(logUrl + "?_=" + Date.now(), { cache: "no-store" });
      if (!response.ok) {
        renderLog("");
        return;
      }
      const text = await response.text();
      if (log.dataset.raw !== text) {
        log.dataset.raw = text;
        renderLog(text);
        if (pinnedToBottom) window.scrollTo(0, document.body.scrollHeight);
      }
    }
    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(log.dataset.raw || "");
        copyButton.textContent = "Copied";
      } catch {
        const range = document.createRange();
        range.selectNodeContents(log);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        log.focus();
        copyButton.textContent = "Selected";
      }
      window.setTimeout(() => {
        copyButton.textContent = "Copy";
      }, 1200);
    });
    refreshLog();
    window.setInterval(refreshLog, 1000);
  </script>
</body>
</html>`);
}

function sendFeatureDiffView(res, feature) {
  const diffUrl = `/features/${encodeURIComponent(feature.id)}/diff`;
  const featureUrl = `/?featureId=${encodeURIComponent(feature.id)}`;
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(feature.name)} diff</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f6f8;
      --panel: #ffffff;
      --text: #172033;
      --muted: #697386;
      --border: #dfe4eb;
      --border-strong: #cbd3dd;
      --accent: #16a36a;
      --accent-soft: #e4f7ee;
      --blue: #3074d9;
      --blue-soft: #e8f1ff;
      --danger: #bb3c47;
      --danger-soft: #fbe8e9;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 13px/1.45 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      padding: 16px 18px 14px;
      border-bottom: 1px solid var(--border);
      background: rgba(244, 246, 248, 0.96);
      backdrop-filter: blur(8px);
    }
    h1 {
      margin: 0;
      font-size: 20px;
      line-height: 1.2;
    }
    p {
      margin: 4px 0 0;
      color: var(--muted);
    }
    nav {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    a,
    button {
      font: inherit;
    }
    a {
      color: var(--blue);
      text-decoration: none;
    }
    a:hover { text-decoration: underline; }
    button {
      min-height: 32px;
      padding: 0 12px;
      color: var(--text);
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      background: #fff;
      cursor: pointer;
    }
    button:hover { background: #f6f7f9; }
    button.primary {
      color: #fff;
      border-color: var(--text);
      background: var(--text);
    }
    button.primary:hover { background: #2d384e; }
    main {
      padding: 14px 18px 24px;
    }
    .summary {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 14px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 9px;
      color: #526074;
      border: 1px solid var(--border-strong);
      border-radius: 999px;
      background: #fff;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .pill strong {
      color: var(--text);
      font-size: 11px;
    }
    .pill.branch {
      color: #245fae;
      border-color: #c9daf3;
      background: #eef5ff;
    }
    .status {
      margin-bottom: 14px;
      color: var(--muted);
      font-size: 12px;
    }
    .empty,
    .error {
      padding: 28px 16px;
      border: 1px dashed var(--border-strong);
      border-radius: 10px;
      background: #fbfcfd;
      text-align: center;
    }
    .error {
      color: var(--danger);
      border-style: solid;
      border-color: #efc7ca;
      background: #fff8f8;
    }
    .section + .section {
      margin-top: 16px;
    }
    .section-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
    }
    .section-header h2 {
      margin: 0 0 4px;
      font-size: 15px;
      line-height: 1.2;
    }
    .section-header p {
      margin: 0;
      font-size: 11px;
    }
    .section-summary {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .files {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .file {
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--panel);
    }
    .file-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      background: #f8fafc;
    }
    .file-paths {
      min-width: 0;
    }
    .file-paths strong,
    .file-paths span {
      display: block;
      overflow-wrap: anywhere;
    }
    .file-paths strong {
      font-size: 12px;
    }
    .file-paths span {
      margin-top: 2px;
      color: var(--muted);
      font-size: 10px;
    }
    .file-meta {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex: 0 0 auto;
    }
    .file-status {
      padding: 2px 6px;
      border-radius: 999px;
      font-size: 9px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .file-status.added {
      color: #0c7650;
      background: var(--accent-soft);
    }
    .file-status.modified {
      color: #245fae;
      background: var(--blue-soft);
    }
    .file-status.deleted {
      color: var(--danger);
      background: var(--danger-soft);
    }
    .file-stats {
      color: var(--muted);
      font: 10px/1.2 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      white-space: nowrap;
    }
    pre {
      margin: 0;
      overflow: auto;
      background: #10161f;
      color: #dce7f7;
    }
    code {
      display: block;
      min-width: 100%;
      padding: 10px 0;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      white-space: pre;
    }
    .line {
      display: block;
      padding: 0 12px;
    }
    .line.meta {
      color: #8aa0bd;
    }
    .line.hunk {
      color: #8cc8ff;
      background: rgba(66, 123, 197, 0.16);
    }
    .line.added {
      color: #d6ffe8;
      background: rgba(22, 163, 106, 0.22);
    }
    .line.deleted {
      color: #ffd7da;
      background: rgba(187, 60, 71, 0.24);
    }
    @media (max-width: 760px) {
      header,
      .section-header,
      .file-header {
        flex-direction: column;
      }
      .file-meta {
        width: 100%;
        justify-content: space-between;
      }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>${escapeHtml(feature.name)}</h1>
      <p>${escapeHtml(feature.branch)} · review current diff against the latest repository snapshot and workspace changes.</p>
    </div>
    <nav>
      <a href="${featureUrl}" target="_blank" rel="noopener noreferrer">Open feature</a>
      <button id="refresh" class="primary" type="button">Refresh</button>
    </nav>
  </header>
  <main>
    <div id="summary" class="summary"></div>
    <div id="status" class="status">Loading diff...</div>
    <div id="content"></div>
  </main>
  <script>
    const diffUrl = ${JSON.stringify(diffUrl)};
    const summary = document.getElementById("summary");
    const status = document.getElementById("status");
    const content = document.getElementById("content");
    const refreshButton = document.getElementById("refresh");

    function escapeHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }

    function pill(label, value, className = "") {
      return '<span class="pill ' + className + '"><strong>' + escapeHtml(String(value)) + '</strong>' + escapeHtml(label) + '</span>';
    }

    function lineMarkup(line) {
      const className =
        line.startsWith("+") && !line.startsWith("+++")
          ? "added"
          : line.startsWith("-") && !line.startsWith("---")
            ? "deleted"
            : line.startsWith("@@")
              ? "hunk"
              : line.startsWith("diff --git") ||
                  line.startsWith("index ") ||
                  line.startsWith("--- ") ||
                  line.startsWith("+++ ")
                ? "meta"
                : "context";
      return '<span class="line ' + className + '">' + (escapeHtml(line) || " ") + '</span>';
    }

    function renderFile(file) {
      const stats = [
        file.additions ? '+' + file.additions : '',
        file.deletions ? '-' + file.deletions : '',
        file.binary ? 'Binary' : '',
      ].filter(Boolean).join(' ');
      const previous =
        file.previousPath &&
        file.previousPath !== file.path &&
        file.status !== 'deleted'
          ? '<span>' + escapeHtml(file.previousPath) + '</span>'
          : '';
      return [
        '<article class="file">',
        '  <div class="file-header">',
        '    <div class="file-paths">',
        '      <strong>' + escapeHtml(file.path) + '</strong>',
               previous,
        '    </div>',
        '    <div class="file-meta">',
        '      <span class="file-status ' + escapeHtml(file.status) + '">' + escapeHtml(file.status) + '</span>',
               stats ? '<span class="file-stats">' + escapeHtml(stats) + '</span>' : '',
        '    </div>',
        '  </div>',
        '  <pre><code>' + String(file.patch ?? '').split('\\n').map(lineMarkup).join('') + '</code></pre>',
        '</article>',
      ].join('');
    }

    function renderSection(section) {
      const files = Array.isArray(section?.files) ? section.files : [];
      return [
        '<section class="section">',
        '  <div class="section-header">',
        '    <div>',
        '      <h2>' + escapeHtml(section?.title ?? 'Diff section') + '</h2>',
        '      <p>' + escapeHtml(section?.description ?? '') + '</p>',
        '    </div>',
        '    <div class="section-summary">',
               pill('files', section?.summary?.files ?? 0),
               pill('added', section?.summary?.additions ?? 0),
               pill('deleted', section?.summary?.deletions ?? 0),
        '    </div>',
        '  </div>',
             files.length
               ? '<div class="files">' + files.map(renderFile).join('') + '</div>'
               : '<div class="empty">No changes.</div>',
        '</section>',
      ].join('');
    }

    async function loadDiff() {
      refreshButton.disabled = true;
      status.textContent = 'Loading diff...';
      content.innerHTML = '';
      try {
        const response = await fetch(diffUrl + '?_=' + Date.now(), { cache: 'no-store' });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(body.message || 'Failed to load diff.');
        }
        const diff = body || {};
        summary.innerHTML = [
          pill('files', diff.summary?.files ?? 0),
          pill('added', diff.summary?.additions ?? 0),
          pill('deleted', diff.summary?.deletions ?? 0),
          diff.branch ? pill('branch', diff.branch, 'branch') : '',
        ].join('');
        status.textContent = diff.generatedAt
          ? 'Generated ' + diff.generatedAt + '. Refresh to update the view.'
          : 'Refresh to update the view.';
        const sections = [diff.committed, diff.uncommitted].filter(Boolean);
        content.innerHTML = sections.length
          ? sections.map(renderSection).join('')
          : '<div class="empty">No changes.</div>';
      } catch (error) {
        summary.innerHTML = '';
        status.textContent = '';
        content.innerHTML = '<div class="error">' + escapeHtml(error.message || 'Failed to load diff.') + '</div>';
      } finally {
        refreshButton.disabled = false;
      }
    }

    refreshButton.addEventListener('click', loadDiff);
    loadDiff();
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
