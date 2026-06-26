"use strict";

const crypto = require("node:crypto");
const { writeConfirmationAudit } = require("./audit");
const { buildValidationFingerprint } = require("./eligibility");
const { evaluateDryRunFromSnapshot } = require("./dry-run");
const { safeErrorMessage } = require("../privacy/errors");
const { redactSensitiveText } = require("../privacy/redact");
const { scanWindows } = require("../scanner/windows");
const { evaluateConfirmationPolicy } = require("./security-policy");

const DEFAULT_CONFIRMATION_TTL_MS = 60 * 1000;
const CONFIRMATION_TOKEN_BYTES = 32;
const GENERIC_CONFIRMATION_UNAVAILABLE = Object.freeze({
  ok: false,
  state: "not-available",
  code: "CONFIRMATION_UNAVAILABLE",
  message: "Confirmation is unavailable, expired, or the access token is invalid.",
  actionExecuted: false,
  executionAuthorized: false
});

function createConfirmationManager(options = {}) {
  const dryRunManager = options.dryRunManager;
  const confirmations = new Map();
  const idempotency = new Map();
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_CONFIRMATION_TTL_MS;
  const scanProvider = options.scanProvider || (() => scanWindows({ skipHistory: true }));
  const auditWriter = options.auditWriter || writeConfirmationAudit;
  const clock = options.clock || (() => new Date());
  const randomId = options.randomId || randomHex;
  const watchdogPrivilege = options.watchdogPrivilege || {
    available: true,
    elevated: false,
    integrityAvailable: true,
    sessionAvailable: true
  };

  async function createConfirmation(input = {}, context = {}) {
    const now = clock();
    prune(now);
    const dryRunLookup = getDryRunForConfirmation(input, now);
    if (!dryRunLookup.ok) return blocked("not-available", dryRunLookup.code, dryRunLookup.message);

    const dryRun = dryRunLookup.dryRun;
    if (!isDryRunConfirmationEligible(dryRun, now)) {
      return blocked("not-available", "DRY_RUN_NOT_CONFIRMATION_ELIGIBLE", "Dry-run result is not confirmation-eligible.");
    }

    let snapshot;
    try {
      snapshot = await scanProvider();
    } catch (error) {
      return blocked("not-available", "SCANNER_UNAVAILABLE", safeErrorMessage("confirmation-scanner", error, {
        code: "SCANNER_UNAVAILABLE",
        category: "scanner",
        message: "Scanner revalidation was unavailable. Confirmation was not recorded."
      }));
    }

    const current = findCurrentRecord(dryRunLookup.originalRequest, snapshot);
    const policy = evaluateConfirmationPolicy(current, { watchdogPrivilege });
    if (!policy.ownerPassed) return blocked("owner-blocked", "OWNER_BLOCKED", policy.ownerMessage, { policy });
    if (!policy.elevationPassed) return blocked("elevation-blocked", "ELEVATION_BLOCKED", policy.elevationMessage, { policy });

    const dryRunRecheck = evaluateDryRunFromSnapshot(dryRunLookup.originalRequest, snapshot, { now, ttlMs, randomId });
    if (!dryRunRecheck.passed) {
      return blocked(stateFromChecks(dryRunRecheck.checks), codeFromChecks(dryRunRecheck.checks), "Fresh revalidation blocked confirmation.");
    }

    const sessionNonce = context.session && context.session.sessionNonce;
    if (!sessionNonce) return blocked("session-invalid", "SESSION_INVALID", "Session validation failed.");

    const existingKey = normalizeKey(input.idempotencyKey);
    if (existingKey && idempotency.has(existingKey)) {
      const existing = confirmations.get(idempotency.get(existingKey));
      if (existing && new Date(existing.expiresAt).getTime() > now.getTime()) return publicChallenge(existing, null);
    }

    const confirmationRequestId = `confirm-${randomId(16)}`;
    const confirmationAccessToken = `confirm-access-${randomId(CONFIRMATION_TOKEN_BYTES)}`;
    const expiresAt = new Date(Math.min(
      now.getTime() + ttlMs,
      new Date(dryRun.expiresAt).getTime()
    )).toISOString();
    const challengeCode = randomId(2).toUpperCase();
    const requiredPhrase = `CONFIRM PORT ${Number(dryRunLookup.originalRequest.expected.port)} ${challengeCode}`;
    const entry = {
      confirmationRequestId,
      dryRunRequestId: dryRun.requestId,
      processInstanceId: dryRun.processInstanceId,
      listenerId: dryRun.listenerId,
      validationFingerprint: dryRun.validationFingerprint,
      originalRequest: dryRunLookup.originalRequest,
      tokenHash: tokenHash(confirmationAccessToken),
      sessionNonce,
      createdAt: now.toISOString(),
      expiresAt,
      state: "awaiting-confirmation",
      challengeId: `challenge-${challengeCode.toLowerCase()}`,
      requiredPhrase,
      idempotencyKeyHash: existingKey ? tokenHash(existingKey) : null,
      acceptedIdempotencyKeyHash: null,
      policy,
      display: buildDisplay(current, dryRunLookup.originalRequest, policy)
    };
    confirmations.set(confirmationRequestId, entry);
    if (existingKey) idempotency.set(existingKey, confirmationRequestId);
    return publicChallenge(entry, confirmationAccessToken);
  }

  async function submitConfirmation(input = {}, context = {}) {
    const now = clock();
    prune(now);
    const credential = validateConfirmationCredential(input, context, now, { allowAccepted: true, idempotencyKey: input.idempotencyKey });
    if (!credential.ok) return genericConfirmationUnavailable();
    const entry = credential.entry;

    if (entry.state === "confirmation-accepted") return acceptedResponse(entry);
    if (entry.state === "cancelled") return terminalResponse(entry);
    if (new Date(entry.expiresAt).getTime() <= now.getTime()) return expire(entry, "confirmation-expired", "CONFIRMATION_EXPIRED");
    if (normalizePhrase(input.typedPhrase) !== entry.requiredPhrase) {
      entry.state = "confirmation-input-invalid";
      return {
        ok: false,
        state: "confirmation-input-invalid",
        code: "CONFIRMATION_INPUT_INVALID",
        message: "Confirmation phrase did not match.",
        actionExecuted: false,
        executionAuthorized: false
      };
    }

    const dryRunLookup = getDryRunForConfirmation({
      dryRunRequestId: entry.dryRunRequestId,
      statusAccessToken: input.statusAccessToken || context.statusAccessToken,
      processInstanceId: entry.processInstanceId
    }, now);
    if (!dryRunLookup.ok || !isDryRunConfirmationEligible(dryRunLookup.dryRun, now)) {
      return setTerminal(entry, "dry-run-expired", "DRY_RUN_EXPIRED", "Dry-run result expired or is no longer confirmation-eligible.");
    }

    let snapshot;
    try {
      snapshot = await scanProvider();
    } catch (error) {
      return setTerminal(entry, "not-available", "SCANNER_UNAVAILABLE", safeErrorMessage("confirmation-scanner", error, {
        code: "SCANNER_UNAVAILABLE",
        category: "scanner",
        message: "Scanner revalidation was unavailable. Confirmation was not recorded."
      }));
    }

    const current = findCurrentRecord(entry.originalRequest, snapshot);
    const dryRunRecheck = evaluateDryRunFromSnapshot(entry.originalRequest, snapshot, { now, ttlMs, randomId });
    if (!dryRunRecheck.passed) {
      return setTerminal(entry, stateFromChecks(dryRunRecheck.checks), codeFromChecks(dryRunRecheck.checks), "Fresh revalidation blocked confirmation.");
    }

    const policy = evaluateConfirmationPolicy(current, { watchdogPrivilege });
    if (!policy.ownerPassed) return setTerminal(entry, "owner-blocked", "OWNER_BLOCKED", policy.ownerMessage);
    if (!policy.elevationPassed) return setTerminal(entry, "elevation-blocked", "ELEVATION_BLOCKED", policy.elevationMessage);

    try {
      auditWriter(buildAuditInput(entry, current, context.session, policy, now, true, "confirmation-accepted"));
    } catch (error) {
      return setTerminal(entry, "audit-unavailable", "AUDIT_UNAVAILABLE", safeErrorMessage("confirmation-audit", error, {
        code: "AUDIT_UNAVAILABLE",
        category: "audit",
        message: "Confirmation audit record could not be written. Confirmation was not recorded."
      }));
    }

    entry.state = "confirmation-accepted";
    entry.acceptedAt = now.toISOString();
    entry.consumedAt = now.toISOString();
    entry.acceptedIdempotencyKeyHash = normalizeKey(input.idempotencyKey) ? tokenHash(normalizeKey(input.idempotencyKey)) : null;
    entry.tokenHash = null;
    entry.policy = policy;
    return acceptedResponse(entry);
  }

  function getConfirmationStatus(input = {}, context = {}) {
    const now = clock();
    prune(now);
    const credential = validateConfirmationCredential(input, context, now, { allowAccepted: true });
    if (!credential.ok) return genericConfirmationUnavailable();
    if (new Date(credential.entry.expiresAt).getTime() <= now.getTime()) return expire(credential.entry, "confirmation-expired", "CONFIRMATION_EXPIRED");
    return publicStatus(credential.entry);
  }

  function cancelConfirmation(input = {}, context = {}) {
    const now = clock();
    prune(now);
    const credential = validateConfirmationCredential(input, context, now, { allowAccepted: false });
    if (!credential.ok) return genericConfirmationUnavailable();
    credential.entry.state = "cancelled";
    credential.entry.tokenHash = null;
    return terminalResponse(credential.entry);
  }

  function getDryRunForConfirmation(input, now) {
    if (!dryRunManager || typeof dryRunManager.getDryRunForConfirmation !== "function") {
      return {
        ok: false,
        code: "DRY_RUN_LOOKUP_UNAVAILABLE",
        message: "Dry-run lookup is unavailable."
      };
    }
    return dryRunManager.getDryRunForConfirmation(input.dryRunRequestId || input.requestId, {
      statusAccessToken: input.statusAccessToken,
      processInstanceId: input.processInstanceId,
      now
    });
  }

  function validateConfirmationCredential(input, context, now, options = {}) {
    if (!safeConfirmationId(input.confirmationRequestId)) return { ok: false };
    const entry = confirmations.get(input.confirmationRequestId);
    if (!entry) return { ok: false };
    if (context.session && context.session.sessionNonce !== entry.sessionNonce) return { ok: false };
    if (entry.state === "confirmation-accepted" && options.allowAccepted) {
      const key = normalizeKey(options.idempotencyKey);
      const keyHash = key ? tokenHash(key) : null;
      if (keyHash && keyHash === entry.acceptedIdempotencyKeyHash) return { ok: true, entry };
      return { ok: false };
    }
    if (!entry.tokenHash || !safeConfirmationToken(context.confirmationAccessToken || input.confirmationAccessToken)) return { ok: false };
    if (!timingSafeTokenEqual(context.confirmationAccessToken || input.confirmationAccessToken, entry.tokenHash)) return { ok: false };
    if (new Date(entry.expiresAt).getTime() <= now.getTime()) return { ok: false };
    return { ok: true, entry };
  }

  function prune(now) {
    const cutoff = now.getTime();
    for (const [id, entry] of confirmations) {
      if (new Date(entry.expiresAt).getTime() + 5000 <= cutoff) confirmations.delete(id);
    }
    for (const [key, id] of idempotency) {
      if (!confirmations.has(id)) idempotency.delete(key);
    }
  }

  function getConfirmationEntryInternal(confirmationRequestId) {
    return confirmations.get(confirmationRequestId) || null;
  }

  return {
    cancelConfirmation,
    createConfirmation,
    getConfirmationStatus,
    submitConfirmation,
    getConfirmationEntryInternal
  };
}

