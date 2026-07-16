"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { expandEnvPath, loadWatchdogConfig, normalizePath, redactConfiguredPath } = require("../config/load");

function createProjectRegistry(options = {}) {
  const configProvider = options.configProvider || (() => loadWatchdogConfig(options.configOptions || {}));
  const io = options.io || fs;

  function listProjects() {
    const config = configProvider() || {};
    return normalizeProjects(config.projects || { projects: [] }, { io });
  }

  function getProject(projectId) {
    const projects = listProjects();
    return projects.find((project) => project.id === projectId) || null;
  }

  return { listProjects, getProject };
}

function normalizeProjects(projectsConfig = {}, options = {}) {
  const io = options.io || fs;
  return (projectsConfig.projects || []).map((project) => normalizeProject(project, { io }));
}

function normalizeProject(project = {}, options = {}) {
  const expandedPath = expandEnvPath(project.path);
  const normalized = expandedPath ? normalizePath(expandedPath) : null;
  const validation = validateProject(project, normalized, options);
  return {
    id: safeString(project.id),
    name: safeString(project.name || project.id),
    path: normalized,
    displayPath: redactConfiguredPath(expandedPath || project.path),
    startCommand: safeString(project.startCommand),
    preferredPort: normalizePort(project.preferredPort),
    portStrategy: normalizePortStrategy(project.portStrategy),
    runtime: safeString(project.runtime),
    env: normalizeEnv(project.env),
    tags: Array.isArray(project.tags) ? project.tags.map(safeString).filter(Boolean) : [],
    valid: validation.ok,
    validation
  };
}

function validateProject(project, normalizedPath, options = {}) {
  const problems = [];
  if (!safeString(project.id)) problems.push({ code: "PROJECT_ID_REQUIRED", message: "Project id is required." });
  if (!normalizedPath || (!path.isAbsolute(normalizedPath) && !/^[a-z]:\\/i.test(normalizedPath))) problems.push({ code: "PROJECT_PATH_ABSOLUTE_REQUIRED", message: "Project path must be absolute." });
  if (normalizedPath) {
    try {
      if (!options.io.existsSync(normalizedPath) || !options.io.statSync(normalizedPath).isDirectory()) {
        problems.push({ code: "PROJECT_PATH_UNAVAILABLE", message: "Project path must exist and be a directory." });
      }
    } catch {
      problems.push({ code: "PROJECT_PATH_UNAVAILABLE", message: "Project path must exist and be a directory." });
    }
  }
  if (!safeString(project.startCommand)) problems.push({ code: "PROJECT_START_COMMAND_REQUIRED", message: "Project start command is required." });
  if (project.preferredPort != null && !normalizePort(project.preferredPort)) problems.push({ code: "PROJECT_PORT_INVALID", message: "Preferred port must be between 1 and 65535." });
  return { ok: problems.length === 0, problems };
}

function normalizeEnv(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) return {};
  const result = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^[A-Z_][A-Z0-9_]*$/i.test(key)) result[key] = String(value);
  }
  return result;
}

function normalizePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function normalizePortStrategy(value) {
  return ["strict", "next-available"].includes(value) ? value : "strict";
}

function safeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

module.exports = { createProjectRegistry, normalizeProject, normalizeProjects };
