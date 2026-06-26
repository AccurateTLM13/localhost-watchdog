"use strict";

const { existsSync } = require("node:fs");
const { expandEnvPath } = require("../config/load");

const DEFAULT_LIFECYCLE_CONFIG = {
  longRunningDevServerMs: 4 * 60 * 60 * 1000,
  staleCandidateMinimumScore: 60,
  categoryExclusions: [
    "database",
    "local-ai-server",
    "browser-helper",
    "editor-helper",
    "system-or-protected",
    "unknown-listener"
  ]
};

const TEMPORARY_DEV_CATEGORIES = new Set([
  "node-dev-server",
  "python-dev-server",
  "java-dev-server"
]);

function buildLifecycleContext(record, options = {}) {
  const config = normalizeLifecycleConfig(options.lifecycle || options.config && options.config.safety && options.config.safety.lifecycle);
  const processAge = {
    createdAt: record.createdAt || null,
    ageMs: Number.isFinite(Number(record.ageMs)) ? Number(record.ageMs) : null,
    label: record.ageLabel || "unknown age",
    source: record.timingSource || null,
    status: record.timingStatus || "unavailable",
    error: record.timingError || null
  };
  const excluded = isExcludedCategory(record.category, config);
  const temporaryDevServer = TEMPORARY_DEV_CATEGORIES.has(record.category);
  const parentAvailable = Boolean(record.launcher && record.launcher.parentCategory && record.launcher.parentCategory !== "missing");
  const rootLauncherAvailable = hasRootLauncher(record);
  const treeStopReason = record.processTree ? record.processTree.stopReason || null : null;
  const signals = [];
  const limitations = [];

  if (excluded) {
    limitations.push(`${record.category || "unknown"} is excluded from stale-candidate scoring`);
  }

  if (processAge.status !== "available") {
    limitations.push(`process timing is ${processAge.status}`);
  }

  const longRunning = processAge.ageMs != null && processAge.ageMs >= config.longRunningDevServerMs;
  if (longRunning) {
    addSignal(signals, "age-threshold", 20, `process exceeds long-running threshold: ${processAge.label}`);
  }

  if (!parentAvailable) {
    addSignal(signals, "missing-parent", 20, "immediate parent process metadata is unavailable");
  }

  if (!rootLauncherAvailable) {
    addSignal(signals, "missing-root-launcher", 15, "original editor or terminal ancestry is unavailable");
  }

  if (isUnexpectedTreeStop(treeStopReason)) {
    addSignal(signals, "unexpected-tree-stop", 10, `process tree ended unexpectedly: ${treeStopReason}`);
  } else if (treeStopReason === "max-depth") {
    limitations.push("process tree reached max depth; not treated as stale by itself");
  } else if (treeStopReason === "protected-boundary") {
    limitations.push("process tree reached a protected/system boundary");
  }

  if (isUnreachableHttpDevServer(record)) {
    addSignal(signals, "unreachable-http-dev-server", 25, "HTTP dev server probe is unreachable or non-HTTP");
  }

  const projectMissing = projectPathMissing(record.project);
  if (projectMissing) {
    addSignal(signals, "project-path-missing", 20, "project path no longer exists or cannot be accessed");
  }

  if (weakOrMissingProject(record.project)) {
    addSignal(signals, "weak-project-ownership", 10, "project ownership is weak or unavailable");
  }

  if (temporaryDevServer) {
    addSignal(signals, "temporary-dev-server", 10, "listener resembles a temporary development server");
  } else if (!excluded) {
    limitations.push("listener does not match temporary dev-server categories");
  }

  if (record.category === "system-or-protected" || record.hiddenReason === "protected") {
    limitations.push("protected/system listeners never receive cleanup recommendations");
  }

  const staleScore = excluded ? 0 : signals.reduce((total, signal) => total + signal.score, 0);
  const nonAgeSignals = signals.filter((signal) => signal.type !== "age-threshold" && signal.score > 0);
  const staleRiskSignals = signals.filter((signal) => [
    "unreachable-http-dev-server",
    "project-path-missing",
    "weak-project-ownership"
  ].includes(signal.type));
  const detachedCandidate = !excluded && longRunning && (Boolean(signals.find((signal) => signal.type === "missing-parent")) || Boolean(signals.find((signal) => signal.type === "missing-root-launcher")) || Boolean(signals.find((signal) => signal.type === "unexpected-tree-stop")));
  const staleCandidate = !excluded &&
    longRunning &&
    temporaryDevServer &&
    staleScore >= config.staleCandidateMinimumScore &&
    nonAgeSignals.length >= 2 &&
    staleRiskSignals.length >= 1;

  return {
    label: lifecycleLabel({
      timingAvailable: processAge.status === "available",
      longRunning,
      detachedCandidate,
      staleCandidate,
      excluded
    }),
    processAge,
    parentAvailable,
    rootLauncherAvailable,
    treeStopReason,
    detachedCandidate,
    staleCandidate,
    staleScore,
    signals,
    limitations: [
      ...limitations,
      "informational heuristic only; not permission to stop, restart, kill, or clean up this process"
    ]
  };
}