function isDryRunConfirmationEligible(dryRun, now) {
  if (!dryRun || dryRun.passed !== true || dryRun.eligibilityState !== "confirmation-eligible") return false;
  if (new Date(dryRun.expiresAt).getTime() <= now.getTime()) return false;
  if ((dryRun.blockers || []).length > 0) return false;
  return !(dryRun.checks || []).some((item) => item.mandatory !== false && item.status !== "pass");
}

function findCurrentRecord(request, snapshot) {
  const servers = snapshot && Array.isArray(snapshot.servers) ? snapshot.servers : [];
  return servers.find((record) => record.processInstanceId === request.processInstanceId && record.listenerId === request.listenerId) || null;
}



function buildDisplay(record, request, policy) {
  const expected = request.expected || {};
  const project = record && record.project || {};
  return {
    serverTitle: safeText((record && record.httpProbe && record.httpProbe.title) || project.name || expected.processName || `Port ${expected.port}`),
    port: Number(expected.port),
    host: safeText(expected.host),
    processName: safeText(expected.processName),
    category: safeText(expected.category),
    confidenceLevel: safeText(expected.confidenceLevel),
    projectDisplayName: safeText(project.name || expected.projectName),
    ownerSessionPolicy: policy.ownerSession,
    elevationPolicy: policy.elevation,
    statement: "Recording confirmation will not stop, restart, kill, clean up, or signal any process."
  };
}

