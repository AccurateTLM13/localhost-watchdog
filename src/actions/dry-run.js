"use strict";

const crypto = require("node:crypto");
const { writeDryRunAudit } = require("./audit");
const {
  ABSOLUTE_BLOCK_CATEGORIES,
  buildValidationFingerprint,
  hasProtectedAncestor,
  hasProtectedPortEvidence,
  hasStrongProjectOwnership
} = require("./eligibility");
const {
  isMandatoryCheck,
  validateRequiredExpectedFields
} = require("./required-fields");
const { safeError, safeErrorMessage } = require("../privacy/errors");
const { redactSensitiveText } = require("../privacy/redact");
const { scanWindows } = require("../scanner/windows");
const { evaluateConfirmationPolicy } = require("./security-policy");

const DEFAULT_DRY_RUN_TTL_MS = 60 * 1000;
const STATUS_ACCESS_TOKEN_BYTES = 32;
const DEV_CATEGORIES = new Set(["node-dev-server", "python-dev-server", "java-dev-server"]);
const GENERIC_STATUS_UNAVAILABLE = Object.freeze({
  ok: false,
  code: "DRY_RUN_STATUS_UNAVAILABLE",
  category: "dry-run-status",
  message: "Dry-run status is unavailable, expired, or the access token is invalid.",
  actionExecuted: false
});

function createDryRunManager(options = {}) {
  const results = new Map();
  const idempotency = new Map();
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_DRY_RUN_TTL_MS;
  const scanProvider = options.scanProvider || (() => scanWindows({ skipHistory: true }));
  const auditWriter = options.auditWriter || writeDryRunAudit;
  const clock = options.clock || (() => new Date());
  const randomId = options.randomId || randomHex;

  async function requestDryRun(input) {
    const now = clock();
    prune(now);
    const validation = validateDryRunRequest(input);
    if (!validation.ok) {
      return storeResult(buildInvalidRequestResult(validation.error, now, ttlMs, randomId), input && input.idempotencyKey);
    }

    const idempotencyKey = normalizeKey(input.idempotencyKey);
    if (idempotencyKey && idempotency.has(idempotencyKey)) {
      const existingId = idempotency.get(idempotencyKey);
      const existing = results.get(existingId);
      if (existing && new Date(existing.expiresAt).getTime() > now.getTime()) return existing.publicResult;
    }

    let snapshot;
    try {
      snapshot = await scanProvider();
    } catch (error) {
      return storeResult(withAuditStatus(buildScannerUnavailableResult(input, now, ttlMs, randomId, error)), idempotencyKey);
    }

    const result = evaluateDryRunFromSnapshot(input, snapshot, {
      now,
      ttlMs,
      randomId
    });
    return storeResult(withAuditStatus(result), idempotencyKey);
  }

  function getDryRunStatus(requestId, options = {}) {
    const now = options.now || clock();
    if (!safeRequestId(requestId) || !safeStatusAccessToken(options.statusAccessToken)) {
      return genericStatusUnavailable();
    }
    const entry = results.get(String(requestId || ""));
    if (!entry) {
      return genericStatusUnavailable();
    }
    if (!timingSafeTokenEqual(options.statusAccessToken, entry.statusAccessTokenHash)) {
      return genericStatusUnavailable();
    }
    if (options.processInstanceId && options.processInstanceId !== entry.publicResult.processInstanceId) {
      return {
        ok: false,
        code: "DRY_RUN_IDENTITY_MISMATCH",
        message: "Dry-run result is tied to a different process identity.",
        actionExecuted: false,
        executionAuthorized: false
      };
    }
    if (new Date(entry.publicResult.expiresAt).getTime() <= now.getTime()) {
      return genericStatusUnavailable();
    }
    return {
      ...entry.publicResult,
      status: "available",
      actionExecuted: false,
      executionAuthorized: false
    };
  }

  function getDryRunForConfirmation(requestId, options = {}) {
    const status = getDryRunStatus(requestId, options);
    if (status.ok === false || status.status !== "available") {
      return {
        ok: false,
        code: "DRY_RUN_STATUS_UNAVAILABLE",
        message: "Dry-run status is unavailable, expired, or the access token is invalid.",
        actionExecuted: false,
        executionAuthorized: false
      };
    }
    const entry = results.get(String(requestId || ""));
    if (!entry) {
      return {
        ok: false,
        code: "DRY_RUN_STATUS_UNAVAILABLE",
        message: "Dry-run status is unavailable, expired, or the access token is invalid.",
        actionExecuted: false,
        executionAuthorized: false
      };
    }
    return {
      ok: true,
      dryRun: status,
      originalRequest: entry.originalRequest,
      actionExecuted: false,
      executionAuthorized: false
    };
  }

  function storeResult(publicResult, idempotencyKey) {
    const statusAccessToken = publicResult.statusAccessToken;
    const storedResult = stripStatusAccessToken(publicResult);
    const result = {
      ...storedResult,
      actionExecuted: false
    };
    results.set(result.requestId, {
      publicResult: result,
      originalRequest: sanitizeStoredRequest(publicResult.originalRequest),
      statusAccessTokenHash: tokenHash(statusAccessToken),
      expiresAt: result.expiresAt
    });
    const normalizedKey = normalizeKey(idempotencyKey);
    if (normalizedKey) idempotency.set(normalizedKey, result.requestId);
    return {
      ...result,
      statusAccessToken
    };
  }

  function withAuditStatus(result) {
    try {
      auditWriter(result);
      return result;
    } catch (error) {
      const blocker = check("AUDIT_LOG_UNAVAILABLE", "blocked", safeErrorMessage("dry-run-audit", error, {
        code: "AUDIT_LOG_UNAVAILABLE",
        category: "audit",
        message: "Dry-run audit record could not be written. No action was executed."
      }));
      const checks = [...(result.checks || []), blocker];
      return finalizeResult({
        ...result,
        eligibilityState: "blocked",
        checks,
        safeMessage: "Dry-run blocked because audit logging failed. No action was executed."
      });
    }
  }

  function prune(now) {
    const cutoff = now.getTime();
    for (const [id, entry] of results) {
      if (new Date(entry.expiresAt).getTime() <= cutoff) results.delete(id);
    }
    for (const [key, id] of idempotency) {
      if (!results.has(id)) idempotency.delete(key);
    }
  }

  return {
    getDryRunForConfirmation,
    getDryRunStatus,
    requestDryRun
  };
}

