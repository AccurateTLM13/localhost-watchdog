"use strict";

const { existsSync, readFileSync, statSync } = require("node:fs");
const path = require("node:path");
const { expandEnvPath, findProjectForRecord, isInsideConfiguredRoot, redactConfiguredPath } = require("../config/load");

const MARKERS = [
  { file: "package.json", type: "package-json" },
  { file: ".git", type: "git" },
  { file: "pyproject.toml", type: "python" },
  { file: "requirements.txt", type: "python" },
  { file: "manage.py", type: "django" },
  { file: "pom.xml", type: "maven" },
  { file: "build.gradle", type: "gradle" }
];

const CONFIG_MARKERS = [
  { prefix: "vite.config.", type: "vite" },
  { prefix: "next.config.", type: "next" },
  { prefix: "astro.config.", type: "astro" }
];

function detectProjectOwnership(record, config = {}) {
  const safetyConfig = config.safety || {};
  const projectsConfig = config.projects || { projects: [] };
  const configuredProject = findProjectForRecord(record, projectsConfig);

  if (configuredProject && configuredProject.path) {
    const configuredRoot = expandEnvPath(configuredProject.path);
    const marker = findBestMarker(configuredRoot);
    return buildProject({
      root: configuredRoot,
      workingDirectory: configuredRoot,
      name: configuredProject.name || marker.name || markerName(configuredRoot),
      source: "config-project",
      confidence: 90,
      evidence: [
        "record path matched configured project path",
        ...marker.evidence
      ]
    });
  }

  const candidates = inferPathCandidates(record);
  for (const candidate of candidates) {
    const startDirectory = candidateToDirectory(candidate);
    if (!startDirectory) continue;

    if (!isInsideConfiguredRoot(startDirectory, safetyConfig.devRoots || [])) {
      continue;
    }

    const markerResult = findNearestMarkedRoot(startDirectory, safetyConfig.devRoots || []);
    if (markerResult) {
      return buildProject({
        root: markerResult.root,
        workingDirectory: startDirectory,
        name: markerResult.name || markerName(markerResult.root),
        source: markerResult.source,
        confidence: markerResult.confidence,
        evidence: markerResult.evidence
      });
    }

    const devRootResult = inferFromDevRoot(startDirectory, safetyConfig.devRoots || []);
    if (devRootResult) {
      return buildProject({
        root: devRootResult.root,
        workingDirectory: startDirectory,
        name: markerName(devRootResult.root),
        source: "dev-root-path",
        confidence: 35,
        evidence: [
          "process path is inside a configured dev root",
          "no project marker found"
        ]
      });
    }
  }

  return null;
}

