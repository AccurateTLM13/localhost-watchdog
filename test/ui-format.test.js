"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  compareRecords,
  compactUrl,
  formatConfidence,
  formatMs,
  httpProbeLabel,
  matchesFilter,
  safetyLabel,
  safetyState,
  summarize
} = require("../src/ui/format");

const nodeRecord = {
  port: 5173,
  category: "node-dev-server",
  confidence: 90,
  confidenceLevel: "high",
  safeToStop: false,
  networkExposure: { warning: false },
  httpProbe: { attempted: true, reachable: true }
};

test("formats confidence, milliseconds, probe labels, and compact URLs", () => {
  assert.equal(formatConfidence(nodeRecord), "90 / high");
  assert.equal(formatMs(42.4), "42 ms");
  assert.equal(formatMs(null), "n/a");
  assert.equal(httpProbeLabel({ attempted: false }), "Not probed");
  assert.equal(httpProbeLabel({ attempted: true, reachable: false }), "Unreachable or non-HTTP");
  assert.equal(compactUrl("http://localhost:3000/login"), "localhost:3000/login");
});

test("summarizes dashboard counts", () => {
  const summary = summarize({
    totals: { scanned: 5, visible: 3, hidden: 2 },
    servers: [
      nodeRecord,
      { category: "unknown-listener", networkExposure: { warning: false }, httpProbe: { attempted: true, reachable: false } },
      { category: "database", networkExposure: { warning: true }, httpProbe: { attempted: true, reachable: true } }
    ]
  });

  assert.deepEqual(summary, {
    scanned: 5,
    visible: 3,
    hidden: 2,
    reachable: 2,
    networkExposed: 1,
    unknown: 1
  });
});

test("maps safety state and labels for dashboard treatment", () => {
  assert.equal(safetyState(nodeRecord), "high-confidence-dev");
  assert.equal(safetyLabel(nodeRecord), "High-confidence dev");
  assert.equal(safetyState({ category: "unknown-listener" }), "unknown");
  assert.equal(safetyState({ category: "node-dev-server", confidenceLevel: "medium" }), "medium-confidence");
  assert.equal(safetyState({ category: "database", networkExposure: { warning: true } }), "network-exposed");
  assert.equal(safetyState({ category: "system-or-protected" }), "protected");
});

test("filters and sorts records", () => {
  const database = { port: 5432, category: "database", confidence: 50, processName: "postgres.exe" };
  const helper = { port: 9222, category: "browser-helper", confidence: 10, processName: "chrome.exe" };
  assert.equal(matchesFilter(nodeRecord, "dev"), true);
  assert.equal(matchesFilter(database, "database"), true);
  assert.equal(matchesFilter(helper, "helpers"), true);
  assert.equal(matchesFilter(database, "dev"), false);

  const sorted = [database, helper, nodeRecord].sort((a, b) => compareRecords(a, b, "confidence"));
  assert.equal(sorted[0], nodeRecord);
});