function evaluateDryRunFromSnapshot(input, snapshot, options = {}) {
  const now = options.now || new Date();
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_DRY_RUN_TTL_MS;
  const randomId = options.randomId || randomHex;
  const expected = input.expected || {};
  const checks = [
    check("REQUEST_SHAPE", "pass", "Dry-run request shape is valid."),
    ...validateRequiredExpectedFields(input).map(normalizeExternalCheck)
  ];
  const current = findCurrentRecord(input, snapshot);

  if (!current) {
    checks.push(check("PID_EXISTS", "blocked", "Requested process/listener identity is not present in the latest scan."));
    return buildResult(input, null, checks, now, ttlMs, randomId);
  }

  checks.push(check("PID_EXISTS", "pass", "Requested process identity is present in the latest scan."));
  addMatchChecks(checks, input, expected, current, snapshot);
  addCategoryChecks(checks, current);
  addExpectedCategoryChecks(checks, expected, current);
  addProtectionChecks(checks, current);
  addOwnershipChecks(checks, expected, current);
  addMetadataChecks(checks, current);
  addLifecycleChecks(checks, current);
  addConflictChecks(checks, expected, current);
  addSecurityChecks(checks, current, options);

  return buildResult(input, current, checks, now, ttlMs, randomId);
}

function findCurrentRecord(input, snapshot) {
  const servers = snapshot && Array.isArray(snapshot.servers) ? snapshot.servers : [];
  return servers.find((record) => record.processInstanceId === input.processInstanceId && record.listenerId === input.listenerId) ||
    servers.find((record) => record.processInstanceId === input.processInstanceId && Number(record.port) === Number(input.expected && input.expected.port)) ||
    servers.find((record) => Number(record.pid) === Number(input.expected && input.expected.pid) && Number(record.port) === Number(input.expected && input.expected.port)) ||
    null;
}

