"use strict";

const { isProtectedProcess } = require("../classifier/safety");
const { redactSensitiveText } = require("../privacy/redact");
const { matchLauncher } = require("./launcher");

const DEFAULT_MAX_DEPTH = 5;

function buildProcessTree(record, processes, options = {}) {
  const safetyConfig = options.safetyConfig || {};
  const maxDepth = normalizeMaxDepth(options.maxDepth);
  const visited = new Set();
  const leafProcess = {
    pid: record.pid,
    parentPid: record.parentPid,
    processName: record.processName,
    commandLine: record.commandLine,
    executablePath: record.executablePath
  };
  const leafToRoot = [];
  const evidence = [];
  let current = leafProcess;
  let truncated = false;
  let stopReason = null;

  while (current) {
    const item = toChainItem(current, safetyConfig);
    leafToRoot.push(item);

    if (isProtectedProcess(current.processName, safetyConfig)) {
      stopReason = "protected-boundary";
      evidence.push(evidenceItem(0, `process-tree traversal stopped at protected process: ${current.processName || "unknown"}`));
      break;
    }

    if (leafToRoot.length >= maxDepth) {
      truncated = Boolean(current.parentPid);
      stopReason = truncated ? "max-depth" : "root";
      if (truncated) {
        evidence.push(evidenceItem(0, `process-tree traversal stopped at max depth ${maxDepth}`));
      }
      break;
    }

    const parentPid = nullableNumber(current.parentPid);
    if (parentPid == null || parentPid <= 0) {
      stopReason = "missing-parent-pid";
      evidence.push(evidenceItem(0, "process-tree traversal stopped because parent PID is unavailable"));
      break;
    }

    if (visited.has(parentPid)) {
      truncated = true;
      stopReason = "cycle";
      evidence.push(evidenceItem(0, `process-tree traversal stopped because parent PID ${parentPid} repeats`));
      break;
    }

    visited.add(current.pid);
    if (visited.has(parentPid)) {
      truncated = true;
      stopReason = "cycle";
      evidence.push(evidenceItem(0, `process-tree traversal stopped because parent PID ${parentPid} repeats`));
      break;
    }

    const parent = processes.get(parentPid);
    if (!parent) {
      stopReason = "missing-parent-metadata";
      evidence.push(evidenceItem(0, `process-tree traversal stopped because parent metadata is unavailable for pid ${parentPid}`));
      break;
    }

    current = parent;
  }

  const chain = leafToRoot.reverse();
  const labels = chain.map((item) => item.launcherName || item.processName || "unknown").filter(Boolean);
  const pattern = detectPattern(chain);
  if (pattern) {
    evidence.unshift(evidenceItem(pattern.score, pattern.message));
  } else if (labels.length > 1) {
    evidence.unshift(evidenceItem(2, `process-tree ancestry observed: ${labels.join(" -> ")}`));
  } else {
    evidence.unshift(evidenceItem(0, "process-tree ancestry unavailable or single process only"));
  }

  return {
    depth: chain.length,
    truncated,
    stopReason,
    rootLauncher: labels[0] || null,
    chain,
    evidence
  };
}

function toChainItem(process, safetyConfig) {
  const detected = matchLauncher(process.processName, process.commandLine, process.executablePath);
  const protectedProcess = isProtectedProcess(process.processName, safetyConfig);
  return {
    pid: nullableNumber(process.pid),
    processName: process.processName || null,
    category: protectedProcess ? "system-or-protected" : detected.category,
    launcherName: detected.matched ? detected.name : null,
    commandLine: redactSensitiveText(process.commandLine),
    executablePath: redactSensitiveText(process.executablePath)
  };
}

function detectPattern(chain) {
  const labels = chainLabels(chain);
  if (has(labels, "vs code") && hasTerminal(labels) && hasPackageManager(labels) && has(labels, "node")) {
    return { score: 8, message: "process-tree pattern detected: VS Code -> shell -> package manager -> node" };
  }
  if (has(labels, "cursor") && hasTerminal(labels) && hasPackageManager(labels) && (has(labels, "node") || hasCommand(chain, "vite"))) {
    return { score: 8, message: "process-tree pattern detected: Cursor -> shell -> package manager -> node/vite" };
  }
  if (has(labels, "windows terminal") && has(labels, "powershell") && has(labels, "python")) {
    return { score: 7, message: "process-tree pattern detected: Windows Terminal -> PowerShell -> python" };
  }
  if (has(labels, "command prompt") && has(labels, "npm") && has(labels, "node")) {
    return { score: 7, message: "process-tree pattern detected: Command Prompt -> npm -> node" };
  }
  if (has(labels, "git bash") && hasPackageManager(labels) && has(labels, "node")) {
    return { score: 7, message: "process-tree pattern detected: Git Bash -> package manager -> node" };
  }
  if ((has(labels, "gradle java") || has(labels, "maven java")) && has(labels, "java")) {
    return { score: 6, message: "process-tree pattern detected: Gradle/Maven -> java" };
  }
  if (labels.filter((label) => label === "python").length >= 2 || (has(labels, "python") && hasCommand(chain, "uvicorn"))) {
    return { score: 6, message: "process-tree pattern detected: Python launcher -> python server" };
  }
  if (has(labels, "docker desktop") || has(labels, "docker compose")) {
    return { score: 5, message: "process-tree pattern detected: Docker Desktop or docker compose ancestry" };
  }
  return null;
}

function chainLabels(chain) {
  return chain.map((item) => String(item.launcherName || item.processName || "").toLowerCase());
}

function has(labels, value) {
  return labels.includes(value);
}

function hasTerminal(labels) {
  return labels.some((label) => ["powershell", "command prompt", "git bash", "windows terminal"].includes(label));
}

function hasPackageManager(labels) {
  return labels.some((label) => ["npm", "npx", "pnpm", "yarn"].includes(label));
}

function hasCommand(chain, value) {
  const needle = String(value).toLowerCase();
  return chain.some((item) => String(item.commandLine || "").toLowerCase().includes(needle));
}

function evidenceItem(score, message) {
  return {
    type: "process-tree",
    score,
    message
  };
}

function normalizeMaxDepth(value) {
  const number = Number(value || DEFAULT_MAX_DEPTH);
  if (!Number.isInteger(number) || number < 1) return DEFAULT_MAX_DEPTH;
  return Math.min(number, 10);
}

function nullableNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

module.exports = {
  DEFAULT_MAX_DEPTH,
  buildProcessTree,
  detectPattern
};
