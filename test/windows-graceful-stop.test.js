"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createWindowsGracefulStopDispatcher } = require("../src/actions/windows-graceful-stop");

test("Windows graceful-stop dispatcher fails closed off Windows", async () => {
  const dispatch = createWindowsGracefulStopDispatcher({ platform: "linux" });
  const result = await dispatch({ pid: 1234, processName: "node.exe" });
  assert.deepEqual(result, {
    ok: false,
    code: "STOP_BACKEND_UNAVAILABLE",
    message: "Windows graceful stop is unavailable on this platform."
  });
});

test("Windows graceful-stop dispatcher rejects unsupported runtimes before dispatch", async () => {
  const dispatch = createWindowsGracefulStopDispatcher({ platform: "win32", scriptPath: "missing-helper.ps1" });
  const result = await dispatch({ pid: 1234, processName: "services.exe" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "STOP_PROCESS_UNSUPPORTED");
});

test("Windows graceful-stop dispatcher rejects invalid verified PIDs before dispatch", async () => {
  const dispatch = createWindowsGracefulStopDispatcher({ platform: "win32", scriptPath: "missing-helper.ps1" });
  const result = await dispatch({ pid: "not-a-pid", processName: "node.exe" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "STOP_TARGET_INVALID");
});
