"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const {
  buildRecordIdentity,
  normalizeConnections,
  normalizeListenerConnections,
  parseNetstatOutput,
  parsePowerShellTcpConnections,
  parseWindowsDate,
  parseWindowsProcesses
} = require("../src/scanner/normalize");

function fixture(path) {
  return readFileSync(join(__dirname, "fixtures", path), "utf8");
}

test("parses Get-NetTCPConnection JSON fixtures", () => {
  const parsed = parsePowerShellTcpConnections(fixture("windows/get-nettcpconnection.sample.json"));
  assert.equal(parsed.length, 4);
  assert.deepEqual(parsed[0], {
    host: "127.0.0.1",
    port: 5173,
    pid: 4242,
    state: "Listen",
    protocol: "tcp"
  });
});

test("parses netstat fallback output and ignores non-listening rows", () => {
  const parsed = parseNetstatOutput(fixture("windows/netstat.sample.txt"));
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed.map((item) => item.port), [3000, 8080, 8000]);
  assert.equal(parsed[2].host, "::1");
});

test("parses CIM process metadata and WMI dates", () => {
  const processes = parseWindowsProcesses(fixture("windows/get-ciminstance.sample.json"));
  assert.equal(processes.get(4242).processName, "node.exe");
  assert.equal(processes.get(4242).creationTime.toISOString(), "2026-06-16T17:00:00.000Z");
  assert.equal(parseWindowsDate("/Date(1781150501212)/").toISOString(), "2026-06-11T04:01:41.212Z");
  assert.equal(parseWindowsDate("not-a-date"), null);
});

test("normalizes records, redacts command lines, and hides protected processes", () => {
  const connections = parsePowerShellTcpConnections(fixture("windows/get-nettcpconnection.sample.json"));
  const processes = parseWindowsProcesses(fixture("windows/get-ciminstance.sample.json"));
  const normalized = normalizeConnections(connections, processes, {
    now: new Date("2026-06-16T18:00:00.000Z"),
    rawSource: "powershell"
  });

  assert.equal(normalized.total, 4);
  assert.equal(normalized.hidden.protected, 1);
  assert.equal(normalized.visible.some((record) => record.category === "browser-helper"), true);

  const nodeRecord = normalized.visible.find((record) => record.pid === 4242);
  assert.equal(nodeRecord.commandLine.includes("super-secret-token"), false);
  assert.equal(nodeRecord.commandLine.includes("[REDACTED]"), true);
  assert.equal(nodeRecord.rawSource, "powershell");
  assert.equal(nodeRecord.category, "node-dev-server");
  assert.equal(nodeRecord.createdAt, "2026-06-16T17:00:00.000Z");
  assert.equal(nodeRecord.ageMs, 60 * 60 * 1000);
  assert.equal(nodeRecord.ageLabel, "1 hour");
  assert.equal(nodeRecord.timingSource, "Win32_Process.CreationDate");
  assert.equal(nodeRecord.timingStatus, "available");
  assert.equal(nodeRecord.lifecycleContext.label, "active");
  assert.equal(nodeRecord.lifecycleContext.staleCandidate, false);
  assert.equal(nodeRecord.launcher.parentPid, 4100);
  assert.equal(nodeRecord.launcher.parentProcessName, "npm.cmd");
  assert.equal(nodeRecord.launcher.parentCategory, "package-manager");
  assert.equal(nodeRecord.launcher.launcherName, "npm");
  assert.equal(nodeRecord.launcher.parentCommandLine.includes("npm-secret"), false);
  assert.deepEqual(nodeRecord.processTree.chain.map((item) => item.launcherName || item.processName), ["VS Code", "PowerShell", "npm", "node"]);
  assert.equal(JSON.stringify(nodeRecord.processTree).includes("parent-secret-token"), false);
  assert.equal(JSON.stringify(nodeRecord.processTree).includes("parent-password"), false);
  assert.equal(JSON.stringify(nodeRecord.processTree).includes("npm-secret"), false);
  assert.equal(nodeRecord.evidence.some((item) => item.type === "launcher" && item.message.includes("npm")), true);
  assert.equal(nodeRecord.evidence.some((item) => item.type === "process-tree" && item.message.includes("VS Code")), true);
  assert.equal(nodeRecord.safeToStop, false);
  assert.equal(nodeRecord.safeToRestart, false);
  assert.equal(nodeRecord.bulkStoppable, false);
  assert.equal(nodeRecord.evidence.length > 0, true);
});

test("process identity uses PID plus creation time and survives PID reuse", () => {
  const first = normalizeConnections([connection(3000, 9000)], processMap(9000, {
    creationTime: new Date("2026-06-17T10:00:00.000Z")
  }), { now: new Date("2026-06-17T10:01:00.000Z") }).visible[0];
  const second = normalizeConnections([connection(3000, 9000)], processMap(9000, {
    creationTime: new Date("2026-06-17T11:00:00.000Z")
  }), { now: new Date("2026-06-17T11:01:00.000Z") }).visible[0];

  assert.notEqual(first.processInstanceId, second.processInstanceId);
  assert.notEqual(first.id, second.id);
  assert.equal(first.identity.status, "stable");
  assert.equal(second.identity.source, "pid-and-creation-time");
});

