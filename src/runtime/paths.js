"use strict";

const path = require("node:path");

const SOURCE_ROOT = path.resolve(__dirname, "..", "..");
const DATA_DIRECTORY_NAME = "Localhost Watchdog";

function resolveRuntimePaths(options = {}) {
  const explicitRoot = options.root || options.appRoot;
  const appRoot = path.resolve(explicitRoot || process.env.LOCALHOST_WATCHDOG_APP_ROOT || SOURCE_ROOT);
  const configuredDataRoot = options.dataRoot || process.env.LOCALHOST_WATCHDOG_DATA_DIR;
  const dataRoot = path.resolve(configuredDataRoot || (explicitRoot ? appRoot : path.join(SOURCE_ROOT, ".localhost-watchdog")));

  return {
    appRoot,
    dataRoot,
    configRoot: path.join(dataRoot, "config"),
    bundledConfigRoot: path.join(appRoot, "config"),
    trayLogRoot: path.join(dataRoot, "tray"),
    historyPath: path.join(dataRoot, "history.json"),
    dryRunAuditPath: path.join(dataRoot, "dry-run-audit.jsonl"),
    confirmationAuditPath: path.join(dataRoot, "confirmation-audit.jsonl"),
    executionAuditPath: path.join(dataRoot, "execution-audit.jsonl"),
    restartHistoryPath: path.join(dataRoot, "restart-history.jsonl")
  };
}

function defaultInstalledDataRoot() {
  const localAppData = process.env.LOCALAPPDATA;
  return localAppData
    ? path.join(localAppData, DATA_DIRECTORY_NAME)
    : path.join(SOURCE_ROOT, ".localhost-watchdog");
}

module.exports = {
  DATA_DIRECTORY_NAME,
  SOURCE_ROOT,
  defaultInstalledDataRoot,
  resolveRuntimePaths
};
