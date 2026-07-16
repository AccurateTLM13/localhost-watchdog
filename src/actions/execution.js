"use strict";

const crypto = require("node:crypto");
const { writeExecutionAudit } = require("./audit");
const { evaluateDryRunFromSnapshot } = require("./dry-run");
const { scanWindows } = require("../scanner/windows");
const { evaluateConfirmationPolicy } = require("./security-policy");
const { redactSensitiveText } = require("../privacy/redact");

const DEFAULT_EXECUTION_TTL_MS = 30 * 1000;
const EXECUTION_TOKEN_BYTES = 32;

function createExecutionManager(options = {}) {
  const confirmationManager = options.confirmationManager;
  const scanProvider = options.scanProvider || (() => scanWindows({ skipHistory: true }));
  const postActionScanProvider = options.postActionScanProvider || scanProvider;
  const auditWriter = options.auditWriter || writeExecutionAudit;
  const gracefulStop = options.gracefulStop || defaultGracefulStopUnavailable;
  const clock = options.clock || (() => new Date());
  const randomId = options.randomId || randomHex;
  const watchdogPrivilege = options.watchdogPrivilege || {
    available: false,
    elevated: false,
    integrityAvailable: false,
    sessionAvailable: false
  };

  const executions = new Map();
  const idempotency = new Map();

  async function executeStop(input = {}, context = {}) {
    return execute(input, context, { real: input.executionMode === "execute" });
  }

  async function execute(input = {}, context = {}, mode = {}) {
    const now = clock();
    const validation = validateExecutionRequest(input, mode);
    if (!validation.ok) return errorResponse(validation.code, validation.message);

    const idempotencyKey = normalizeKey(input.idempotencyKey);
    if (idempotencyKey && idempotency.has(idempotencyKey)) {
      const cached = executions.get(idempotency.get(idempotencyKey));
      if (cached) return cached;
    }

    if (!confirmationManager || typeof confirmationManager.getConfirmationEntryInternal !== "function") {
      return errorResponse("CONFIRMATION_UNAVAILABLE", "Confirmation manager is unavailable.");
    }

    const confirmationRequestId = input.confirmationRequestId || input.confirmationId;
    const entry = confirmationManager.getConfirmationEntryInternal(confirmationRequestId);
    if (!entry) return errorResponse("CONFIRMATION_UNAVAILABLE", "Confirmation is unavailable, expired, or the access token is invalid.");

    const sessionNonce = context.session && context.session.sessionNonce;
    if (!sessionNonce || entry.sessionNonce !== sessionNonce) return errorResponse("SESSION_INVALID", "Session validation failed.");
    if (entry.state !== "confirmation-accepted") return errorResponse("CONFIRMATION_NOT_ACCEPTED", "Confirmation has not been accepted.");
    if (new Date(entry.expiresAt).getTime() <= now.getTime()) return errorResponse("CONFIRMATION_EXPIRED", "Confirmation has expired.");
    if (entry.processInstanceId !== input.processInstanceId || entry.listenerId !== input.listenerId) {
      return errorResponse("IDENTITY_MISMATCH", "Target process or listener identity mismatch.");
    }

    if (mode.real) {
      const proof = consumeExecutionProof(entry, input.executionAccessToken, now);
      if (!proof.ok) return auditAndReturnError(entry, now, proof.code, proof.message);
    } else {
      const expectedPhrase = entry.requiredPhrase;
      const typedPhrase = typeof input.typedToken === "string" ? input.typedToken.trim() : "";
      if (typedPhrase !== expectedPhrase) return errorResponse("CONFIRMATION_MISMATCH", "Typed confirmation phrase does not match.");
    }

    let snapshot;
    try {
      snapshot = await scanProvider();
    } catch {
      return auditAndReturnError(entry, now, "REVALIDATION_UNAVAILABLE", "Scanner revalidation was unavailable.");
    }

    const current = findCurrentRecord(entry.originalRequest, snapshot);
    if (!current) {
      const exited = classifyMissingTarget(entry, snapshot);
      return auditAndReturnError(entry, now, exited.code, exited.message);
    }

    const identityError = validateCurrentRecord(entry, current);
    if (identityError) return auditAndReturnError(entry, now, identityError.code, identityError.message, { current });

    const recheck = evaluateDryRunFromSnapshot(entry.originalRequest, snapshot, { now, randomId, watchdogPrivilege });
    if (!recheck.passed) {
      const firstBlocker = recheck.blockers && recheck.blockers[0];
      let code = firstBlocker ? firstBlocker.code : "REVALIDATION_BLOCKED";
      const message = firstBlocker ? firstBlocker.message : "Revalidation blocked execution.";
      if (code === "OWNER_POLICY") code = "OWNER_BLOCKED";
      if (code === "ELEVATION_POLICY") code = "ELEVATION_BLOCKED";
      const policy = evaluateConfirmationPolicy(current, { watchdogPrivilege });
      return auditAndReturnError(entry, now, code, message, { current, failureReason: policy.failureReason, policy });
    }

    const policy = evaluateConfirmationPolicy(current, { watchdogPrivilege });
    if (!policy.ownerPassed) return auditAndReturnError(entry, now, "OWNER_BLOCKED", policy.ownerMessage, { current, failureReason: policy.failureReason, policy });
    if (!policy.elevationPassed) return auditAndReturnError(entry, now, "ELEVATION_BLOCKED", policy.elevationMessage, { current, failureReason: policy.failureReason, policy });

    const executionRequestId = `actreq-${randomId(16)}`;
    if (!mode.real) {
      const result = {
        ok: true,
        schemaVersion: "localhost-watchdog.execution-result.v1",
        actionRequestId: executionRequestId,
        state: "simulation-completed",
        message: "Execution simulator completed. No process action was executed.",
        actionExecuted: false,
        executionAuthorized: false
      };
      const audit = writeAudit(entry, current, now, executionRequestId, "simulation-completed", null, false, false);
      if (!audit.ok) return errorResponse("AUDIT_LOG_UNAVAILABLE", "Audit logging failed.");
      cacheResult(executionRequestId, idempotencyKey, result);
      return result;
    }

    const preAudit = writeAudit(entry, current, now, executionRequestId, "execution-dispatching", null, false, true);
    if (!preAudit.ok) return errorResponse("AUDIT_LOG_UNAVAILABLE", "Audit logging failed.");

    let stopResult;
    try {
      stopResult = await gracefulStop({ pid: current.pid, processInstanceId: current.processInstanceId, listenerId: current.listenerId, port: current.port, processName: current.processName });
    } catch {
      stopResult = { ok: false, code: "STOP_SIGNAL_FAILED", message: "Graceful stop dispatch failed." };
    }
    if (!stopResult || stopResult.ok !== true) {
      const code = stopResult && stopResult.code || "STOP_SIGNAL_FAILED";
      const message = stopResult && stopResult.message || "Graceful stop dispatch failed.";
      writeAudit(entry, current, now, executionRequestId, "stop-dispatch-failed", code, false, true);
      return cacheAndReturn(executionRequestId, idempotencyKey, errorResponse(code, message, { actionRequestId: executionRequestId, state: "stop-dispatch-failed", executionAuthorized: true }));
    }

    let postSnapshot;
    try {
      postSnapshot = await postActionScanProvider();
    } catch {
      writeAudit(entry, current, now, executionRequestId, "verification-unavailable", "REVALIDATION_UNAVAILABLE", true, true);
      return cacheAndReturn(executionRequestId, idempotencyKey, errorResponse("REVALIDATION_UNAVAILABLE", "Post-action verification was unavailable.", { actionRequestId: executionRequestId, state: "verification-unavailable", actionExecuted: true, executionAuthorized: true }));
    }

    const verification = verifyStopped(entry, postSnapshot);
    const finalState = verification.ok ? "success" : verification.state;
    writeAudit(entry, current, now, executionRequestId, finalState, verification.ok ? null : verification.code, true, true);
    const result = verification.ok ? {
      ok: true,
      schemaVersion: "localhost-watchdog.execution-result.v1",
      actionRequestId: executionRequestId,
      state: "success",
      message: "Graceful stop was dispatched and the target listener is no longer present.",
      actionExecuted: true,
      executionAuthorized: true
    } : errorResponse(verification.code, verification.message, {
      actionRequestId: executionRequestId,
      state: verification.state,
      actionExecuted: true,
      executionAuthorized: true
    });
    return cacheAndReturn(executionRequestId, idempotencyKey, result);
  }

  function auditAndReturnError(entry, now, code, message, extra = {}) {
    const executionRequestId = `actreq-${randomId(16)}`;
    writeAudit(entry, extra.current || null, now, executionRequestId, "blocked", code, false, false);
    return errorResponse(code, message, extra);
  }

  function writeAudit(entry, current, now, executionRequestId, finalState, errorCode, actionExecuted, executionAuthorized) {
    try {
      auditWriter({
        executionRequestId,
        confirmationRequestId: entry.confirmationRequestId,
        dryRunRequestId: entry.dryRunRequestId,
        timestamp: now.toISOString(),
        redactedIdentity: {
          processInstanceId: entry.processInstanceId,
          listenerId: entry.listenerId,
          port: entry.originalRequest.expected && entry.originalRequest.expected.port,
          bindHostClass: hostClass(entry.originalRequest.expected && entry.originalRequest.expected.host),
          processName: current && current.processName || entry.originalRequest.expected && entry.originalRequest.expected.processName,
          category: current && current.category || entry.originalRequest.expected && entry.originalRequest.expected.category,
          confidenceLevel: current && current.confidenceLevel || entry.originalRequest.expected && entry.originalRequest.expected.confidenceLevel,
          projectDisplayName: current && current.project && current.project.name || entry.originalRequest.expected && entry.originalRequest.expected.projectName
        },
        finalState,
        errorCode,
        actionExecuted,
        executionAuthorized
      });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  function errorResponse(code, message, extra = {}) {
    return {
      ok: false,
      code,
      category: "execution",
      message: redactSensitiveText(String(message)),
      actionExecuted: false,
      executionAuthorized: false,
      ...extra
    };
  }

  function cacheAndReturn(executionRequestId, idempotencyKey, result) {
    cacheResult(executionRequestId, idempotencyKey, result);
    return result;
  }

  function cacheResult(executionRequestId, idempotencyKey, result) {
    executions.set(executionRequestId, result);
    if (idempotencyKey) idempotency.set(idempotencyKey, executionRequestId);
  }

  return { executeStop };
}

function consumeExecutionProof(entry, token, now) {
  if (!safeExecutionToken(token) || !entry.executionTokenHash) {
    return { ok: false, code: "EXECUTION_PROOF_INVALID", message: "Execution proof is unavailable, expired, or invalid." };
  }
  if (entry.executionProofConsumedAt) {
    return { ok: false, code: "EXECUTION_PROOF_INVALID", message: "Execution proof is unavailable, expired, or invalid." };
  }
  if (!entry.executionProofExpiresAt || new Date(entry.executionProofExpiresAt).getTime() <= now.getTime()) {
    entry.executionTokenHash = null;
    return { ok: false, code: "DRY_RUN_EXPIRED", message: "Execution proof expired before it could be used." };
  }
  if (!timingSafeTokenEqual(token, entry.executionTokenHash)) {
    return { ok: false, code: "EXECUTION_PROOF_INVALID", message: "Execution proof is unavailable, expired, or invalid." };
  }
  entry.executionProofConsumedAt = now.toISOString();
  entry.executionTokenHash = null;
  return { ok: true };
}

function validateExecutionRequest(input, mode = {}) {
  if (!input || typeof input !== "object") return { ok: false, code: "INVALID_REQUEST", message: "Execution request body must be an object." };
  const confirmationId = input.confirmationRequestId || input.confirmationId;
  if (!confirmationId || typeof confirmationId !== "string") return { ok: false, code: "CONFIRMATION_ID_REQUIRED", message: "Confirmation ID is required." };
  if (mode.real && !normalizeKey(input.idempotencyKey)) return { ok: false, code: "IDEMPOTENCY_KEY_REQUIRED", message: "Execution requests require an idempotency key." };
  if (mode.real && !safeExecutionToken(input.executionAccessToken)) return { ok: false, code: "EXECUTION_PROOF_REQUIRED", message: "Execution access token is required." };
  if (!mode.real && (typeof input.typedToken !== "string" || !input.typedToken.trim())) return { ok: false, code: "TYPED_TOKEN_REQUIRED", message: "Typed confirmation token is required." };
  if (!input.processInstanceId || typeof input.processInstanceId !== "string") return { ok: false, code: "PROCESS_INSTANCE_ID_REQUIRED", message: "Process instance ID is required." };
  if (!input.listenerId || typeof input.listenerId !== "string") return { ok: false, code: "LISTENER_ID_REQUIRED", message: "Listener ID is required." };
  return { ok: true };
}

function validateCurrentRecord(entry, current) {
  if (current.processInstanceId !== entry.processInstanceId) return { code: "CREATION_TIME_MISMATCH", message: "The process creation time changed." };
  if (Number(current.port) !== Number(entry.originalRequest.expected.port)) return { code: "PORT_OWNER_CHANGED", message: "The port ownership has changed." };
  if (current.processName !== entry.originalRequest.expected.processName) return { code: "PROCESS_NAME_CHANGED", message: "The process name has changed." };
  return null;
}

function classifyMissingTarget(entry, snapshot) {
  const servers = snapshot && Array.isArray(snapshot.servers) ? snapshot.servers : [];
  const expected = entry.originalRequest.expected || {};
  const portOwner = servers.find((record) => Number(record.port) === Number(expected.port));
  if (portOwner && Number(portOwner.pid) !== Number(expected.pid)) return { code: "PORT_OWNER_CHANGED", message: "The port ownership has changed." };
  const samePidProc = servers.find((record) => Number(record.pid) === Number(expected.pid));
  if (samePidProc) return { code: "PORT_OWNER_CHANGED", message: "The port ownership has changed." };
  return { code: "ALREADY_EXITED", message: "The process has already exited." };
}

function verifyStopped(entry, snapshot) {
  const current = findCurrentRecord(entry.originalRequest, snapshot);
  if (!current) {
    const servers = snapshot && Array.isArray(snapshot.servers) ? snapshot.servers : [];
    const expected = entry.originalRequest.expected || {};
    const samePort = servers.find((record) => Number(record.port) === Number(expected.port));
    if (samePort) return { ok: false, state: "process-respawned", code: "PROCESS_RESPAWNED", message: "The listener was replaced by another process after stop dispatch." };
    return { ok: true };
  }
  return { ok: false, state: "listener-still-active", code: "LISTENER_STILL_ACTIVE", message: "The target listener is still active after graceful stop dispatch." };
}

function findCurrentRecord(input, snapshot) {
  const servers = snapshot && Array.isArray(snapshot.servers) ? snapshot.servers : [];
  const expected = input && input.expected || {};
  return servers.find((record) => record.processInstanceId === input.processInstanceId && record.listenerId === input.listenerId) ||
    servers.find((record) => record.processInstanceId === input.processInstanceId && Number(record.port) === Number(expected.port)) ||
    servers.find((record) => Number(record.pid) === Number(expected.pid) && Number(record.port) === Number(expected.port)) ||
    null;
}

function hostClass(host) {
  if (host === "0.0.0.0" || host === "::") return "all-interfaces";
  if (host === "127.0.0.1" || host === "::1" || host === "localhost") return "loopback";
  return "other-local";
}

function normalizeKey(value) {
  if (!value || typeof value !== "string") return null;
  return redactSensitiveText(value).replace(/[^a-z0-9_.:-]/gi, "").slice(0, 120) || null;
}

function safeExecutionToken(value) {
  return typeof value === "string" && /^exec-access-[a-f0-9]{64}$/i.test(value);
}

function timingSafeTokenEqual(token, hash) {
  const actual = tokenHash(token);
  const expected = String(hash || "");
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function tokenHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

async function defaultGracefulStopUnavailable() {
  return {
    ok: false,
    code: "STOP_BACKEND_UNAVAILABLE",
    message: "Graceful stop backend is unavailable in this environment. No process action was executed."
  };
}

module.exports = {
  DEFAULT_EXECUTION_TTL_MS,
  EXECUTION_TOKEN_BYTES,
  createExecutionManager,
  tokenHash
};
