"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildValidationFingerprint } = require("../src/actions/eligibility");
const { buildExecutionAuditRecord, pruneExecutionAudit, readExecutionAuditRecords } = require("../src/actions/audit");
const { createConfirmationManager } = require("../src/actions/confirmation");
const { createDryRunManager } = require("../src/actions/dry-run");
const { createExecutionManager } = require("../src/actions/execution");
const { createSessionManager } = require("../src/security/session");

const NOW = new Date("2026-06-18T12:00:00.000Z");

test("execution simulator performs planned final checks and returns actionExecuted:false and executionAuthorized:false", async () => {
  const record = devRecord();
  const auditRecords = [];
  const { dryRun, confirmation, execution, session } = await readyManagers(record, {
    executionAuditWriter: (input) => auditRecords.push(buildExecutionAuditRecord(input))
  });

  const created = await confirmation.createConfirmation({
    dryRunRequestId: dryRun.requestId,
    statusAccessToken: dryRun.statusAccessToken,
    processInstanceId: record.processInstanceId,
    listenerId: record.listenerId,
    validationFingerprint: dryRun.validationFingerprint,
    idempotencyKey: "create-one"
  }, { session });

  const accepted = await confirmation.submitConfirmation({
    confirmationRequestId: created.confirmationRequestId,
    typedPhrase: created.displayChallenge.requiredPhrase,
    statusAccessToken: dryRun.statusAccessToken,
    idempotencyKey: "submit-one"
  }, {
    session,
    confirmationAccessToken: created.confirmationAccessToken,
    statusAccessToken: dryRun.statusAccessToken
  });

  assert.equal(accepted.state, "confirmation-accepted");

  const result = await execution.executeStop({
    confirmationRequestId: created.confirmationRequestId,
    typedToken: created.displayChallenge.requiredPhrase,
    processInstanceId: record.processInstanceId,
    listenerId: record.listenerId,
    idempotencyKey: "exec-one"
  }, { session });

  assert.equal(result.ok, true);
  assert.equal(result.state, "simulation-completed");
  assert.equal(result.actionExecuted, false);
  assert.equal(result.executionAuthorized, false);

  assert.equal(auditRecords.length, 1);
  assert.equal(auditRecords[0].finalState, "simulation-completed");
  assert.equal(auditRecords[0].actionExecuted, false);
  assert.equal(auditRecords[0].executionAuthorized, false);
});

test("different user/session policy blocks execution", async () => {
  const original = devRecord();
  const differentUserRecord = devRecord({
    confirmationSafety: safety({ ownerMatch: "different-user" })
  });

  const { dryRun, confirmation, execution, session } = await readyManagers(original, {
    executionScanProvider: async () => ({ servers: [differentUserRecord] })
  });

  const created = await confirmation.createConfirmation({
    dryRunRequestId: dryRun.requestId,
    statusAccessToken: dryRun.statusAccessToken,
    processInstanceId: original.processInstanceId,
    listenerId: original.listenerId
  }, { session });

  // Note: we bypass the confirmation check so we can submit it (or submit it with original record first)
  const accepted = await confirmation.submitConfirmation({
    confirmationRequestId: created.confirmationRequestId,
    typedPhrase: created.displayChallenge.requiredPhrase,
    statusAccessToken: dryRun.statusAccessToken,
    idempotencyKey: "submit-diff-user"
  }, {
    session,
    confirmationAccessToken: created.confirmationAccessToken,
    statusAccessToken: dryRun.statusAccessToken
  });

  assert.equal(accepted.state, "confirmation-accepted");

  // Revalidation in execution should fail due to OWNER_BLOCKED because of differentUserRecord in scan provider
  const result = await execution.executeStop({
    confirmationRequestId: created.confirmationRequestId,
    typedToken: created.displayChallenge.requiredPhrase,
    processInstanceId: original.processInstanceId,
    listenerId: original.listenerId,
    idempotencyKey: "exec-diff-user"
  }, { session });

  assert.equal(result.ok, false);
  assert.equal(result.code, "OWNER_BLOCKED");
  assert.equal(result.actionExecuted, false);
});

