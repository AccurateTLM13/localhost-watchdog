"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createTrayNativeHost } = require("../src/tray/native-host");

test("native tray host initializes from the scanner envelope and exposes safe menu state", async () => {
  const calls = [];
  const host = createTrayNativeHost({
    scanProvider: async () => ({ ok: true, servers: [{ visible: true, lifecycle: { state: "active" } }] }),
    setBadge: (count) => calls.push(["badge", count]),
    openDashboard: async () => calls.push(["open"]),
    hideWindow: (request) => calls.push(["hide", request.reason]),
    requestQuit: (request) => calls.push(["quit", request.reason, request.serversTerminated])
  });

  const ready = await host.initialize();
  assert.equal(ready.ok, true);
  assert.equal(ready.state, "tray-ready");
  assert.deepEqual(ready.menu.map((item) => item.id), ["open-dashboard", "refresh", "quit"]);
  assert.equal(ready.status.visibleServerCount, 1);
  assert.equal(ready.trayState.badgeCount, 1);
  assert.equal(ready.serversTerminated, false);

  const open = await host.dispatchMenuAction("open-dashboard");
  const close = host.dispatchWindowClose();
  const quit = await host.dispatchMenuAction("quit");
  assert.equal(open.state, "dashboard-opened");
  assert.equal(close.state, "window-hidden-to-tray");
  assert.equal(quit.state, "watchdog-quit-requested");
  assert.deepEqual(calls, [["badge", 1], ["open"], ["hide", "window-close"], ["quit", "tray-menu", false]]);
  assert.equal(quit.actionExecuted, false);
  assert.equal(quit.serversTerminated, false);
});

test("native tray host rejects unsupported actions without touching lifecycle state", async () => {
  const host = createTrayNativeHost({ scanProvider: async () => ({ ok: true, servers: [] }) });
  const result = await host.dispatchMenuAction("stop-all");
  assert.equal(result.ok, false);
  assert.equal(result.code, "UNKNOWN_TRAY_ACTION");
  assert.equal(result.actionExecuted, false);
  assert.equal(result.serversTerminated, false);
  assert.equal((await host.state()).trayState.quitRequested, false);
});
