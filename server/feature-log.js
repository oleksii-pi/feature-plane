const { formatDateTime } = require("./time");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function featureTimelineEntries(feature) {
  const changeRequestRunIndex = new Map();
  const liveRuns = Array.isArray(feature?.runs) ? feature.runs : [];
  const archivedRuns = Array.isArray(feature?.archivedRuns)
    ? feature.archivedRuns
    : [];

  liveRuns.forEach((run, index) => {
    if (run.changeRequestArtifact) {
      changeRequestRunIndex.set(run.changeRequestArtifact, { run, index });
    }
  });

  const artifacts = (feature?.artifacts ?? []).map((artifact, index) => ({
    kind: "artifact",
    artifact,
    sourceIndex: index,
    order: artifact.availableAtStep ?? 0,
    ...artifactSortPosition(artifact, index, changeRequestRunIndex),
  }));
  const runs = [...liveRuns, ...archivedRuns].map((run, index) => ({
    kind: "run",
    run,
    sourceIndex: index,
    order: run.step,
    createdOrder: index * 2,
    sortTime: run.startedAt ?? "",
  }));

  return [...artifacts, ...runs].sort(
    (a, b) =>
      sortTime(a).localeCompare(sortTime(b)) ||
      a.order - b.order ||
      a.createdOrder - b.createdOrder,
  );
}

function sortTime(entry) {
  return entry.sortTime ?? "";
}

function artifactSortPosition(artifact, index, changeRequestRunIndex) {
  const defaultSortTime = artifact.createdAt ?? artifact.updated ?? "";
  const attachedRun = changeRequestRunIndex.get(artifact.name);
  if (!attachedRun) {
    return {
      createdOrder: index * 2 + 1,
      sortTime: defaultSortTime,
    };
  }
  const runSortTime = attachedRun.run.startedAt ?? "";
  return {
    createdOrder: attachedRun.index * 2 - 1,
    sortTime:
      runSortTime && defaultSortTime
        ? [runSortTime, defaultSortTime].sort()[0]
        : runSortTime || defaultSortTime,
  };
}

function displayRunTitle(step) {
  return String(step?.agent ?? step?.state ?? "Run");
}

function displayRunPrice(run) {
  return run.cost ?? "";
}

