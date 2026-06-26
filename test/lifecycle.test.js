"use strict";

const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const test = require("node:test");
const { classifyReadOnly } = require("../src/classifier/confidence");
const { attachLifecycleContext, buildLifecycleContext } = require("../src/process/lifecycle");
const { buildProcessTiming } = require("../src/process/timing");

const HOUR = 60 * 60 * 1000;
const CONFIG = {
  safety: {
    devRoots: [],
    protectedProcesses: ["system"],
    protectedPorts: [],
    protectedPortRanges: [],
    devRuntimes: ["node.exe", "python.exe", "java.exe", "postgres.exe", "ollama.exe"],
    commonDevPorts: [3000, 5173, 8000, 8080, 5432, 11434],
    lifecycle: {
      longRunningDevServerMs: 4 * HOUR,
      staleCandidateMinimumScore: 60,
      categoryExclusions: [
        "database",
        "local-ai-server",
        "browser-helper",
        "editor-helper",
        "system-or-protected",
        "unknown-listener"
      ]
    }
  },
  projects: {
    projects: []
  }
};

function baseRecord(overrides = {}) {
  const ageMs = overrides.ageMs ?? 10 * 60 * 1000;
  return {
    id: "session-unstable-test-pid-10-listener-tcp-127-0-0-1-5173",
    pid: 10,
    parentPid: 9,
    port: 5173,
    host: "127.0.0.1",
    protocol: "tcp",
    url: "http://localhost:5173",
    processName: "node.exe",
    commandLine: "node vite.js --token [REDACTED]",
    executablePath: "C:\\Program Files\\nodejs\\node.exe",
    category: "node-dev-server",
    confidence: 80,
    confidenceLevel: "high",
    safeToStop: false,
    safeToRestart: false,
    bulkStoppable: false,
    createdAt: "2026-06-17T10:00:00.000Z",
    ageMs,
    ageLabel: ageMs >= HOUR ? `${Math.floor(ageMs / HOUR)} hours` : "10 minutes",
    timingSource: "Win32_Process.CreationDate",
    timingStatus: "available",
    timingError: null,
    launcher: {
      parentPid: 9,
      parentProcessName: "npm.cmd",
      parentCategory: "package-manager",
      launcherName: "npm"
    },
    processTree: activeTree(),
    project: {
      name: "vite-app",
      root: mkdtempSync(join(tmpdir(), "watchdog-lifecycle-project-")),
      confidence: 85,
      source: "marker:package.json",
      evidence: ["found package.json"],
      workingDirectory: null
    },
    httpProbe: {
      attempted: true,
      reachable: true,
      statusCode: 200
    },
    evidence: [],
    reasons: [],
    ...overrides
  };
}

function activeTree() {
  return {
    depth: 4,
    truncated: false,
    stopReason: "missing-parent-pid",
    rootLauncher: "VS Code",
    chain: [
      { pid: 1, processName: "Code.exe", category: "editor", launcherName: "VS Code", commandLine: "Code.exe", executablePath: "C:\\Code.exe" },
      { pid: 2, processName: "powershell.exe", category: "terminal", launcherName: "PowerShell", commandLine: "powershell.exe npm run dev", executablePath: "C:\\powershell.exe" },
      { pid: 9, processName: "npm.cmd", category: "package-manager", launcherName: "npm", commandLine: "npm run dev", executablePath: "C:\\npm.cmd" },
      { pid: 10, processName: "node.exe", category: "runtime", launcherName: "node", commandLine: "node vite.js", executablePath: "C:\\node.exe" }
    ],
    evidence: []
  };
}

function missingParentTree() {
  return {
    depth: 1,
    truncated: false,
    stopReason: "missing-parent-metadata",
    rootLauncher: "node",
    chain: [
      { pid: 10, processName: "node.exe", category: "runtime", launcherName: "node", commandLine: "node vite.js", executablePath: "C:\\node.exe" }
    ],
    evidence: []
  };
}

test("recently started Vite server with active launcher chain is active", () => {
  const context = buildLifecycleContext(baseRecord(), { config: CONFIG });

  assert.equal(context.label, "active");
  assert.equal(context.staleCandidate, false);
  assert.equal(context.detachedCandidate, false);
});

test("long-running Vite server with active launcher chain is long-running, not stale", () => {
  const context = buildLifecycleContext(baseRecord({ ageMs: 8 * HOUR, ageLabel: "8 hours" }), { config: CONFIG });

  assert.equal(context.label, "long-running");
  assert.equal(context.signals.some((signal) => signal.type === "age-threshold"), true);
  assert.equal(context.staleCandidate, false);
});

