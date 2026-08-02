"use strict";

const { createTrayApp } = require("./app");

const TRAY_ACTIONS = Object.freeze(["open-dashboard", "refresh", "quit"]);

/**
 * Stable boundary for a native tray host (Tauri, Win32, or another shell).
 * This module owns no process-control capability; it only forwards tray/window
 * events to the reusable tray application and returns safe lifecycle state.
 */
function createTrayNativeHost(options = {}) {
  const app = options.app || createTrayApp(options);

  async function initialize() {
    const status = await app.refreshStatus();
    return bridgeResult({
      ok: status.ok,
      state: "tray-ready",
      status,
      menu: app.menuTemplate(),
      trayState: app.getState()
    });
  }

  async function dispatchMenuAction(action) {
    if (!TRAY_ACTIONS.includes(action)) {
      return bridgeResult({
        ok: false,
        code: "UNKNOWN_TRAY_ACTION",
        message: "Tray action is not supported."
      });
    }
    return bridgeResult(await app.menuAction(action));
  }

  function dispatchWindowClose() {
    return bridgeResult(app.closeWindow());
  }

  function state() {
    return bridgeResult({ ok: true, trayState: app.getState() });
  }

  return { dispatchMenuAction, dispatchWindowClose, initialize, state };
}

function bridgeResult(result = {}) {
  return {
    ...result,
    actionExecuted: result.actionExecuted === true,
    serversTerminated: false
  };
}

module.exports = { TRAY_ACTIONS, createTrayNativeHost };
