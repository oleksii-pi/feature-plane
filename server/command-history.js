const { formatDateTime } = require("./time");

const MAX_COMMAND_HISTORY = 500;

function shellQuote(value) {
  const text = String(value ?? "");
  if (!text.length) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return "'" + text.split("'").join("'\"'\"'") + "'";
}

function formatShellCommand(command, args = []) {
  return [command, ...args].map(shellQuote).join(" ");
}

function normalizeCommandHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const command = String(entry.command ?? "").trim();
      if (!command) return null;
      return {
        timestamp: entry.timestamp
          ? formatDateTime(entry.timestamp)
          : formatDateTime(),
        command,
      };
    })
    .filter(Boolean)
    .slice(-MAX_COMMAND_HISTORY);
}

function recordEnvironmentCommand(feature, command, timestamp = formatDateTime()) {
  const normalizedCommand = String(command ?? "").trim();
  if (!feature || !normalizedCommand) return null;
  const entry = {
    timestamp: formatDateTime(timestamp),
    command: normalizedCommand,
  };
  feature.environmentCommands = normalizeCommandHistory([
    ...(feature.environmentCommands ?? []),
    entry,
  ]);
  return entry;
}

module.exports = {
  formatShellCommand,
  normalizeCommandHistory,
  recordEnvironmentCommand,
};
