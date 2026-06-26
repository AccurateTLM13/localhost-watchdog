"use strict";

const crypto = require("node:crypto");
const { writeExecutionAudit } = require("./audit");
const { evaluateDryRunFromSnapshot } = require("./dry-run");
const { scanWindows } = require("../scanner/windows");
const { evaluateConfirmationPolicy } = require("./security-policy");
const { redactSensitiveText } = require("../privacy/redact");

const DEFAULT_EXECUTION_TTL_MS = 60 * 1000;

function createExecutionManager(options = {}) {
  const confirmationManager = options.confirmationManager;
  const scanProvider = options.scanProvider || (() => scanWindows({ skipHistory: true }));
  const auditWriter = options.auditWriter || writeExecutionAudit;
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
    const now = clock();
    
    // 1. Validate request shape
    const validation = validateExecutionRequest(input);
    if (!validation.ok) {
      return {
        ok: false,
        code: validation.code,
        category: "execution",
        message: validation.message,
        actionExecuted: false,
        executionAuthorized: false
      };
    }

    // 2. Check Idempotency
    const idempotencyKey = normalizeKey(input.idempotencyKey);
    if (idempotencyKey && idempotency.has(idempotencyKey)) {
      const cachedId = idempotency.get(idempotencyKey);
      const cached = executions.get(cachedId);
      if (cached) return cached;
    }

    // 3. Fetch confirmation entry
    if (!confirmationManager || typeof confirmationManager.getConfirmationEntryInternal !== "function") {
      return errorResponse("CONFIRMATION_UNAVAILABLE", "Confirmation manager is unavailable.");
    }

    const confirmationRequestId = input.confirmationRequestId || input.confirmationId;
    const entry = confirmationManager.getConfirmationEntryInternal(confirmationRequestId);
    if (!entry) {
      return errorResponse("CONFIRMATION_UNAVAILABLE", "Confirmation is unavailable, expired, or the access token is invalid.");
    }

    // Verify session matches
    const sessionNonce = context.session && context.session.sessionNonce;
    if (!sessionNonce || entry.sessionNonce !== sessionNonce) {
      return errorResponse("SESSION_INVALID", "Session validation failed.");
    }

    // Verify confirmation is accepted
    if (entry.state !== "confirmation-accepted") {
      return errorResponse("CONFIRMATION_NOT_ACCEPTED", "Confirmation has not been accepted.");
    }

    // Verify confirmation not expired
    if (new Date(entry.expiresAt).getTime() <= now.getTime()) {
      return errorResponse("CONFIRMATION_EXPIRED", "Confirmation has expired.");
    }

    // Verify input targets match confirmation target
    if (entry.processInstanceId !== input.processInstanceId || entry.listenerId !== input.listenerId) {
      return errorResponse("IDENTITY_MISMATCH", "Target process or listener identity mismatch.");
    }

    // 4. Verify typed phrase
    const expectedPhrase = entry.requiredPhrase;
    const typedPhrase = typeof input.typedToken === "string" ? input.typedToken.trim() : "";
    if (typedPhrase !== expectedPhrase) {
      return errorResponse("CONFIRMATION_MISMATCH", "Typed confirmation phrase does not match.");
    }

    // 5. Trigger fresh scan revalidation
    let snapshot;
    try {
      snapshot = await scanProvider();
    } catch (error) {
      return errorResponse("REVALIDATION_UNAVAILABLE", "Scanner revalidation was unavailable.");
    }

    // 6. Find target process in snapshot
    const servers = snapshot && Array.isArray(snapshot.servers) ? snapshot.servers : [];
    const current = findCurrentRecord(entry.originalRequest, snapshot);
    
    // Check if exited
    if (!current) {
      // Check if port is now owned by someone else
      const portOwner = servers.find((record) => Number(record.port) === Number(entry.originalRequest.expected.port));
      if (portOwner && Number(portOwner.pid) !== Number(entry.originalRequest.expected.pid)) {
        return errorResponse("PORT_OWNER_CHANGED", "The port ownership has changed.");
      }
      // Check if the PID is still running but on a different port
      const samePidProc = servers.find((record) => Number(record.pid) === Number(entry.originalRequest.expected.pid));
      if (samePidProc) {
        return errorResponse("PORT_OWNER_CHANGED", "The port ownership has changed.");
      }
      return errorResponse("ALREADY_EXITED", "The process has already exited.");
    }

    // Check creation time matches
    if (current.processInstanceId !== entry.processInstanceId) {
      return errorResponse("CREATION_TIME_MISMATCH", "The process creation time changed.");
    }

    // Check port owner matches
    if (Number(current.port) !== Number(entry.originalRequest.expected.port)) {
      return errorResponse("PORT_OWNER_CHANGED", "The port ownership has changed.");
    }

    // Check process name matches
    if (current.processName !== entry.originalRequest.expected.processName) {
      return errorResponse("PROCESS_NAME_CHANGED", "The process name has changed.");
    }

    // 7. Evaluate dry-run safety recheck on current record
    const recheck = evaluateDryRunFromSnapshot(entry.originalRequest, snapshot, { now, randomId, watchdogPrivilege });
    if (!recheck.passed) {
      const firstBlocker = recheck.blockers && recheck.blockers[0];
      let code = firstBlocker ? firstBlocker.code : "REVALIDATION_BLOCKED";
      let message = firstBlocker ? firstBlocker.message : "Revalidation blocked execution.";
      if (code === "OWNER_POLICY") code = "OWNER_BLOCKED";
      if (code === "ELEVATION_POLICY") code = "ELEVATION_BLOCKED";
      
      const policy = evaluateConfirmationPolicy(current, { watchdogPrivilege });
      return errorResponse(code, message, { failureReason: policy.failureReason, policy });
    }

    // 8. Re-evaluate confirmation policies
    const policy = evaluateConfirmationPolicy(current, { watchdogPrivilege });
    if (!policy.ownerPassed) {
      return errorResponse("OWNER_BLOCKED", policy.ownerMessage, { failureReason: policy.failureReason, policy });
    }
    if (!policy.elevationPassed) {
      return errorResponse("ELEVATION_BLOCKED", policy.elevationMessage, { failureReason: policy.failureReason, policy });
    }

    // 9. Write Execution Audit (failure blocks execution)
    const executionRequestId = `actreq-${randomId(16)}`;
    const auditRecordInput = {
      executionRequestId,
      confirmationRequestId: entry.confirmationRequestId,
      dryRunRequestId: entry.dryRunRequestId,
      timestamp: now.toISOString(),
      redactedIdentity: {
        processInstanceId: entry.processInstanceId,
        listenerId: entry.listenerId,
        port: entry.originalRequest.expected && entry.originalRequest.expected.port,
        bindHostClass: hostClass(entry.originalRequest.expected && entry.originalRequest.expected.host),
        processName: current.processName,
        category: current.category,
        confidenceLevel: current.confidenceLevel,
        projectDisplayName: current.project && current.project.name
      },
      finalState: "simulation-completed",
      errorCode: null
    };

    try {
      auditWriter(auditRecordInput);
    } catch (auditError) {
      return errorResponse("AUDIT_LOG_UNAVAILABLE", "Audit logging failed.");
    }

    // 10. Construct successful response (Simulator always returns actionExecuted:false and executionAuthorized:false)
    const result = {
      ok: true,
      schemaVersion: "localhost-watchdog.execution-result.v1",
      actionRequestId: executionRequestId,
      state: "simulation-completed",
      message: "Execution simulator completed. No process action was executed.",
      actionExecuted: false,
      executionAuthorized: false
    };

    // Store in execution history for idempotency
    executions.set(executionRequestId, result);
    if (idempotencyKey) {
      idempotency.set(idempotencyKey, executionRequestId);
    }

    return result;
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

  return {
    executeStop
  };
}

function validateExecutionRequest(input) {
  if (!input || typeof input !== "object") {
    return { ok: false, code: "INVALID_REQUEST", message: "Execution request body must be an object." };
  }
  const confirmationId = input.confirmationRequestId || input.confirmationId;
  if (!confirmationId || typeof confirmationId !== "string") {
    return { ok: false, code: "CONFIRMATION_ID_REQUIRED", message: "Confirmation ID is required." };
  }
  if (typeof input.typedToken !== "string" || !input.typedToken.trim()) {
    return { ok: false, code: "TYPED_TOKEN_REQUIRED", message: "Typed confirmation token is required." };
  }
  if (!input.processInstanceId || typeof input.processInstanceId !== "string") {
    return { ok: false, code: "PROCESS_INSTANCE_ID_REQUIRED", message: "Process instance ID is required." };
  }
  if (!input.listenerId || typeof input.listenerId !== "string") {
    return { ok: false, code: "LISTENER_ID_REQUIRED", message: "Listener ID is required." };
  }
  return { ok: true };
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

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

module.exports = {
  createExecutionManager
};
