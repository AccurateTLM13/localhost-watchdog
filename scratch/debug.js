"use strict";

const { evaluateDryRunFromSnapshot } = require("../src/actions/dry-run");
const { buildValidationFingerprint } = require("../src/actions/eligibility");

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

const original = devRecord();
const changedRecord = devRecord({ confirmationSafety: safety({ ownerMatch: "different-user" }) });

const req = requestFor(original);
const result = evaluateDryRunFromSnapshot(req, { servers: [changedRecord] }, { now: new Date("2026-06-18T12:00:00.000Z") });
console.log("Passed:", result.passed);
console.log("Checks:", result.checks.filter(c => c.status !== "pass"));
