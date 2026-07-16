"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildValidationFingerprint } = require("../src/actions/eligibility");
const { buildConfirmationAuditRecord, pruneConfirmationAudit, readConfirmationAuditRecords } = require("../src/actions/audit");
const { createConfirmationManager, evaluateConfirmationPolicy } = require("../src/actions/confirmation");
const { createDryRunManager } = require("../src/actions/dry-run");
const { createSessionManager } = require("../src/security/session");

const NOW = new Date("2026-06-18T12:00:00.000Z");

test("confirmation records explicit intent only after valid session, CSRF, token, phrase, and revalidation", async () => {
  const record = devRecord();
  const auditRecords = [];
  const { dryRun, confirmation, session } = await readyManagers(record, {
    confirmationAuditWriter: (input) => auditRecords.push(buildConfirmationAuditRecord(input))
  });

  const created = await confirmation.createConfirmation({
    dryRunRequestId: dryRun.requestId,
    statusAccessToken: dryRun.statusAccessToken,
    processInstanceId: record.processInstanceId,
    listenerId: record.listenerId,
    validationFingerprint: dryRun.validationFingerprint,
    idempotencyKey: "create-one"
  }, { session });

  assert.equal(created.state, "awaiting-confirmation");
  assert.match(created.confirmationAccessToken, /^confirm-access-/);
  assert.equal(created.authorization.authorizesConfirmation, true);
  assert.equal(created.authorization.authorizesExecution, false);
  assert.equal(created.actionExecuted, false);
  assert.equal(JSON.stringify(created).includes("statusAccessToken"), false);

  const accepted = await confirmation.submitConfirmation({
    confirmationRequestId: created.confirmationRequestId,
    typedPhrase: `  ${created.displayChallenge.requiredPhrase}  `,
    statusAccessToken: dryRun.statusAccessToken,
    idempotencyKey: "submit-one"
  }, {
    session,
    confirmationAccessToken: created.confirmationAccessToken,
    statusAccessToken: dryRun.statusAccessToken
  });

  assert.equal(accepted.state, "confirmation-accepted");
  assert.equal(accepted.message, "Confirmation recorded. A short-lived execution proof was issued for this exact target.");
  assert.match(accepted.executionAccessToken, /^exec-access-[a-f0-9]{64}$/);
  assert.equal(accepted.executionProof.tokenType, "single-use");
  assert.equal(accepted.actionExecuted, false);
  assert.equal(accepted.executionAuthorized, false);
  assert.equal(accepted.authorization.authorizesExecution, true);
  assert.equal(auditRecords.length, 1);
  const auditText = JSON.stringify(auditRecords);
  assert.equal(auditText.includes(created.confirmationAccessToken), false);
  assert.equal(auditText.includes(created.displayChallenge.requiredPhrase), false);
  assert.equal(auditRecords[0].finalState, "confirmation-accepted");
  assert.equal(auditRecords[0].actionExecuted, false);
  assert.equal(auditRecords[0].executionAuthorized, false);
});

test("confirmation session and CSRF validation fails closed", async () => {
  const manager = createSessionManager({ clock: () => NOW });
  const session = manager.createSession();
  const request = {
    headers: {
      host: "127.0.0.1:4545",
      origin: "http://127.0.0.1:4545",
      "x-csrf-token": session.csrfToken
    }
  };

  assert.equal(manager.validateRequest(request, { sessionNonce: session.sessionNonce }).ok, true);
  assert.equal(manager.validateRequest(request, { sessionNonce: "lw-session-" + "f".repeat(64) }).code, "SESSION_INVALID");
  assert.equal(manager.validateRequest({ headers: { ...request.headers, origin: "null" } }, { sessionNonce: session.sessionNonce }).code, "ORIGIN_BLOCKED");
  assert.equal(manager.validateRequest({ headers: { ...request.headers, origin: "http://example.com" } }, { sessionNonce: session.sessionNonce }).code, "ORIGIN_BLOCKED");
  assert.equal(manager.validateRequest({ headers: { ...request.headers, host: "example.com" } }, { sessionNonce: session.sessionNonce }).code, "HOST_BLOCKED");
  assert.equal(manager.validateRequest({ headers: { ...request.headers, "x-csrf-token": "lw-csrf-" + "f".repeat(64) } }, { sessionNonce: session.sessionNonce }).code, "CSRF_BLOCKED");
  manager.reset();
  assert.equal(manager.validateRequest(request, { sessionNonce: session.sessionNonce }).code, "SESSION_INVALID");
});

