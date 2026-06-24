const fsp = require("node:fs/promises");
const path = require("node:path");
const { FEATURE_ROOT, workflow } = require("./config");
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
      await fsp.rm(path.join(FEATURE_ROOT, feature.slug), { recursive: true, force: true });
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
      const artifact = await updateArtifact(feature, Number(parts[3]), String(body.content ?? ""));
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

    if (req.method === "POST" && parts[2] === "cancel") {
      const cancelled = await cancelRun(run.id);
      sendJson(res, 200, cancelled);
      return;
    }
  }

  await serveStatic(url.pathname, res);
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
