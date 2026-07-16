"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const test = require("node:test");
const { createProjectRegistry } = require("../src/project/registry");
const { normalizePath, redactConfiguredPath } = require("../src/config/load");
const { createStartManager } = require("../src/actions/start");
const { createRestartManager } = require("../src/actions/restart");

function registry(projects) {
  return createProjectRegistry({ configProvider: () => ({ projects: { projects } }) });
}

test("project registry normalizes managed projects and keeps raw paths out of display fields", () => {
  const root = mkdtempSync(path.join(tmpdir(), "lw-managed-project-"));
  const manager = registry([{ id: "web", name: "Web", path: root, startCommand: "npm run dev", preferredPort: 5173, portStrategy: "strict", tags: ["ui"] }]);
  const [project] = manager.listProjects();
  assert.equal(project.id, "web");
  assert.equal(project.valid, true);
  assert.equal(project.path, normalizePath(root));
  assert.equal(project.displayPath, redactConfiguredPath(root));
  assert.equal(project.preferredPort, 5173);
});

test("start manager fails closed without an injected launcher", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lw-start-project-"));
  const manager = createStartManager({ registry: registry([{ id: "web", path: root, startCommand: "npm run dev" }]), scanProvider: async () => [] });
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
    launcher: async (request) => { calls.push(request); return { ok: true }; }
  });
  const first = await manager.startProject({ projectId: "web", idempotencyKey: "same" });
  const second = await manager.startProject({ projectId: "web", idempotencyKey: "same" });
  assert.equal(first.ok, true);
  assert.equal(first.actionExecuted, true);
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].project.id, "web");
});

test("restart manager stops, verifies disappearance, then dispatches managed start", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lw-restart-project-"));
  const calls = [];
  const scanRecord = { pid: 42, processInstanceId: "proc-1", listenerId: "listener-1", port: 5173, processName: "node", commandLine: `${root} npm run dev` };
  const manager = createRestartManager({
    registry: registry([{ id: "web", path: root, startCommand: "npm run dev", preferredPort: 5173 }]),
    scanProvider: async () => [scanRecord],
    postStopScanProvider: async () => [],
    postStartScanProvider: async () => [],
    randomId: () => "def456",
    gracefulStop: async (request) => { calls.push(["stop", request.listenerId]); return { ok: true }; },
    launcher: async (request) => { calls.push(["start", request.project.id]); return { ok: true }; }
  });
  const result = await manager.restartProject({ projectId: "web", listenerId: "listener-1", processInstanceId: "proc-1", idempotencyKey: "restart-1" });
  assert.equal(result.ok, true);
  assert.equal(result.state, "restart-completed");
  assert.equal(result.actionExecuted, true);
  assert.deepEqual(calls, [["stop", "listener-1"], ["start", "web"]]);
});

