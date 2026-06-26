export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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
