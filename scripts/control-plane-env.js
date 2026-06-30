#!/usr/bin/env node

function envValue(name) {
  const key = normalizeName(name);
  return process.env[key] ?? "";
}

function requiredEnv(name) {
  const key = normalizeName(name);
  const value = envValue(key);
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function normalizeName(name) {
  const key = String(name ?? "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid environment variable name: ${key || "(empty)"}.`);
  }
  return key;
}

function usage() {
  return [
    "Usage: node scripts/control-plane-env.js [--optional] NAME",
    "",
    "Prints the value of NAME. Missing required values exit non-zero.",
  ].join("\n");
}

function runCli(argv) {
  const args = [...argv];
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(usage());
    return 0;
  }
  const optional = args[0] === "--optional";
  if (optional) args.shift();
  if (args.length !== 1) {
    console.error(usage());
    return 2;
  }

  try {
    const value = optional ? envValue(args[0]) : requiredEnv(args[0]);
    if (value) process.stdout.write(`${value}\n`);
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = runCli(process.argv.slice(2));
}

module.exports = {
  envValue,
  requiredEnv,
};