test("owner, session, and elevation policy blocks unsafe or unavailable metadata", () => {
  assert.equal(evaluateConfirmationPolicy(devRecord()).ownerPassed, true);
  assert.equal(evaluateConfirmationPolicy(devRecord({ confirmationSafety: safety({ ownerMatch: "different-user" }) })).ownerPassed, false);
  assert.equal(evaluateConfirmationPolicy(devRecord({ confirmationSafety: safety({ sessionMatch: "different-session" }) })).ownerPassed, false);
  assert.equal(evaluateConfirmationPolicy(devRecord({ confirmationSafety: safety({ accountType: "system", systemOwned: true }) })).ownerPassed, false);
  assert.equal(evaluateConfirmationPolicy(devRecord({ confirmationSafety: safety({ accountType: "service", serviceOwned: true }) })).ownerPassed, false);
  assert.equal(evaluateConfirmationPolicy(devRecord({ confirmationSafety: safety({ ownerAvailable: false }) })).ownerPassed, false);
  assert.equal(evaluateConfirmationPolicy(devRecord({ confirmationSafety: safety({ sessionAvailable: false }) })).ownerPassed, false);
  assert.equal(evaluateConfirmationPolicy(devRecord({ confirmationSafety: safety({ targetElevated: true }) })).elevationPassed, false);
  assert.equal(evaluateConfirmationPolicy(devRecord({ confirmationSafety: safety({ elevationAvailable: false }) })).elevationPassed, false);
});

test("confirmation tokens are single-use, status-protected, and replay-safe", async () => {
  const record = devRecord();
  const { dryRun, confirmation, session } = await readyManagers(record);
  const created = await confirmation.createConfirmation({
    dryRunRequestId: dryRun.requestId,
    statusAccessToken: dryRun.statusAccessToken,
    processInstanceId: record.processInstanceId,
    listenerId: record.listenerId,
    idempotencyKey: "create"
  }, { session });

  assert.equal(confirmation.getConfirmationStatus({ confirmationRequestId: created.confirmationRequestId }, { session }).code, "CONFIRMATION_UNAVAILABLE");
  assert.equal(confirmation.getConfirmationStatus({
    confirmationRequestId: created.confirmationRequestId
  }, {
    session,
    confirmationAccessToken: "dryrun-status-" + "a".repeat(64)
  }).code, "CONFIRMATION_UNAVAILABLE");

  const accepted = await confirmation.submitConfirmation({
    confirmationRequestId: created.confirmationRequestId,
    typedPhrase: created.displayChallenge.requiredPhrase,
    statusAccessToken: dryRun.statusAccessToken,
    idempotencyKey: "submit"
  }, {
    session,
    confirmationAccessToken: created.confirmationAccessToken,
    statusAccessToken: dryRun.statusAccessToken
  });
  assert.equal(accepted.state, "confirmation-accepted");

  const duplicate = await confirmation.submitConfirmation({
    confirmationRequestId: created.confirmationRequestId,
    typedPhrase: created.displayChallenge.requiredPhrase,
    statusAccessToken: dryRun.statusAccessToken,
    idempotencyKey: "submit"
  }, {
    session,
    statusAccessToken: dryRun.statusAccessToken
  });
  assert.equal(duplicate.state, "confirmation-accepted");

  const replay = await confirmation.submitConfirmation({
    confirmationRequestId: created.confirmationRequestId,
    typedPhrase: created.displayChallenge.requiredPhrase,
    statusAccessToken: dryRun.statusAccessToken,
    idempotencyKey: "other"
  }, {
    session,
    confirmationAccessToken: created.confirmationAccessToken,
    statusAccessToken: dryRun.statusAccessToken
  });
  assert.equal(replay.code, "CONFIRMATION_UNAVAILABLE");
});

