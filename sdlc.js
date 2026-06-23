const fs = require("node:fs");
const path = require("node:path");

function loadSdlcConfig(rootDir = __dirname) {
  const filePath = path.join(rootDir, "SDLC.yaml");
  const source = fs.readFileSync(filePath, "utf8");
  return parseSdlcYaml(source, filePath);
}

function parseSdlcYaml(source, filePath) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const config = {};
  let index = skipIgnorableLines(lines, 0);

  if (index >= lines.length || countIndent(lines[index]) !== 0 || lines[index].trim() !== "sdlc:") {
    throw yamlError(filePath, index + 1, "Expected a top-level `sdlc:` mapping.");
  }

  index += 1;
  while (index < lines.length) {
    index = skipIgnorableLines(lines, index);
    if (index >= lines.length) break;

    const line = lines[index];
    const indent = countIndent(line);
    if (indent === 0) break;
    if (indent !== 2) {
      throw yamlError(filePath, index + 1, "Expected two-space indentation inside `sdlc:`.");
    }

    const { key, value } = splitKeyValue(line.trim(), filePath, index + 1);
    if (value) {
      config[key] = parseScalar(value);
      index += 1;
      continue;
    }

    if (key === "workflow") {
      const parsed = parseWorkflowList(lines, index + 1, filePath, 4);
      config.workflow = parsed.items;
      index = parsed.nextIndex;
      continue;
    }

    if (key === "agents") {
      const parsed = parseScalarList(lines, index + 1, filePath, 4);
      config.agents = parsed.items;
      index = parsed.nextIndex;
      continue;
    }

    const skipped = skipIndentedBlock(lines, index + 1, 2);
    index = skipped.nextIndex;
  }

  if (!Array.isArray(config.workflow) || !config.workflow.length) {
    throw yamlError(filePath, lines.length, "Missing non-empty `sdlc.workflow`.");
  }

  const agents = Array.isArray(config.agents) ? config.agents.map((agent) => String(agent).trim()) : [];
  if (config.workflow.some((entry) => Boolean(entry.value.agent)) && !agents.length) {
    throw yamlError(filePath, lines.length, "Workflow contains agent states but `sdlc.agents` is missing.");
  }

  config.workflow = config.workflow.map((entry, workflowIndex) =>
    normalizeWorkflowStep(entry.value, entry.lineNumber, workflowIndex, agents, filePath),
  );
  if (agents.length) config.agents = agents;

  return config;
}

function parseWorkflowList(lines, startIndex, filePath, itemIndent) {
  const items = [];
  let index = startIndex;
  let currentItem = null;

  while (index < lines.length) {
    if (isIgnorableLine(lines[index])) {
      index += 1;
      continue;
    }

    const indent = countIndent(lines[index]);
    if (indent <= 2) break;
    if (indent !== itemIndent && indent !== itemIndent + 2) {
      throw yamlError(
        filePath,
        index + 1,
        "Workflow items must use four-space indentation and properties six-space indentation.",
      );
    }

    const trimmed = lines[index].trim();
    if (indent === itemIndent) {
      if (!trimmed.startsWith("-")) {
        throw yamlError(filePath, index + 1, "Workflow list items must begin with `-`.");
      }
      if (currentItem) items.push(currentItem);
      currentItem = { value: {}, lineNumber: index + 1 };
      const remainder = trimmed.slice(1).trim();
      if (remainder) assignMappingEntry(currentItem.value, remainder, filePath, index + 1);
      index += 1;
      continue;
    }

    if (!currentItem) {
      throw yamlError(filePath, index + 1, "Workflow step properties must follow a list item.");
    }

    assignMappingEntry(currentItem.value, trimmed, filePath, index + 1);
    index += 1;
  }

  if (currentItem) items.push(currentItem);
  return { items, nextIndex: index };
}

function parseScalarList(lines, startIndex, filePath, itemIndent) {
  const items = [];
  let index = startIndex;

  while (index < lines.length) {
    if (isIgnorableLine(lines[index])) {
      index += 1;
      continue;
    }

    const indent = countIndent(lines[index]);
    if (indent <= 2) break;
    if (indent !== itemIndent) {
      throw yamlError(filePath, index + 1, "List items must use four-space indentation.");
    }

    const trimmed = lines[index].trim();
    if (!trimmed.startsWith("-")) {
      throw yamlError(filePath, index + 1, "List items must begin with `-`.");
    }

    const value = trimmed.slice(1).trim();
    if (!value) {
      throw yamlError(filePath, index + 1, "List items must define a value.");
    }

    items.push(parseScalar(value));
    index += 1;
  }

  return { items, nextIndex: index };
}