function lifecycleLabel(state) {
  if (!state.timingAvailable) return "unknown";
  if (state.staleCandidate) return "stale-candidate";
  if (state.detachedCandidate) return "possibly-detached";
  if (state.longRunning) return "long-running";
  return "active";
}

function attachLifecycleContext(record, options = {}) {
  const lifecycleContext = buildLifecycleContext(record, options);
  const lifecycleEvidence = [
    {
      type: "lifecycle",
      score: 0,
      message: `lifecycle label: ${lifecycleContext.label}`
    },
    ...lifecycleContext.signals.map((signal) => ({
      type: "lifecycle",
      score: 0,
      message: signal.message
    }))
  ];

  const evidence = [
    ...(record.evidence || []).filter((item) => item.type !== "lifecycle"),
    ...lifecycleEvidence
  ];

  return {
    ...record,
    lifecycleContext,
    evidence,
    reasons: evidence.map((item) => item.message)
  };
}

function normalizeLifecycleConfig(value = {}) {
  const longRunningDevServerMs = normalizePositiveInteger(value.longRunningDevServerMs, DEFAULT_LIFECYCLE_CONFIG.longRunningDevServerMs);
  const staleCandidateMinimumScore = normalizePositiveInteger(value.staleCandidateMinimumScore, DEFAULT_LIFECYCLE_CONFIG.staleCandidateMinimumScore);
  const categoryExclusions = Array.isArray(value.categoryExclusions) && value.categoryExclusions.length
    ? value.categoryExclusions.map((item) => String(item))
    : DEFAULT_LIFECYCLE_CONFIG.categoryExclusions;
  return {
    longRunningDevServerMs,
    staleCandidateMinimumScore,
    categoryExclusions
  };
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function isExcludedCategory(category, config) {
  return config.categoryExclusions.includes(category);
}

function hasRootLauncher(record) {
  const tree = record.processTree;
  if (!tree || !Array.isArray(tree.chain) || tree.chain.length <= 1) return false;
  return tree.chain.some((item) => ["editor", "terminal", "container"].includes(item.category));
}

function isUnexpectedTreeStop(reason) {
  return ["missing-parent-metadata", "cycle"].includes(reason);
}

function isUnreachableHttpDevServer(record) {
  if (!TEMPORARY_DEV_CATEGORIES.has(record.category)) return false;
  const probe = record.httpProbe || {};
  return probe.attempted === true && probe.reachable !== true;
}

function weakOrMissingProject(project) {
  return !project || Number(project.confidence || 0) < 60;
}

function projectPathMissing(project) {
  if (!project || !project.root) return false;
  const path = expandRedactedPath(project.root);
  if (!path || path.includes("%")) return false;
  try {
    return !existsSync(path);
  } catch {
    return true;
  }
}

function expandRedactedPath(value) {
  return expandEnvPath(String(value).replace(/^%USERPROFILE%/i, process.env.USERPROFILE || process.env.HOME || "%USERPROFILE%"));
}

function addSignal(signals, type, score, message) {
  signals.push({ type, score, message });
}

module.exports = {
  DEFAULT_LIFECYCLE_CONFIG,
  attachLifecycleContext,
  buildLifecycleContext,
  normalizeLifecycleConfig
};
