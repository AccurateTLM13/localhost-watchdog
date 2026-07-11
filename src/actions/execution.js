"use strict";

const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const net = require("node:net");
const path = require("node:path");
const execFileAsync = promisify(execFile);

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
    const isFixture = await isRepositoryTestFixture(current.pid, current.processName, entry.originalRequest.fixtureToken);

    if (isFixture) {
      // 9a. Write initial attempt record (failure blocks execution)
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
        finalState: "attempted",
        errorCode: null,
        actionExecuted: false,
        executionAuthorized: true
      };

      try {
        auditWriter(auditRecordInput);
      } catch (auditError) {
        return errorResponse("AUDIT_LOG_UNAVAILABLE", "Audit logging failed.");
      }

      // 9b. Perform final fresh revalidation immediately before signaling
      let finalSnapshot;
      try {
        finalSnapshot = await scanProvider();
      } catch (error) {
        const failedRecord = {
          ...auditRecordInput,
          finalState: "failed",
          errorCode: "REVALIDATION_UNAVAILABLE"
        };
        try { auditWriter(failedRecord); } catch { return errorResponse("AUDIT_WRITE_FAILED", "Audit logging failed during final revalidation."); }
        return errorResponse("REVALIDATION_UNAVAILABLE", "Scanner revalidation was unavailable before signaling.");
      }

      const finalCurrent = findCurrentRecord(entry.originalRequest, finalSnapshot);
      if (!finalCurrent) {
        const portOwner = finalSnapshot.servers && finalSnapshot.servers.find((record) => Number(record.port) === Number(entry.originalRequest.expected.port));
        const errorCode = portOwner ? "PORT_OWNER_CHANGED" : "ALREADY_EXITED";
        const msg = portOwner ? "The port ownership has changed." : "The process has already exited.";
        const failedRecord = {
          ...auditRecordInput,
          finalState: "failed",
          errorCode
        };
        try { auditWriter(failedRecord); } catch { return errorResponse("AUDIT_WRITE_FAILED", "Audit logging failed during final revalidation."); }
        return errorResponse(errorCode, msg);
      }

      if (finalCurrent.processInstanceId !== entry.processInstanceId) {
        const failedRecord = {
          ...auditRecordInput,
          finalState: "failed",
          errorCode: "CREATION_TIME_MISMATCH"
        };
        try { auditWriter(failedRecord); } catch { return errorResponse("AUDIT_WRITE_FAILED", "Audit logging failed during final revalidation."); }
        return errorResponse("CREATION_TIME_MISMATCH", "The process creation time changed.");
      }

      if (Number(finalCurrent.port) !== Number(entry.originalRequest.expected.port)) {
        const failedRecord = {
          ...auditRecordInput,
          finalState: "failed",
          errorCode: "PORT_OWNER_CHANGED"
        };
        try { auditWriter(failedRecord); } catch { return errorResponse("AUDIT_WRITE_FAILED", "Audit logging failed during final revalidation."); }
        return errorResponse("PORT_OWNER_CHANGED", "The port ownership has changed.");
      }

      if (finalCurrent.processName !== entry.originalRequest.expected.processName) {
        const failedRecord = {
          ...auditRecordInput,
          finalState: "failed",
          errorCode: "PROCESS_NAME_CHANGED"
        };
        try { auditWriter(failedRecord); } catch { return errorResponse("AUDIT_WRITE_FAILED", "Audit logging failed during final revalidation."); }
        return errorResponse("PROCESS_NAME_CHANGED", "The process name has changed.");
      }

      const finalRecheck = evaluateDryRunFromSnapshot(entry.originalRequest, finalSnapshot, { now, randomId, watchdogPrivilege });
      if (!finalRecheck.passed) {
        const firstBlocker = finalRecheck.blockers && finalRecheck.blockers[0];
        let code = firstBlocker ? firstBlocker.code : "REVALIDATION_BLOCKED";
        let message = firstBlocker ? firstBlocker.message : "Revalidation blocked execution.";
        if (code === "OWNER_POLICY") code = "OWNER_BLOCKED";
        if (code === "ELEVATION_POLICY") code = "ELEVATION_BLOCKED";
        
        const failedRecord = { ...auditRecordInput, finalState: "failed", errorCode: code };
        try { auditWriter(failedRecord); } catch { return errorResponse("AUDIT_WRITE_FAILED", "Audit logging failed during final revalidation."); }
        
        const policy = evaluateConfirmationPolicy(finalCurrent, { watchdogPrivilege });
        return errorResponse(code, message, { failureReason: policy.failureReason, policy });
      }

      const finalPolicy = evaluateConfirmationPolicy(finalCurrent, { watchdogPrivilege });
      if (!finalPolicy.ownerPassed) {
        const failedRecord = { ...auditRecordInput, finalState: "failed", errorCode: "OWNER_BLOCKED" };
        try { auditWriter(failedRecord); } catch { return errorResponse("AUDIT_WRITE_FAILED", "Audit logging failed during final revalidation."); }
        return errorResponse("OWNER_BLOCKED", finalPolicy.ownerMessage, { failureReason: finalPolicy.failureReason, policy: finalPolicy });
      }
      if (!finalPolicy.elevationPassed) {
        const failedRecord = { ...auditRecordInput, finalState: "failed", errorCode: "ELEVATION_BLOCKED" };
        try { auditWriter(failedRecord); } catch { return errorResponse("AUDIT_WRITE_FAILED", "Audit logging failed during final revalidation."); }
        return errorResponse("ELEVATION_BLOCKED", finalPolicy.elevationMessage, { failureReason: finalPolicy.failureReason, policy: finalPolicy });
      }

      const isFinalFixture = await isRepositoryTestFixture(finalCurrent.pid, finalCurrent.processName, entry.originalRequest.fixtureToken);
      if (!isFinalFixture) {
        const failedRecord = { ...auditRecordInput, finalState: "failed", errorCode: "IDENTITY_MISMATCH" };
        try { auditWriter(failedRecord); } catch { return errorResponse("AUDIT_WRITE_FAILED", "Audit logging failed during final revalidation."); }
        return errorResponse("IDENTITY_MISMATCH", "Final process identity does not match the test fixture allowlist.");
      }

      // 9c. Signal the process (using SIGINT gracefully)
      const targetPid = finalCurrent.pid;
      let signalSent = false;
      try {
        const pKill = process.kill;
        pKill(targetPid, "SIGINT");
        signalSent = true;
      } catch (killError) {
        const failedRecord = {
          ...auditRecordInput,
          finalState: "failed",
          errorCode: "SIGNAL_FAILED"
        };
        try { auditWriter(failedRecord); } catch { return errorResponse("AUDIT_WRITE_FAILED", "Audit logging failed after signal failure."); }
        return errorResponse("SIGNAL_FAILED", `Failed to signal process: ${killError.message}`);
      }

      // 9d. Wait for process exit and port release
      const timeoutMs = 5000;
      const pollIntervalMs = 200;
      const startTime = Date.now();
      let processExited = false;
      let portReleased = false;
      const port = Number(entry.originalRequest.expected.port);
      const host = entry.originalRequest.expected.host || "127.0.0.1";

      while (Date.now() - startTime < timeoutMs) {
        if (!processExited) {
          processExited = !isProcessRunning(targetPid);
        }
        if (!portReleased) {
          portReleased = await isPortFree(port, host);
        }
        if (processExited && portReleased) {
          break;
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }

      const success = processExited && portReleased;
      const finalState = success ? "success" : "timeout";

      const finalRecord = {
        ...auditRecordInput,
        finalState: finalState,
        errorCode: success ? null : "EXECUTION_TIMEOUT",
        actionExecuted: signalSent,
        executionAuthorized: true
      };

      let auditFailed = false;
      try {
        auditWriter(finalRecord);
      } catch (auditError) {
        auditFailed = true;
      }

      const result = {
        ok: success && !auditFailed,
        schemaVersion: "localhost-watchdog.execution-result.v1",
        actionRequestId: executionRequestId,
        state: finalState,
        code: undefined,
        message: "Process stopped successfully.",
        actionExecuted: signalSent,
        executionAuthorized: true,
        details: { signalSent, processExited, portReleased }
      };

      if (auditFailed) {
        result.ok = false;
        result.code = "AUDIT_WRITE_FAILED";
        result.message = "Process signaled, but final audit record failed to write.";
      } else if (!success) {
        result.ok = false;
        result.code = "EXECUTION_TIMEOUT";
        result.message = "The process did not exit or release the port within the timeout window.";
      }

      executions.set(executionRequestId, result);
      if (idempotencyKey) {
        idempotency.set(idempotencyKey, executionRequestId);
      }
      return result;
    } else {
      // 10. Simulation logic for non-fixtures (keeps actionExecuted:false and executionAuthorized:false)
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
        errorCode: null,
        actionExecuted: false,
        executionAuthorized: false
      };

      try {
        auditWriter(auditRecordInput);
      } catch (auditError) {
        return errorResponse("AUDIT_LOG_UNAVAILABLE", "Audit logging failed.");
      }

      const result = {
        ok: true,
        schemaVersion: "localhost-watchdog.execution-result.v1",
        actionRequestId: executionRequestId,
        state: "simulation-completed",
        message: "Execution simulator completed. No process action was executed.",
        actionExecuted: false,
        executionAuthorized: false
      };

      executions.set(executionRequestId, result);
      if (idempotencyKey) {
        idempotency.set(idempotencyKey, executionRequestId);
      }
      return result;
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