function addMatchChecks(checks, input, expected, current) {
  const stable = current.identity && current.identity.status === "stable" && current.processInstanceId && !String(current.id || "").startsWith("session-unstable-");
  checks.push(stable ? check("STABLE_IDENTITY", "pass", "Stable PID plus creation-time identity is available.") : check("STABLE_IDENTITY", "blocked", "Stable PID plus creation-time identity is required."));

  checks.push(current.processInstanceId === input.processInstanceId
    ? check("CREATION_TIME_MATCH", "pass", "Process creation time still matches the requested process identity.")
    : check("CREATION_TIME_MATCH", "blocked", "Process creation time changed; PID reuse or identity mismatch is possible."));

  checks.push(current.listenerId === input.listenerId
    ? check("LISTENER_ID_MATCH", "pass", "Listener identity still matches the requested listener.")
    : check("LISTENER_ID_MATCH", "blocked", "Listener identity changed since the request."));

  compareExpected(checks, "PID_MATCH", expected.pid, current.pid, "PID still matches.", "PID changed since the request.");
  compareExpected(checks, "CREATION_TIME_VALUE_MATCH", expected.createdAt, current.createdAt, "Process creation timestamp still matches.", "Process creation timestamp changed since the request.");
  compareExpected(checks, "PROCESS_NAME_MATCH", expected.processName, current.processName, "Process name still matches.", "Process name changed since the request.");
  compareExpected(checks, "LISTENER_PORT_OWNERSHIP", expected.port, current.port, "Listener port is still owned by the same process identity.", "Listener port ownership changed since the request.");
  compareExpected(checks, "HOST_BIND_MATCH", expected.host, current.host, "Listener bind address still matches.", "Listener bind address changed since the request.");
}

function addCategoryChecks(checks, current) {
  if (ABSOLUTE_BLOCK_CATEGORIES.has(current.category)) {
    checks.push(check("CATEGORY_BLOCKED", "blocked", `Category ${safeText(current.category)} is blocked for dry-run eligibility.`));
    return;
  }
  checks.push(DEV_CATEGORIES.has(current.category)
    ? check("DEV_CATEGORY", "pass", "Listener is a development server category.")
    : check("DEV_CATEGORY", "blocked", "Only high-confidence development server categories can pass dry-run revalidation."));

  checks.push(current.confidenceLevel === "high"
    ? check("HIGH_CONFIDENCE", "pass", "Classification confidence remains high.")
    : check("HIGH_CONFIDENCE", "blocked", "Classification confidence is not high enough for dry-run revalidation."));
}

function addExpectedCategoryChecks(checks, expected, current) {
  compareExpected(checks, "CATEGORY_MATCH", expected.category, current.category, "Category still matches.", "Category changed since the request.");
  compareExpected(checks, "CONFIDENCE_LEVEL_MATCH", expected.confidenceLevel, current.confidenceLevel, "Confidence level still matches.", "Confidence level changed since the request.");
}

function addProtectionChecks(checks, current) {
  checks.push(current.category === "system-or-protected"
    ? check("PROTECTED_PROCESS", "blocked", "Protected/system processes are blocked.")
    : check("PROTECTED_PROCESS", "pass", "Process category is not protected/system."));

  checks.push(hasProtectedPortEvidence(current)
    ? check("PROTECTED_PORT", "blocked", "Protected ports are blocked.")
    : check("PROTECTED_PORT", "pass", "Listener port is not marked protected."));

  const treeAvailable = current.processTree && current.processTree.stopReason && Array.isArray(current.processTree.chain);
  checks.push(treeAvailable
    ? check("PROCESS_TREE_BOUNDARY_AVAILABLE", "pass", "Process-tree boundary result is available.")
    : check("PROCESS_TREE_BOUNDARY_AVAILABLE", "blocked", "Process-tree boundary result is unavailable."));

  checks.push(hasProtectedAncestor(current)
    ? check("PROTECTED_TREE_BOUNDARY", "blocked", "Process tree crosses a protected boundary.")
    : check("PROTECTED_TREE_BOUNDARY", "pass", "No protected process-tree boundary was detected."));

  checks.push(current.processTree && current.processTree.truncated
    ? check("PROCESS_TREE_NOT_TRUNCATED", "blocked", "Process tree is truncated and cannot become confirmation-eligible.")
    : check("PROCESS_TREE_NOT_TRUNCATED", "pass", "Process tree is not truncated."));

  if (current.privilege && current.privilege.elevated === true && current.privilege.verified !== true) {
    checks.push(check("ELEVATED_PRIVILEGE_UNVERIFIED", "blocked", "Elevated process state could not be safely verified."));
  } else {
    checks.push(check("PRIVILEGE_SAFE", "pass", "No elevated-process mismatch was detected."));
  }
}

