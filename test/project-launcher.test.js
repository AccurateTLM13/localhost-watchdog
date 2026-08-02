"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { mkdtempSync, writeFileSync } = fs;
const { tmpdir } = require("node:os");
const test = require("node:test");
const { createStartManager } = require("../src/actions/start");
const { createManagedProjectLauncher } = require("../src/project/launcher");
const { createProjectRegistry } = require("../src/project/registry");
const { createWindowsGracefulStopDispatcher } = require("../src/actions/windows-graceful-stop");

test("managed launcher fails closed off Windows", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lw-launcher-platform-"));
  const launcher = createManagedProjectLauncher({ platform: "linux" });
  const result = await launcher({ cwd: root, command: process.execPath, args: [] });
  assert.equal(result.ok, false);
  assert.equal(result.code, "PROJECT_START_BACKEND_UNAVAILABLE");
  assert.equal(result.actionExecuted, false);
});

test("managed launcher preserves direct executable arguments and process-group contract", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lw-launcher-unit-"));
  const executable = path.join(root, "node.exe");
  writeFileSync(executable, "fixture");
  const calls = [];
  const launcher = createManagedProjectLauncher({
    platform: "win32",
    runner: async (request) => {
      calls.push(request);
      return "3210|2026-07-31T18:00:00.000Z";
    }
  });

  const result = await launcher({
    cwd: root,
    command: executable,
    args: ["server.js", "--port", "5173"],
    env: { PORT: "5173" },
    selectedPort: 5173
  });

  assert.equal(result.ok, true);
  assert.equal(result.pid, 3210);
  assert.equal(result.processGroupId, 3210);
  assert.equal(result.processInstanceId, "pid-3210-created-2026-07-31t18-00-00-000z");
  assert.equal(result.mechanism, "CREATE_NEW_PROCESS_GROUP");
  assert.equal(calls[0].cwd, root);
  assert.deepEqual(calls[0].args, ["server.js", "--port", "5173"]);
  assert.equal(calls[0].env.PORT, "5173");
});

test("managed launcher rejects shell wrappers that cannot preserve target ownership", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lw-launcher-wrapper-"));
  const wrapper = path.join(root, "npm.cmd");
  writeFileSync(wrapper, "@echo off");
  const launcher = createManagedProjectLauncher({ platform: "win32", runner: async () => { throw new Error("runner should not be called"); } });
  const result = await launcher({ cwd: root, command: wrapper, args: ["run", "dev"] });
  assert.equal(result.ok, false);
  assert.equal(result.code, "PROJECT_START_WRAPPER_UNSUPPORTED");
  assert.equal(result.actionExecuted, false);
});

test("managed launcher rejects direct runtimes outside the graceful-stop contract", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lw-launcher-runtime-"));
  const executable = path.join(root, "custom-runtime.exe");
  writeFileSync(executable, "fixture");
  const launcher = createManagedProjectLauncher({ platform: "win32", runner: async () => "3210|2026-07-31T18:00:00.000Z" });
  const result = await launcher({ cwd: root, command: executable, args: [] });
  assert.equal(result.ok, false);
  assert.equal(result.code, "PROJECT_START_RUNTIME_UNSUPPORTED");
  assert.equal(result.actionExecuted, false);
});

test("default managed start launches a disposable fixture in its configured cwd and returns Phase 4 identity", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows process-group integration coverage");

  const root = mkdtempSync(path.join(tmpdir(), "lw-managed-fixture-"));
  const fixturePath = path.join(__dirname, "fixtures", "server.js");
  const token = "phase5-fixture-token";
  const port = 45000 + Math.floor(Math.random() * 1000);
  const registry = createProjectRegistry({
    configProvider: () => ({
      projects: {
        projects: [{
          id: "fixture",
          path: root,
          start: {
            command: process.execPath,
            args: [fixturePath, token, String(port)]
          },
          preferredPort: port,
          portStrategy: "strict"
        }]
      }
    })
  });
  const manager = createStartManager({ registry, scanProvider: async () => [] });
  let startedPid = null;

  try {
    const result = await manager.startProject({ projectId: "fixture", idempotencyKey: "phase5-fixture-start" });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.process.mechanism, "CREATE_NEW_PROCESS_GROUP");
    assert.equal(result.process.processGroupId, result.process.pid);
    startedPid = result.process.pid;
    await waitForPort(port);

    const stop = createWindowsGracefulStopDispatcher();
    const stopResult = await stop({
      pid: result.process.pid,
      processName: result.process.processName,
      createdAt: result.process.createdAt,
      port
    });
    assert.equal(stopResult.ok, true, JSON.stringify(stopResult));
    await waitForPortClosed(port);
  } finally {
    if (startedPid) {
      try { process.kill(startedPid, "SIGKILL"); } catch {}
    }
  }
});

function waitForPort(port, timeoutMs = 7000) {
  return pollPort(port, true, timeoutMs);
}

function waitForPortClosed(port, timeoutMs = 7000) {
  return pollPort(port, false, timeoutMs);
}

function pollPort(port, expectedOpen, timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const request = http.get({ host: "127.0.0.1", port, path: "/" }, (response) => {
        response.resume();
        response.on("end", () => {
          if (expectedOpen) return resolve();
          setTimeout(poll, 50);
        });
      });
      request.setTimeout(250, () => request.destroy());
      request.on("error", () => {
        if (!expectedOpen) return resolve();
        if (Date.now() - startedAt >= timeoutMs) return reject(new Error("Timed out waiting for fixture port " + port));
        setTimeout(poll, 50);
      });
      if (Date.now() - startedAt >= timeoutMs) {
        request.destroy();
        reject(new Error("Timed out waiting for fixture port " + port));
      }
    };
    poll();
  });
}
