"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const test = require("node:test");
const { createAdoptionManager } = require("../src/project/adoption");
const { createRestartManager } = require("../src/actions/restart");
const { createProjectRegistry } = require("../src/project/registry");
const { MANAGED_LAUNCH_CONTRACT_VERSION, buildProcessInstanceId } = require("../src/project/managed-contract");

test("Phase 7 adoption persists a project that Phase 6 can restart", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lw-adopt-restart-"));
  const config = {
    projects: { projects: [] },
    safety: { protectedProcesses: [], protectedPorts: [], protectedPortRanges: [] }
  };
  const registry = createProjectRegistry({ configProvider: () => config });
  const adoption = createAdoptionManager({
    registry,
    configProvider: () => config,
    randomId: () => "fixture",
    configWriter: async ({ project }) => {
      config.projects.projects.push(project);
      return { ok: true };
    }
  });
  const detected = {
    confidenceScore: 92,
    confidenceLevel: "high",
    category: "node-dev-server",
    processName: "node.exe",
    commandLine: "node server.js",
    host: "127.0.0.1",
    port: 5173,
    project: { name: "Adopted Fixture", root, workingDirectory: root }
  };

  const adopted = await adoption.adoptProject({
    record: detected,
    project: { id: "adopted-fixture", name: "Adopted Fixture" }
  });
  assert.equal(adopted.ok, true, JSON.stringify(adopted));
  assert.equal(adopted.state, "project-adopted");
  assert.equal(adopted.project.managed, true);
  assert.equal(adopted.project.displayRoot, root);
  assert.equal(config.projects.projects.length, 1);

  const current = {
    pid: 6201,
    processInstanceId: "pid-6201-created-before-restart",
    listenerId: "listener-before-restart",
    port: 5173,
    processName: "node.exe",
    project: { id: adopted.project.id, root }
  };
  let postStartCalls = 0;
  const stopRequests = [];
  const history = [];
  const restart = createRestartManager({
    registry,
    scanProvider: async () => ({ ok: true, servers: [current] }),
    postStopScanProvider: async () => ({ ok: true, servers: [] }),
    postStartScanProvider: async () => {
      postStartCalls += 1;
      if (postStartCalls === 1) return { ok: true, servers: [] };
      return {
        ok: true,
        servers: [{
          pid: 6202,
          processInstanceId: buildProcessInstanceId(6202, "2026-07-31T19:00:00.000Z"),
          listenerId: "listener-after-restart",
          port: 5173,
          processName: "node.exe",
          project: { id: adopted.project.id, root }
        }]
      };
    },
    gracefulStop: async (request) => {
      stopRequests.push(request);
      return { ok: true };
    },
    launcher: async (request) => managedLaunchResult(request.cwd, 6202, request.selectedPort),
    historyWriter: (entry) => history.push(entry),
    startupTimeoutMs: 50,
    stopTimeoutMs: 50,
    pollMs: 1
  });

  const result = await restart.restartProject({
    projectId: adopted.project.id,
    listenerId: current.listenerId,
    processInstanceId: current.processInstanceId,
    idempotencyKey: "adopted-fixture-restart"
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.projectId, adopted.project.id);
  assert.equal(result.project.root, adopted.project.root);
  assert.equal(result.startupHealth.ok, true);
  assert.equal(result.process.processInstanceId, buildProcessInstanceId(6202, "2026-07-31T19:00:00.000Z"));
  assert.equal(stopRequests[0].processInstanceId, current.processInstanceId);
  assert.equal(history[0].state, "restart-completed");
});

function managedLaunchResult(cwd, pid, selectedPort) {
  const createdAt = "2026-07-31T19:00:00.000Z";
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
    message: "managed adoption acceptance launch"
  };
}
