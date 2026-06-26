"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createDryRunManager, evaluateDryRunFromSnapshot, validateDryRunRequest } = require("../src/actions/dry-run");
const { buildDryRunAuditRecord } = require("../src/actions/audit");
const { buildValidationFingerprint } = require("../src/actions/eligibility");
const { REQUIRED_EXPECTED_FIELDS } = require("../src/actions/required-fields");

const NOW = new Date("2026-06-17T12:00:00.000Z");

test("dry-run passes for a stable high-confidence owned dev server without executing action", async () => {
  const record = devRecord();
  const manager = createDryRunManager({
    clock: () => NOW,
    scanProvider: async () => ({ servers: [record] }),
    auditWriter: () => {}
  });

  const result = await manager.requestDryRun(requestFor(record));

  assert.equal(result.passed, true);
  assert.equal(result.eligibilityState, "confirmation-eligible");
  assert.equal(result.actionExecuted, false);
  assert.match(result.requestId, /^dryrun-/);
  assert.match(result.statusAccessToken, /^dryrun-status-/);
  assert.equal(result.statusAccess.authorizesStatusRead, true);
  assert.equal(result.statusAccess.authorizesConfirmation, false);
  assert.equal(result.statusAccess.authorizesExecution, false);
  assert.equal(result.dryRunToken, undefined);
  assert.equal(result.blockers.length, 0);
  assert.equal(result.safeToStop, undefined);
});

test("PID reuse with different creation time blocks dry-run revalidation", () => {
  const previous = devRecord();
  const reusedPid = devRecord({
    createdAt: "2026-06-17T12:05:00.000Z",
    processInstanceId: "pid-4242-created-2026-06-17t12-05-00-000z",
    listenerId: "pid-4242-created-2026-06-17t12-05-00-000z-listener-tcp-127-0-0-1-5173"
  });

  const result = evaluateDryRunFromSnapshot(requestFor(previous), { servers: [reusedPid] }, { now: NOW });

  assert.equal(result.passed, false);
  assert.equal(hasBlocker(result, "CREATION_TIME_MATCH"), true);
  assert.equal(result.actionExecuted, false);
});

test("same process with multiple ports requires the requested listener identity", () => {
  const requested = devRecord({ port: 5173 });
  const otherPort = devRecord({
    port: 3000,
    listenerId: `${requested.processInstanceId}-listener-tcp-127-0-0-1-3000`
  });

  const result = evaluateDryRunFromSnapshot(requestFor(requested), { servers: [otherPort] }, { now: NOW });

  assert.equal(result.passed, false);
  assert.equal(hasBlocker(result, "PID_EXISTS"), true);
});

