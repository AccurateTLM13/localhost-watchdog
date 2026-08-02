"use strict";

const { createStartManager, findRunningProject } = require("./start");
const { createWindowsGracefulStopDispatcher } = require("./windows-graceful-stop");
const { createRestartHistory } = require("./restart-history");
const { readProjectScan } = require("./project-scan");
const { createProjectRegistry } = require("../project/registry");
const { scanWindows } = require("../scanner/windows");

const DEFAULT_STOP_TIMEOUT_MS = 5000;
const DEFAULT_STARTUP_TIMEOUT_MS = 10000;
const DEFAULT_POLL_MS = 250;

function createRestartManager(options = {}) {
  const registry = options.registry || createProjectRegistry(options.registryOptions || {});
  const scanProvider = options.scanProvider || (() => scanWindows({ skipHistory: true }));
  const postStopScanProvider = options.postStopScanProvider || scanProvider;
  const postStartScanProvider = options.postStartScanProvider || scanProvider;
  const gracefulStop = options.gracefulStop || createWindowsGracefulStopDispatcher();
  const startManager = options.startManager || createStartManager({
    registry,
    scanProvider: postStartScanProvider,
    launcher: options.launcher,
    randomId: options.randomId
  });
  const randomId = options.randomId || ((bytes = 8) => require("node:crypto").randomBytes(bytes).toString("hex"));
  const stopTimeoutMs = positiveInteger(options.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS);
  const startupTimeoutMs = positiveInteger(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
  const pollMs = positiveInteger(options.pollMs, DEFAULT_POLL_MS);
  const restarts = new Map();
  const idempotency = new Map();
  const history = createRestartHistory(options);

  async function restartProject(input = {}) {
    const validation = validateRestart(input);
    if (!validation.ok) return errorResponse(validation.code, validation.message);
    if (idempotency.has(input.idempotencyKey)) return restarts.get(idempotency.get(input.idempotencyKey));

    const project = registry.getProject(input.projectId);
    if (!project) return errorResponse("PROJECT_NOT_FOUND", "Configured project was not found.");
    if (!project.valid) return errorResponse("PROJECT_INVALID", "Configured project is not restartable.", { validation: project.validation });

    const initialScan = await readProjectScan(scanProvider);
    if (!initialScan.ok) return errorResponse(initialScan.code, initialScan.message);
    const current = findRunningProject(project, initialScan.records);
    if (!current) return errorResponse("PROJECT_NOT_RUNNING", "Configured project is not currently running.");
    if (input.listenerId && input.listenerId !== current.listenerId) return errorResponse("LISTENER_ID_MISMATCH", "Running listener identity does not match the restart request.");
    if (input.processInstanceId && input.processInstanceId !== current.processInstanceId) return errorResponse("PROCESS_INSTANCE_ID_MISMATCH", "Running process identity does not match the restart request.");

    const identityValidation = validateRestartTarget(current);
    if (!identityValidation.ok) return errorResponse(identityValidation.code, identityValidation.message);
    const port = Number(current.port);
    const actionRequestId = `projrestart-${randomId(12)}`;

    let stopResult;
    try {
      stopResult = await gracefulStop({
        pid: current.pid,
        processInstanceId: current.processInstanceId,
        listenerId: current.listenerId,
        port,
        processName: current.processName,
        processGroupId: current.processGroupId,
        createdAt: current.createdAt,
        actionRequestId
      });
    } catch {
      stopResult = { ok: false, code: "STOP_SIGNAL_FAILED", message: "Graceful stop dispatch failed." };
    }
    if (!stopResult || stopResult.ok !== true) {
      return cache(actionRequestId, input.idempotencyKey, errorResponse(
        stopResult && stopResult.code || "STOP_SIGNAL_FAILED",
        stopResult && stopResult.message || "Graceful stop dispatch failed.",
        { actionRequestId, projectId: project.id, state: "stop-dispatch-failed", executionAuthorized: true }
      ), { projectId: project.id, port });
    }

    const stopVerification = await waitForStopped({
      project,
      current,
      port,
      scanProvider: postStopScanProvider,
      timeoutMs: stopTimeoutMs,
      pollMs
    });
    if (!stopVerification.ok) {
      return cache(actionRequestId, input.idempotencyKey, errorResponse(
        stopVerification.code,
        stopVerification.message,
        {
          actionRequestId,
          projectId: project.id,
          state: stopVerification.state || "stop-verification-failed",
          actionExecuted: true,
          executionAuthorized: true,
          stopVerified: false,
          stopVerification: publicStopVerification(stopVerification)
        }
      ), { projectId: project.id, port });
    }

    const startResult = await startManager.startProject({ projectId: project.id, idempotencyKey: `${input.idempotencyKey}:start` });
    if (!startResult.ok) {
      return cache(actionRequestId, input.idempotencyKey, errorResponse(
        startResult.code || "PROJECT_START_FAILED",
        startResult.message || "Project start failed after the previous process stopped.",
        {
          actionRequestId,
          projectId: project.id,
          state: "stop-completed-start-failed",
          actionExecuted: true,
          executionAuthorized: true,
          stopVerified: true,
          startActionRequestId: startResult.actionRequestId || null,
          process: startResult.process || null
        }
      ), { projectId: project.id, port });
    }

    const selectedPort = Number(startResult.project && startResult.project.selectedPort || startResult.process && startResult.process.selectedPort || port);
    const startupHealth = await waitForStartupHealth({
      project,
      process: startResult.process,
      port: selectedPort,
      scanProvider: postStartScanProvider,
      timeoutMs: startupTimeoutMs,
      pollMs
    });
    if (!startupHealth.ok) {
      return cache(actionRequestId, input.idempotencyKey, errorResponse(
        startupHealth.code,
        startupHealth.message,
        {
          actionRequestId,
          projectId: project.id,
          state: "startup-health-check-failed",
          actionExecuted: true,
          executionAuthorized: true,
          stopVerified: true,
          startActionRequestId: startResult.actionRequestId,
          process: startResult.process,
          startupHealth: publicStartupHealth(startupHealth)
        }
      ), { projectId: project.id, port: selectedPort });
    }

    return cache(actionRequestId, input.idempotencyKey, {
      ok: true,
      schemaVersion: "localhost-watchdog.project-action.v1",
      actionRequestId,
      state: "restart-completed",
      projectId: project.id,
      project: startResult.project,
      stopActionExecuted: true,
      stopVerified: true,
      startActionRequestId: startResult.actionRequestId,
      process: startResult.process,
      startupHealth: publicStartupHealth(startupHealth),
      actionExecuted: true,
      executionAuthorized: true,
      message: "Managed project restart completed and passed startup health checks."
    }, { projectId: project.id, port: selectedPort });
  }

  function cache(actionRequestId, idempotencyKey, result, context) {
    restarts.set(actionRequestId, result);
    idempotency.set(idempotencyKey, actionRequestId);
    history.record(result, context);
    return result;
  }

  return { listHistory: history.list, restartProject };
}

async function waitForStopped({ current, port, scanProvider, timeoutMs, pollMs }) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (true) {
    attempts += 1;
    const scan = await readProjectScan(scanProvider);
    if (!scan.ok) return { ok: false, code: "RESTART_REVALIDATION_UNAVAILABLE", message: "The post-stop scanner could not verify that the previous listener stopped.", state: "stop-revalidation-unavailable", attempts };
    const sameTarget = scan.records.find((record) => sameProcessInstance(record, current) || sameListener(record, current));
    if (!sameTarget) {
      const portOwner = scan.records.find((record) => Number(record.port) === port);
      if (portOwner) return { ok: false, code: "RESTART_PORT_OWNER_CHANGED", message: "The restart port is now owned by a different listener; start was not dispatched.", state: "stop-port-owner-changed", attempts, portOwner };
      return { ok: true, attempts, lastRecords: scan.records };
    }
    if (Date.now() >= deadline) return { ok: false, code: "STOP_VERIFICATION_FAILED", message: "The previous listener did not disappear before the restart timeout; start was not dispatched.", state: "stop-verification-failed", attempts, lastRecord: sameTarget };
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

async function waitForStartupHealth({ project, process, port, scanProvider, timeoutMs, pollMs }) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (true) {
    attempts += 1;
    const scan = await readProjectScan(scanProvider);
    if (!scan.ok) return { ok: false, code: "PROJECT_STARTUP_REVALIDATION_UNAVAILABLE", message: "The startup scanner could not verify the newly launched listener.", state: "startup-revalidation-unavailable", attempts };
    const portOwner = scan.records.find((record) => Number(record.port) === port);
    const healthy = scan.records.find((record) =>
      Number(record.port) === port &&
      findRunningProject(project, [record]) &&
      record.processInstanceId === process.processInstanceId
    );
    if (healthy) return { ok: true, attempts, port, processInstanceId: process.processInstanceId, listenerId: healthy.listenerId, record: healthy };
    if (portOwner && portOwner.processInstanceId !== process.processInstanceId) {
      return { ok: false, code: "PROJECT_STARTUP_PORT_OWNER_CHANGED", message: "The managed start port is owned by a different listener; restart health verification failed.", state: "startup-port-owner-changed", attempts, portOwner };
    }
    if (Date.now() >= deadline) return { ok: false, code: "PROJECT_STARTUP_TIMEOUT", message: "The managed project did not appear with the expected process identity before the startup timeout.", state: "startup-timeout", attempts };
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

function sameProcessInstance(record, current) {
  return Boolean(current.processInstanceId && record && record.processInstanceId === current.processInstanceId);
}

function sameListener(record, current) {
  return Boolean(current.listenerId && record && record.listenerId === current.listenerId);
}

function validateRestartTarget(current) {
  if (!Number.isInteger(Number(current.pid)) || Number(current.pid) <= 0) return { ok: false, code: "RESTART_PID_UNAVAILABLE", message: "The running project does not have a valid process ID." };
  if (typeof current.processInstanceId !== "string" || !current.processInstanceId) return { ok: false, code: "RESTART_PROCESS_IDENTITY_UNAVAILABLE", message: "The running project does not have a stable process identity." };
  if (typeof current.listenerId !== "string" || !current.listenerId) return { ok: false, code: "RESTART_LISTENER_ID_UNAVAILABLE", message: "The running project does not have a stable listener identity." };
  if (!Number.isInteger(Number(current.port)) || Number(current.port) <= 0) return { ok: false, code: "RESTART_PORT_UNAVAILABLE", message: "The running project does not have a verified listening port." };
  return { ok: true };
}

function publicStopVerification(result) {
  return { attempts: result.attempts, portOwner: result.portOwner ? publicRecordIdentity(result.portOwner) : null };
}

function publicStartupHealth(result) {
  return {
    ok: result.ok === true,
    attempts: result.attempts,
    port: result.port || null,
    processInstanceId: result.processInstanceId || null,
    listenerId: result.listenerId || null
  };
}

function publicRecordIdentity(record) {
  return record ? { pid: Number(record.pid) || null, processInstanceId: record.processInstanceId || null, listenerId: record.listenerId || null, port: Number(record.port) || null } : null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function validateRestart(input) {
  if (!input || typeof input !== "object") return { ok: false, code: "INVALID_REQUEST", message: "Request body must be an object." };
  if (!input.projectId || typeof input.projectId !== "string") return { ok: false, code: "PROJECT_ID_REQUIRED", message: "Project id is required." };
  if (!input.idempotencyKey || typeof input.idempotencyKey !== "string") return { ok: false, code: "IDEMPOTENCY_KEY_REQUIRED", message: "Restart requests require an idempotency key." };
  return { ok: true };
}

function errorResponse(code, message, extra = {}) {
  return { ok: false, code, category: "project-action", message, actionExecuted: false, executionAuthorized: false, ...extra };
}

function defaultGracefulStopUnavailable() {
  return { ok: false, code: "STOP_BACKEND_UNAVAILABLE", message: "Graceful stop backend is unavailable." };
}

module.exports = { createRestartManager, defaultGracefulStopUnavailable, waitForStartupHealth, waitForStopped };
