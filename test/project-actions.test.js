"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const test = require("node:test");
const { createProjectRegistry } = require("../src/project/registry");
const { containsProjectPath, createStartManager, defaultProjectLauncherUnavailable } = require("../src/actions/start");
const { createRestartManager } = require("../src/actions/restart");
const { MANAGED_LAUNCH_CONTRACT_VERSION, buildProcessInstanceId } = require("../src/project/managed-contract");
const { normalizeProjectRoot } = require("../src/config/load");

function registry(projects) {
  return createProjectRegistry({ configProvider: () => ({ projects: { projects } }) });
}

test("project registry separates canonical root from preserved displayRoot", () => {
  const root = mkdtempSync(path.join(tmpdir(), "lw-managed-project-"));
  const manager = registry([{ id: "web", name: "Web", root, displayRoot: root, startCommand: "npm run dev", preferredPort: 5173, portStrategy: "strict", tags: ["ui"] }]);
  const [project] = manager.listProjects();
  assert.equal(project.id, "web");
  assert.equal(project.valid, true);
  assert.equal(project.root, normalizeProjectRoot(root));
  assert.equal(project.displayRoot, root);
  assert.equal(project.preferredPort, 5173);
});

test("project registry migrates legacy path records into root and displayRoot", () => {
  const root = mkdtempSync(path.join(tmpdir(), "lw-legacy-project-"));
  const [project] = registry([{ id: "legacy", path: root, startCommand: "node server.js" }]).listProjects();
  assert.equal(project.root, normalizeProjectRoot(root));
  assert.equal(project.displayRoot, root);
});

test("start manager fails closed without an injected launcher", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lw-start-project-"));
  const manager = createStartManager({ registry: registry([{ id: "web", path: root, startCommand: "npm run dev" }]), scanProvider: async () => [], launcher: defaultProjectLauncherUnavailable });
  const result = await manager.startProject({ projectId: "web", idempotencyKey: "start-1" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "PROJECT_START_BACKEND_UNAVAILABLE");
  assert.equal(result.actionExecuted, false);
});

test("start manager dispatches injected launcher once per idempotency key", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lw-start-launch-"));
  const calls = [];
  const manager = createStartManager({
    registry: registry([{ id: "web", path: root, startCommand: "npm run dev", preferredPort: 5173 }]),
    scanProvider: async () => [],
    randomId: () => "abc123",
    launcher: async (request) => { calls.push(request); return managedLaunchResult(request.cwd, 5101, 5173); }
  });
  const first = await manager.startProject({ projectId: "web", idempotencyKey: "same" });
  const second = await manager.startProject({ projectId: "web", idempotencyKey: "same" });
  assert.equal(first.ok, true);
  assert.equal(first.actionExecuted, true);
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].project.id, "web");
  assert.equal(first.process.processGroupId, first.process.pid);
});

test("running-project matching respects project path boundaries", () => {
  assert.equal(containsProjectPath("node c:\\work\\app\\server.js", "c:\\work\\app"), true);
  assert.equal(containsProjectPath("node c:\\work\\application\\server.js", "c:\\work\\app"), false);
});

test("start manager rejects a launcher that does not return the managed identity contract", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lw-start-invalid-identity-"));
  const manager = createStartManager({
    registry: registry([{ id: "web", path: root, startCommand: "node server.js" }]),
    scanProvider: async () => [],
    launcher: async () => ({ ok: true })
  });
  const result = await manager.startProject({ projectId: "web", idempotencyKey: "invalid-identity" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "PROJECT_START_CONTRACT_INVALID");
  assert.equal(result.actionExecuted, false);
});

