"use strict";

const { createStartManager, findRunningProject } = require("./start");
const { createProjectRegistry } = require("../project/registry");
const { scanWindows } = require("../scanner/windows");

function createRestartManager(options = {}) {
  const registry = options.registry || createProjectRegistry(options.registryOptions || {});
  const scanProvider = options.scanProvider || (() => scanWindows({ skipHistory: true }));
  const postStopScanProvider = options.postStopScanProvider || scanProvider;
  const gracefulStop = options.gracefulStop || defaultGracefulStopUnavailable;
  const startManager = options.startManager || createStartManager({ registry, scanProvider: options.postStartScanProvider || scanProvider, launcher: options.launcher, randomId: options.randomId });
  const randomId = options.randomId || ((bytes = 8) => require("node:crypto").randomBytes(bytes).toString("hex"));
  const restarts = new Map();
  const idempotency = new Map();

  async function restartProject(input = {}) {
    const validation = validateRestart(input);
    if (!validation.ok) return errorResponse(validation.code, validation.message);
    if (idempotency.has(input.idempotencyKey)) return restarts.get(idempotency.get(input.idempotencyKey));
    const project = registry.getProject(input.projectId);
    if (!project) return errorResponse("PROJECT_NOT_FOUND", "Configured project was not found.");
    if (!project.valid) return errorResponse("PROJECT_INVALID", "Configured project is not restartable.", { validation: project.validation });
    const snapshot = await safeScan(scanProvider);
    const current = findRunningProject(project, snapshot);
    if (!current) return errorResponse("PROJECT_NOT_RUNNING", "Configured project is not currently running.");
    if (input.listenerId && input.listenerId !== current.listenerId) return errorResponse("LISTENER_ID_MISMATCH", "Running listener identity does not match the restart request.");
    if (input.processInstanceId && input.processInstanceId !== current.processInstanceId) return errorResponse("PROCESS_INSTANCE_ID_MISMATCH", "Running process identity does not match the restart request.");
    const actionRequestId = `projrestart-${randomId(12)}`;
    let stopResult;
    try {
      stopResult = await gracefulStop({ pid: current.pid, processInstanceId: current.processInstanceId, listenerId: current.listenerId, port: current.port, processName: current.processName, actionRequestId });
    } catch {
      stopResult = { ok: false, code: "STOP_SIGNAL_FAILED", message: "Graceful stop dispatch failed." };
    }
    if (!stopResult || stopResult.ok !== true) {
      return cache(actionRequestId, input.idempotencyKey, errorResponse(stopResult && stopResult.code || "STOP_SIGNAL_FAILED", stopResult && stopResult.message || "Graceful stop dispatch failed.", { actionRequestId, state: "stop-dispatch-failed", executionAuthorized: true }));
    }
    const postStop = await safeScan(postStopScanProvider);
    if (postStop.some((record) => record.listenerId === current.listenerId || record.processInstanceId === current.processInstanceId || (project.preferredPort && Number(record.port) === project.preferredPort))) {
      return cache(actionRequestId, input.idempotencyKey, errorResponse("STOP_VERIFICATION_FAILED", "Stopped listener is still present; start was not dispatched.", { actionRequestId, state: "stop-verification-failed", actionExecuted: true, executionAuthorized: true }));
    }
    const startResult = await startManager.startProject({ projectId: project.id, idempotencyKey: `${input.idempotencyKey}:start` });
    if (!startResult.ok) {
      return cache(actionRequestId, input.idempotencyKey, errorResponse(startResult.code || "PROJECT_START_FAILED", startResult.message || "Project start failed after stop.", { actionRequestId, state: "stop-completed-start-failed", actionExecuted: true, executionAuthorized: true }));
    }
    return cache(actionRequestId, input.idempotencyKey, { ok: true, schemaVersion: "localhost-watchdog.project-action.v1", actionRequestId, state: "restart-completed", projectId: project.id, stopActionExecuted: true, startActionRequestId: startResult.actionRequestId, actionExecuted: true, executionAuthorized: true, message: "Managed project restart completed." });
  }

  function cache(actionRequestId, idempotencyKey, result) {
    restarts.set(actionRequestId, result);
    idempotency.set(idempotencyKey, actionRequestId);
    return result;
  }
  return { restartProject };
}

async function safeScan(scanProvider) {
  try { return await scanProvider(); } catch { return []; }
}
function validateRestart(input) {
  if (!input || typeof input !== "object") return { ok: false, code: "INVALID_REQUEST", message: "Request body must be an object." };
  if (!input.projectId || typeof input.projectId !== "string") return { ok: false, code: "PROJECT_ID_REQUIRED", message: "Project id is required." };
  if (!input.idempotencyKey || typeof input.idempotencyKey !== "string") return { ok: false, code: "IDEMPOTENCY_KEY_REQUIRED", message: "Restart requests require an idempotency key." };
  return { ok: true };
}
function errorResponse(code, message, extra = {}) { return { ok: false, code, category: "project-action", message, actionExecuted: false, executionAuthorized: false, ...extra }; }
function defaultGracefulStopUnavailable() { return { ok: false, code: "STOP_BACKEND_UNAVAILABLE", message: "Graceful stop backend is unavailable." }; }

module.exports = { createRestartManager, defaultGracefulStopUnavailable };
