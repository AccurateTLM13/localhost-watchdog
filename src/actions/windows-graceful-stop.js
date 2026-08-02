"use strict";

const { execFile } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const { MANAGED_PROCESS_NAMES, normalizeManagedProcessName } = require("../project/managed-contract");

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 5000;
const SCRIPT_PATH = path.join(__dirname, "windows-graceful-stop.ps1");

const SUPPORTED_PROCESS_NAMES = MANAGED_PROCESS_NAMES;

function createWindowsGracefulStopDispatcher(options = {}) {
  const platform = options.platform || process.platform;
  const powerShellPath = options.powerShellPath || "powershell.exe";
  const scriptPath = options.scriptPath || SCRIPT_PATH;
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;

  return async function dispatchGracefulStop(target = {}) {
    if (platform !== "win32") {
      return failure("STOP_BACKEND_UNAVAILABLE", "Windows graceful stop is unavailable on this platform.");
    }

    const pid = Number(target.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      return failure("STOP_TARGET_INVALID", "The verified process ID is invalid.");
    }

    const processName = normalizeProcessName(target.processName);
    if (!SUPPORTED_PROCESS_NAMES.has(processName)) {
      return failure("STOP_PROCESS_UNSUPPORTED", "The verified process runtime does not support a safe graceful stop signal.");
    }

    if (!existsSync(scriptPath)) {
      return failure("STOP_BACKEND_UNAVAILABLE", "The Windows graceful stop helper is unavailable.");
    }

    try {
      await execFileAsync(powerShellPath, [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        scriptPath,
        "-TargetPid",
        String(pid),
        "-ProcessName",
        processName,
        "-CreatedAt",
        String(target.createdAt || ""),
        "-Port",
        String(Number(target.port) || 0)
      ], {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024
      });
      return { ok: true, code: "STOP_SIGNAL_SENT", mechanism: "windows-graceful-stop" };
    } catch (error) {
      return failure(codeForHelperError(error), messageForHelperError(error));
    }
  };
}

function normalizeProcessName(value) {
  return normalizeManagedProcessName(value);
}

function codeForHelperError(error) {
  if (error && error.code === "ENOENT") return "STOP_BACKEND_UNAVAILABLE";
  if (error && error.killed) return "STOP_SIGNAL_TIMEOUT";
  const exitCode = Number(error && error.code);
  return ({
    10: "STOP_TARGET_EXITED",
    11: "STOP_TARGET_IDENTITY_CHANGED",
    12: "STOP_PORT_OWNER_CHANGED",
    13: "STOP_CONSOLE_UNAVAILABLE",
    14: "STOP_SIGNAL_FAILED",
    15: "STOP_SIGNAL_FAILED",
    16: "STOP_SIGNAL_FAILED"
  })[exitCode] || "STOP_SIGNAL_FAILED";
}

function messageForHelperError(error) {
  const code = codeForHelperError(error);
  return ({
    STOP_BACKEND_UNAVAILABLE: "The Windows graceful stop helper is unavailable.",
    STOP_SIGNAL_TIMEOUT: "The Windows graceful stop helper timed out without completing.",
    STOP_TARGET_EXITED: "The verified process exited before the graceful stop signal was sent.",
    STOP_TARGET_IDENTITY_CHANGED: "The process identity changed before the graceful stop signal was sent.",
    STOP_PORT_OWNER_CHANGED: "The verified listener is no longer owned by the verified process.",
    STOP_CONSOLE_UNAVAILABLE: "The verified process does not expose a safe console-control signal path.",
    STOP_SIGNAL_FAILED: "The verified process did not accept the graceful stop signal."
  })[code] || "The verified process did not accept the graceful stop signal.";
}

function failure(code, message) {
  return { ok: false, code, message };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  SUPPORTED_PROCESS_NAMES,
  createWindowsGracefulStopDispatcher
};