function publicChallenge(entry, token) {
  return {
    ok: true,
    confirmationRequestId: entry.confirmationRequestId,
    dryRunRequestId: entry.dryRunRequestId,
    state: entry.state,
    expiresAt: entry.expiresAt,
    confirmationAccessToken: token || undefined,
    displayChallenge: {
      challengeId: entry.challengeId,
      requiredPhrase: entry.requiredPhrase,
      normalization: "trim-only-case-sensitive"
    },
    review: entry.display,
    authorization: {
      authorizesStatusRead: false,
      authorizesConfirmation: true,
      authorizesExecution: false
    },
    actionExecuted: false,
    executionAuthorized: false
  };
}

function publicStatus(entry) {
  return {
    ok: true,
    confirmationRequestId: entry.confirmationRequestId,
    dryRunRequestId: entry.dryRunRequestId,
    state: entry.state,
    expiresAt: entry.expiresAt,
    acceptedAt: entry.acceptedAt || null,
    review: entry.display,
    authorization: {
      authorizesStatusRead: false,
      authorizesConfirmation: entry.state === "awaiting-confirmation",
      authorizesExecution: false
    },
    actionExecuted: false,
    executionAuthorized: false
  };
}

function acceptedResponse(entry) {
  return {
    ok: true,
    confirmationRequestId: entry.confirmationRequestId,
    dryRunRequestId: entry.dryRunRequestId,
    state: "confirmation-accepted",
    acceptedAt: entry.acceptedAt,
    message: "Confirmation recorded. No process action was executed.",
    authorization: {
      authorizesStatusRead: false,
      authorizesConfirmation: false,
      authorizesExecution: false
    },
    actionExecuted: false,
    executionAuthorized: false
  };
}