test("long-running dev server with missing parent metadata is possibly detached when other signals are healthy", () => {
  const context = buildLifecycleContext(baseRecord({
    ageMs: 8 * HOUR,
    ageLabel: "8 hours",
    launcher: { parentPid: 999, parentCategory: "missing", launcherName: "Parent process unknown" },
    processTree: missingParentTree()
  }), { config: CONFIG });

  assert.equal(context.label, "possibly-detached");
  assert.equal(context.detachedCandidate, true);
  assert.equal(context.staleCandidate, false);
});

test("detached process with existing project and successful HTTP probe is not stale", () => {
  const context = buildLifecycleContext(baseRecord({
    ageMs: 12 * HOUR,
    ageLabel: "12 hours",
    launcher: { parentPid: 999, parentCategory: "missing", launcherName: "Parent process unknown" },
    processTree: missingParentTree(),
    httpProbe: { attempted: true, reachable: true, statusCode: 200 }
  }), { config: CONFIG });

  assert.equal(context.label, "possibly-detached");
  assert.equal(context.staleCandidate, false);
});

test("stale candidate requires multiple agreeing signals beyond age", () => {
  const missingProject = join(tmpdir(), `watchdog-missing-${Date.now()}`);
  const context = buildLifecycleContext(baseRecord({
    ageMs: 12 * HOUR,
    ageLabel: "12 hours",
    launcher: { parentPid: 999, parentCategory: "missing", launcherName: "Parent process unknown" },
    processTree: missingParentTree(),
    project: { name: "missing", root: missingProject, confidence: 35, source: "dev-root-path", evidence: [] },
    httpProbe: { attempted: true, reachable: false, error: "Non-HTTP response" }
  }), { config: CONFIG });

  assert.equal(context.label, "stale-candidate");
  assert.equal(context.staleCandidate, true);
  assert.equal(context.signals.some((signal) => signal.type === "unreachable-http-dev-server"), true);
  assert.equal(context.signals.some((signal) => signal.type === "project-path-missing"), true);
});

test("long-running Postgres database is excluded from stale scoring", () => {
  const context = buildLifecycleContext(baseRecord({
    category: "database",
    processName: "postgres.exe",
    ageMs: 72 * HOUR,
    ageLabel: "3 days"
  }), { config: CONFIG });

  assert.equal(context.label, "long-running");
  assert.equal(context.staleCandidate, false);
  assert.equal(context.staleScore, 0);
});

test("long-running Ollama/local AI server is excluded from stale scoring", () => {
  const context = buildLifecycleContext(baseRecord({
    category: "local-ai-server",
    processName: "ollama.exe",
    ageMs: 72 * HOUR,
    ageLabel: "3 days"
  }), { config: CONFIG });

  assert.equal(context.label, "long-running");
  assert.equal(context.staleCandidate, false);
  assert.equal(context.staleScore, 0);
});

test("protected system listener never receives stale recommendation", () => {
  const context = buildLifecycleContext(baseRecord({
    category: "system-or-protected",
    processName: "System",
    ageMs: 72 * HOUR,
    ageLabel: "3 days"
  }), { config: CONFIG });

  assert.equal(context.staleCandidate, false);
  assert.equal(context.staleScore, 0);
  assert.match(context.limitations.join(" "), /protected\/system listeners never receive cleanup recommendations/);
});

test("missing, invalid, and future creation times are explicit timing states", () => {
  assert.equal(buildProcessTiming(null).timingStatus, "unavailable");
  assert.equal(buildProcessTiming("not-a-date").timingStatus, "invalid");
  const future = buildProcessTiming(new Date("2026-06-17T12:00:00.000Z"), new Date("2026-06-17T11:00:00.000Z"));
  assert.equal(future.timingStatus, "skewed");
  assert.equal(future.ageMs, null);
});

test("process-tree truncation alone does not create false stale classification", () => {
  const context = buildLifecycleContext(baseRecord({
    ageMs: 8 * HOUR,
    ageLabel: "8 hours",
    processTree: {
      ...activeTree(),
      truncated: true,
      stopReason: "max-depth"
    }
  }), { config: CONFIG });

  assert.equal(context.label, "long-running");
  assert.equal(context.staleCandidate, false);
});

test("lifecycle context does not enable action flags", () => {
  const record = baseRecord({
    ageMs: 12 * HOUR,
    ageLabel: "12 hours",
    launcher: { parentPid: 999, parentCategory: "missing", launcherName: "Parent process unknown" },
    processTree: missingParentTree(),
    httpProbe: { attempted: true, reachable: false, error: "Non-HTTP response" },
    project: null
  });
  const classified = classifyReadOnly(record, { config: CONFIG });
  const enriched = attachLifecycleContext({ ...record, ...classified }, { config: CONFIG });

  assert.equal(enriched.lifecycleContext.staleCandidate, true);
  assert.equal(enriched.safeToStop, false);
  assert.equal(enriched.safeToRestart, false);
  assert.equal(enriched.bulkStoppable, false);
  assert.equal(enriched.evidence.some((item) => item.type === "lifecycle"), true);
});