test("restart manager stops, verifies disappearance, then dispatches managed start", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lw-restart-project-"));
  const calls = [];
  const scanRecord = { pid: 42, processInstanceId: "proc-1", listenerId: "listener-1", port: 5173, processName: "node", commandLine: `${root} npm run dev` };
  let postStartCalls = 0;
  const manager = createRestartManager({
    registry: registry([{ id: "web", path: root, startCommand: "npm run dev", preferredPort: 5173 }]),
    scanProvider: async () => [scanRecord],
    postStopScanProvider: async () => [],
    postStartScanProvider: async () => {
      postStartCalls += 1;
      return postStartCalls === 1 ? [] : [{
        pid: 5102,
        processInstanceId: managedLaunchResult(root, 5102, 5173).processInstanceId,
        listenerId: "listener-new",
        port: 5173,
        processName: "node.exe",
        project: { id: "web", root },
        commandLine: `${root} npm run dev`
      }];
    },
    randomId: () => "def456",
    gracefulStop: async (request) => { calls.push(["stop", request.listenerId]); return { ok: true }; },
    launcher: async (request) => { calls.push(["start", request.project.id]); return managedLaunchResult(request.cwd, 5102, 5173); }
  });
  const result = await manager.restartProject({ projectId: "web", listenerId: "listener-1", processInstanceId: "proc-1", idempotencyKey: "restart-1" });
  assert.equal(result.ok, true);
  assert.equal(result.state, "restart-completed");
  assert.equal(result.actionExecuted, true);
  assert.equal(result.startupHealth.ok, true);
  assert.deepEqual(calls, [["stop", "listener-1"], ["start", "web"]]);
  assert.equal(result.process.processGroupId, result.process.pid);
});

test("restart manager accepts scanner envelopes and records a verified restart", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lw-restart-envelope-"));
  const current = { pid: 43, processInstanceId: "proc-envelope-1", listenerId: "listener-envelope-1", port: 5173, processName: "node.exe", workingDirectory: root };
  const history = [];
  const postStopSnapshots = [[current], []];
  let postStartCalls = 0;
  const manager = createRestartManager({
    registry: registry([{ id: "web", root, displayRoot: root, startCommand: "npm run dev", preferredPort: 5173 }]),
    scanProvider: async () => ({ ok: true, servers: [current] }),
    postStopScanProvider: async () => postStopSnapshots.shift() || [],
    postStartScanProvider: async () => {
      postStartCalls += 1;
      return postStartCalls === 1 ? { ok: true, servers: [] } : {
        ok: true,
        servers: [{ pid: 5104, processInstanceId: managedLaunchResult(root, 5104, 5173).processInstanceId, listenerId: "listener-envelope-new", port: 5173, project: { id: "web", root } }]
      };
    },
    stopTimeoutMs: 50,
    startupTimeoutMs: 50,
    pollMs: 1,
    historyWriter: (entry) => history.push(entry),
    gracefulStop: async () => ({ ok: true }),
    launcher: async (request) => managedLaunchResult(request.cwd, 5104, request.selectedPort)
  });
  const result = await manager.restartProject({ projectId: "web", listenerId: current.listenerId, processInstanceId: current.processInstanceId, idempotencyKey: "restart-envelope" });
  assert.equal(result.ok, true);
  assert.equal(result.stopVerified, true);
  assert.equal(result.startupHealth.ok, true);
  assert.equal(manager.listHistory().length, 1);
  assert.equal(history[0].state, "restart-completed");
  assert.equal(history[0].startupHealthy, true);
});

test("restart manager never starts when the previous listener cannot be verified gone", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lw-restart-stop-timeout-"));
  const current = { pid: 44, processInstanceId: "proc-timeout-1", listenerId: "listener-timeout-1", port: 5173, processName: "node.exe", commandLine: `${root} npm run dev` };
  let launches = 0;
  const manager = createRestartManager({
    registry: registry([{ id: "web", root, startCommand: "npm run dev", preferredPort: 5173 }]),
    scanProvider: async () => [current],
    postStopScanProvider: async () => [current],
    stopTimeoutMs: 5,
    pollMs: 1,
    historyWriter: () => {},
    gracefulStop: async () => ({ ok: true }),
    launcher: async () => { launches += 1; return managedLaunchResult(root, 5105, 5173); }
  });
  const result = await manager.restartProject({ projectId: "web", idempotencyKey: "restart-stop-timeout" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "STOP_VERIFICATION_FAILED");
  assert.equal(result.state, "stop-verification-failed");
  assert.equal(result.actionExecuted, true);
  assert.equal(result.stopVerified, false);
  assert.equal(launches, 0);
});