function addOwnershipChecks(checks, expected, current) {
  if (!hasStrongProjectOwnership(current)) {
    checks.push(check("PROJECT_OWNERSHIP", "blocked", "Strong project ownership is required for dry-run revalidation."));
    return;
  }
  checks.push(check("PROJECT_OWNERSHIP", "pass", "Project ownership remains strong."));
  const project = current.project || {};
  compareExpected(checks, "PROJECT_NAME_MATCH", expected.projectName, project.name, "Project display identity still matches.", "Project display identity changed since the request.");
  compareExpected(checks, "PROJECT_ROOT_MATCH", expected.projectRoot, project.root, "Project root identity still matches.", "Project root identity changed since the request.");
  compareExpected(checks, "PROJECT_SOURCE_MATCH", expected.projectSource, project.source, "Project ownership source still matches.", "Project ownership source changed since the request.");
}

function addMetadataChecks(checks, current) {
  checks.push(current.createdAt && current.timingStatus === "available"
    ? check("CREATION_TIME_AVAILABLE", "pass", "Creation-time metadata is available.")
    : check("CREATION_TIME_AVAILABLE", "blocked", "Creation-time metadata is unavailable."));
  checks.push(current.processName
    ? check("PROCESS_METADATA_AVAILABLE", "pass", "Required process metadata is available.")
    : check("PROCESS_METADATA_AVAILABLE", "blocked", "Required process metadata is unavailable."));
}

function addLifecycleChecks(checks, current) {
  const label = current.lifecycleContext && current.lifecycleContext.label;
  checks.push(label === "stale-candidate"
    ? check("LIFECYCLE_NOT_STALE", "blocked", "Lifecycle context is stale-candidate and cannot become confirmation-eligible.")
    : check("LIFECYCLE_NOT_STALE", "pass", "Lifecycle context does not block dry-run confirmation eligibility."));
}

function addConflictChecks(checks, expected, current) {
  const currentFingerprint = buildValidationFingerprint(current);
  if (expected.validationFingerprint && expected.validationFingerprint !== currentFingerprint) {
    checks.push(check("CONFLICTING_NEWER_SCAN", "blocked", "Current scanner evidence differs from the requested record."));
  } else {
    checks.push(check("CONFLICTING_NEWER_SCAN", "pass", "No conflicting newer scan evidence was detected."));
  }

}

function addSecurityChecks(checks, current, options = {}) {
  const watchdogPrivilege = options.watchdogPrivilege || {
    available: false,
    elevated: false,
    integrityAvailable: false,
    sessionAvailable: false
  };
  const policy = evaluateConfirmationPolicy(current, { watchdogPrivilege });

  if (!policy.ownerPassed) {
    checks.push(check("OWNER_POLICY", "blocked", policy.ownerMessage));
  } else {
    checks.push(check("OWNER_POLICY", "pass", policy.ownerMessage));
  }

  if (!policy.elevationPassed) {
    checks.push(check("ELEVATION_POLICY", "blocked", policy.elevationMessage));
  } else {
    checks.push(check("ELEVATION_POLICY", "pass", policy.elevationMessage));
  }
}

function compareExpected(checks, code, expected, actual, passMessage, blockMessage) {
  if (!hasComparableValue(expected)) {
    checks.push(check(code, "blocked", "Expected value was not supplied or was invalid; mandatory comparison failed."));
    return;
  }
  if (!hasComparableValue(actual)) {
    checks.push(check(code, "blocked", "Current value is unavailable; mandatory comparison failed."));
    return;
  }
  checks.push(String(expected) === String(actual)
    ? check(code, "pass", passMessage)
    : check(code, "blocked", blockMessage));
}

function hasComparableValue(value) {
  return value != null && value !== "" && !(typeof value === "number" && !Number.isFinite(value));
}