test("SYSTEM ownership blocks execution", async () => {
  const original = devRecord();
  const systemRecord = devRecord({
    confirmationSafety: safety({ accountType: "system", systemOwned: true })
  });

  const { dryRun, confirmation, execution, session } = await readyManagers(original, {
    executionScanProvider: async () => ({ servers: [systemRecord] })
  });

  const created = await confirmation.createConfirmation({
    dryRunRequestId: dryRun.requestId,
    statusAccessToken: dryRun.statusAccessToken,
    processInstanceId: original.processInstanceId,
    listenerId: original.listenerId
  }, { session });

  const accepted = await confirmation.submitConfirmation({
    confirmationRequestId: created.confirmationRequestId,
    typedPhrase: created.displayChallenge.requiredPhrase,
    statusAccessToken: dryRun.statusAccessToken,
    idempotencyKey: "submit-system"
  }, {
    session,
    confirmationAccessToken: created.confirmationAccessToken,
    statusAccessToken: dryRun.statusAccessToken
  });

  assert.equal(accepted.state, "confirmation-accepted");

  const result = await execution.executeStop({
    confirmationRequestId: created.confirmationRequestId,
    typedToken: created.displayChallenge.requiredPhrase,
    processInstanceId: original.processInstanceId,
    listenerId: original.listenerId,
    idempotencyKey: "exec-system"
  }, { session });

  assert.equal(result.ok, false);
  assert.equal(result.code, "OWNER_BLOCKED");
});

test("elevation mismatch blocks execution", async () => {
  const original = devRecord();
  const elevatedRecord = devRecord({
    confirmationSafety: safety({ targetElevated: true, elevationMatch: "elevation-mismatch" })
  });

  const { dryRun, confirmation, execution, session } = await readyManagers(original, {
    executionScanProvider: async () => ({ servers: [elevatedRecord] })
  });

  const created = await confirmation.createConfirmation({
    dryRunRequestId: dryRun.requestId,
    statusAccessToken: dryRun.statusAccessToken,
    processInstanceId: original.processInstanceId,
    listenerId: original.listenerId
  }, { session });

  const accepted = await confirmation.submitConfirmation({
    confirmationRequestId: created.confirmationRequestId,
    typedPhrase: created.displayChallenge.requiredPhrase,
    statusAccessToken: dryRun.statusAccessToken,
    idempotencyKey: "submit-elevated"
  }, {
    session,
    confirmationAccessToken: created.confirmationAccessToken,
    statusAccessToken: dryRun.statusAccessToken
  });

  assert.equal(accepted.state, "confirmation-accepted");

  const result = await execution.executeStop({
    confirmationRequestId: created.confirmationRequestId,
    typedToken: created.displayChallenge.requiredPhrase,
    processInstanceId: original.processInstanceId,
    listenerId: original.listenerId,
    idempotencyKey: "exec-elevated"
  }, { session });

  assert.equal(result.ok, false);
  assert.equal(result.code, "ELEVATION_BLOCKED");
});

test("missing metadata blocks execution", async () => {
  const original = devRecord();
  const missingMetaRecord = devRecord({
    confirmationSafety: safety({ ownerAvailable: false })
  });

  const { dryRun, confirmation, execution, session } = await readyManagers(original, {
    executionScanProvider: async () => ({ servers: [missingMetaRecord] })
  });

  const created = await confirmation.createConfirmation({
    dryRunRequestId: dryRun.requestId,
    statusAccessToken: dryRun.statusAccessToken,
    processInstanceId: original.processInstanceId,
    listenerId: original.listenerId
  }, { session });

  const accepted = await confirmation.submitConfirmation({
    confirmationRequestId: created.confirmationRequestId,
    typedPhrase: created.displayChallenge.requiredPhrase,
    statusAccessToken: dryRun.statusAccessToken,
    idempotencyKey: "submit-missing-meta"
  }, {
    session,
    confirmationAccessToken: created.confirmationAccessToken,
    statusAccessToken: dryRun.statusAccessToken
  });

  assert.equal(accepted.state, "confirmation-accepted");

  const result = await execution.executeStop({
    confirmationRequestId: created.confirmationRequestId,
    typedToken: created.displayChallenge.requiredPhrase,
    processInstanceId: original.processInstanceId,
    listenerId: original.listenerId,
    idempotencyKey: "exec-missing-meta"
  }, { session });

  assert.equal(result.ok, false);
  assert.equal(result.code, "OWNER_BLOCKED");
});

