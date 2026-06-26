"use strict";

const { existsSync, readFileSync, statSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");

const REPO_ROOT = resolve(__dirname, "..", "..");

function loadWatchdogConfig(options = {}) {
  const root = options.root || REPO_ROOT;
  const safety = readJsonWithFallback(
    join(root, "config", "safety.json"),
    join(root, "config", "safety.example.json")
  );
  const projects = readJsonWithFallback(
    join(root, "config", "projects.json"),
    join(root, "config", "projects.example.json")
  );
  const devRoots = readJsonWithFallback(
    join(root, "config", "dev-roots.json"),
    join(root, "config", "dev-roots.example.json")
  );

  return normalizeConfig({ safety, projects, devRoots }, { root });
}

function readJsonWithFallback(primaryPath, fallbackPath) {
  const sourcePath = existsSync(primaryPath) ? primaryPath : fallbackPath;
  if (!existsSync(sourcePath)) {
    const repoFallbackPath = join(REPO_ROOT, "config", sourcePath.split(/[\\/]/).pop());
    if (existsSync(repoFallbackPath)) {
      return JSON.parse(readFileSync(repoFallbackPath, "utf8"));
    }
  }
  return JSON.parse(readFileSync(sourcePath, "utf8"));
}

function normalizeConfig(config, options = {}) {
  const root = options.root || REPO_ROOT;
  const projectRoots = (config.projects.projects || [])
    .map((project) => project.path)
    .filter(Boolean);
  const configuredDevRoots = (config.devRoots && config.devRoots.devRoots) || [];
  const normalizedDevRoots = normalizePathList([
    ...(config.safety.devRoots || []),
    ...configuredDevRoots,
    ...projectRoots
  ]);

  return {
    safety: {
      ...config.safety,
      devRoots: normalizedDevRoots,
      devRootsDisplay: normalizedDevRoots.map(redactConfiguredPath),
      protectedProcesses: config.safety.protectedProcesses || [],
      protectedPorts: normalizePortList(config.safety.protectedPorts || []),
      protectedPortRanges: normalizePortRanges(config.safety.protectedPortRanges || []),
      devRuntimes: lowerList(config.safety.devRuntimes || []),
      commonDevPorts: normalizePortList(config.safety.commonDevPorts || []),
      httpProbeTimeoutMs: normalizePositiveInteger(config.safety.httpProbeTimeoutMs, 750),
      httpProbeMaxRedirects: normalizePositiveInteger(config.safety.httpProbeMaxRedirects, 2),
      processTree: normalizeProcessTreeConfig(config.safety.processTree || {}),
      lifecycle: normalizeLifecycleConfig(config.safety.lifecycle || {}),
      history: normalizeHistoryConfig(config.safety.history || {}, root)
    },
    projects: {
      ...config.projects,
      projects: config.projects.projects || []
    },
    devRoots: {
      version: config.devRoots ? config.devRoots.version || 1 : 1,
      devRoots: normalizePathList(configuredDevRoots),
      devRootsDisplay: normalizePathList(configuredDevRoots).map(redactConfiguredPath)
    }
  };
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizeLifecycleConfig(value) {
  const defaults = {
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
  return {
    longRunningDevServerMs: normalizePositiveInteger(value.longRunningDevServerMs, defaults.longRunningDevServerMs),
    staleCandidateMinimumScore: normalizePositiveInteger(value.staleCandidateMinimumScore, defaults.staleCandidateMinimumScore),
    categoryExclusions: Array.isArray(value.categoryExclusions) && value.categoryExclusions.length
      ? value.categoryExclusions.map((item) => String(item))
      : defaults.categoryExclusions
  };
}

function normalizeProcessTreeConfig(value) {
  return {
    maxDepth: normalizePositiveInteger(value.maxDepth, 5)
  };
}

function normalizeHistoryConfig(value, root) {
  return {
    enabled: value.enabled !== false,
    storagePath: resolve(root, value.storagePath || ".localhost-watchdog/history.json"),
    maxSnapshots: normalizePositiveInteger(value.maxSnapshots, 25),
    maxHistoryAgeMs: normalizePositiveInteger(value.maxHistoryAgeMs, 14 * 24 * 60 * 60 * 1000),
    maxProcessRecords: normalizePositiveInteger(value.maxProcessRecords, 500)
  };
}

function normalizePathList(paths) {
  return unique(paths
    .map(expandEnvPath)
    .filter(Boolean)
    .map(normalizePath)
    .filter(isUsableDevRootPath));
}

function expandEnvPath(path) {
  if (!path) return null;
  return String(path).replace(/%([^%]+)%/g, (_, name) => process.env[name] || `%${name}%`);
}

function normalizePath(value) {
  return String(value || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

function isUsableDevRootPath(value) {
  if (!value || !isAbsoluteWindowsPath(value)) return false;
  try {
    return existsSync(value) && statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function isAbsoluteWindowsPath(value) {
  return /^[a-z]:\\/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}

function redactConfiguredPath(value) {
  if (!value) return null;
  const text = String(value);
  const home = normalizePath(process.env.USERPROFILE || process.env.HOME || "");
  if (home && text.toLowerCase().startsWith(home.toLowerCase())) {
    return `%USERPROFILE%${text.slice(home.length)}`;
  }
  return text;
}

function normalizePortList(ports) {
  return ports
    .map(Number)
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
}

function normalizePortRanges(ranges) {
  return ranges
    .map((range) => ({
      from: Number(range.from),
      to: Number(range.to),
      reason: range.reason || "protected port range"
    }))
    .filter((range) => Number.isInteger(range.from) && Number.isInteger(range.to) && range.from <= range.to);
}

function lowerList(values) {
  return values.map((value) => String(value).toLowerCase());
}

function findProjectForRecord(record, projectsConfig) {
  const haystack = lowerPath(`${record.commandLine || ""} ${record.executablePath || ""}`);
  for (const project of projectsConfig.projects || []) {
    if (!project.path) continue;
    const projectPath = expandEnvPath(project.path).replace(/\//g, "\\").toLowerCase();
    if (haystack.includes(projectPath)) {
      return project;
    }
  }
  return null;
}

function isInsideConfiguredRoot(value, roots) {
  const haystack = lowerPath(value);
  if (!haystack) return false;
  return roots.some((root) => haystack === root || haystack.startsWith(`${root}\\`));
}

function lowerPath(value) {
  return String(value || "").replace(/\//g, "\\").toLowerCase();
}

function unique(values) {
  return [...new Set(values)];
}

function configDir() {
  return dirname(join(REPO_ROOT, "config", "safety.example.json"));
}

module.exports = {
  configDir,
  expandEnvPath,
  findProjectForRecord,
  isInsideConfiguredRoot,
  loadWatchdogConfig,
  normalizeConfig,
  normalizePath,
  normalizePortList,
  normalizePortRanges,
  normalizePositiveInteger,
  redactConfiguredPath
};
