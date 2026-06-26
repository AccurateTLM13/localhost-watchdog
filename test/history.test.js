"use strict";

const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const test = require("node:test");
const { applyHistoryToSnapshot, buildProcessInstanceId } = require("../src/history/store");

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "watchdog-history-"));
  return {
    root,
    historyPath: join(root, "history.json")
  };
}

function snapshot(records, generatedAt = "2026-06-17T10:00:00.000Z") {
  return {
    ok: true,
    generatedAt,
    platform: "win32",
    scanner: { destructiveActionsAvailable: false },
    config: { devRoots: [] },
    servers: records,
    hidden: { protected: 0, unknown: 0, nonLocalhost: 0, lowConfidence: 0 },
    totals: { scanned: records.length, visible: records.length, hidden: 0 },
    errors: []
  };
}

function record(overrides = {}) {
  return {
    id: "pid-100-created-2026-06-17t09-00-00-000z-listener-tcp-127-0-0-1-5173",
    processInstanceId: "pid-100-created-2026-06-17t09-00-00-000z",
    listenerId: "pid-100-created-2026-06-17t09-00-00-000z-listener-tcp-127-0-0-1-5173",
    pid: 100,
    port: 5173,
    processName: "node.exe",
    commandLine: "node server.js --token raw-secret",
    executablePath: "C:\\Users\\JP\\code\\app\\node.exe",
    createdAt: "2026-06-17T09:00:00.000Z",
    category: "node-dev-server",
    confidenceLevel: "high",
    project: {
      name: "safe-project-name",
      root: "C:\\Users\\JP\\code\\private-app"
    },
    httpProbe: {
      attempted: true,
      reachable: true
    },
    lifecycleContext: {
      label: "active",
      staleScore: 0,
      staleCandidate: false
    },
    safeToStop: false,
    safeToRestart: false,
    bulkStoppable: false,
    evidence: [],
    reasons: [],
    ...overrides
  };
}

function apply(inputSnapshot, ws, now, extraHistory = {}) {
  return applyHistoryToSnapshot(inputSnapshot, {
    now: new Date(now),
    root: ws.root,
    history: {
      enabled: true,
      storagePath: ws.historyPath,
      maxSnapshots: 25,
      maxHistoryAgeMs: 14 * 24 * 60 * 60 * 1000,
      maxProcessRecords: 500,
      ...extraHistory
    }
  });
}

test("first observation creates privacy-safe history context", () => {
  const ws = workspace();
  const result = apply(snapshot([record()]), ws, "2026-06-17T10:00:00.000Z");
  const context = result.servers[0].historyContext;

  assert.equal(context.previouslySeen, false);
  assert.equal(context.seenCount, 1);
  assert.equal(context.consecutiveSeenCount, 1);
  assert.equal(context.persistedAcrossScans, false);
  assert.equal(result.history.storageHealth, "available");
});

test("repeat and consecutive observations increment counts", () => {
  const ws = workspace();
  apply(snapshot([record()]), ws, "2026-06-17T10:00:00.000Z");
  const result = apply(snapshot([record()]), ws, "2026-06-17T10:05:00.000Z");
  const context = result.servers[0].historyContext;

  assert.equal(context.previouslySeen, true);
  assert.equal(context.seenCount, 2);
  assert.equal(context.consecutiveSeenCount, 2);
  assert.equal(context.persistedAcrossScans, true);
});

test("disappearance and reappearance are detected", () => {
  const ws = workspace();
  apply(snapshot([record()]), ws, "2026-06-17T10:00:00.000Z");
  const empty = apply(snapshot([]), ws, "2026-06-17T10:05:00.000Z");
  const reappeared = apply(snapshot([record()]), ws, "2026-06-17T10:10:00.000Z");

  assert.equal(empty.history.disappearedSincePrevious, 1);
  assert.equal(reappeared.servers[0].historyContext.reappeared, true);
  assert.equal(reappeared.servers[0].historyContext.consecutiveSeenCount, 1);
});