function terminalResponse(entry) {
  return {
    ok: entry.state === "confirmation-accepted",
    confirmationRequestId: entry.confirmationRequestId,
    dryRunRequestId: entry.dryRunRequestId,
    state: entry.state,
    actionExecuted: false,
    executionAuthorized: false
  };
}

function setTerminal(entry, state, code, message) {
  entry.state = state;
  entry.tokenHash = null;
  return {
    ok: false,
    confirmationRequestId: entry.confirmationRequestId,
    state,
    code,
    message: safeText(message),
    actionExecuted: false,
    executionAuthorized: false
  };
}

function expire(entry, state, code) {
  return setTerminal(entry, state, code, "Confirmation expired before it could be recorded.");
}

function blocked(state, code, message) {
  return {
    ok: false,
    state,
    code,
    message: safeText(message),
    actionExecuted: false,
    executionAuthorized: false
  };
}

function buildAuditInput(entry, current, session, policy, now, phraseAccepted, finalState) {
  return {
    confirmationRequestId: entry.confirmationRequestId,
    dryRunRequestId: entry.dryRunRequestId,
    timestamp: now.toISOString(),
    redactedIdentity: {
      processInstanceId: entry.processInstanceId,
      listenerId: entry.listenerId,
      port: entry.originalRequest.expected && entry.originalRequest.expected.port,
      bindHostClass: hostClass(entry.originalRequest.expected && entry.originalRequest.expected.host),
      processName: current && current.processName,
      category: current && current.category,
      confidenceLevel: current && current.confidenceLevel,
      projectDisplayName: current && current.project && current.project.name
    },
    sessionValidation: session && session.validation || {},
    csrf: session && session.validation && session.validation.csrf || "passed",
    ownerSession: policy.ownerSession,
    elevation: policy.elevation,
    phrase: {
      challengeId: entry.challengeId,
      accepted: phraseAccepted
    },
    finalState,
    expiresAt: entry.expiresAt
  };
}

