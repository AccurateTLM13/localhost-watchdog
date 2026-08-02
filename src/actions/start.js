"use strict";

const { createProjectRegistry } = require("../project/registry");
const { scanWindows } = require("../scanner/windows");
const { createManagedProjectLauncher } = require("../project/launcher");
const { MANAGED_LAUNCH_CONTRACT_VERSION, validateManagedLaunchIdentity } = require("../project/managed-contract");
const { readProjectScan } = require("./project-scan");

function createStartManager(options = {}) {
  const registry = options.registry || createProjectRegistry(options.registryOptions || {});
  const scanProvider = options.scanProvider || (() => scanWindows({ skipHistory: true }));
  const launcher = options.launcher || createManagedProjectLauncher(options.launcherOptions || {});
  const randomId = options.randomId || ((bytes = 8) => require("node:crypto").randomBytes(bytes).toString("hex"));
  const starts = new Map();
  const idempotency = new Map();

  async function listProjects() {
    const projects = registry.listProjects();
    const scan = await readProjectScan(scanProvider);
    const records = scan.ok ? scan.records : [];
    return { ok: true, schemaVersion: "localhost-watchdog.projects.v1", projects: projects.map((project) => publicProject(project, records)), actionExecuted: false };
  }

  async function startProject(input = {}) {
    const validation = validateStart(input);
    if (!validation.ok) return errorResponse(validation.code, validation.message);
    if (idempotency.has(input.idempotencyKey)) return starts.get(idempotency.get(input.idempotencyKey));
    const project = registry.getProject(input.projectId);
    if (!project) return errorResponse("PROJECT_NOT_FOUND", "Configured project was not found.");
    if (!project.valid) return errorResponse("PROJECT_INVALID", "Configured project is not startable.", { validation: project.validation });
    const scan = await readProjectScan(scanProvider);
    if (!scan.ok) return errorResponse(scan.code, scan.message);
    const snapshot = scan.records;
    const running = findRunningProject(project, snapshot);
    if (running) return errorResponse("PROJECT_ALREADY_RUNNING", "Configured project already appears to be running.", { project: publicProject(project, snapshot), actionExecuted: false });
    const occupiedPorts = new Set(snapshot.map((record) => Number(record.port)).filter((port) => Number.isInteger(port)));
    const portConflict = project.preferredPort && occupiedPorts.has(project.preferredPort);
    if (portConflict && project.portStrategy === "strict") return errorResponse("PROJECT_PORT_IN_USE", "Preferred project port is already in use.");
    const selectedPort = project.portStrategy === "next-available" ? nextAvailablePort(project.preferredPort, occupiedPorts) : project.preferredPort;
    if (project.portStrategy === "next-available" && project.preferredPort && !selectedPort) return errorResponse("PROJECT_PORT_UNAVAILABLE", "No available project port was found.");
    const actionRequestId = `projstart-${randomId(12)}`;
    const launchEnv = { ...(project.env || {}) };
    if (selectedPort && launchEnv.PORT == null) launchEnv.PORT = String(selectedPort);
    let launchResult;
    try {
      launchResult = await launcher({ project, cwd: project.startCwd || project.root || project.path, command: project.startCommand, args: project.startArgs || [], env: launchEnv, preferredPort: project.preferredPort, selectedPort, actionRequestId });
    } catch {
      launchResult = { ok: false, code: "PROJECT_START_FAILED", message: "Project start dispatch failed." };
    }
    const launchValidation = launchResult && launchResult.ok === true
      ? validateStartLaunchResult(launchResult)
      : launchResult;
    const result = launchValidation && launchValidation.ok === true ? {
      ok: true,
      schemaVersion: "localhost-watchdog.project-action.v1",
      actionRequestId,
      state: "start-dispatched",
      project: { ...publicProject(project, []), selectedPort },
      actionExecuted: true,
      message: launchResult.message || "Project start was dispatched by the configured launcher.",
      process: launchValidation.identity
    } : errorResponse(launchValidation && launchValidation.code || "PROJECT_START_BACKEND_UNAVAILABLE", launchValidation && launchValidation.message || "Project start backend is unavailable.", { actionRequestId });
    starts.set(actionRequestId, result);
    idempotency.set(input.idempotencyKey, actionRequestId);
    return result;
  }

  return { listProjects, startProject };
}

function publicProject(project, records) {
  const running = findRunningProject(project, records || []);
  const root = project.root || project.path || null;
  return { id: project.id, name: project.name, root, displayRoot: project.displayRoot || root, preferredPort: project.preferredPort, portStrategy: project.portStrategy, runtime: project.runtime, tags: project.tags, valid: project.valid, validation: project.validation, status: running ? "running" : "stopped", listenerId: running && running.listenerId || null, processInstanceId: running && running.processInstanceId || null, port: running && running.port || null };
}

function findRunningProject(project, records) {
  const projectPath = String(project.root || project.path || "").replace(/\//g, "\\").toLowerCase();
  return (records || []).find((record) => {
    if (record.project && record.project.id === project.id) return true;
    const haystack = `${record.commandLine || ""} ${record.executablePath || ""} ${record.workingDirectory || ""} ${record.project && (record.project.root || record.project.path) || ""}`.replace(/\//g, "\\").toLowerCase();
    return projectPath && containsProjectPath(haystack, projectPath);
  }) || null;
}

function containsProjectPath(haystack, projectPath) {
  if (!haystack || !projectPath) return false;
  let offset = haystack.indexOf(projectPath);
  while (offset >= 0) {
    const before = offset === 0 ? "" : haystack[offset - 1];
    const end = offset + projectPath.length;
    const after = end >= haystack.length ? "" : haystack[end];
    const beforeIsBoundary = !before || /[\s"'=:\\/]/.test(before);
    const afterIsBoundary = !after || /[\s"'\\/]/.test(after);
    if (beforeIsBoundary && afterIsBoundary) return true;
    offset = haystack.indexOf(projectPath, offset + 1);
  }
  return false;
}

function nextAvailablePort(preferredPort, occupiedPorts) {
  if (!preferredPort) return null;
  for (let port = preferredPort; port <= 65535; port += 1) {
    if (!occupiedPorts.has(port)) return port;
  }
  return null;
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

function publicLaunchIdentity(result) {
  const pid = Number(result && result.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return {
    contractVersion: typeof result.contractVersion === "string" ? result.contractVersion : null,
    pid,
    processInstanceId: typeof result.processInstanceId === "string" ? result.processInstanceId : null,
    processGroupId: Number.isInteger(Number(result.processGroupId)) ? Number(result.processGroupId) : pid,
    createdAt: typeof result.createdAt === "string" ? result.createdAt : null,
    processName: typeof result.processName === "string" ? result.processName : null,
    selectedPort: Number.isInteger(Number(result.selectedPort)) ? Number(result.selectedPort) : null,
    mechanism: typeof result.mechanism === "string" ? result.mechanism : null
  };
}

function validateStartLaunchResult(result) {
  if (result.contractVersion !== MANAGED_LAUNCH_CONTRACT_VERSION) {
    return { ok: false, code: "PROJECT_START_CONTRACT_INVALID", message: "The configured launcher does not satisfy the managed launch contract." };
  }
  const validation = validateManagedLaunchIdentity(result);
  if (!validation.ok) {
    return { ok: false, code: validation.code, message: "The managed launcher did not return a complete process identity." };
  }
  return { ok: true, identity: publicLaunchIdentity(result) };
}

module.exports = { containsProjectPath, createStartManager, defaultProjectLauncherUnavailable, findRunningProject, nextAvailablePort, publicLaunchIdentity, validateStartLaunchResult };
