"use strict";

const { scanWindows } = require("../scanner/windows");

function createTrayApp(options = {}) {
  const scanProvider = options.scanProvider || (() => scanWindows({ skipHistory: true }));
  const openDashboard = options.openDashboard || noop;
  const notify = options.notify || noop;
  let visible = false;
  let closedToTray = false;
  let quitRequested = false;

  async function refreshStatus() {
    const records = await safeScan(scanProvider);
    const visibleRecords = records.filter((record) => record.visible !== false);
    const staleRecords = visibleRecords.filter((record) => record.lifecycle && record.lifecycle.state === "stale-candidate");
    if (staleRecords.length > 0) notify({ type: "stale-dev-server", count: staleRecords.length });
    return {
      ok: true,
      schemaVersion: "localhost-watchdog.tray-status.v1",
      visibleServerCount: visibleRecords.length,
      staleServerCount: staleRecords.length,
      closedToTray,
      quitRequested,
      actionExecuted: false
    };
  }

  async function menuAction(action) {
    if (action === "open-dashboard") {
      visible = true;
      closedToTray = false;
      await openDashboard();
      return { ok: true, state: "dashboard-opened", actionExecuted: false };
    }
    if (action === "refresh") return refreshStatus();
    if (action === "quit") {
      quitRequested = true;
      return { ok: true, state: "watchdog-quit-requested", serversTerminated: false, actionExecuted: false };
    }
    return { ok: false, code: "UNKNOWN_TRAY_ACTION", message: "Tray action is not supported.", actionExecuted: false };
  }

  function closeWindow() {
    visible = false;
    closedToTray = true;
    return { ok: true, state: "window-hidden-to-tray", serversTerminated: false, actionExecuted: false };
  }

  function menuTemplate() {
    return [
      { id: "open-dashboard", label: "Open Watchdog" },
      { id: "refresh", label: "Refresh" },
      { id: "quit", label: "Quit" }
    ];
  }

  return { closeWindow, menuAction, menuTemplate, refreshStatus, isVisible: () => visible };
}

async function safeScan(scanProvider) {
  try {
    const result = await scanProvider();
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

function noop() {}

module.exports = { createTrayApp };