function skipIndentedBlock(lines, startIndex, baseIndent) {
  let index = startIndex;

  while (index < lines.length) {
    if (isIgnorableLine(lines[index])) {
      index += 1;
      continue;
    }

    if (countIndent(lines[index]) <= baseIndent) break;
    index += 1;
  }

  return { nextIndex: index };
}

function assignMappingEntry(target, text, filePath, lineNumber) {
  const { key, value } = splitKeyValue(text, filePath, lineNumber);
  if (!value) {
    throw yamlError(filePath, lineNumber, `Expected a value for \`${key}\`.`);
  }
  target[key] = parseScalar(value);
}

function normalizeWorkflowStep(step, lineNumber, workflowIndex, agents, filePath) {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    throw yamlError(filePath, lineNumber, "Each workflow step must be a mapping.");
  }

  const normalized = { ...step };
  normalized.state = normalizeString(normalized.state);
  if (!normalized.state) {
    throw yamlError(filePath, lineNumber, "Each workflow step must include a non-empty `state`.");
  }

  if ("artifact" in normalized) {
    normalized.artifact = normalizeString(normalized.artifact);
    if (!normalized.artifact) {
      throw yamlError(filePath, lineNumber, `Workflow step \`${normalized.state}\` has an empty artifact.`);
    }
  }

  if ("agent" in normalized) {
    normalized.agent = normalizeString(normalized.agent);
    if (!normalized.agent) {
      throw yamlError(filePath, lineNumber, `Workflow step \`${normalized.state}\` has an empty agent.`);
    }
  }

  const isAgentState = normalized.state.startsWith("@");
  if (isAgentState && !normalized.agent) {
    throw yamlError(filePath, lineNumber, `Agent workflow step \`${normalized.state}\` must declare an agent.`);
  }
  if (!isAgentState && normalized.agent) {
    throw yamlError(filePath, lineNumber, `Human workflow step \`${normalized.state}\` cannot declare an agent.`);
  }
  if (isAgentState && agents.length && !agents.includes(normalized.agent)) {
    throw yamlError(
      filePath,
      lineNumber,
      `Agent workflow step \`${normalized.state}\` references unknown agent \`${normalized.agent}\`.`,
    );
  }
  if (workflowIndex === 0 && normalized.artifact !== "prompt.md") {
    throw yamlError(filePath, lineNumber, "The first workflow step must produce `prompt.md`.");
  }
  if (isAgentState && !normalized.artifact) {
    throw yamlError(filePath, lineNumber, `Agent workflow step \`${normalized.state}\` must declare an artifact.`);
  }

  return normalized;
}

function splitKeyValue(text, filePath, lineNumber) {
  const colonIndex = text.indexOf(":");
  if (colonIndex < 0) {
    throw yamlError(filePath, lineNumber, `Expected a key/value pair, got \`${text}\`.`);
  }

  const key = text.slice(0, colonIndex).trim();
  const value = text.slice(colonIndex + 1).trim();
  if (!key) {
    throw yamlError(filePath, lineNumber, "Expected a non-empty key.");
  }

  return { key, value };
}

function parseScalar(raw) {
  const value = stripInlineComment(raw.trim());
  if (!value) return "";

  if (value === "null" || value === "~") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);

  if (value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\(["\\nrt])/g, (_, escaped) => {
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

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }

  return value;
}

function normalizeString(value) {
  return String(value ?? "").trim();
}

function stripInlineComment(text) {
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const previous = text[index - 1];

    if (inDoubleQuote) {
      if (char === "\\" && index + 1 < text.length) {
        index += 1;
        continue;
      }
      if (char === '"') {
        inDoubleQuote = false;
      }
      continue;
    }

    if (inSingleQuote) {
      if (char === "'" && text[index + 1] === "'") {
        index += 1;
        continue;
      }
      if (char === "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (char === '"') {
      inDoubleQuote = true;
      continue;
    }
    if (char === "'") {
      inSingleQuote = true;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(previous))) {
      return text.slice(0, index).trimEnd();
    }
  }

  return text.trimEnd();
}

function skipIgnorableLines(lines, startIndex) {
  let index = startIndex;
  while (index < lines.length && isIgnorableLine(lines[index])) index += 1;
  return index;
}

function isIgnorableLine(line) {
  const trimmed = line.trim();
  return !trimmed || trimmed.startsWith("#");
}

function countIndent(line) {
  const match = line.match(/^ */);
  return match ? match[0].length : 0;
}

function yamlError(filePath, lineNumber, message) {
  const error = new Error(`${path.basename(filePath)}:${lineNumber}: ${message}`);
  error.code = "SDLC_YAML_ERROR";
  return error;
}

module.exports = { loadSdlcConfig };