test("PID reuse with different creation time is a different process instance", () => {
  const ws = workspace();
  apply(snapshot([record({ pid: 123, createdAt: "2026-06-17T09:00:00.000Z" })]), ws, "2026-06-17T10:00:00.000Z");
  const result = apply(snapshot([record({ pid: 123, createdAt: "2026-06-17T09:30:00.000Z" })]), ws, "2026-06-17T10:05:00.000Z");

  assert.equal(result.servers[0].historyContext.previouslySeen, false);
  assert.equal(Object.keys(JSON.parse(readFileSync(ws.historyPath, "utf8")).records).length, 2);
});

test("same process is tracked across port changes", () => {
  const ws = workspace();
  apply(snapshot([record({ port: 5173 })]), ws, "2026-06-17T10:00:00.000Z");
  const result = apply(snapshot([record({ port: 3000 })]), ws, "2026-06-17T10:05:00.000Z");
  const stored = JSON.parse(readFileSync(ws.historyPath, "utf8"));

  assert.equal(result.servers[0].historyContext.seenCount, 2);
  assert.equal(Object.values(stored.records)[0].mostRecentPort, 3000);
});

test("invalid history file recovers without blocking current scan", () => {
  const ws = workspace();
  writeFileSync(ws.historyPath, "{not-json");
  const result = apply(snapshot([record()]), ws, "2026-06-17T10:00:00.000Z");

  assert.equal(result.history.storageHealth, "corrupt-recovered");
  assert.match(result.history.warning, /invalid JSON/);
  assert.equal(result.servers.length, 1);
});

test("interrupted temp write is ignored when main history is valid", () => {
  const ws = workspace();
  apply(snapshot([record()]), ws, "2026-06-17T10:00:00.000Z");
  writeFileSync(`${ws.historyPath}.tmp`, "{interrupted");
  const result = apply(snapshot([record()]), ws, "2026-06-17T10:05:00.000Z");

  assert.equal(result.servers[0].historyContext.seenCount, 2);
  assert.equal(existsSync(`${ws.historyPath}.tmp`), false);
});

test("retention prunes snapshots and tracked records", () => {
  const ws = workspace();
  apply(snapshot([record({ pid: 1, createdAt: "2026-06-17T08:00:00.000Z" })]), ws, "2026-06-17T10:00:00.000Z", { maxSnapshots: 2, maxProcessRecords: 2 });
  apply(snapshot([record({ pid: 2, createdAt: "2026-06-17T08:01:00.000Z" })]), ws, "2026-06-17T10:01:00.000Z", { maxSnapshots: 2, maxProcessRecords: 2 });
  apply(snapshot([record({ pid: 3, createdAt: "2026-06-17T08:02:00.000Z" })]), ws, "2026-06-17T10:02:00.000Z", { maxSnapshots: 2, maxProcessRecords: 2 });
  const stored = JSON.parse(readFileSync(ws.historyPath, "utf8"));

  assert.equal(stored.snapshots.length, 2);
  assert.equal(Object.keys(stored.records).length, 2);
});

test("retention prunes snapshots older than configured max age", () => {
  const ws = workspace();
  apply(snapshot([record({ pid: 1, createdAt: "2026-06-17T08:00:00.000Z" })]), ws, "2026-06-17T10:00:00.000Z", { maxHistoryAgeMs: 60 * 1000 });
  apply(snapshot([record({ pid: 2, createdAt: "2026-06-17T08:01:00.000Z" })]), ws, "2026-06-17T10:05:00.000Z", { maxHistoryAgeMs: 60 * 1000 });
  const stored = JSON.parse(readFileSync(ws.historyPath, "utf8"));

  assert.equal(stored.snapshots.length, 1);
  assert.equal(stored.snapshots[0].scannedAt, "2026-06-17T10:05:00.000Z");
});