test("PID reuse blocks execution", async () => {
  const original = devRecord();
  const recycledRecord = devRecord({
    createdAt: "2026-06-18T11:05:00.000Z",
    processInstanceId: "pid-4242-created-2026-06-18t11-05-00-000z"
  });

  const { dryRun, confirmation, execution, session } = await readyManagers(original, {
    executionScanProvider: async () => ({ servers: [recycledRecord] })
  });

  const created = await confirmation.createConfirmation({
    dryRunRequestId: dryRun.requestId,
    statusAccessToken: dryRun.statusAccessToken,
    processInstanceId: original.processInstanceId,
    listenerId: original.listenerId
  }, { session });

  const accepted = await confirmation.submitConfirmation({
    confirmationRequestId: created.confirmationRequestId,
    typedPhrase: created.displayChallenge.requiredPhrase,
    statusAccessToken: dryRun.statusAccessToken,
    idempotencyKey: "submit-pid-reuse"
  }, {
    session,
    confirmationAccessToken: created.confirmationAccessToken,
    statusAccessToken: dryRun.statusAccessToken
  });

  assert.equal(accepted.state, "confirmation-accepted");

  const result = await execution.executeStop({
    confirmationRequestId: created.confirmationRequestId,
    typedToken: created.displayChallenge.requiredPhrase,
    processInstanceId: original.processInstanceId,
    listenerId: original.listenerId,
    idempotencyKey: "exec-pid-reuse"
  }, { session });

  assert.equal(result.ok, false);
  assert.equal(result.code, "CREATION_TIME_MISMATCH");
});

test("listener reassignment blocks execution", async () => {
  const original = devRecord();
  const reassignedRecord = devRecord({
    port: 9000,
    listenerId: "pid-4242-created-2026-06-18t11-00-00-000z-listener-tcp-127-0-0-1-9000"
  });

  const { dryRun, confirmation, execution, session } = await readyManagers(original, {
    executionScanProvider: async () => ({ servers: [reassignedRecord] })
  });

  const created = await confirmation.createConfirmation({
    dryRunRequestId: dryRun.requestId,
    statusAccessToken: dryRun.statusAccessToken,
    processInstanceId: original.processInstanceId,
    listenerId: original.listenerId
  }, { session });

  const accepted = await confirmation.submitConfirmation({
    confirmationRequestId: created.confirmationRequestId,
    typedPhrase: created.displayChallenge.requiredPhrase,
    statusAccessToken: dryRun.statusAccessToken,
    idempotencyKey: "submit-reassign"
  }, {
    session,
    confirmationAccessToken: created.confirmationAccessToken,
    statusAccessToken: dryRun.statusAccessToken
  });

  assert.equal(accepted.state, "confirmation-accepted");

  const result = await execution.executeStop({
    confirmationRequestId: created.confirmationRequestId,
    typedToken: created.displayChallenge.requiredPhrase,
    processInstanceId: original.processInstanceId,
    listenerId: original.listenerId,
    idempotencyKey: "exec-reassign"
  }, { session });

  assert.equal(result.ok, false);
  assert.equal(result.code, "PORT_OWNER_CHANGED");
});

test("process exit during revalidation blocks execution", async () => {
  const original = devRecord();

  const { dryRun, confirmation, execution, session } = await readyManagers(original, {
    executionScanProvider: async () => ({ servers: [] }) // Empty snapshot mimics exited process
  });

  const created = await confirmation.createConfirmation({
    dryRunRequestId: dryRun.requestId,
    statusAccessToken: dryRun.statusAccessToken,
    processInstanceId: original.processInstanceId,
    listenerId: original.listenerId
  }, { session });

  const accepted = await confirmation.submitConfirmation({
    confirmationRequestId: created.confirmationRequestId,
    typedPhrase: created.displayChallenge.requiredPhrase,
    statusAccessToken: dryRun.statusAccessToken,
    idempotencyKey: "submit-exit"
  }, {
    session,
    confirmationAccessToken: created.confirmationAccessToken,
    statusAccessToken: dryRun.statusAccessToken
  });

  assert.equal(accepted.state, "confirmation-accepted");

  const result = await execution.executeStop({
    confirmationRequestId: created.confirmationRequestId,
    typedToken: created.displayChallenge.requiredPhrase,
    processInstanceId: original.processInstanceId,
    listenerId: original.listenerId,
    idempotencyKey: "exec-exit"
  }, { session });

  assert.equal(result.ok, false);
  assert.equal(result.code, "ALREADY_EXITED");
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

  const confirmation = createConfirmationManager({
    dryRunManager: dryRun,
    scanProvider: overrides.confirmationScanProvider || (async () => ({ servers: [record] })),
    auditWriter: overrides.confirmationAuditWriter || (() => {}),
    clock: () => NOW,
    watchdogPrivilege: {
      available: true,
      elevated: false,
      integrityAvailable: true
    }
  });

  const execution = createExecutionManager({
    confirmationManager: confirmation,
    scanProvider: overrides.executionScanProvider || (async () => ({ servers: [record] })),
    auditWriter: overrides.executionAuditWriter || (() => {}),
    clock: () => NOW,
    watchdogPrivilege: {
      available: true,
      elevated: false,
      integrityAvailable: true
    }
  });

  return {
    dryRun: dryRunResult,
    session,
    confirmation,
    execution
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
    }
  };
}
