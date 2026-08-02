"use strict";

const { scanWindows } = require("../scanner/windows");

function createTrayApp(options = {}) {
  const scanProvider = options.scanProvider || (() => scanWindows({ skipHistory: true }));
  const openDashboard = options.openDashboard || noop;
  const hideWindow = options.hideWindow || noop;
  const requestQuit = options.requestQuit || noop;
  const setBadge = options.setBadge || noop;
  const notify = options.notify || noop;
  const now = options.now || (() => new Date());
  let visible = false;
  let closedToTray = false;
  let quitRequested = false;
  let lastRefreshAt = null;
  let lastRefreshError = null;
  let badgeCount = 0;

  function updateBadge(count) {
    const nextCount = Number.isInteger(count) && count >= 0 ? count : 0;
    try {
      setBadge(nextCount);
      badgeCount = nextCount;
    } catch {
      safeNotify(notify, { type: "tray-badge-update-failed" });
    }
  }

  async function refreshStatus() {
    const scan = await safeScan(scanProvider);
    if (!scan.ok) {
      lastRefreshError = scan.error;
      updateBadge(0);
      safeNotify(notify, { type: "tray-refresh-failed", code: scan.error.code });
      return {
        ok: false,
        code: scan.error.code,
        message: scan.error.message,
        schemaVersion: "localhost-watchdog.tray-status.v1",
        visibleServerCount: 0,
        staleServerCount: 0,
        badgeCount,
        closedToTray,
        quitRequested,
        lastRefreshAt,
        actionExecuted: false,
        serversTerminated: false
      };
    }

    lastRefreshAt = timestamp(now());
    lastRefreshError = null;
    const records = scan.records;
    const visibleRecords = records.filter((record) => record.visible !== false);
    const staleRecords = visibleRecords.filter((record) => record.lifecycle && record.lifecycle.state === "stale-candidate");
    updateBadge(visibleRecords.length);
    if (staleRecords.length > 0) safeNotify(notify, { type: "stale-dev-server", count: staleRecords.length });
    return {
      ok: true,
      schemaVersion: "localhost-watchdog.tray-status.v1",
      visibleServerCount: visibleRecords.length,
      staleServerCount: staleRecords.length,
      badgeCount,
      closedToTray,
      quitRequested,
      lastRefreshAt,
      actionExecuted: false,
      serversTerminated: false
    };
  }

  async function openDashboardAction() {
    try {
      await openDashboard();
    } catch {
      return {
        ok: false,
        code: "TRAY_DASHBOARD_OPEN_FAILED",
        message: "The Watchdog dashboard could not be opened.",
        actionExecuted: false,
        serversTerminated: false
      };
    }

    visible = true;
    closedToTray = false;
    return {
      ok: true,
      state: "dashboard-opened",
      actionExecuted: false,
      serversTerminated: false
    };
  }

  async function requestQuitAction() {
    if (quitRequested) {
      return {
        ok: true,
        state: "watchdog-quit-requested",
        quitRequested: true,
        serversTerminated: false,
        actionExecuted: false
      };
    }

    try {
      await requestQuit({ reason: "tray-menu", serversTerminated: false });
    } catch {
      return {
        ok: false,
        code: "TRAY_QUIT_REQUEST_FAILED",
        message: "The Watchdog tray host could not be asked to quit.",
        quitRequested: false,
        serversTerminated: false,
        actionExecuted: false
      };
    }

    quitRequested = true;
    visible = false;
    closedToTray = false;
    return {
      ok: true,
      state: "watchdog-quit-requested",
      quitRequested: true,
      serversTerminated: false,
      actionExecuted: false
    };
  }

  async function menuAction(action) {
    if (action === "open-dashboard") {
      return openDashboardAction();
    }
    if (action === "refresh") return refreshStatus();
    if (action === "quit") return requestQuitAction();
    return { ok: false, code: "UNKNOWN_TRAY_ACTION", message: "Tray action is not supported.", actionExecuted: false };
  }

  function closeWindow() {
    if (closedToTray) {
      return { ok: true, state: "window-hidden-to-tray", serversTerminated: false, actionExecuted: false };
    }

    try {
      hideWindow({ reason: "window-close", serversTerminated: false });
    } catch {
      return {
        ok: false,
        code: "TRAY_HIDE_FAILED",
        message: "The Watchdog window could not be hidden to the tray.",
        serversTerminated: false,
        actionExecuted: false
      };
    }

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

  function getState() {
    return {
      visible,
      closedToTray,
      quitRequested,
      lastRefreshAt,
      lastRefreshError,
      badgeCount,
      serversTerminated: false,
      actionExecuted: false
    };
  }

  return { closeWindow, getState, menuAction, menuTemplate, refreshStatus, isVisible: () => visible };
}

async function safeScan(scanProvider) {
  try {
    const result = await scanProvider();
    if (Array.isArray(result)) return { ok: true, records: result };
    if (result && Array.isArray(result.servers) && result.ok !== false) {
      return { ok: true, records: result.servers };
    }
    if (!result || !Array.isArray(result.servers)) {
      return {
        ok: false,
        error: {
          code: result && result.code || "TRAY_SCAN_INVALID",
          message: result && result.message || "Watchdog refresh returned an invalid server snapshot."
        }
      };
    }
    return {
      ok: false,
      error: {
        code: result.code || "TRAY_SCAN_FAILED",
        message: result.message || "Watchdog could not refresh the local server snapshot."
      }
    };
  } catch {
    return {
      ok: false,
      error: {
        code: "TRAY_SCAN_FAILED",
        message: "Watchdog could not refresh the local server snapshot."
      }
    };
  }
}

function safeNotify(notify, message) {
  try {
    notify(message);
  } catch {
    // Notifications are advisory and must not change tray state or action results.
  }
}

function timestamp(now) {
  try {
    const value = now instanceof Date ? now : new Date(now);
    return value.toISOString();
  } catch {
    return null;
  }
}

function noop() {}

module.exports = { createTrayApp };