function stateFromChecks(checks = []) {
  const isBlocked = (code) => checks.some((item) => item.code === code && item.status === "blocked");
  if (
    isBlocked("CREATION_TIME_MATCH") ||
    isBlocked("PID_MATCH") ||
    isBlocked("STABLE_IDENTITY") ||
    isBlocked("LISTENER_ID_MATCH") ||
    isBlocked("LISTENER_PORT_OWNERSHIP") ||
    isBlocked("HOST_BIND_MATCH") ||
    isBlocked("PROCESS_NAME_MATCH") ||
    isBlocked("PROTECTED_TREE_BOUNDARY") ||
    isBlocked("PROJECT_NAME_MATCH") ||
    isBlocked("PROJECT_ROOT_MATCH") ||
    isBlocked("PROJECT_SOURCE_MATCH") ||
    isBlocked("CONFLICTING_NEWER_SCAN")
  ) {
    return "identity-changed";
  }
  if (isBlocked("OWNER_POLICY")) return "owner-blocked";
  if (isBlocked("ELEVATION_POLICY")) return "elevation-blocked";
  if (checks.some((item) => String(item.code).startsWith("PROTECTED_") && item.status === "blocked")) return "owner-blocked";
  return "not-available";
}

function codeFromChecks(checks = []) {
  const blocker = checks.find((item) => item.status === "blocked");
  return blocker ? blocker.code : "CONFIRMATION_REVALIDATION_BLOCKED";
}

function hostClass(host) {
  if (host === "0.0.0.0" || host === "::") return "all-interfaces";
  if (host === "127.0.0.1" || host === "::1" || host === "localhost") return "loopback";
  return "other-local";
}

function normalizePhrase(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeKey(value) {
  if (!value || typeof value !== "string") return null;
  return redactSensitiveText(value).replace(/[^a-z0-9_.:-]/gi, "").slice(0, 120) || null;
}

function safeConfirmationId(value) {
  return typeof value === "string" && /^confirm-[a-f0-9]{32}$/i.test(value);
}

function safeConfirmationToken(value) {
  return typeof value === "string" && /^confirm-access-[a-f0-9]{64}$/i.test(value);
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function timingSafeTokenEqual(token, expectedHash) {
  if (!safeConfirmationToken(token) || typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/i.test(expectedHash)) return false;
  const actual = Buffer.from(tokenHash(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function genericConfirmationUnavailable() {
  return { ...GENERIC_CONFIRMATION_UNAVAILABLE };
}

function safeText(value) {
  return redactSensitiveText(String(value == null ? "" : value)).replace(/[<>]/g, "").slice(0, 500);
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

module.exports = {
  DEFAULT_CONFIRMATION_TTL_MS,
  createConfirmationManager,
  evaluateConfirmationPolicy
};