test("missing or unstable creation-time identity is rejected before scanner revalidation", async () => {
  const invalid = validateDryRunRequest({
    processInstanceId: "session-unstable-2026-pid-1-listener-tcp-127-0-0-1-3000",
    listenerId: "session-unstable-2026-pid-1-listener-tcp-127-0-0-1-3000"
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "UNSTABLE_IDENTITY");

  const manager = createDryRunManager({
    clock: () => NOW,
    scanProvider: async () => ({ servers: [] }),
    auditWriter: () => {}
  });
  const result = await manager.requestDryRun({ processInstanceId: null, listenerId: "listener" });
  assert.equal(result.passed, false);
  assert.equal(hasBlocker(result, "PROCESS_INSTANCE_ID_REQUIRED"), true);
  assert.equal(result.actionExecuted, false);
});

test("absolute block categories and protected boundaries block dry-run", () => {
  for (const category of ["system-or-protected", "database", "local-ai-server", "unknown-listener"]) {
    const record = devRecord({ category });
    const result = evaluateDryRunFromSnapshot(requestFor(record), { servers: [record] }, { now: NOW });
    assert.equal(result.passed, false, category);
    assert.equal(hasBlocker(result, "CATEGORY_BLOCKED"), true, category);
  }

  const protectedTree = devRecord({
    processTree: {
      stopReason: "protected-boundary",
      truncated: false,
      chain: [{ category: "system-or-protected", processName: "services.exe" }]
    }
  });
  const result = evaluateDryRunFromSnapshot(requestFor(protectedTree), { servers: [protectedTree] }, { now: NOW });
  assert.equal(hasBlocker(result, "PROTECTED_TREE_BOUNDARY"), true);
});

test("project, category, host, process name, and fingerprint changes block dry-run", () => {
  const requested = devRecord();
  const changed = devRecord({
    processName: "python.exe",
    host: "0.0.0.0",
    category: "python-dev-server",
    confidenceLevel: "medium",
    project: {
      name: "other-project",
      root: "%USERPROFILE%\\code\\other-project",
      source: "marker:pyproject.toml",
      confidence: 90
    }
  });
  const result = evaluateDryRunFromSnapshot(requestFor(requested), { servers: [changed] }, { now: NOW });

  assert.equal(result.passed, false);
  assert.equal(hasBlocker(result, "PROCESS_NAME_MATCH"), true);
  assert.equal(hasBlocker(result, "HOST_BIND_MATCH"), true);
  assert.equal(hasBlocker(result, "HIGH_CONFIDENCE"), true);
  assert.equal(hasBlocker(result, "PROJECT_NAME_MATCH"), true);
  assert.equal(hasBlocker(result, "CONFLICTING_NEWER_SCAN"), true);
});

test("required expected-field matrix fails closed for missing, empty, malformed, and wrong typed values", () => {
  const record = devRecord();
  for (const field of REQUIRED_EXPECTED_FIELDS) {
    for (const value of invalidValuesFor(field.type)) {
      const request = requestFor(record);
      setPathValue(request, field.path, value);
      const result = evaluateDryRunFromSnapshot(request, { servers: [record] }, { now: NOW });

      assert.equal(result.passed, false, `${field.path}=${String(value)}`);
      assert.equal(result.eligibilityState, "blocked", field.path);
      assert.equal(hasBlocker(result, field.code), true, field.path);
      assert.equal(result.actionExecuted, false);
    }
  }
});

test("truncated process tree and stale-candidate lifecycle cannot become confirmation-eligible", () => {
  const truncated = devRecord({
    processTree: {
      truncated: true,
      stopReason: "max-depth",
      chain: [{ category: "node-runtime", processName: "node.exe" }]
    }
  });
  const stale = devRecord({
    lifecycleContext: {
      label: "stale-candidate"
    }
  });

  const truncatedResult = evaluateDryRunFromSnapshot(requestFor(truncated), { servers: [truncated] }, { now: NOW });
  const staleResult = evaluateDryRunFromSnapshot(requestFor(stale), { servers: [stale] }, { now: NOW });

  assert.equal(truncatedResult.passed, false);
  assert.equal(hasBlocker(truncatedResult, "PROCESS_TREE_NOT_TRUNCATED"), true);
  assert.equal(staleResult.passed, false);
  assert.equal(hasBlocker(staleResult, "LIFECYCLE_NOT_STALE"), true);
});

test("scanner unavailable and audit write failure fail closed without executing action", async () => {
  const record = devRecord();
  const scannerFail = createDryRunManager({
    clock: () => NOW,
    scanProvider: async () => {
      throw new Error("C:\\Users\\johnp\\secret --token raw");
    },
    auditWriter: () => {}
  });
  const scannerResult = await scannerFail.requestDryRun(requestFor(record));
  assert.equal(scannerResult.passed, false);
  assert.equal(hasBlocker(scannerResult, "SCANNER_UNAVAILABLE"), true);
  assert.equal(JSON.stringify(scannerResult).includes("raw"), false);
  assert.equal(scannerResult.actionExecuted, false);

  const auditFail = createDryRunManager({
    clock: () => NOW,
    scanProvider: async () => ({ servers: [record] }),
    auditWriter: () => {
      throw new Error("C:\\Users\\johnp\\private\\audit.jsonl");
    }
  });
  const auditResult = await auditFail.requestDryRun(requestFor(record));
  assert.equal(auditResult.passed, false);
  assert.equal(hasBlocker(auditResult, "AUDIT_LOG_UNAVAILABLE"), true);
  assert.equal(JSON.stringify(auditResult).includes("C:\\Users\\johnp"), false);
  assert.equal(auditResult.actionExecuted, false);
});

test("dry-run audit records and stored status never expose raw status tokens", async () => {
  const record = devRecord();
  const auditRecords = [];
  const manager = createDryRunManager({
    ttlMs: 1000,
    clock: () => NOW,
    scanProvider: async () => ({ servers: [record] }),
    auditWriter: (result) => auditRecords.push(buildDryRunAuditRecord(result))
  });

  const result = await manager.requestDryRun(requestFor(record));
  const auditText = JSON.stringify(auditRecords);
  assert.match(result.statusAccessToken, /^dryrun-status-/);
  assert.equal(auditText.includes(result.statusAccessToken), false);
  assert.equal(auditText.includes("statusAccessToken"), false);
  assert.equal(auditText.includes("dryRunToken"), false);

  const status = manager.getDryRunStatus(result.requestId, {
    statusAccessToken: result.statusAccessToken,
    processInstanceId: record.processInstanceId,
    now: NOW
  });
  assert.equal(status.status, "available");
  assert.equal(status.statusAccessToken, undefined);
  assert.equal(JSON.stringify(status).includes(result.statusAccessToken), false);
});

test("dry-run status requires a separate status access token, identity binding, expiry, and idempotency", async () => {
  const record = devRecord();
  const manager = createDryRunManager({
    ttlMs: 1000,
    clock: () => NOW,
    scanProvider: async () => ({ servers: [record] }),
    auditWriter: () => {}
  });
  const request = { ...requestFor(record), idempotencyKey: "same-click" };
  const first = await manager.requestDryRun(request);
  const second = await manager.requestDryRun(request);

  assert.equal(first.requestId, second.requestId);
  assert.match(first.statusAccessToken, /^dryrun-status-/);
  assert.equal(second.statusAccessToken, undefined);
  assert.equal(manager.getDryRunStatus(first.requestId, {
    statusAccessToken: first.statusAccessToken,
    processInstanceId: record.processInstanceId,
    now: NOW
  }).status, "available");
  assert.equal(manager.getDryRunStatus(first.requestId, {
    statusAccessToken: "dryrun-status-ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    now: NOW
  }).code, "DRY_RUN_STATUS_UNAVAILABLE");
  assert.equal(manager.getDryRunStatus(first.requestId, {
    now: NOW
  }).code, "DRY_RUN_STATUS_UNAVAILABLE");
  assert.equal(manager.getDryRunStatus("dryrun-ffffffffffffffffffffffffffffffff", {
    statusAccessToken: first.statusAccessToken,
    now: NOW
  }).code, "DRY_RUN_STATUS_UNAVAILABLE");
  assert.equal(manager.getDryRunStatus(first.requestId, {
    statusAccessToken: first.statusAccessToken,
    processInstanceId: "pid-other",
    now: NOW
  }).code, "DRY_RUN_IDENTITY_MISMATCH");
  assert.equal(manager.getDryRunStatus(first.requestId, {
    statusAccessToken: first.statusAccessToken,
    processInstanceId: record.processInstanceId,
    now: new Date("2026-06-17T12:00:02.000Z")
  }).code, "DRY_RUN_STATUS_UNAVAILABLE");
});

function hasBlocker(result, code) {
  return result.blockers.some((item) => item.code === code);
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
    id: "pid-4242-created-2026-06-17t11-00-00-000z-listener-tcp-127-0-0-1-5173",
    processInstanceId: "pid-4242-created-2026-06-17t11-00-00-000z",
    listenerId: "pid-4242-created-2026-06-17t11-00-00-000z-listener-tcp-127-0-0-1-5173",
    identity: {
      status: "stable",
      processInstanceId: "pid-4242-created-2026-06-17t11-00-00-000z"
    },
    pid: 4242,
    port: 5173,
    host: "127.0.0.1",
    protocol: "tcp",
    processName: "node.exe",
    createdAt: "2026-06-17T11:00:00.000Z",
    timingStatus: "available",
    category: "node-dev-server",
    confidenceLevel: "high",
    project: {
      name: "watchdog-app",
      root: "%USERPROFILE%\\code\\watchdog-app",
      source: "marker:package.json",
      confidence: 90
    },
    evidence: [],
    processTree: {
      truncated: false,
      stopReason: "root-reached",
      chain: [{ category: "editor", processName: "Code.exe" }, { category: "node-runtime", processName: "node.exe" }]
    },
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

function invalidValuesFor(type) {
  if (type === "integer") return [undefined, null, "", " ", 0, -1, "not-a-number", 1.5];
  if (type === "port") return [undefined, null, "", 0, 65536, "abc"];
  if (type === "identity") return [undefined, null, "", "session-unstable-1", "Session-Unstable-1", "bad identity"];
  if (type === "iso-date") return [undefined, null, "", "not-a-date"];
  if (type === "sha256") return [undefined, null, "", "abc", "z".repeat(64)];
  return [undefined, null, ""];
}

function setPathValue(target, path, value) {
  const parts = String(path).split(".");
  let current = target;
  while (parts.length > 1) {
    const part = parts.shift();
    current[part] = current[part] || {};
    current = current[part];
  }
  current[parts[0]] = value;
}
