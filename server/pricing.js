const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { AGENT_PRICING, RUN_LOG_ROOT } = require("./config");

function parseTokenCount(value) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value ?? "").replace(/,/g, "").trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function firstTokenMatch(source, patterns) {
  for (const pattern of patterns) {
    const match = source.match(pattern);
    const count = parseTokenCount(match?.[1]);
    if (count !== null) return count;
  }
  return null;
}

function parseCodexTotalTokens(source) {
  const lines = String(source ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(/^\[[^\]]+\]\s+\[(?:stdout|stderr)\]\s*/, "")
        .trim(),
    );

  for (let index = 0; index < lines.length; index += 1) {
    if (!/^tokens used$/i.test(lines[index])) continue;
    for (let distance = 1; distance <= 8; distance += 1) {
      const count = parseTokenCount(lines[index + distance]) ?? parseTokenCount(lines[index - distance]);
      if (count !== null) return count;
    }
  }

  return firstTokenMatch(source, [
    /tokens used\s+(\d[\d,]*)/i,
    /(\d[\d,]*)\s+tokens used/i,
  ]);
}

function parseUsageFromLog(source) {
  const inputTokens = firstTokenMatch(source, [
    /"input_tokens"\s*:\s*(\d[\d,]*)/i,
    /(?:input|prompt)\s+tokens?\s*[:=]?\s*(\d[\d,]*)/i,
  ]);
  const outputTokens = firstTokenMatch(source, [
    /"output_tokens"\s*:\s*(\d[\d,]*)/i,
    /(?:output|completion)\s+tokens?\s*[:=]?\s*(\d[\d,]*)/i,
  ]);

  if (inputTokens !== null || outputTokens !== null) {
    return {
      inputTokens: inputTokens ?? 0,
      cachedInputTokens: 0,
      outputTokens: outputTokens ?? 0,
      totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
      source: "split",
    };
  }

  const totalTokens = parseCodexTotalTokens(source);
  if (totalTokens !== null) {
    return {
      inputTokens: totalTokens,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens,
      source: "codex-total",
    };
  }

  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    source: "unavailable",
  };
}

function parseCodexSessionId(source) {
  return source.match(/session id:\s*([0-9a-f-]+)/i)?.[1] ?? null;
}

function codexSessionRoots() {
  return [
    path.join(os.homedir(), ".codex", "sessions"),
    path.join(os.homedir(), ".codex", "codex", "sessions"),
  ];
}

async function findCodexSessionFile(sessionId) {
  if (!sessionId) return null;
  for (const root of codexSessionRoots()) {
    const found = await findFileContaining(root, sessionId);
    if (found) return found;
  }
  return null;
}

async function findFileContaining(root, needle) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EACCES") return null;
    throw error;
  }

  entries.sort((a, b) => b.name.localeCompare(a.name));
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = await findFileContaining(entryPath, needle);
      if (found) return found;
    } else if (entry.isFile() && entry.name.includes(needle)) {
      return entryPath;
    }
  }
  return null;
}

function parseUsageFromSession(source) {
  let latestUsage = null;
  String(source ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .forEach((line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      const usage = event?.payload?.info?.total_token_usage;
      if (!usage || typeof usage !== "object") return;
      latestUsage = usage;
    });

  if (!latestUsage) return null;
  const inputTokens = parseTokenCount(latestUsage.input_tokens) ?? 0;
  const cachedInputTokens = parseTokenCount(latestUsage.cached_input_tokens) ?? 0;
  const outputTokens = parseTokenCount(latestUsage.output_tokens) ?? 0;
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    source: "codex-session",
  };
}

async function parseCodexSessionUsage(logSource) {
  const sessionId = parseCodexSessionId(logSource);
  const sessionFile = await findCodexSessionFile(sessionId);
  if (!sessionFile) return null;
  const sessionSource = await fsp.readFile(sessionFile, "utf8");
  const usage = parseUsageFromSession(sessionSource);
  return usage ? { ...usage, sessionId, sessionFile } : null;
}

function calculateUsagePrice(usage) {
  const cachedInputTokens = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const uncachedInputTokens = Math.max(0, usage.inputTokens - cachedInputTokens);
  const inputCostUsd = uncachedInputTokens * AGENT_PRICING.inputTokenPrice;
  const cachedInputCostUsd = cachedInputTokens * AGENT_PRICING.cachedInputTokenPrice;
  const outputCostUsd = usage.outputTokens * AGENT_PRICING.outputTokenPrice;
  const costUsd = inputCostUsd + cachedInputCostUsd + outputCostUsd;
  return {
    currency: "USD",
    inputTokenPrice: AGENT_PRICING.inputTokenPrice,
    cachedInputTokenPrice: AGENT_PRICING.cachedInputTokenPrice,
    outputTokenPrice: AGENT_PRICING.outputTokenPrice,
    uncachedInputTokens,
    cachedInputTokens,
    inputCostUsd,
    cachedInputCostUsd,
    outputCostUsd,
    costUsd,
  };
}

function formatUsd(amount) {
  if (!Number.isFinite(amount)) return "TBD";
  if (amount > 0 && amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

async function priceRun(run) {
  let logSource = "";
  try {
    logSource = await fsp.readFile(path.join(RUN_LOG_ROOT, `${run.id}.log`), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const usage = (await parseCodexSessionUsage(logSource)) ?? parseUsageFromLog(logSource);
  const pricing = calculateUsagePrice(usage);
  run.usage = usage;
  run.pricing = pricing;
  run.cost = usage.totalTokens ? formatUsd(pricing.costUsd) : "TBD";
  return run;
}

function updateFeatureCost(feature) {
  const total = (feature.runs ?? []).reduce((sum, run) => {
    const cost = Number(run?.pricing?.costUsd);
    return Number.isFinite(cost) ? sum + cost : sum;
  }, 0);
  feature.cost = total > 0 ? formatUsd(total) : null;
  return feature.cost;
}

module.exports = {
  formatUsd,
  parseUsageFromLog,
  priceRun,
  updateFeatureCost,
};