function inferPathCandidates(record) {
  const values = [
    record.workingDirectory,
    record.executablePath,
    record.commandLine
  ].filter(Boolean);
  const candidates = [];

  for (const value of values) {
    const text = String(value);
    for (const match of text.matchAll(/"([A-Za-z]:\\[^"]+)"/g)) {
      candidates.push(cleanCandidate(match[1]));
    }
    for (const match of text.matchAll(/(?:^|\s)([A-Za-z]:\\[^\s"]+)/g)) {
      candidates.push(cleanCandidate(match[1]));
    }
    for (const match of text.matchAll(/"((?:\/|~\/)[^"]+)"/g)) {
      candidates.push(cleanCandidate(match[1]));
    }
    for (const match of text.matchAll(/(?:^|\s)((?:\/|~\/)[^\s"]+)/g)) {
      candidates.push(cleanCandidate(match[1]));
    }
  }

  return unique(candidates.filter(Boolean));
}

function cleanCandidate(value) {
  return String(value || "")
    .replace(/[),;]+$/g, "")
    .replace(/\\node_modules\\.*$/i, "")
    .replace(/\\\.venv\\.*$/i, "")
    .replace(/\\venv\\.*$/i, "")
    .replace(/\/node_modules\/.*$/i, "")
    .replace(/\/\.venv\/.*$/i, "")
    .replace(/\/venv\/.*$/i, "");
}

function candidateToDirectory(candidate) {
  if (!candidate) return null;
  try {
    if (existsSync(candidate)) {
      const stats = statSync(candidate);
      return stats.isDirectory() ? candidate : path.dirname(candidate);
    }
  } catch {
    return path.extname(candidate) ? path.dirname(candidate) : candidate;
  }
  return path.extname(candidate) ? path.dirname(candidate) : candidate;
}

function findNearestMarkedRoot(startDirectory, devRoots) {
  let current = path.resolve(startDirectory);
  const stopRoots = devRoots.map((root) => path.resolve(root).toLowerCase());

  while (current && isInsideConfiguredRoot(current, devRoots)) {
    const marker = findBestMarker(current);
    if (marker.found) {
      return {
        root: current,
        name: marker.name,
        source: marker.source,
        confidence: marker.confidence,
        evidence: marker.evidence
      };
    }

    if (stopRoots.includes(current.toLowerCase())) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

function findBestMarker(directory) {
  const empty = { found: false, evidence: [] };
  if (!directory) return empty;

  const packagePath = path.join(directory, "package.json");
  if (safeExists(packagePath)) {
    const packageName = readPackageName(packagePath);
    return {
      found: true,
      source: "marker:package.json",
      confidence: packageName ? 85 : 75,
      name: packageName || markerName(directory),
      evidence: [`found package.json${packageName ? ` with name '${packageName}'` : ""}`]
    };
  }

  for (const marker of CONFIG_MARKERS) {
    const filename = safeReadDirMarker(directory, marker.prefix);
    if (filename) {
      return {
        found: true,
        source: `marker:${filename}`,
        confidence: 80,
        name: markerName(directory),
        evidence: [`found ${filename}`]
      };
    }
  }

  for (const marker of MARKERS.filter((item) => item.file !== "package.json")) {
    if (safeExists(path.join(directory, marker.file))) {
      return {
        found: true,
        source: `marker:${marker.file}`,
        confidence: marker.file === ".git" ? 65 : 75,
        name: markerName(directory),
        evidence: [`found ${marker.file}`]
      };
    }
  }

  return empty;
}

function inferFromDevRoot(startDirectory, devRoots) {
  const root = nearestDevRoot(startDirectory, devRoots);
  if (!root) return null;

  const relative = path.relative(root, startDirectory);
  const firstSegment = relative.split(/[\\/]/).filter(Boolean)[0];
  if (!firstSegment) return null;
  return {
    root: path.join(root, firstSegment)
  };
}

function nearestDevRoot(value, devRoots) {
  const normalizedValue = path.resolve(value).toLowerCase();
  const matches = devRoots
    .filter((root) => normalizedValue.startsWith(path.resolve(root).toLowerCase()))
    .sort((a, b) => b.length - a.length);
  return matches[0] || null;
}

function buildProject(input) {
  return {
    name: input.name || markerName(input.root),
    root: redactPath(input.root),
    confidence: input.confidence,
    source: input.source,
    evidence: input.evidence || [],
    workingDirectory: input.workingDirectory ? redactPath(input.workingDirectory) : null
  };
}

function readPackageName(packagePath) {
  try {
    const parsed = JSON.parse(readFileSync(packagePath, "utf8"));
    return typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : null;
  } catch {
    return null;
  }
}

function markerName(root) {
  return path.basename(String(root || "").replace(/[\\/]+$/g, "")) || null;
}

function redactPath(value) {
  const redacted = redactConfiguredPath(value);
  if (!redacted || redacted.startsWith("%USERPROFILE%")) return redacted;
  return redacted.replace(/\//g, "\\");
}

function safeExists(filePath) {
  try {
    return existsSync(filePath);
  } catch {
    return false;
  }
}

function safeReadDirMarker(directory, prefix) {
  try {
    const entries = require("node:fs").readdirSync(directory);
    return entries.find((entry) => entry.toLowerCase().startsWith(prefix));
  } catch {
    return null;
  }
}

function unique(values) {
  return [...new Set(values)];
}

module.exports = {
  detectProjectOwnership,
  inferPathCandidates,
  redactPath
};
