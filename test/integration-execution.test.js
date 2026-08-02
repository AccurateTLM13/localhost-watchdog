"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const http = require("node:http");
const { createConfirmationManager } = require("../src/actions/confirmation");
const { createDryRunManager } = require("../src/actions/dry-run");
const { createExecutionManager } = require("../src/actions/execution");
const { buildValidationFingerprint } = require("../src/actions/eligibility");

const NOW = new Date("2026-06-18T12:00:00.000Z");

test("graceful stop executes against spawned fixture server", async () => {
  const token = crypto.randomBytes(16).toString("hex");
  const fixturePath = path.join(__dirname, "fixtures", "server.js");
  const launcherPath = path.join(__dirname, "fixtures", "launch-console-process.ps1");
  
  let child;
  try {
    const requestedPort = process.platform === "win32" ? 43000 + Math.floor(Math.random() * 1000) : 0;
    if (process.platform === "win32") {
      child = await launchWindowsFixture(launcherPath, fixturePath, token, requestedPort);
    } else {
      child = spawn(process.execPath, [fixturePath, token, String(requestedPort)], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    }

    const port = process.platform === "win32"
      ? await waitForListener(requestedPort, child)
      : await readFixturePort(child);

    const record = devRecord({
      pid: child.pid,
      port: port,
      createdAt: child.createdAt
    });
    await assertStopFlow(record, token, child, "exec-integ");
  } catch (err) {
    console.error("Test failed:", err);
    throw err;
  } finally {
    if (child) {
      try { process.kill(child.pid, "SIGKILL"); } catch (e) {}
    }
  }
});

test("graceful stop executes against a spawned Python fixture server", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows console-control integration coverage");
  const pythonPath = await findPython();
  if (!pythonPath) return t.skip("Python runtime is unavailable");

  const token = crypto.randomBytes(16).toString("hex");
  const fixturePath = path.join(__dirname, "fixtures", "server.py");
  const launcherPath = path.join(__dirname, "fixtures", "launch-console-process.ps1");
  const requestedPort = 44000 + Math.floor(Math.random() * 1000);
  let child;
  try {
    child = await launchWindowsFixture(launcherPath, fixturePath, token, requestedPort, pythonPath);
    const port = await waitForListener(requestedPort, child);
    const record = devRecord({
      id: "python-fixture-listener",
      processInstanceId: `pid-${child.pid}-python-fixture`,
      listenerId: `pid-${child.pid}-python-fixture-listener`,
      pid: child.pid,
      port,
      createdAt: child.createdAt,
      processName: path.basename(pythonPath).toLowerCase(),
      category: "python-dev-server",
      processTree: {
        truncated: false,
        stopReason: "root-reached",
        chain: [{ category: "terminal", processName: "powershell.exe" }, { category: "python-runtime", processName: "python.exe" }]
      }
    });
    await assertStopFlow(record, token, child, "exec-python-integ");
  } finally {
    if (child) {
      try { process.kill(child.pid, "SIGKILL"); } catch (e) {}
    }
  }
});

async function assertStopFlow(record, fixtureToken, child, executionKey) {
  const stopOverrides = {
    postActionScanProvider: async () => {
      await waitForExit(child);
      return { servers: [] };
    }
  };
  if (process.platform !== "win32") {
    stopOverrides.gracefulStop = async ({ pid }) => {
      process.kill(pid, "SIGINT");
      return { ok: true };
    };
  }
  const { dryRun, confirmation, execution, session } = await readyManagers(record, fixtureToken, stopOverrides);
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
    idempotencyKey: `${executionKey}-submit`
  }, {
    session,
    confirmationAccessToken: created.confirmationAccessToken,
    statusAccessToken: dryRun.statusAccessToken
  });
  assert.equal(accepted.state, "confirmation-accepted");
  const result = await execution.executeStop({
    confirmationRequestId: created.confirmationRequestId,
    executionAccessToken: accepted.executionAccessToken,
    executionMode: "execute",
    processInstanceId: record.processInstanceId,
    listenerId: record.listenerId,
    idempotencyKey: executionKey
  }, { session });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.state, "success");
  assert.equal(result.actionExecuted, true);
  await waitForExit(child);
}

