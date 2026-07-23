"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const test = require("node:test");
const { createProjectRegistry } = require("../src/project/registry");
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
  assert.equal(project.path, root);
  assert.equal(project.displayPath, root);
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


test("project registry validates duplicate ids and structured start config", () => {
  const root = mkdtempSync(path.join(tmpdir(), "lw-structured-project-"));
  const manager = registry([
    { id: "web", path: root, start: { command: "npm", args: ["run", "dev"], cwd: root, env: { PORT: "5173" }, preferredPort: 5173, portStrategy: "next-available" } },
    { id: "web", path: root, startCommand: "npm run dev" }
  ]);
  const projects = manager.listProjects();
  assert.equal(projects[0].startCommand, "npm");
  assert.deepEqual(projects[0].startArgs, ["run", "dev"]);
  assert.equal(projects[0].startCwd, root);
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
    launcher: async (request) => { calls.push(request); return { ok: true }; }
  });
  const result = await manager.startProject({ projectId: "web", idempotencyKey: "next-port" });
  assert.equal(result.ok, true);
  assert.equal(result.project.selectedPort, 5175);
  assert.equal(calls[0].selectedPort, 5175);
});
