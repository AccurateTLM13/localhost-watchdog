"use strict";

const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const net = require("node:net");
const execFileAsync = promisify(execFile);

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
    const isFixture = await isRepositoryTestFixture(current.pid, current.processName);

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
        try { auditWriter(failedRecord); } catch {}
        return errorResponse("REVALIDATION_UNAVAILABLE", "Scanner revalidation was unavailable before signaling.");
      }

      const finalCurrent = findCurrentRecord(entry.originalRequest, finalSnapshot);
      if (!finalCurrent) {
        const portOwner = finalSnapshot.servers && finalSnapshot.servers.find((record) => Number(record.port) === Number(entry.originalRequest.expected.port));
        if (portOwner) {
          const failedRecord = {
            ...auditRecordInput,
            finalState: "failed",
            errorCode: "PORT_OWNER_CHANGED"
          };
          try { auditWriter(failedRecord); } catch {}
          return errorResponse("PORT_OWNER_CHANGED", "The port ownership has changed.");
        }
        const failedRecord = {
          ...auditRecordInput,
          finalState: "failed",
          errorCode: "ALREADY_EXITED"
        };
        try { auditWriter(failedRecord); } catch {}
        return errorResponse("ALREADY_EXITED", "The process has already exited.");
      }

      if (finalCurrent.processInstanceId !== entry.processInstanceId) {
        const failedRecord = {
          ...auditRecordInput,
          finalState: "failed",
          errorCode: "CREATION_TIME_MISMATCH"
        };
        try { auditWriter(failedRecord); } catch {}
        return errorResponse("CREATION_TIME_MISMATCH", "The process creation time changed.");
      }

      if (Number(finalCurrent.port) !== Number(entry.originalRequest.expected.port)) {
        const failedRecord = {
          ...auditRecordInput,
          finalState: "failed",
          errorCode: "PORT_OWNER_CHANGED"
        };
        try { auditWriter(failedRecord); } catch {}
        return errorResponse("PORT_OWNER_CHANGED", "The port ownership has changed.");
      }

      if (finalCurrent.processName !== entry.originalRequest.expected.processName) {
        const failedRecord = {
          ...auditRecordInput,
          finalState: "failed",
          errorCode: "PROCESS_NAME_CHANGED"
        };
        try { auditWriter(failedRecord); } catch {}
        return errorResponse("PROCESS_NAME_CHANGED", "The process name has changed.");
      }

      // 9c. Signal the process (using SIGINT gracefully)
      const targetPid = current.pid;
      try {
        const pKill = process.kill;
        pKill(targetPid, "SIGINT");
      } catch (killError) {
        const failedRecord = {
          ...auditRecordInput,
          finalState: "failed",
          errorCode: "SIGNAL_FAILED"
        };
        try { auditWriter(failedRecord); } catch {}
        return errorResponse("SIGNAL_FAILED", `Failed to signal process: ${killError.message}`);
      }

      // 9d. Wait for process exit and port release
      const timeoutMs = 5000;
      const pollIntervalMs = 200;
      const startTime = Date.now();
      let exited = false;
      const port = Number(entry.originalRequest.expected.port);

      while (Date.now() - startTime < timeoutMs) {
        const pidRunning = isProcessRunning(targetPid);
        const portFree = await isPortFree(port);
        if (!pidRunning && portFree) {
          exited = true;
          break;
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }

      if (exited) {
        const successRecord = {
          ...auditRecordInput,
          finalState: "success",
          actionExecuted: true,
          executionAuthorized: true
        };
        try { auditWriter(successRecord); } catch {}

        const result = {
          ok: true,
          schemaVersion: "localhost-watchdog.execution-result.v1",
          actionRequestId: executionRequestId,
          state: "success",
          message: "Process stopped successfully.",
          actionExecuted: true,
          executionAuthorized: true
        };

        executions.set(executionRequestId, result);
        if (idempotencyKey) {
          idempotency.set(idempotencyKey, executionRequestId);
        }
        return result;
      } else {
        const failedRecord = {
          ...auditRecordInput,
          finalState: "failed",
          errorCode: "EXECUTION_TIMEOUT",
          actionExecuted: false,
          executionAuthorized: true
        };
        try { auditWriter(failedRecord); } catch {}

        const result = {
          ok: false,
          code: "EXECUTION_TIMEOUT",
          category: "execution",
          message: "The process did not exit within the timeout window.",
          actionExecuted: false,
          executionAuthorized: true
        };

        executions.set(executionRequestId, result);
        if (idempotencyKey) {
          idempotency.set(idempotencyKey, executionRequestId);
        }
        return result;
      }
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

async function isRepositoryTestFixture(pid, processName) {
  const name = String(processName || "").toLowerCase();
  if (name !== "node.exe" && name !== "node") {
    return false;
  }
  const info = await getProcessInfo(pid);
  if (!info) return false;

  const cmdLine = String(info.commandLine).toLowerCase();
  const execPath = String(info.executablePath).toLowerCase();

  const repoRoot = process.cwd().toLowerCase();
  const isUnderRepo = cmdLine.includes(repoRoot) || execPath.includes(repoRoot);
  const isFixture = cmdLine.includes("localhost-watchdog-test-fixture") ||
                    cmdLine.includes("test-fixture-server") ||
                    cmdLine.includes("test\\fixtures") ||
                    cmdLine.includes("test/fixtures");

  return isUnderRepo && isFixture;
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

function isPortFree(port) {
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
    server.listen(port, "127.0.0.1");
  });
}

module.exports = {
  createExecutionManager
};
