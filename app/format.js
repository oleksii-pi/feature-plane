export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function formatLogSize(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return size ? "1kb" : "0kb";
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)}kb`;
  return `${(size / 1024 / 1024).toFixed(1).replace(/\.0$/, "")}mb`;
}

export function formatDuration(startedAt, finishedAt = new Date()) {
  const start = new Date(startedAt);
  const end = finishedAt ? new Date(finishedAt) : new Date();
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf())) return "--:--";
  const totalSeconds = Math.max(0, Math.floor((end - start) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function padDatePart(value) {
  return String(value).padStart(2, "0");
}

function formatLocalDateTime(date) {
  return [
    date.getFullYear(),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate()),
  ].join("-") + " " + [
    padDatePart(date.getHours()),
    padDatePart(date.getMinutes()),
    padDatePart(date.getSeconds()),
  ].join(":");
}

export function currentDateTime() {
  return formatLocalDateTime(new Date());
}

export function formatDateTime(value) {
  if (value instanceof Date) {
    return formatLocalDateTime(value);
  }
  const text = String(value ?? "");
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) return text;
  const date = new Date(text);
  if (Number.isNaN(date.valueOf())) return text;
  return formatLocalDateTime(date);
}

export function formatDateTimeParts(value) {
  const text = formatDateTime(value);
  const match = text.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/);
  return match ? { date: match[1], time: match[2] } : { date: text, time: "" };
}

export function markdownToHtml(content) {
  const lines = escapeHtml(content).split("\n");
  let html = "";
  let inList = false;

  lines.forEach((line) => {
    if (line.startsWith("## ")) {
      if (inList) html += "</ul>";
      inList = false;
      html += `<h4>${line.slice(3)}</h4>`;
    } else if (/^\d+\. /.test(line) || line.startsWith("- ")) {
      if (!inList) html += "<ul>";
      inList = true;
      html += `<li>${line.replace(/^\d+\. |^- /, "")}</li>`;
    } else if (line.trim()) {
      if (inList) html += "</ul>";
      inList = false;
      html += `<p>${line}</p>`;
    } else {
      if (inList) html += "</ul>";
      inList = false;
      html += '<p class="artifact-blank-line"><br></p>';
    }
  });

  if (inList) html += "</ul>";
  return html;
}