test("restart manager fails closed when the restart port is reassigned during stop verification", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lw-restart-port-owner-"));
  const current = { pid: 45, processInstanceId: "proc-owner-1", listenerId: "listener-owner-1", port: 5173, processName: "node.exe", commandLine: `${root} npm run dev` };
  let launches = 0;
  const manager = createRestartManager({
    registry: registry([{ id: "web", root, startCommand: "npm run dev", preferredPort: 5173 }]),
    scanProvider: async () => [current],
    postStopScanProvider: async () => [{ pid: 99, processInstanceId: "other-process", listenerId: "other-listener", port: 5173 }],
    pollMs: 1,
    historyWriter: () => {},
    gracefulStop: async () => ({ ok: true }),
    launcher: async () => { launches += 1; return managedLaunchResult(root, 5106, 5173); }
  });
  const result = await manager.restartProject({ projectId: "web", idempotencyKey: "restart-port-owner" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "RESTART_PORT_OWNER_CHANGED");
  assert.equal(result.state, "stop-port-owner-changed");
  assert.equal(result.actionExecuted, true);
  assert.equal(launches, 0);
});

test("restart manager reports startup health timeout after a successful stop and start dispatch", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lw-restart-start-timeout-"));
  const current = { pid: 46, processInstanceId: "proc-start-timeout-1", listenerId: "listener-start-timeout-1", port: 5173, processName: "node.exe", commandLine: `${root} npm run dev` };
  const manager = createRestartManager({
    registry: registry([{ id: "web", root, startCommand: "npm run dev", preferredPort: 5173 }]),
    scanProvider: async () => [current],
    postStopScanProvider: async () => [],
    postStartScanProvider: async () => [],
    startupTimeoutMs: 5,
    pollMs: 1,
    historyWriter: () => {},
    gracefulStop: async () => ({ ok: true }),
    launcher: async (request) => managedLaunchResult(request.cwd, 5107, 5173)
  });
  const result = await manager.restartProject({ projectId: "web", idempotencyKey: "restart-start-timeout" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "PROJECT_STARTUP_TIMEOUT");
  assert.equal(result.state, "startup-health-check-failed");
  assert.equal(result.actionExecuted, true);
  assert.equal(result.stopVerified, true);
  assert.equal(result.process.pid, 5107);
});


test("project registry validates duplicate ids and structured start config", () => {
  const root = mkdtempSync(path.join(tmpdir(), "lw-structured-project-"));
  const manager = registry([
    { id: "web", path: root, start: { command: "npm", args: ["run", "dev"], cwd: root, env: { PORT: "5173" }, preferredPort: 5173, portStrategy: "next-available" } },
    { id: "web", path: root, startCommand: "npm run dev" }
  ]);
  const projects = manager.listProjects();
  assert.equal(projects[0].startCommand, "npm");
  assert.deepEqual(projects[0].startArgs, ["run", "dev"]);
  assert.equal(projects[0].startCwd, normalizeProjectRoot(root));
  assert.equal(projects[0].env.PORT, "5173");
  assert.equal(projects[0].portStrategy, "next-available");
  assert.equal(projects[0].valid, false);
  assert.equal(projects[0].validation.problems.some((problem) => problem.code === "PROJECT_ID_DUPLICATE"), true);
});

test("start manager passes next available fallback port to injected launcher", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lw-start-next-port-"));
  const calls = [];
  const manager = createStartManager({
    registry: registry([{ id: "web", path: root, startCommand: "npm run dev", preferredPort: 5173, portStrategy: "next-available" }]),
    scanProvider: async () => [{ port: 5173, commandLine: "other project" }, { port: 5174, commandLine: "other project" }],
    randomId: () => "nextport",
    launcher: async (request) => { calls.push(request); return managedLaunchResult(request.cwd, 5103, request.selectedPort); }
  });
  const result = await manager.startProject({ projectId: "web", idempotencyKey: "next-port" });
  assert.equal(result.ok, true);
  assert.equal(result.project.selectedPort, 5175);
  assert.equal(calls[0].selectedPort, 5175);
});

function managedLaunchResult(cwd, pid, selectedPort) {
  const createdAt = "2026-07-31T18:00:00.000Z";
  return {
    ok: true,
    code: "PROJECT_STARTED",
    contractVersion: MANAGED_LAUNCH_CONTRACT_VERSION,
    pid,
    processInstanceId: buildProcessInstanceId(pid, createdAt),
    processGroupId: pid,
    createdAt,
    processName: "node.exe",
    cwd,
    selectedPort,
    mechanism: "CREATE_NEW_PROCESS_GROUP",
    message: "managed test launch"
  };
}
