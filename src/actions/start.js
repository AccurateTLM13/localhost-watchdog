"use strict";

const { createProjectRegistry } = require("../project/registry");
const { scanWindows } = require("../scanner/windows");

function createStartManager(options = {}) {
  const registry = options.registry || createProjectRegistry(options.registryOptions || {});
  const scanProvider = options.scanProvider || (() => scanWindows({ skipHistory: true }));
  const launcher = options.launcher || defaultProjectLauncherUnavailable;
  const randomId = options.randomId || ((bytes = 8) => require("node:crypto").randomBytes(bytes).toString("hex"));
  const starts = new Map();
  const idempotency = new Map();

  async function listProjects() {
    const projects = registry.listProjects();
    let records = [];
    try { records = await scanProvider(); } catch { records = []; }
    return { ok: true, schemaVersion: "localhost-watchdog.projects.v1", projects: projects.map((project) => publicProject(project, records)), actionExecuted: false };
  }

  async function startProject(input = {}) {
    const validation = validateStart(input);
    if (!validation.ok) return errorResponse(validation.code, validation.message);
    if (idempotency.has(input.idempotencyKey)) return starts.get(idempotency.get(input.idempotencyKey));
    const project = registry.getProject(input.projectId);
    if (!project) return errorResponse("PROJECT_NOT_FOUND", "Configured project was not found.");
    if (!project.valid) return errorResponse("PROJECT_INVALID", "Configured project is not startable.", { validation: project.validation });
    const snapshot = await safeScan(scanProvider);
    const running = findRunningProject(project, snapshot);
    if (running) return errorResponse("PROJECT_ALREADY_RUNNING", "Configured project already appears to be running.", { project: publicProject(project, snapshot), actionExecuted: false });
    const portConflict = project.preferredPort && snapshot.find((record) => Number(record.port) === project.preferredPort);
    if (portConflict && project.portStrategy === "strict") return errorResponse("PROJECT_PORT_IN_USE", "Preferred project port is already in use.");
    const actionRequestId = `projstart-${randomId(12)}`;
    let launchResult;
    try {
      launchResult = await launcher({ project, cwd: project.path, command: project.startCommand, env: project.env, preferredPort: project.preferredPort, actionRequestId });
    } catch {
      launchResult = { ok: false, code: "PROJECT_START_FAILED", message: "Project start dispatch failed." };
    }
    const result = launchResult && launchResult.ok === true ? {
      ok: true,
      schemaVersion: "localhost-watchdog.project-action.v1",
      actionRequestId,
      state: "start-dispatched",
      project: publicProject(project, []),
      actionExecuted: true,
      message: launchResult.message || "Project start was dispatched by the configured launcher."
    } : errorResponse(launchResult && launchResult.code || "PROJECT_START_BACKEND_UNAVAILABLE", launchResult && launchResult.message || "Project start backend is unavailable.", { actionRequestId });
    starts.set(actionRequestId, result);
    idempotency.set(input.idempotencyKey, actionRequestId);
    return result;
  }

  return { listProjects, startProject };
}

function publicProject(project, records) {
  const running = findRunningProject(project, records || []);
  return { id: project.id, name: project.name, displayPath: project.displayPath, preferredPort: project.preferredPort, portStrategy: project.portStrategy, runtime: project.runtime, tags: project.tags, valid: project.valid, validation: project.validation, status: running ? "running" : "stopped", listenerId: running && running.listenerId || null, processInstanceId: running && running.processInstanceId || null, port: running && running.port || null };
}

function findRunningProject(project, records) {
  const projectPath = String(project.path || "").replace(/\//g, "\\").toLowerCase();
  return (records || []).find((record) => {
    if (record.project && record.project.id === project.id) return true;
    if (project.preferredPort && Number(record.port) === project.preferredPort) return true;
    const haystack = `${record.commandLine || ""} ${record.executablePath || ""}`.replace(/\//g, "\\").toLowerCase();
    return projectPath && haystack.includes(projectPath);
  }) || null;
}

async function safeScan(scanProvider) {
  try { return await scanProvider(); } catch { return []; }
}

function validateStart(input) {
  if (!input || typeof input !== "object") return { ok: false, code: "INVALID_REQUEST", message: "Request body must be an object." };
  if (!input.projectId || typeof input.projectId !== "string") return { ok: false, code: "PROJECT_ID_REQUIRED", message: "Project id is required." };
  if (!input.idempotencyKey || typeof input.idempotencyKey !== "string") return { ok: false, code: "IDEMPOTENCY_KEY_REQUIRED", message: "Start requests require an idempotency key." };
  return { ok: true };
}

function errorResponse(code, message, extra = {}) {
  return { ok: false, code, category: "project-action", message, actionExecuted: false, ...extra };
}

function defaultProjectLauncherUnavailable() {
  return { ok: false, code: "PROJECT_START_BACKEND_UNAVAILABLE", message: "Project start backend is unavailable." };
}

module.exports = { createStartManager, defaultProjectLauncherUnavailable, findRunningProject };