async function getProcessInfo(pid) {
  if (process.platform === "win32") {
    try {
      const cmd = `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object CommandLine, ExecutablePath | ConvertTo-Json`;
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        cmd
      ]);
      if (!stdout.trim()) return null;
      const parsed = JSON.parse(stdout);
      return {
        commandLine: parsed.CommandLine || parsed.commandLine || "",
        executablePath: parsed.ExecutablePath || parsed.executablePath || ""
      };
    } catch {
      return null;
    }
  } else {
    try {
      const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="]);
      return {
        commandLine: stdout.trim(),
        executablePath: ""
      };
    } catch {
      return null;
    }
  }
}

async function isRepositoryTestFixture(pid, processName, expectedToken) {
  const name = String(processName || "").toLowerCase();
  if (name !== "node.exe" && name !== "node") {
    return false;
  }
  const info = await getProcessInfo(pid);
  if (!info) {
    return false;
  }

  const cmdLine = String(info.commandLine);

  if (!expectedToken || typeof expectedToken !== "string") {
    return false;
  }

  const repoRoot = process.cwd();
  const allowlistedPath = path.join(repoRoot, "test", "fixtures", "server.js");
  
  const normalizedCmd = cmdLine.replace(/\\/g, '/').toLowerCase();
  const normalizedAllowlist = allowlistedPath.replace(/\\/g, '/').toLowerCase();
  
  if (!normalizedCmd.includes(normalizedAllowlist)) {
    return false;
  }
  if (!cmdLine.includes(expectedToken)) {
    return false;
  }

  return true;
}

function isProcessRunning(pid) {
  try {
    const pKill = process.kill;
    pKill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH";
  }
}

function isPortFree(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => {
        resolve(true);
      });
    });
    server.listen(port, host || "127.0.0.1");
  });
}

module.exports = {
  DEFAULT_EXECUTION_TTL_MS,
  EXECUTION_TOKEN_BYTES,
  createExecutionManager,
  tokenHash
};