test("fresh confirmation revalidation blocks identity, listener, project, owner, elevation, and fingerprint drift", async () => {
  const scenarios = [
    ["creation-time mismatch", devRecord({ createdAt: "2026-06-18T11:01:00.000Z", processInstanceId: "pid-4242-created-2026-06-18t11-01-00-000z" }), "identity-changed"],
    ["listener reassignment", devRecord({ listenerId: "pid-4242-created-2026-06-18t11-00-00-000z-listener-tcp-127-0-0-1-3000", port: 3000 }), "not-available"],
    ["bind-host change", devRecord({ host: "0.0.0.0" }), "identity-changed"],
    ["process-name change", devRecord({ processName: "python.exe" }), "identity-changed"],
    ["protected-boundary change", devRecord({ processTree: { truncated: false, stopReason: "protected-boundary", chain: [{ category: "system-or-protected", processName: "services.exe" }] } }), "identity-changed"],
    ["project drift", devRecord({ project: { name: "other", root: "%USERPROFILE%\\code\\other", source: "marker:package.json", confidence: 90 } }), "identity-changed"],
    ["owner change", devRecord({ confirmationSafety: safety({ ownerMatch: "different-user" }) }), "owner-blocked"],
    ["elevation change", devRecord({ confirmationSafety: safety({ targetElevated: true }) }), "elevation-blocked"]
  ];

  for (const [name, changedRecord, expectedState] of scenarios) {
    const original = devRecord();
    let current = original;
    const { dryRun, confirmation, session } = await readyManagers(original, {
      confirmationScanProvider: async () => ({ servers: [current] })
    });
    const created = await confirmation.createConfirmation({
      dryRunRequestId: dryRun.requestId,
      statusAccessToken: dryRun.statusAccessToken,
      processInstanceId: original.processInstanceId,
      listenerId: original.listenerId
    }, { session });
    current = changedRecord;
    const result = await confirmation.submitConfirmation({
      confirmationRequestId: created.confirmationRequestId,
      typedPhrase: created.displayChallenge.requiredPhrase,
      statusAccessToken: dryRun.statusAccessToken,
      idempotencyKey: `submit-${name}`
    }, {
      session,
      confirmationAccessToken: created.confirmationAccessToken,
      statusAccessToken: dryRun.statusAccessToken
    });
    assert.equal(result.state, expectedState, name);
    assert.equal(result.actionExecuted, false);
    assert.equal(result.executionAuthorized, false);
  }
});

test("confirmation audit retention prunes old records and recovers interrupted temp writes", () => {
  const { mkdtempSync, writeFileSync, existsSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const dir = mkdtempSync(join(tmpdir(), "lw-confirm-audit-"));
  const filePath = join(dir, "confirmation-audit.jsonl");
  const old = buildConfirmationAuditRecord({ confirmationRequestId: "confirm-old", timestamp: "2026-01-01T00:00:00.000Z" });
  const recent = buildConfirmationAuditRecord({ confirmationRequestId: "confirm-new", timestamp: "2026-06-18T12:00:00.000Z" });
  writeFileSync(filePath, `${JSON.stringify(old)}\n${JSON.stringify(recent)}\nnot-json\n`, "utf8");
  writeFileSync(`${filePath}.tmp`, "partial", "utf8");

  pruneConfirmationAudit(filePath, { maxAgeMs: 60 * 1000, maxRecords: 10 }, NOW);
  const parsed = readConfirmationAuditRecords(filePath);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].confirmationRequestId, "confirm-new");
  assert.equal(existsSync(`${filePath}.tmp`), false);
});

