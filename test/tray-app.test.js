"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createTrayApp } = require("../src/tray/app");

test("tray app exposes non-destructive menu actions and counts visible servers", async () => {
  const notifications = [];
  const app = createTrayApp({
    scanProvider: async () => [
      { visible: true, lifecycle: { state: "active" } },
      { visible: true, lifecycle: { state: "stale-candidate" } },
      { visible: false, lifecycle: { state: "active" } }
    ],
    notify: (message) => notifications.push(message)
  });
  assert.deepEqual(app.menuTemplate().map((item) => item.id), ["open-dashboard", "refresh", "quit"]);
  const status = await app.refreshStatus();
  assert.equal(status.visibleServerCount, 2);
  assert.equal(status.staleServerCount, 1);
  assert.equal(status.actionExecuted, false);
  assert.equal(notifications[0].type, "stale-dev-server");
});

test("tray close and quit never terminate managed servers", async () => {
  let opened = false;
  const app = createTrayApp({ openDashboard: async () => { opened = true; } });
  const open = await app.menuAction("open-dashboard");
  assert.equal(open.state, "dashboard-opened");
  assert.equal(opened, true);
  assert.equal(app.isVisible(), true);
  const close = app.closeWindow();
  assert.equal(close.state, "window-hidden-to-tray");
  assert.equal(close.serversTerminated, false);
  const quit = await app.menuAction("quit");
  assert.equal(quit.state, "watchdog-quit-requested");
  assert.equal(quit.serversTerminated, false);
  assert.equal(quit.actionExecuted, false);
});