test("schema version mismatch recovers without blocking current scan", () => {
  const ws = workspace();
  writeFileSync(ws.historyPath, JSON.stringify({ version: 999, snapshots: [], records: {} }));
  const result = apply(snapshot([record()]), ws, "2026-06-17T10:00:00.000Z");

  assert.equal(result.history.storageHealth, "schema-mismatch");
  assert.match(result.history.warning, /schema version mismatch/);
  assert.equal(result.servers.length, 1);
});

test("missing creation time is not persisted as stable identity", () => {
  const ws = workspace();
  const result = apply(snapshot([record({ createdAt: null })]), ws, "2026-06-17T10:00:00.000Z");
  const stored = JSON.parse(readFileSync(ws.historyPath, "utf8"));

  assert.equal(result.servers[0].historyContext.historyStatus, "available");
  assert.match(result.servers[0].historyContext.evidence[0].message, /stable process identity unavailable/);
  assert.equal(Object.keys(stored.records).length, 0);
});

test("history disabled adds disabled context without writing", () => {
  const ws = workspace();
  const result = applyHistoryToSnapshot(snapshot([record()]), {
    now: new Date("2026-06-17T10:00:00.000Z"),
    root: ws.root,
    history: {
      enabled: false,
      storagePath: ws.historyPath
    }
  });

  assert.equal(result.history.enabled, false);
  assert.equal(result.servers[0].historyContext.historyStatus, "disabled");
  assert.equal(existsSync(ws.historyPath), false);
});

test("history write failure does not block scanner result", () => {
  const ws = workspace();
  const result = applyHistoryToSnapshot(snapshot([record()]), {
    now: new Date("2026-06-17T10:00:00.000Z"),
    root: ws.root,
    history: {
      enabled: true,
      storagePath: ws.historyPath
    },
    io: {
      existsSync: () => false,
      mkdirSync: () => {},
      writeFileSync: () => {
        throw new Error("disk denied");
      },
      renameSync: () => {},
      readFileSync: () => "{}"
    }
  });

  assert.equal(result.servers.length, 1);
  assert.equal(result.history.storageHealth, "write-failed");
  assert.equal(result.history.warning, "History storage could not be updated; current scan results were still returned.");
  assert.equal(JSON.stringify(result).includes("disk denied"), false);
});

test("persisted history excludes command lines, paths, process trees, and secrets", () => {
  const ws = workspace();
  apply(snapshot([record({
    commandLine: "node server.js --token raw-secret",
    processTree: {
      chain: [{ commandLine: "secret tree", executablePath: "C:\\Users\\JP\\secret" }]
    }
  })]), ws, "2026-06-17T10:00:00.000Z");
  const text = readFileSync(ws.historyPath, "utf8");

  assert.equal(text.includes("raw-secret"), false);
  assert.equal(text.includes("commandLine"), false);
  assert.equal(text.includes("C:\\Users\\JP"), false);
  assert.equal(text.includes("processTree"), false);
  assert.equal(text.includes("safe-project-name"), true);
});

test("history alone does not mark stale or enable actions", () => {
  const ws = workspace();
  let result;
  for (let index = 0; index < 3; index += 1) {
    result = apply(snapshot([record({
      lifecycleContext: {
        label: "long-running",
        staleScore: 20,
        staleCandidate: false
      }
    })]), ws, `2026-06-17T10:0${index}:00.000Z`);
  }

  const server = result.servers[0];
  assert.equal(server.historyContext.seenCount, 3);
  assert.equal(server.lifecycleContext.staleCandidate, false);
  assert.equal(server.safeToStop, false);
  assert.equal(server.safeToRestart, false);
  assert.equal(server.bulkStoppable, false);
});

test("process-instance identity requires PID and creation time", () => {
  assert.equal(buildProcessInstanceId(record({ pid: 1, createdAt: "2026-06-17T09:00:00.000Z" })), "pid:1|created:2026-06-17T09:00:00.000Z");
  assert.equal(buildProcessInstanceId(record({ createdAt: null })), null);
});
