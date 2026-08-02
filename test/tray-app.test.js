"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createTrayApp } = require("../src/tray/app");

test("tray app exposes non-destructive menu actions and counts visible servers", async () => {
  const notifications = [];
  const refreshTime = new Date("2026-07-31T12:00:00.000Z");
  const app = createTrayApp({
    scanProvider: async () => [
      { visible: true, lifecycle: { state: "active" } },
      { visible: true, lifecycle: { state: "stale-candidate" } },
      { visible: false, lifecycle: { state: "active" } }
    ],
    notify: (message) => notifications.push(message),
    now: () => refreshTime
  });
  assert.deepEqual(app.menuTemplate().map((item) => item.id), ["open-dashboard", "refresh", "quit"]);
  const status = await app.refreshStatus();
  assert.equal(status.ok, true);
  assert.equal(status.visibleServerCount, 2);
  assert.equal(status.staleServerCount, 1);
  assert.equal(status.lastRefreshAt, refreshTime.toISOString());
  assert.equal(status.actionExecuted, false);
  assert.equal(status.serversTerminated, false);
  assert.equal(notifications[0].type, "stale-dev-server");
});

test("tray native host acceptance handles scanner envelopes, live badge state, and safe quit", async () => {
  const badges = [];
  const nativeCalls = [];
  const notifications = [];
  const app = createTrayApp({
    scanProvider: async () => ({
      ok: true,
      servers: [
        { visible: true, lifecycle: { state: "active" } },
        { visible: false, lifecycle: { state: "active" } }
      ]
    }),
    setBadge: (count) => badges.push(count),
    openDashboard: async () => nativeCalls.push("open"),
    hideWindow: (request) => nativeCalls.push(["hide", request.reason]),
    requestQuit: (request) => nativeCalls.push(["quit", request.reason, request.serversTerminated]),
    notify: (message) => notifications.push(message),
    now: () => new Date("2026-07-31T12:30:00.000Z")
  });

  const refresh = await app.menuAction("refresh");
  assert.equal(refresh.ok, true);
  assert.equal(refresh.visibleServerCount, 1);
  assert.equal(refresh.badgeCount, 1);
  assert.deepEqual(badges, [1]);

  const open = await app.menuAction("open-dashboard");
  const close = app.closeWindow();
  const quit = await app.menuAction("quit");
  assert.equal(open.state, "dashboard-opened");
  assert.equal(close.state, "window-hidden-to-tray");
  assert.equal(quit.state, "watchdog-quit-requested");
  assert.deepEqual(nativeCalls, ["open", ["hide", "window-close"], ["quit", "tray-menu", false]]);
  assert.deepEqual(notifications, []);
  assert.equal(app.getState().serversTerminated, false);
  assert.equal(app.getState().badgeCount, 1);
});

test("tray open and close delegate only to the native window host", async () => {
  let opened = false;
  const hidden = [];
  const app = createTrayApp({ openDashboard: async () => { opened = true; } });
  const open = await app.menuAction("open-dashboard");
  assert.equal(open.state, "dashboard-opened");
  assert.equal(opened, true);
  assert.equal(app.isVisible(), true);
  const closeApp = createTrayApp({
    hideWindow: (request) => hidden.push(request)
  });
  const close = closeApp.closeWindow();
  assert.equal(close.state, "window-hidden-to-tray");
  assert.equal(close.serversTerminated, false);
  assert.deepEqual(hidden, [{ reason: "window-close", serversTerminated: false }]);
  assert.equal(closeApp.closeWindow().state, "window-hidden-to-tray");
  assert.equal(hidden.length, 1);
});

test("tray quit is idempotent and never terminates managed servers", async () => {
  const quitRequests = [];
  const app = createTrayApp({
    requestQuit: (request) => quitRequests.push(request)
  });
  const quit = await app.menuAction("quit");
  assert.equal(quit.state, "watchdog-quit-requested");
  assert.equal(quit.quitRequested, true);
  assert.equal(quit.serversTerminated, false);
  assert.equal(quit.actionExecuted, false);
  assert.deepEqual(quitRequests, [{ reason: "tray-menu", serversTerminated: false }]);

  const repeatedQuit = await app.menuAction("quit");
  assert.equal(repeatedQuit.state, "watchdog-quit-requested");
  assert.equal(quitRequests.length, 1);
  assert.deepEqual(app.getState(), {
    visible: false,
    closedToTray: false,
    quitRequested: true,
    lastRefreshAt: null,
    lastRefreshError: null,
    badgeCount: 0,
    serversTerminated: false,
    actionExecuted: false
  });
});

test("tray refresh reports failures without presenting stale data as current", async () => {
  const notifications = [];
  const app = createTrayApp({
    scanProvider: async () => { throw new Error("scanner unavailable"); },
    notify: (message) => notifications.push(message)
  });
  const status = await app.menuAction("refresh");
  assert.equal(status.ok, false);
  assert.equal(status.code, "TRAY_SCAN_FAILED");
  assert.equal(status.lastRefreshAt, null);
  assert.equal(status.serversTerminated, false);
  assert.deepEqual(notifications, [{ type: "tray-refresh-failed", code: "TRAY_SCAN_FAILED" }]);
  assert.equal(app.getState().lastRefreshError.code, "TRAY_SCAN_FAILED");
});

test("tray host callback failures leave lifecycle state unchanged", async () => {
  const app = createTrayApp({
    openDashboard: async () => { throw new Error("window unavailable"); },
    hideWindow: () => { throw new Error("window unavailable"); },
    requestQuit: async () => { throw new Error("host unavailable"); }
  });
  const open = await app.menuAction("open-dashboard");
  const close = app.closeWindow();
  const quit = await app.menuAction("quit");
  assert.equal(open.code, "TRAY_DASHBOARD_OPEN_FAILED");
  assert.equal(close.code, "TRAY_HIDE_FAILED");
  assert.equal(quit.code, "TRAY_QUIT_REQUEST_FAILED");
  assert.deepEqual(app.getState(), {
    visible: false,
    closedToTray: false,
    quitRequested: false,
    lastRefreshAt: null,
    lastRefreshError: null,
    badgeCount: 0,
    serversTerminated: false,
    actionExecuted: false
  });
});