async function readyManagers(record, fixtureToken, overrides = {}) {
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
    watchdogPrivilege: overrides.watchdogPrivilege || {
      available: true,
      elevated: false,
      integrityAvailable: true,
      sid: "S-1-5-21-mock-watchdog-sid",
      sessionId: 1
    }
  });

  const execution = createExecutionManager({
    confirmationManager: confirmation,
    scanProvider: overrides.executionScanProvider || (async () => ({ servers: [record] })),
    postActionScanProvider: overrides.postActionScanProvider,
    auditWriter: overrides.executionAuditWriter || (() => {}),
    gracefulStop: overrides.gracefulStop,
    clock: () => NOW,
    watchdogPrivilege: overrides.watchdogPrivilege || {
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
    confirmationSafety: overrides.confirmationSafety || {
      owner: { available: true, match: "same-user", accountType: "user", systemOwned: false, serviceOwned: false },
      session: { available: true, match: "same-session" },
      elevation: { available: true, targetIntegrityAvailable: true, targetElevated: false, match: "same-non-elevated-session" },
      watchdog: { available: true, elevated: false, integrityAvailable: true, sid: "S-1-5-21-mock-watchdog-sid", sessionId: 1 }
    },
    safeToStop: false,
    safeToRestart: false,
    bulkStoppable: false,
    privilege: overrides.privilege || { elevated: false, verified: true }
  };
  return { ...base, ...overrides };
}

async function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null) return;
  if (child.detachedTarget) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!isProcessRunning(child.pid)) {
        child.exitCode = 0;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Fixture did not exit after graceful stop");
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Fixture did not exit after graceful stop")), timeoutMs))
  ]);
}

async function launchWindowsFixture(launcherPath, fixturePath, token, port, runtimePath = process.execPath) {
  const launcher = spawn("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-File",
    launcherPath,
    "-NodePath",
    runtimePath,
    "-FixturePath",
    fixturePath,
    "-Token",
    token,
    "-Port",
    String(port)
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

  const target = await new Promise((resolve, reject) => {
    let output = "";
    launcher.stdout.on("data", (data) => { output += data.toString(); });
    launcher.stderr.on("data", (data) => { output += data.toString(); });
    launcher.on("error", reject);
    launcher.on("exit", (code) => {
      const match = output.match(/(\d+)\|([^\r\n]+)/);
      if (code === 0 && match) return resolve({ pid: Number(match[1]), createdAt: match[2] });
      reject(new Error(`Windows fixture launcher failed: ${output.trim() || `exit ${code}`}`));
    });
  });
  return { ...target, exitCode: null, detachedTarget: true };
}

async function findPython() {
  for (const candidate of [process.env.LOCALHOST_WATCHDOG_PYTHON || "python.exe", "python"]) {
    try {
      await new Promise((resolve, reject) => {
        const probe = spawn(candidate, ["--version"], { stdio: "ignore", windowsHide: true });
        probe.once("error", reject);
        probe.once("exit", (code) => code === 0 ? resolve() : reject(new Error("python probe failed")));
      });
      if (path.isAbsolute(candidate)) return candidate;
      const located = await locateExecutable(candidate);
      if (located) return located;
    } catch {}
  }
  return null;
}

async function locateExecutable(candidate) {
  return new Promise((resolve) => {
    const locator = spawn("where.exe", [candidate], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let output = "";
    locator.stdout.on("data", (data) => { output += data.toString(); });
    locator.once("error", () => resolve(null));
    locator.once("exit", (code) => {
      const candidates = output.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).filter((item) => !/\\WindowsApps\\/i.test(item));
      resolve(code === 0 ? candidates[candidates.length - 1] || null : null);
    });
  });
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code !== "ESRCH";
  }
}

async function readFixturePort(child) {
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (data) => {
      const match = data.toString().match(/LISTENING:(\d+)/);
      if (match) resolve(parseInt(match[1], 10));
    });
    child.on("error", reject);
    child.on("exit", () => reject(new Error("Fixture exited early")));
  });
}

async function waitForListener(port, child, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) throw new Error("Fixture exited early");
    try {
      await new Promise((resolve, reject) => {
        const request = http.get({ host: "127.0.0.1", port, path: "/" }, (response) => {
          response.resume();
          response.once("end", resolve);
        });
        request.once("error", reject);
        request.setTimeout(250, () => request.destroy(new Error("listener probe timed out")));
      });
      return port;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Fixture listener did not become ready");
}
