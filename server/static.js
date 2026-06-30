const fsp = require("node:fs/promises");
const path = require("node:path");
const { ROOT } = require("./config");
const { httpError } = require("./http");

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function serveStatic(requestPath, res) {
  const filePath = requestPath === "/" ? path.join(ROOT, "index.html") : path.join(ROOT, requestPath);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(ROOT)) throw httpError(404, "Not found.");
  try {
    const data = await fsp.readFile(resolved);
    const ext = path.extname(resolved);
    res.writeHead(200, { "Content-Type": contentTypes[ext] ?? "application/octet-stream" });
    res.end(data);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") throw httpError(404, "Not found.");
    throw error;
  }
}

module.exports = {
  serveStatic,
};
