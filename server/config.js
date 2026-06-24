const fs = require("node:fs");
const path = require("node:path");
const { loadSdlcConfig } = require("../sdlc");

const ROOT = path.join(__dirname, "..");
const ENV_FILE = path.join(ROOT, ".env");

loadDotEnv(ENV_FILE);

const sdlcConfig = loadSdlcConfig(ROOT);
const PORT = resolvePort(process.argv.slice(2), sdlcConfig.app_port);
const FEATURES_HOME = resolveFeaturesHome(process.env.features_home);
const FEATURE_ROOT = path.join(ROOT, FEATURES_HOME);
const LEGACY_FEATURE_ROOTS = ["feature", ".features"].filter((entry) => entry !== FEATURES_HOME);
const STATE_FILE = path.join(FEATURE_ROOT, "state.json");
const { workflow } = sdlcConfig;
const WORKSPACE_COPY_EXCLUDES = new Set([FEATURES_HOME, ...LEGACY_FEATURE_ROOTS, ".git", ".env"]);

function loadDotEnv(filePath) {
  let source;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return;
  }

  source
    .replace(/\r\n/g, "\n")
    .split("\n")
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;

      const entry = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
      const equalsIndex = entry.indexOf("=");
      if (equalsIndex < 0) return;

      const key = entry.slice(0, equalsIndex).trim();
      if (!key || process.env[key] !== undefined) return;

      const rawValue = entry.slice(equalsIndex + 1).trim();
      process.env[key] = parseDotEnvValue(rawValue);
    });
}

function parseDotEnvValue(rawValue) {
  if (!rawValue) return "";

  const quoted =
    (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"));
  if (quoted) {
    const body = rawValue.slice(1, -1);
    if (rawValue.startsWith('"')) {
      return body.replace(/\\(["\\nrt])/g, (_, escaped) => {
        switch (escaped) {
          case '"':
            return '"';
          case "\\":
            return "\\";
          case "n":
            return "\n";
          case "r":
            return "\r";
          case "t":
            return "\t";
          default:
            return escaped;
        }
      });
    }
    return body;
  }

  const commentIndex = rawValue.search(/\s#/);
  return commentIndex >= 0 ? rawValue.slice(0, commentIndex).trimEnd() : rawValue;
}

function resolvePort(argv, fallbackPort) {
  const cliPort = parsePort(argv[0]);
  if (cliPort !== null) return cliPort;

  const envPort = parsePort(process.env.PORT ?? process.env.port);
  if (envPort !== null) return envPort;

  const sdlcPort = parsePort(fallbackPort);
  if (sdlcPort !== null) return sdlcPort;

  return 8765;
}

function parsePort(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) return null;
  return parsed;
}

function resolveFeaturesHome(rawValue) {
  const fallback = "feature";
  const original = String(rawValue ?? fallback).trim();
  if (!original || original === "." || path.isAbsolute(original)) return fallback;

  const normalized = original
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+|\/+$/g, "");

  if (!normalized || normalized === ".") return fallback;
  return normalized;
}

function getAgentRunCommand() {
  return String(process.env.agent_run_command ?? "").trim();
}

function getFeatureRunCommand() {
  return String(process.env.feature_run_command ?? "").trim();
}

module.exports = {
  ROOT,
  PORT,
  FEATURES_HOME,
  FEATURE_ROOT,
  LEGACY_FEATURE_ROOTS,
  STATE_FILE,
  WORKSPACE_COPY_EXCLUDES,
  sdlcConfig,
  workflow,
  getAgentRunCommand,
  getFeatureRunCommand,
};