function buildResult(input, current, checks, now, ttlMs, randomId) {
  const requestId = `dryrun-${randomId(16)}`;
  const statusAccessToken = `dryrun-status-${randomId(STATUS_ACCESS_TOKEN_BYTES)}`;
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  return finalizeResult({
    ok: true,
    requestId,
    statusAccessToken,
    evaluatedAt: now.toISOString(),
    expiresAt,
    processInstanceId: input.processInstanceId || null,
    listenerId: input.listenerId || null,
    category: current && current.category || null,
    confidenceLevel: current && current.confidenceLevel || null,
    validationFingerprint: current ? buildValidationFingerprint(current) : null,
    checks,
    safeMessage: "Dry-run safety check completed. No action was executed.",
    actionExecuted: false,
    executionAuthorized: false,
    originalRequest: sanitizeStoredRequest(input),
    statusAccess: {
      expiresAt,
      tiedToProcessInstanceId: input.processInstanceId || null,
      tiedToListenerId: input.listenerId || null,
      authorizesStatusRead: true,
      authorizesConfirmation: false,
      authorizesExecution: false
    }
  });
}

function finalizeResult(result) {
  const checks = result.checks || [];
  const blockers = checks.filter((item) => item.status === "blocked");
  const warnings = checks.filter((item) => item.status === "warning" || item.status === "unavailable");
  const mandatoryProblems = checks.filter((item) => item.mandatory !== false && item.status !== "pass");
  let passed = blockers.length === 0 && mandatoryProblems.length === 0;
  let eligibilityState = result.eligibilityState || (passed ? "confirmation-eligible" : "blocked");
  let finalChecks = checks;

  if (eligibilityState === "confirmation-eligible" && (!passed || blockers.length > 0 || mandatoryProblems.length > 0)) {
    finalChecks = [
      ...checks,
      check("DRY_RUN_INTERNAL_INVARIANT_VIOLATION", "blocked", "Dry-run state was internally inconsistent and was blocked safely.")
    ];
    passed = false;
    eligibilityState = "blocked";
  }

  if (eligibilityState === "blocked") {
    passed = false;
  }

  const finalBlockers = finalChecks.filter((item) => item.status === "blocked");
  const finalWarnings = finalChecks.filter((item) => item.status === "warning" || item.status === "unavailable");

  return {
    ...result,
    eligibilityState,
    passed,
    checks: finalChecks,
    warnings: finalWarnings,
    blockers: finalBlockers,
    actionExecuted: false,
    executionAuthorized: false,
    safeMessage: passed
      ? "Dry-run safety check completed. No action was executed."
      : (result.safeMessage || "Dry-run safety check blocked. No action was executed.")
  };
}

function buildInvalidRequestResult(error, now, ttlMs, randomId) {
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  return finalizeResult({
    ok: false,
    requestId: `dryrun-${randomId(16)}`,
    statusAccessToken: `dryrun-status-${randomId(STATUS_ACCESS_TOKEN_BYTES)}`,
    evaluatedAt: now.toISOString(),
    expiresAt,
    processInstanceId: null,
    listenerId: null,
    checks: [check(error.code, "blocked", error.message)],
    safeMessage: "Dry-run request was rejected. No action was executed.",
    actionExecuted: false,
    executionAuthorized: false,
    statusAccess: {
      expiresAt,
      tiedToProcessInstanceId: null,
      tiedToListenerId: null,
      authorizesStatusRead: true,
      authorizesConfirmation: false,
      authorizesExecution: false
    }
  });
}

function buildScannerUnavailableResult(input, now, ttlMs, randomId, error) {
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  return finalizeResult({
    ok: false,
    requestId: `dryrun-${randomId(16)}`,
    statusAccessToken: `dryrun-status-${randomId(STATUS_ACCESS_TOKEN_BYTES)}`,
    evaluatedAt: now.toISOString(),
    expiresAt,
    processInstanceId: input && input.processInstanceId || null,
    listenerId: input && input.listenerId || null,
    eligibilityState: "blocked",
    checks: [check("SCANNER_UNAVAILABLE", "blocked", safeError("dry-run-scanner", error, {
      code: "SCANNER_UNAVAILABLE",
      category: "scanner",
      message: "Scanner revalidation was unavailable. No action was executed."
    }).message)],
    safeMessage: "Dry-run blocked because scanner revalidation was unavailable. No action was executed.",
    actionExecuted: false,
    executionAuthorized: false,
    originalRequest: sanitizeStoredRequest(input),
    statusAccess: {
      expiresAt,
      tiedToProcessInstanceId: input && input.processInstanceId || null,
      tiedToListenerId: input && input.listenerId || null,
      authorizesStatusRead: true,
      authorizesConfirmation: false,
      authorizesExecution: false
    }
  });
}

