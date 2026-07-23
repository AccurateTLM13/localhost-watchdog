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
  const ids = new Map();
  for (const project of projectsConfig.projects || []) {
    const id = safeString(project && project.id);
    if (id) ids.set(id, (ids.get(id) || 0) + 1);
  }
  return (projectsConfig.projects || []).map((project) => normalizeProject(project, { io, duplicateId: ids.get(safeString(project && project.id)) > 1 }));
}

function normalizeProject(project = {}, options = {}) {
  const start = normalizeStartConfig(project);
  const expandedPath = expandEnvPath(project.path);
  const normalized = expandedPath ? normalizePath(expandedPath) : null;
  const expandedCwd = expandEnvPath(start.cwd || project.path);
  const normalizedCwd = expandedCwd ? normalizePath(expandedCwd) : normalized;
  const validation = validateProject(project, normalized, { ...options, start, normalizedCwd });
  return {
    id: safeString(project.id),
    name: safeString(project.name || project.id),
    path: normalized,
    displayPath: redactConfiguredPath(expandedPath || project.path),
    managed: project.managed === true || Boolean(start.command),
    startCommand: start.command,
    startArgs: start.args,
    startCwd: normalizedCwd,
    preferredPort: normalizePort(project.preferredPort != null ? project.preferredPort : start.preferredPort),
    portStrategy: normalizePortStrategy(project.portStrategy || start.portStrategy),
    runtime: safeString(project.runtime),
    env: normalizeEnv({ ...(project.env || {}), ...(start.env || {}) }),
    tags: Array.isArray(project.tags) ? project.tags.map(safeString).filter(Boolean) : [],
    valid: validation.ok,
    validation
  };
}

function validateProject(project, normalizedPath, options = {}) {
  const problems = [];
  const start = options.start || normalizeStartConfig(project);
  if (!safeString(project.id)) problems.push({ code: "PROJECT_ID_REQUIRED", message: "Project id is required." });
  if (options.duplicateId) problems.push({ code: "PROJECT_ID_DUPLICATE", message: "Project id must be unique." });
  if (!normalizedPath || (!path.isAbsolute(normalizedPath) && !/^[a-z]:\\/i.test(normalizedPath))) problems.push({ code: "PROJECT_PATH_ABSOLUTE_REQUIRED", message: "Project path must be absolute." });
  if (normalizedPath) validateDirectory(normalizedPath, options.io, problems, "PROJECT_PATH_UNAVAILABLE", "Project path must exist and be a directory.");
  if (options.normalizedCwd) validateDirectory(options.normalizedCwd, options.io, problems, "PROJECT_CWD_UNAVAILABLE", "Project start working directory must exist and be a directory.");
  if (!safeString(start.command)) problems.push({ code: "PROJECT_START_COMMAND_REQUIRED", message: "Project start command is required." });
  if (start.command && /[\r\n]/.test(start.command)) problems.push({ code: "PROJECT_START_COMMAND_INVALID", message: "Project start command must be a single command line." });
  const preferredPort = project.preferredPort != null ? project.preferredPort : start.preferredPort;
  if (preferredPort != null && !normalizePort(preferredPort)) problems.push({ code: "PROJECT_PORT_INVALID", message: "Preferred port must be between 1 and 65535." });
  if (!Array.isArray(start.args)) problems.push({ code: "PROJECT_START_ARGS_INVALID", message: "Project start args must be an array of strings." });
  return { ok: problems.length === 0, problems };
}

function validateDirectory(value, io, problems, code, message) {
  try {
    if (!io.existsSync(value) || !io.statSync(value).isDirectory()) problems.push({ code, message });
  } catch {
    problems.push({ code, message });
  }
}

function normalizeStartConfig(project = {}) {
  const start = project.start && typeof project.start === "object" ? project.start : {};
  const command = safeString(project.startCommand) || safeString(start.command);
  const args = Array.isArray(start.args) && start.args.every((arg) => typeof arg === "string") ? start.args.slice() : [];
  return {
    command,
    args,
    cwd: safeString(start.cwd),
    env: normalizeEnv(start.env),
    preferredPort: start.preferredPort,
    portStrategy: start.portStrategy
  };
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

module.exports = { createProjectRegistry, normalizeProject, normalizeProjects, normalizeStartConfig };
