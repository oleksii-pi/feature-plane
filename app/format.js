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
    }
  });

  if (inList) html += "</ul>";
  return html;
}
