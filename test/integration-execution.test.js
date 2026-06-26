"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const { createConfirmationManager } = require("../src/actions/confirmation");
const { createDryRunManager } = require("../src/actions/dry-run");
const { createExecutionManager } = require("../src/actions/execution");
const { buildValidationFingerprint } = require("../src/actions/eligibility");

const NOW = new Date("2026-06-18T12:00:00.000Z");

test("graceful stop executes against spawned fixture server", async () => {
  const token = crypto.randomBytes(16).toString("hex");
  const fixturePath = path.join(__dirname, "fixtures", "server.js");
  
  let child;
  try {
    child = spawn(process.execPath, [fixturePath, token], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let port;
    await new Promise((resolve, reject) => {
      child.stdout.on("data", (data) => {
        const match = data.toString().match(/LISTENING:(\d+)/);
        if (match) {
          port = parseInt(match[1], 10);
          resolve();
        }
      });
      child.on("error", reject);
      child.on("exit", () => reject(new Error("Fixture exited early")));
    });

    const record = devRecord({
      pid: child.pid,
      port: port
    });

    const { dryRun, confirmation, execution, session } = await readyManagers(record, token);

    const created = await confirmation.createConfirmation({
      dryRunRequestId: dryRun.requestId,
      statusAccessToken: dryRun.statusAccessToken,
      processInstanceId: record.processInstanceId,
      listenerId: record.listenerId
    }, { session });

    const accepted = await confirmation.submitConfirmation({
      confirmationRequestId: created.confirmationRequestId,
      typedPhrase: created.displayChallenge.requiredPhrase,
      statusAccessToken: dryRun.statusAccessToken,
      idempotencyKey: "submit-integ"
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
      idempotencyKey: "exec-integ"
    }, { session });

    if (!result.ok) {
      console.error("execution failed:", result);
    }
    assert.equal(result.ok, true);
    assert.equal(result.state, "success");
    assert.equal(result.actionExecuted, true);
    assert.equal(result.details.signalSent, true);
    assert.equal(result.details.processExited, true);
    assert.equal(result.details.portReleased, true);

    // Ensure process is actually gone
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      process.kill(child.pid, 0);
      assert.fail("Process should be dead");
    } catch (err) {
      assert.equal(err.code, "ESRCH", "Process should be dead");
    }
  } catch (err) {
    console.error("Test failed:", err);
    throw err;
  } finally {
    if (child) {
      try { process.kill(child.pid, "SIGKILL"); } catch (e) {}
    }
  }
});

async function readyManagers(record, fixtureToken) {
  const dryRun = createDryRunManager({
    clock: () => NOW,
    scanProvider: async () => ({ servers: [record] }),
    auditWriter: () => {}
  });
  
  const dryRunResult = await dryRun.requestDryRun({
    ...requestFor(record),
    fixtureToken
  });
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
    scanProvider: async () => ({ servers: [record] }),
    auditWriter: () => {},
    clock: () => NOW,
    watchdogPrivilege: {
      available: true,
      elevated: false,
      integrityAvailable: true,
      sid: "S-1-5-21-mock-watchdog-sid",
      sessionId: 1
    }
  });

  const execution = createExecutionManager({
    confirmationManager: confirmation,
    scanProvider: async () => ({ servers: [record] }),
    auditWriter: () => {},
    clock: () => NOW,
    watchdogPrivilege: {
      available: true,
      elevated: false,
      integrityAvailable: true,
      sid: "S-1-5-21-mock-watchdog-sid",
      sessionId: 1
    }
  });

  return { dryRun: dryRunResult, confirmation, execution, session };
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
    processName: "node.exe", // In GitHub Actions it might be node instead of node.exe
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
    confirmationSafety: {
      owner: { available: true, match: "same-user", accountType: "user", systemOwned: false, serviceOwned: false },
      session: { available: true, match: "same-session" },
      elevation: { available: true, targetIntegrityAvailable: true, targetElevated: false, match: "same-non-elevated-session" },
      watchdog: { available: true, elevated: false, integrityAvailable: true, sid: "S-1-5-21-mock-watchdog-sid", sessionId: 1 }
    },
    safeToStop: false,
    safeToRestart: false,
    bulkStoppable: false
  };
  return { ...base, ...overrides };
}
