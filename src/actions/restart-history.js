"use strict";

const { appendFileSync, mkdirSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { resolveRuntimePaths } = require("../runtime/paths");

const DEFAULT_HISTORY_PATH = resolveRuntimePaths().restartHistoryPath;

function createRestartHistory(options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 100;
  const clock = options.clock || (() => new Date());
  const writer = options.historyWriter || ((entry) => writeRestartHistory(entry, { filePath: options.historyPath }));
  const entries = [];

  function record(result, context = {}) {
    const entry = {
      schemaVersion: "localhost-watchdog.project-action-history.v1",
      recordType: "project-restart",
      timestamp: clock().toISOString(),
      actionRequestId: result.actionRequestId || null,
      projectId: result.projectId || context.projectId || null,
      state: result.state || (result.ok ? "restart-completed" : "restart-failed"),
      code: result.code || null,
      actionExecuted: result.actionExecuted === true,
      executionAuthorized: result.executionAuthorized === true,
      stopVerified: result.stopVerified === true,
      startupHealthy: result.startupHealth && result.startupHealth.ok === true,
      port: result.startupHealth && result.startupHealth.port || context.port || null,
      processInstanceId: result.process && result.process.processInstanceId || null
    };
    entries.push(entry);
    while (entries.length > limit) entries.shift();
    try { writer(entry); } catch { /* History must not change the action outcome. */ }
    return entry;
  }

  return { list: () => entries.slice(), record };
}

function writeRestartHistory(entry, options = {}) {
  const filePath = options.filePath || resolveRuntimePaths().restartHistoryPath;
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { encoding: "utf8" });
}

module.exports = { DEFAULT_HISTORY_PATH, createRestartHistory, writeRestartHistory };