test("audit write failure blocks confirmation acceptance", async () => {
  const record = devRecord();
  const { dryRun, confirmation, session } = await readyManagers(record, {
    confirmationAuditWriter: () => {
      throw new Error("C:\\Users\\johnp\\secret\\audit.jsonl --token raw");
    }
  });
  const created = await confirmation.createConfirmation({
    dryRunRequestId: dryRun.requestId,
    statusAccessToken: dryRun.statusAccessToken,
    processInstanceId: record.processInstanceId,
    listenerId: record.listenerId
  }, { session });
  const result = await confirmation.submitConfirmation({
    confirmationRequestId: created.confirmationRequestId,
    typedPhrase: created.displayChallenge.requiredPhrase,
    statusAccessToken: dryRun.statusAccessToken,
    idempotencyKey: "submit"
  }, {
    session,
    confirmationAccessToken: created.confirmationAccessToken,
    statusAccessToken: dryRun.statusAccessToken
  });
  assert.equal(result.state, "audit-unavailable");
  assert.equal(result.actionExecuted, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(JSON.stringify(result).includes("C:\\Users\\johnp"), false);
  assert.equal(JSON.stringify(result).includes("raw"), false);
});

async function readyManagers(record, overrides = {}) {
  const dryRun = createDryRunManager({
    clock: () => NOW,
    scanProvider: async () => ({ servers: [record] }),
    auditWriter: () => {}
  });
  const dryRunResult = await dryRun.requestDryRun(requestFor(record));
  assert.equal(dryRunResult.passed, true);
  const session = {
    sessionNonce: "lw-session-" + "a".repeat(64),
    validation: {
      host: "passed",
      origin: "passed",
      session: "passed",
      csrf: "passed"
    }
  };
  return {
    dryRun: dryRunResult,
    session,
    confirmation: createConfirmationManager({
      dryRunManager: dryRun,
      scanProvider: overrides.confirmationScanProvider || (async () => ({ servers: [record] })),
      auditWriter: overrides.confirmationAuditWriter || (() => {}),
      clock: () => NOW,
      watchdogPrivilege: {
        available: true,
        elevated: false,
        integrityAvailable: true,
        sid: "S-1-5-21-mock-watchdog-sid",
        sessionId: 1
      }
    })
  };
}

function requestFor(record) {
  return {
    processInstanceId: record.processInstanceId,
    listenerId: record.listenerId,
    expected: {
      pid: record.pid,
      processName: record.processName,
      host: record.host,
      port: record.port,
      createdAt: record.createdAt,
      projectName: record.project && record.project.name,
      projectRoot: record.project && record.project.root,
      projectSource: record.project && record.project.source,
      category: record.category,
      confidenceLevel: record.confidenceLevel,
      validationFingerprint: buildValidationFingerprint(record)
    }
  };
}

function devRecord(overrides = {}) {
  const base = {
    id: "pid-4242-created-2026-06-18t11-00-00-000z-listener-tcp-127-0-0-1-5173",
    processInstanceId: "pid-4242-created-2026-06-18t11-00-00-000z",
    listenerId: "pid-4242-created-2026-06-18t11-00-00-000z-listener-tcp-127-0-0-1-5173",
    identity: { status: "stable" },
    pid: 4242,
    port: 5173,
    host: "127.0.0.1",
    processName: "node.exe",
    createdAt: "2026-06-18T11:00:00.000Z",
    timingStatus: "available",
    category: "node-dev-server",
    confidenceLevel: "high",
    project: {
      name: "watchdog-app",
      root: "%USERPROFILE%\\code\\watchdog-app",
      source: "marker:package.json",
      confidence: 90
    },
    processTree: {
      truncated: false,
      stopReason: "root-reached",
      chain: [{ category: "editor", processName: "Code.exe" }, { category: "node-runtime", processName: "node.exe" }]
    },
    lifecycleContext: { label: "active" },
    confirmationSafety: safety(),
    safeToStop: false,
    safeToRestart: false,
    bulkStoppable: false
  };
  return {
    ...base,
    ...overrides,
    project: overrides.project === undefined ? base.project : overrides.project,
    processTree: overrides.processTree === undefined ? base.processTree : overrides.processTree,
    confirmationSafety: overrides.confirmationSafety === undefined ? base.confirmationSafety : overrides.confirmationSafety
  };
}

function safety(overrides = {}) {
  return {
    owner: {
      available: overrides.ownerAvailable !== false,
      match: overrides.ownerMatch || "same-user",
      accountType: overrides.accountType || "user",
      systemOwned: overrides.systemOwned === true,
      serviceOwned: overrides.serviceOwned === true
    },
    session: {
      available: overrides.sessionAvailable !== false,
      match: overrides.sessionMatch || "same-session"
    },
    elevation: {
      available: overrides.elevationAvailable !== false,
      targetIntegrityAvailable: overrides.targetIntegrityAvailable !== false,
      targetElevated: overrides.targetElevated === true,
      match: overrides.elevationMatch || "same-non-elevated-session"
    },
    watchdog: {
      available: overrides.watchdogAvailable !== false,
      elevated: overrides.watchdogElevated === true,
      integrityAvailable: overrides.watchdogIntegrityAvailable !== false,
      sid: overrides.watchdogSid || "S-1-5-21-mock-watchdog-sid",
      sessionId: overrides.watchdogSessionId ?? 1
    }
  };
}