function displayRunDuration(run) {
  const startedAt = new Date(run.startedAt);
  const finishedAt = run.finishedAt ? new Date(run.finishedAt) : new Date();
  if (Number.isNaN(startedAt.valueOf()) || Number.isNaN(finishedAt.valueOf())) {
    return "--:--";
  }
  const totalSeconds = Math.max(0, Math.floor((finishedAt - startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function runLabel(run) {
  if (run.status === "running" || run.status === "queued") return "Running";
  if (run.status === "cancelled") return "Stopped";
  return run.status.charAt(0).toUpperCase() + run.status.slice(1);
}

function formatRunEventsMarkdown(run) {
  return (run.events ?? [])
    .map((event) => {
      const timestamp = formatDateTime(event.timestamp);
      const status = String(event.status ?? "");
      const isOutput = status === "stdout" || status === "stderr";
      return isOutput
        ? `${timestamp} ${event.message}`
        : `${timestamp} ${status}${status ? ": " : ""}${event.message}`;
    })
    .filter((line) => String(line).trim())
    .join("\n");
}

function markdownFromTimelineEntry(feature, entry) {
  if (entry.kind === "artifact") {
    const time = formatDateTime(entry.artifact.updated ?? entry.artifact.createdAt);
    const content = String(entry.artifact.content ?? "")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .filter((line) => String(line).trim())
      .join("\n")
      .trimEnd();
    return [
      `<span style='font-weight:100'>${escapeHtml(time)}</span>`,
      "",
      `## ${escapeHtml(entry.artifact.name)}`,
      content || "_Empty artifact_",
    ]
      .join("\n")
      .trimEnd();
  }

  const step = featureWorkflowStep(feature, entry.run.step);
  const logUrl = `/runs/${encodeURIComponent(entry.run.id)}/log/view`;
  const summary = [
    `Status: ${runLabel(entry.run)}`,
    `Duration: ${displayRunDuration(entry.run)}`,
    displayRunPrice(entry.run) ? `Price: ${displayRunPrice(entry.run)}` : "",
    entry.run.artifact ? `Produced: ${entry.run.artifact}` : "",
    `[View logs](${logUrl})`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const events = formatRunEventsMarkdown(entry.run);
  return [
    `<span style='font-weight:100'>${escapeHtml(
      formatDateTime(entry.run.startedAt ?? entry.run.finishedAt ?? entry.run.updated),
    )}</span>`,
    "",
    `## ${escapeHtml(displayRunTitle(step))}`,
    summary,
    "### Run log",
    "```text",
    events || "No events recorded.",
    "```",
  ]
    .join("\n")
    .trimEnd();
}

function featureWorkflowStep(feature, index) {
  const workflow = Array.isArray(feature?.sdlc?.workflow)
    ? feature.sdlc.workflow
    : [];
  return workflow[Number(index)] ?? {};
}

function featureLogMarkdown(feature) {
  const entries = featureTimelineEntries(feature);
  return entries.map((entry) => markdownFromTimelineEntry(feature, entry)).join("\n");
}

function renderInlineMarkdown(text) {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function renderMarkdownPreview(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let inList = false;
  let inCode = false;

  const closeList = () => {
    if (!inList) return;
    html.push("</ul>");
    inList = false;
  };

  lines.forEach((line) => {
    if (line.startsWith("```")) {
      if (inCode) {
        html.push("</code></pre>");
        inCode = false;
      } else {
        closeList();
        html.push('<pre class="markdown-code"><code>');
        inCode = true;
      }
      return;
    }

    if (inCode) {
      html.push(`${escapeHtml(line)}\n`);
      return;
    }

    if (/^<span style='font-weight:100'>.*<\/span>$/.test(line)) {
      closeList();
      html.push(line);
      return;
    }

    if (line.startsWith("## ")) {
      closeList();
      html.push(`<h2>${renderInlineMarkdown(line.slice(3))}</h2>`);
      return;
    }

    if (line.startsWith("### ")) {
      closeList();
      html.push(`<h3>${renderInlineMarkdown(line.slice(4))}</h3>`);
      return;
    }

    if (/^\d+\. /.test(line) || line.startsWith("- ")) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${renderInlineMarkdown(line.replace(/^\d+\. |^- /, ""))}</li>`);
      return;
    }

    if (!line.trim()) return;

    closeList();
    html.push(`<p>${renderInlineMarkdown(line)}</p>`);
  });

  closeList();
  if (inCode) html.push("</code></pre>");
  return html.join("");
}

function scriptJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("&", "\\u0026");
}

function sendFeatureLogView(res, feature) {
  const markdown = featureLogMarkdown(feature);
  const preview = renderMarkdownPreview(markdown);
  const title = escapeHtml(feature.name);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} feature log</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f6f8;
      --panel: #ffffff;
      --text: #172033;
      --muted: #697386;
      --border: #dfe4eb;
      --border-strong: #cbd3dd;
      --button: #172033;
      --button-hover: #2a3550;
      --link: #275cc5;
      --shadow: 0 24px 80px rgba(15, 23, 42, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background:
        radial-gradient(circle at top left, rgba(39, 92, 197, 0.08), transparent 30%),
        radial-gradient(circle at top right, rgba(23, 160, 106, 0.08), transparent 25%),
        var(--bg);
      color: var(--text);
      font: 14px/1.5 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .shell {
      max-width: 1040px;
      margin: 0 auto;
      padding: 18px;
    }
    .header {
      position: sticky;
      top: 0;
      z-index: 1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 16px;
      padding: 14px 18px;
      border: 1px solid var(--border);
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.88);
      box-shadow: var(--shadow);
      backdrop-filter: blur(10px);
    }
    .eyebrow {
      margin: 0 0 4px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      font-size: 24px;
      line-height: 1.1;
    }
    .header-copy {
      margin: 5px 0 0;
      color: var(--muted);
    }
    .copy-button {
      min-height: 38px;
      padding: 0 14px;
      border: 1px solid var(--button);
      border-radius: 10px;
      background: var(--button);
      color: #fff;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    .copy-button:hover {
      background: var(--button-hover);
    }
    .preview {
      padding: 22px 22px 30px;
      border: 1px solid var(--border);
      border-radius: 20px;
      background: rgba(255, 255, 255, 0.92);
      box-shadow: var(--shadow);
    }
    .preview > :first-child { margin-top: 0; }
    .preview > :last-child { margin-bottom: 0; }
    .preview h2 {
      margin: 18px 0 8px;
      font-size: 18px;
      line-height: 1.2;
    }
    .preview h3 {
      margin: 16px 0 8px;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
    }
    .preview p,
    .preview li {
      margin: 0;
      white-space: pre-wrap;
    }
    .preview p + p,
    .preview p + ul,
    .preview ul + p,
    .preview ul + ul,
    .preview h2 + p,
    .preview h2 + ul,
    .preview h3 + p,
    .preview h3 + ul {
      margin-top: 12px;
    }
    .preview ul {
      padding-left: 20px;
      margin: 0;
    }
    .preview li + li {
      margin-top: 4px;
    }
    .preview code {
      padding: 1px 5px;
      border-radius: 6px;
      background: #eef2f7;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.95em;
    }
    .markdown-code code {
      display: block;
      padding: 0;
      border-radius: 0;
      background: transparent;
      color: inherit;
      white-space: pre;
    }
    .markdown-code {
      margin: 12px 0;
      padding: 14px;
      overflow: auto;
      border-radius: 12px;
      background: #10151f;
      color: #e8eef9;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
      line-height: 1.5;
    }
    .blank-line {
      margin: 0;
      min-height: 1.3em;
    }
    a {
      color: var(--link);
    }
    @media (max-width: 760px) {
      .header {
        flex-direction: column;
        align-items: stretch;
      }
      .copy-button {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="header">
      <div>
        <p class="eyebrow">Feature log</p>
        <h1>${title}</h1>
        <p class="header-copy">Rendered markdown preview of the full feature log.</p>
      </div>
      <button id="copy-button" class="copy-button" type="button">Copy</button>
    </header>
    <main class="preview" id="preview">${preview}</main>
  </div>
  <script id="feature-log-data" type="application/json">${scriptJson(markdown)}</script>
  <script>
    const data = JSON.parse(document.getElementById("feature-log-data").textContent);
    const copyButton = document.getElementById("copy-button");
    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(data);
        copyButton.textContent = "Copied";
      } catch {
        copyButton.textContent = "Unavailable";
      }
      window.setTimeout(() => {
        copyButton.textContent = "Copy";
      }, 1200);
    });
  </script>
</body>
</html>`);
}

module.exports = {
  featureLogMarkdown,
  sendFeatureLogView,
};