test("same process with multiple ports shares process identity but has separate listener ids", () => {
  const normalized = normalizeConnections([
    connection(3000, 9001),
    connection(5173, 9001)
  ], processMap(9001), { now: new Date("2026-06-17T12:00:00.000Z") });
  const [first, second] = normalized.visible;

  assert.equal(first.processInstanceId, second.processInstanceId);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.listenerId, second.listenerId);
  assert.match(first.listenerId, /listener-tcp-127-0-0-1-3000$/);
  assert.match(second.listenerId, /listener-tcp-127-0-0-1-5173$/);
});

test("missing creation time produces explicitly unstable session-scoped ids", () => {
  const normalized = normalizeConnections([connection(3000, 9002)], processMap(9002, {
    creationTime: null
  }), { now: new Date("2026-06-17T12:00:00.000Z") });
  const record = normalized.visible[0];

  assert.equal(record.processInstanceId, null);
  assert.equal(record.identity.status, "unstable");
  assert.equal(record.identity.scope, "session-listener");
  assert.match(record.id, /^session-unstable-/);
});

test("top-level executable path and command line paths are redacted before output", () => {
  const normalized = normalizeConnections([connection(3000, 9003)], processMap(9003, {
    commandLine: "node C:\\Users\\JP\\code\\secret-app\\server.js --token raw-secret",
    executablePath: "C:\\Users\\JP\\code\\secret-app\\.venv\\Scripts\\node.exe"
  }), { now: new Date("2026-06-17T12:00:00.000Z") });
  const record = normalized.visible[0];
  const text = JSON.stringify(record);

  assert.equal(text.includes("C:\\Users\\JP"), false);
  assert.equal(text.includes("raw-secret"), false);
  assert.match(record.executablePath, /^%USERPROFILE%\\/);
  assert.match(record.commandLine, /%USERPROFILE%\\code\\secret-app/);
  assert.equal(record.safeToStop, false);
  assert.equal(record.safeToRestart, false);
  assert.equal(record.bulkStoppable, false);
});

test("duplicate listener normalization collapses equivalent rows but keeps IPv4 and IPv6 distinct", () => {
  const listeners = normalizeListenerConnections([
    connection(3000, 9010, "127.0.0.1"),
    connection(3000, 9010, "localhost"),
    connection(3000, 9010, "::1"),
    connection(3000, 9010, "[::1]")
  ]);

  assert.equal(listeners.length, 2);
  assert.deepEqual(listeners.map((item) => item.host).sort(), ["127.0.0.1", "::1"]);
});

test("wildcard and loopback listeners are retained separately to preserve exposure meaning", () => {
  const normalized = normalizeConnections([
    connection(5432, 9011, "0.0.0.0"),
    connection(5432, 9011, "*"),
    connection(5432, 9011, "127.0.0.1")
  ], processMap(9011, {
    processName: "postgres.exe",
    commandLine: "postgres -D %USERPROFILE%\\code\\db",
    executablePath: "C:\\Program Files\\PostgreSQL\\17\\bin\\postgres.exe"
  }), { now: new Date("2026-06-17T12:00:00.000Z") });

  assert.equal(normalized.total, 2);
  assert.equal(normalized.hidden.duplicate, 1);
  assert.equal(normalized.visible.some((record) => record.host === "0.0.0.0" && record.networkExposure.warning), true);
  assert.equal(normalized.visible.some((record) => record.host === "127.0.0.1" && !record.networkExposure.warning), true);
});

test("record identity helper marks listener host and port as secondary identity only", () => {
  const identity = buildRecordIdentity({
    pid: 1,
    createdAt: "2026-06-17T12:00:00.000Z",
    host: "127.0.0.1",
    port: 3000,
    protocol: "tcp",
    rawSource: "powershell",
    now: new Date("2026-06-17T12:00:00.000Z")
  });

  assert.equal(identity.processInstanceId, "pid-1-created-2026-06-17t12-00-00-000z");
  assert.equal(identity.listenerKey, "listener-tcp-127-0-0-1-3000");
  assert.equal(identity.evidence.some((item) => item.includes("secondary listener identity")), true);
});

function connection(port, pid, host = "127.0.0.1") {
  return {
    host,
    port,
    pid,
    state: "Listen",
    protocol: "tcp"
  };
}

function processMap(pid, overrides = {}) {
  return new Map([
    [pid, {
      pid,
      parentPid: null,
      processName: "node.exe",
      commandLine: "node vite.js",
      executablePath: "C:\\Program Files\\nodejs\\node.exe",
      creationTime: new Date("2026-06-17T09:00:00.000Z"),
      ...overrides
    }]
  ]);
}