function validateDryRunRequest(input) {
  if (!input || typeof input !== "object") {
    return { ok: false, error: { code: "INVALID_DRY_RUN_REQUEST", message: "Dry-run request body must be an object." } };
  }
  if (!safeIdentity(input.processInstanceId)) {
    return { ok: false, error: { code: "PROCESS_INSTANCE_ID_REQUIRED", message: "Stable process instance identity is required." } };
  }
  if (!safeIdentity(input.listenerId)) {
    return { ok: false, error: { code: "LISTENER_ID_REQUIRED", message: "Listener identity is required." } };
  }
  if (String(input.processInstanceId).startsWith("session-unstable-") || String(input.listenerId).startsWith("session-unstable-")) {
    return { ok: false, error: { code: "UNSTABLE_IDENTITY", message: "Session-scoped unstable identities cannot run dry-run eligibility." } };
  }
  return { ok: true };
}

function check(code, status, message) {
  const safe = safeCode(code);
  return {
    code: safe,
    status,
    mandatory: isMandatoryCheck(safe),
    message: safeText(message)
  };
}

function normalizeExternalCheck(item) {
  return {
    code: safeCode(item.code),
    status: item.status || "blocked",
    mandatory: item.mandatory !== false,
    message: safeText(item.message)
  };
}

function safeCode(value) {
  return String(value || "UNKNOWN").toUpperCase().replace(/[^A-Z0-9_]+/g, "_").slice(0, 80) || "UNKNOWN";
}

function safeText(value) {
  return redactSensitiveText(String(value == null ? "" : value)).replace(/[<>]/g, "").slice(0, 500);
}

function safeIdentity(value) {
  return typeof value === "string" && /^[a-z0-9_.:-]+$/i.test(value) && value.length <= 220;
}

function safeRequestId(value) {
  return typeof value === "string" && /^dryrun-[a-f0-9]{32}$/i.test(value);
}

function safeStatusAccessToken(value) {
  return typeof value === "string" && /^dryrun-status-[a-f0-9]{64}$/i.test(value);
}

function normalizeKey(value) {
  if (!value || typeof value !== "string") return null;
  return redactSensitiveText(value).replace(/[^a-z0-9_.:-]/gi, "").slice(0, 120) || null;
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function timingSafeTokenEqual(token, expectedHash) {
  if (!safeStatusAccessToken(token) || typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/i.test(expectedHash)) return false;
  const actual = Buffer.from(tokenHash(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function stripStatusAccessToken(result) {
  const { statusAccessToken, originalRequest, request, ...safeResult } = result || {};
  return safeResult;
}

function sanitizeStoredRequest(input) {
  if (!input || typeof input !== "object") return null;
  const expected = input.expected && typeof input.expected === "object" ? input.expected : {};
  return {
    processInstanceId: typeof input.processInstanceId === "string" ? input.processInstanceId : null,
    listenerId: typeof input.listenerId === "string" ? input.listenerId : null,
    expected: {
      pid: expected.pid,
      processName: expected.processName,
      host: expected.host,
      port: expected.port,
      createdAt: expected.createdAt,
      projectName: expected.projectName,
      projectRoot: expected.projectRoot,
      projectSource: expected.projectSource,
      category: expected.category,
      confidenceLevel: expected.confidenceLevel,
      validationFingerprint: expected.validationFingerprint
    }
  };
}

function genericStatusUnavailable() {
  return { ...GENERIC_STATUS_UNAVAILABLE };
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

module.exports = {
  DEFAULT_DRY_RUN_TTL_MS,
  createDryRunManager,
  evaluateDryRunFromSnapshot,
  validateDryRunRequest
};
