"use strict";

const { execFile } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { promisify } = require("node:util");
const { attachActionEligibilityToSnapshot } = require("../actions/eligibility");
const { loadWatchdogConfig } = require("../config/load");
const { applyHistoryToSnapshot } = require("../history/store");
const { safeError, safeErrorMessage } = require("../privacy/errors");
const { attachLifecycleContext } = require("../process/lifecycle");
const { enrichWithHttpProbes } = require("./probe");
const {
  normalizeConnections,
  parseJsonArray,
  parseNetstatOutput,
  parsePowerShellTcpConnections,
  parseWindowsProcesses
} = require("./normalize");

const execFileAsync = promisify(execFile);
const POWERSHELL = process.env.LOCALHOST_WATCHDOG_POWERSHELL || resolveWindowsCommand("WindowsPowerShell\\v1.0\\powershell.exe", "powershell.exe");
const NETSTAT = resolveWindowsCommand("netstat.exe", "netstat.exe");
let lastScanDiagnostics = null;

async function scanWindows(options = {}) {
  const now = options.now || new Date();
  const startedAt = now;
  const runner = options.runner || runCommand;
  const config = options.config || loadWatchdogConfig();
  const errors = [];

  let connections = [];
  let rawSource = "powershell";

  try {
    const tcpOutput = await runner(POWERSHELL, [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "$ErrorActionPreference='Stop'; Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess,State | ConvertTo-Json -Depth 4"
    ]);
    connections = parsePowerShellTcpConnections(tcpOutput);
  } catch (error) {
    errors.push(safeError("Get-NetTCPConnection", error));
  }

  if (connections.length === 0) {
    try {
      const netstatOutput = await runner(NETSTAT, ["-ano"]);
      connections = parseNetstatOutput(netstatOutput);
      rawSource = "netstat";
  } catch (error) {
      errors.push(safeError("netstat -ano", error));
    }
  }

  let processes = new Map();
  try {
    const processOutput = await runner(POWERSHELL, [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath,CreationDate | ConvertTo-Json -Depth 4"
    ]);
    processes = parseWindowsProcesses(processOutput);
  } catch (error) {
    errors.push(safeError("Get-CimInstance Win32_Process", error));
  }

  const normalized = normalizeConnections(connections, processes, {
    now,
    config,
    rawSource,
    processTreeMaxDepth: config.safety.processTree ? config.safety.processTree.maxDepth : 5
  });
  const probedServers = options.skipHttpProbe
    ? normalized.visible
    : await enrichWithHttpProbes(normalized.visible, {
      timeoutMs: config.safety.httpProbeTimeoutMs,
      maxRedirects: config.safety.httpProbeMaxRedirects
    });
  const servers = probedServers.map((record) => attachLifecycleContext(record, { config }));

  const snapshot = {
    ok: true,
    generatedAt: now.toISOString(),
    platform: "win32",
    scanner: {
      primary: "Get-NetTCPConnection",
      processMetadata: "Get-CimInstance Win32_Process",
      fallback: "netstat -ano",
      destructiveActionsAvailable: false
    },
    config: {
      devRoots: config.safety.devRootsDisplay || []
    },
    servers,
    hidden: normalized.hidden,
    totals: {
      scanned: normalized.total,
      visible: servers.length,
      hidden: normalized.total - normalized.visible.length
    },
    errors
  };
  const scanEndedAt = new Date();

  if (options.skipHistory) {
    const result = attachActionEligibilityToSnapshot(applyHistoryToSnapshot(snapshot, {
      now,
      config: {
        safety: {
          history: {
            enabled: false
          }
        }
      }
    }));
    recordLastScanDiagnostics(result, { startedAt, endedAt: scanEndedAt, rawSource, errors, options });
    return result;
  }

  try {
    const result = attachActionEligibilityToSnapshot(applyHistoryToSnapshot(snapshot, {
      now,
      config
    }));
    recordLastScanDiagnostics(result, { startedAt, endedAt: scanEndedAt, rawSource, errors, options });
    return result;
  } catch (error) {
    const result = attachActionEligibilityToSnapshot({
      ...snapshot,
      servers: snapshot.servers.map((record) => ({
        ...record,
        historyContext: {
          firstSeenAt: null,
          lastSeenAt: null,
          seenCount: 0,
          consecutiveSeenCount: 0,
          persistedAcrossScans: false,
          previouslySeen: false,
          reappeared: false,
          historyStatus: "unavailable",
          evidence: [
            {
              type: "history",
              score: 0,
              message: safeErrorMessage("history", error)
            }
          ]
        }
      })),
      history: {
        enabled: true,
        storageHealth: "unavailable",
        retainedSnapshotCount: 0,
        oldestRetainedSnapshot: null,
        lastSuccessfulHistoryWrite: null,
        disappearedSincePrevious: 0,
        redactionPrivacyStatus: "privacy-safe normalized fields only; no command lines, paths, response bodies, or process trees persisted",
        warning: safeErrorMessage("history", error)
      }
    });
    recordLastScanDiagnostics(result, { startedAt, endedAt: scanEndedAt, rawSource, errors: [...errors, safeError("history", error)], options });
    return result;
  }
}

function recordLastScanDiagnostics(snapshot, context) {
  const servers = snapshot.servers || [];
  const probes = servers.map((record) => record.httpProbe || {});
  lastScanDiagnostics = {
    scanId: snapshot.history && snapshot.history.lastSuccessfulHistoryWrite ? `scan-${snapshot.generatedAt}` : `scan-${snapshot.generatedAt}`,
    startedAt: context.startedAt.toISOString(),
    endedAt: context.endedAt.toISOString(),
    durationMs: Math.max(0, context.endedAt.getTime() - context.startedAt.getTime()),
    activeScannerSource: context.rawSource,
    visible: snapshot.totals.visible,
    hidden: snapshot.totals.hidden,
    errors: context.errors || [],
    warnings: [
      ...(snapshot.history && snapshot.history.warning ? [snapshot.history.warning] : [])
    ],
    probeSummary: {
      enabled: !context.options.skipHttpProbe,
      attempted: probes.filter((probe) => probe.attempted).length,
      reachable: probes.filter((probe) => probe.reachable).length,
      timeout: probes.filter((probe) => String(probe.error || "").toLowerCase().includes("timeout")).length,
      refused: probes.filter((probe) => String(probe.error || "").toLowerCase().includes("refused")).length,
      nonHttp: probes.filter((probe) => String(probe.error || "").toLowerCase().includes("non-http")).length
    },
    enrichment: {
      truncatedTreeCount: servers.filter((record) => record.processTree && record.processTree.truncated).length,
      missingParentMetadataCount: servers.filter((record) => record.processTree && record.processTree.stopReason === "missing-parent-metadata").length,
      missingCreationTimeCount: servers.filter((record) => record.timingStatus !== "available").length
    },
    history: snapshot.history || null
  };
}

function getLastScanDiagnostics() {
  return lastScanDiagnostics;
}

async function runCommand(command, args) {
  const { stdout } = await execFileAsync(command, args, {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  return stdout;
}

function resolveWindowsCommand(system32RelativePath, fallback) {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const candidate = join(systemRoot, "System32", system32RelativePath);
  return existsSync(candidate) ? candidate : fallback;
}

module.exports = {
  parseJsonArray,
  parseNetstatOutput,
  parsePowerShellTcpConnections,
  parseWindowsProcesses,
  resolveWindowsCommand,
  runCommand,
  scanWindows,
  getLastScanDiagnostics
};
