"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { loadWatchdogConfig, normalizeConfig, redactConfiguredPath, expandEnvPath, normalizePath } = require("../config/load");
const { redactSensitiveText } = require("../privacy/redact");
const { DEFAULT_MAX_DEPTH } = require("../process/tree");
const { MAX_BODY_BYTES } = require("../scanner/probe");
const { getLastScanDiagnostics, resolveWindowsCommand } = require("../scanner/windows");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function buildDiagnostics(options = {}) {
  const root = options.root || REPO_ROOT;
  const io = options.io || fs;
  const now = options.now || new Date();
  const sourceReport = readConfigSources(root, io);
  const configResult = loadEffectiveConfig(root);
  const config = configResult.config;
  const lastScan = options.lastScanDiagnostics !== undefined ? options.lastScanDiagnostics : getLastScanDiagnostics();
  const historyStorage = inspectHistoryStorage(config.safety.history.storagePath, io);

  return {
    ok: true,
    generatedAt: now.toISOString(),
    destructiveActionsAvailable: false,
    status: overallStatus(sourceReport, configResult, lastScan, historyStorage),
    configuration: buildConfigurationDiagnostics(sourceReport, config, root, io),
    scanner: buildScannerDiagnostics(lastScan),
    probing: buildProbeDiagnostics(config, lastScan),
    processContext: buildProcessContextDiagnostics(config, lastScan),
    lifecycle: buildLifecycleDiagnostics(config),
    history: buildHistoryDiagnostics(config, historyStorage, lastScan),
    privacy: buildPrivacyDiagnostics(root, io)
  };
}

function readConfigSources(root, io) {
  return {
    safety: readSource(path.join(root, "config", "safety.json"), path.join(root, "config", "safety.example.json"), io),
    projects: readSource(path.join(root, "config", "projects.json"), path.join(root, "config", "projects.example.json"), io),
    devRoots: readSource(path.join(root, "config", "dev-roots.json"), path.join(root, "config", "dev-roots.example.json"), io)
  };
}

function readSource(primaryPath, fallbackPath, io) {
  const primaryExists = io.existsSync(primaryPath);
  const selectedPath = primaryExists ? primaryPath : fallbackPath;
  try {
    const parsed = JSON.parse(io.readFileSync(selectedPath, "utf8"));
    return {
      sourceFile: safeDisplayPath(selectedPath),
      primaryConfigured: primaryExists,
      status: primaryExists ? "configured" : "defaulted",
      data: parsed,
      error: null
    };
  } catch (error) {
    return {
      sourceFile: safeDisplayPath(selectedPath),
      primaryConfigured: primaryExists,
      status: "invalid",
      data: null,
      error: "invalid JSON"
    };
  }
}

function loadEffectiveConfig(root) {
  try {
    return {
      status: "healthy",
      config: loadWatchdogConfig({ root }),
      error: null
    };
  } catch (error) {
    return {
      status: "degraded",
      config: loadBundledDefaultConfig(),
      error: "effective config fell back to bundled defaults because local config could not be loaded"
    };
  }
}

function loadBundledDefaultConfig() {
  return normalizeConfig({
    safety: JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "config", "safety.example.json"), "utf8")),
    projects: JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "config", "projects.example.json"), "utf8")),
    devRoots: JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "config", "dev-roots.example.json"), "utf8"))
  }, { root: REPO_ROOT });
}

function buildConfigurationDiagnostics(sources, config, root, io) {
  const configuredDevRoots = [
    ...((sources.safety.data && sources.safety.data.devRoots) || []).map((value) => ({ value, source: sources.safety.sourceFile })),
    ...((sources.devRoots.data && sources.devRoots.data.devRoots) || []).map((value) => ({ value, source: sources.devRoots.sourceFile })),
    ...((sources.projects.data && sources.projects.data.projects || []).filter((project) => project.path).map((project) => ({ value: project.path, source: sources.projects.sourceFile })))
  ];
  const devRoots = configuredDevRoots.map((entry) => inspectDevRoot(entry.value, entry.source, io));

  return {
    status: anyInvalidSource(sources) ? "degraded" : "healthy",
    sources: {
      safety: sourceSummary(sources.safety),
      projects: sourceSummary(sources.projects),
      devRoots: sourceSummary(sources.devRoots)
    },
    safety: {
      status: sourceToStatus(sources.safety),
      configuredValue: sources.safety.status === "configured" ? "local safety config" : null,
      effectiveValue: "normalized safety config",
      defaultedValue: sources.safety.status === "defaulted" ? "config/safety.example.json" : null,
      invalidIgnoredValue: sources.safety.status === "invalid" ? sources.safety.error : null
    },
    devRoots: {
      status: devRoots.some((root) => root.status === "ignored") ? "warning" : "healthy",
      loadedRoots: devRoots,
      validRoots: devRoots.filter((root) => root.status === "valid"),
      ignoredRoots: devRoots.filter((root) => root.status === "ignored"),
      effectiveValue: config.safety.devRootsDisplay || []
    },
    protectedProcesses: valueStatus(config.safety.protectedProcesses, sources.safety),
    protectedPorts: valueStatus(config.safety.protectedPorts, sources.safety),
    protectedPortRanges: valueStatus(config.safety.protectedPortRanges, sources.safety),
    commonDevelopmentPorts: valueStatus(config.safety.commonDevPorts, sources.safety),
    httpProbeSettings: {
      timeoutMs: config.safety.httpProbeTimeoutMs,
      maxRedirects: config.safety.httpProbeMaxRedirects,
      sourceFile: sources.safety.sourceFile,
      status: sourceToStatus(sources.safety)
    },
    processTreeDepth: {
      configuredValue: sources.safety.data && sources.safety.data.processTree ? sources.safety.data.processTree.maxDepth || null : null,
      effectiveValue: config.safety.processTree ? config.safety.processTree.maxDepth : DEFAULT_MAX_DEPTH,
      defaultedValue: sources.safety.data && sources.safety.data.processTree ? null : DEFAULT_MAX_DEPTH,
      status: "healthy"
    },
    lifecycleThresholds: {
      effectiveValue: config.safety.lifecycle,
      sourceFile: sources.safety.sourceFile,
      status: "healthy"
    },
    historySettings: {
      effectiveValue: {
        ...config.safety.history,
        storagePath: safeDisplayPath(config.safety.history.storagePath)
      },
      sourceFile: sources.safety.sourceFile,
      status: config.safety.history.enabled ? "healthy" : "disabled"
    },
    retentionSettings: {
      maxSnapshots: config.safety.history.maxSnapshots,
      maxHistoryAgeMs: config.safety.history.maxHistoryAgeMs,
      maxProcessRecords: config.safety.history.maxProcessRecords,
      status: "healthy"
    },
    redactionPrivacyStatus: {
      commandLineRedaction: "active",
      pathRedaction: "active",
      status: "healthy"
    },
    root: safeDisplayPath(root)
  };
}

function inspectDevRoot(value, sourceFile, io) {
  const expanded = expandEnvPath(value);
  const normalized = expanded ? normalizePath(expanded) : null;
  const envExpanded = String(value || "").includes("%");
  const base = {
    configuredValue: compactConfiguredValue(value),
    safeDisplayPath: safeDisplayPath(expanded || value),
    sourceFile,
    environmentVariablesExpanded: envExpanded,
    status: "ignored",
    reasonIgnored: null
  };

  if (!value) {
    return { ...base, reasonIgnored: "empty value" };
  }
  if (!isSupportedAbsolutePath(expanded)) {
    return { ...base, reasonIgnored: "not an absolute Windows path" };
  }
  try {
    if (!io.existsSync(normalized)) return { ...base, reasonIgnored: "path does not exist" };
    if (!io.statSync(normalized).isDirectory()) return { ...base, reasonIgnored: "path is not a directory" };
    return { ...base, status: "valid", reasonIgnored: null };
  } catch {
    return { ...base, reasonIgnored: "path is inaccessible" };
  }
}

function buildScannerDiagnostics(lastScan) {
  const powershellPath = resolveWindowsCommand("WindowsPowerShell\\v1.0\\powershell.exe", "powershell.exe");
  const netstatPath = resolveWindowsCommand("netstat.exe", "netstat.exe");
  const errors = lastScan ? lastScan.errors || [] : [];
  return {
    status: !lastScan ? "unavailable" : errors.length ? "degraded" : "healthy",
    activeScannerSource: lastScan ? lastScan.activeScannerSource : "unavailable",
    powerShellAvailability: powershellPath.toLowerCase().endsWith("powershell.exe") ? "healthy" : "unavailable",
    cimAvailability: scanErrorStatus(errors, "Get-CimInstance Win32_Process"),
    getNetTcpConnectionAvailability: scanErrorStatus(errors, "Get-NetTCPConnection"),
    getCimInstanceAvailability: scanErrorStatus(errors, "Get-CimInstance Win32_Process"),
    netstatFallbackAvailability: netstatPath.toLowerCase().endsWith("netstat.exe") ? "healthy" : "unavailable",
    metadataElevationLimitations: "process command lines and executable paths may be unavailable for protected or elevated processes",
    lastScanId: lastScan ? lastScan.scanId : null,
    lastScanStartTime: lastScan ? lastScan.startedAt : null,
    lastScanEndTime: lastScan ? lastScan.endedAt : null,
    scanDurationMs: lastScan ? lastScan.durationMs : null,
    visible: lastScan ? lastScan.visible : null,
    hidden: lastScan ? lastScan.hidden : null,
    scannerWarnings: lastScan ? (lastScan.warnings || []).map((warning) => redactSensitiveText(warning)) : ["no scan has completed in this process"],
    recoverableErrors: errors.map((error) => ({
      source: error.source,
      code: error.code || "UNKNOWN_RECOVERABLE_ERROR",
      category: error.category || "recoverable",
      message: redactSensitiveText(error.message || "A recoverable scanner error occurred.")
    }))
  };
}

function buildProbeDiagnostics(config, lastScan) {
  return {
    status: "healthy",
    enabled: true,
    timeoutMs: config.safety.httpProbeTimeoutMs,
    redirectLimit: config.safety.httpProbeMaxRedirects,
    responseBodyMetadataCapBytes: MAX_BODY_BYTES,
    localhostOnlyRedirectPolicy: "redirects to non-localhost destinations are blocked",
    lastProbeSummary: lastScan ? lastScan.probeSummary : null,
    timeoutCount: lastScan && lastScan.probeSummary ? lastScan.probeSummary.timeout : 0,
    refusedCount: lastScan && lastScan.probeSummary ? lastScan.probeSummary.refused : 0,
    nonHttpCount: lastScan && lastScan.probeSummary ? lastScan.probeSummary.nonHttp : 0
  };
}

function buildProcessContextDiagnostics(config, lastScan) {
  return {
    status: "healthy",
    projectOwnership: { enabled: true, status: "healthy" },
    launcherContext: { enabled: true, status: "healthy" },
    maxProcessTreeDepth: config.safety.processTree ? config.safety.processTree.maxDepth : DEFAULT_MAX_DEPTH,
    truncatedTreeCount: lastScan ? lastScan.enrichment.truncatedTreeCount : 0,
    missingParentMetadataCount: lastScan ? lastScan.enrichment.missingParentMetadataCount : 0,
    missingCreationTimeCount: lastScan ? lastScan.enrichment.missingCreationTimeCount : 0,
    lifecycleEvaluation: { enabled: true, status: "healthy" }
  };
}

function buildLifecycleDiagnostics(config) {
  return {
    status: "healthy",
    thresholds: config.safety.lifecycle,
    labels: ["active", "long-running", "possibly-detached", "stale-candidate", "unknown"],
    staleWarning: "history and lifecycle context are informational and not cleanup recommendations"
  };
}

function buildHistoryDiagnostics(config, storage, lastScan) {
  const history = config.safety.history;
  return {
    enabled: history.enabled,
    status: history.enabled ? storage.status : "disabled",
    safeDisplayLocation: safeDisplayPath(history.storagePath),
    schemaVersion: storage.schemaVersion,
    storageHealth: storage.status,
    retainedSnapshotCount: storage.retainedSnapshotCount,
    retainedProcessCount: storage.retainedProcessCount,
    oldestSnapshot: storage.oldestSnapshot,
    newestSnapshot: storage.newestSnapshot,
    lastSuccessfulWrite: storage.lastSuccessfulWrite,
    lastWarningOrError: redactSensitiveText(storage.warning || (lastScan && lastScan.history ? lastScan.history.warning : null)),
    retentionLimits: {
      maxSnapshots: history.maxSnapshots,
      maxHistoryAgeMs: history.maxHistoryAgeMs,
      maxProcessRecords: history.maxProcessRecords
    },
    pruningStatus: "automatic pruning after each successful scan",
    overlappingScanWarning: "not detected; history writes use atomic replacement but no inter-process lock"
  };
}

function buildPrivacyDiagnostics(root, io) {
  const gitignorePath = path.join(root, ".gitignore");
  const gitignore = io.existsSync(gitignorePath) ? io.readFileSync(gitignorePath, "utf8") : "";
  return {
    status: gitignore.includes(".localhost-watchdog/") ? "healthy" : "warning",
    commandLineRedactionActive: true,
    pathRedactionActive: true,
    httpBodyPersistenceDisabled: true,
    rawCimPersistenceDisabled: true,
    processTreePersistenceDisabled: true,
    protectedDetailsAggregationActive: true,
    historyFileIgnoredByGit: gitignore.includes(".localhost-watchdog/"),
    prohibitedData: [
      "secrets",
      "unredacted command lines",
      "raw environment values",
      "raw CIM snapshots",
      "process trees in history",
      "full HTTP response bodies"
    ]
  };
}

function inspectHistoryStorage(storagePath, io) {
  if (!io.existsSync(storagePath)) {
    return {
      status: "unavailable",
      schemaVersion: null,
      retainedSnapshotCount: 0,
      retainedProcessCount: 0,
      oldestSnapshot: null,
      newestSnapshot: null,
      lastSuccessfulWrite: null,
      warning: "history file does not exist yet"
    };
  }
  try {
    const parsed = JSON.parse(io.readFileSync(storagePath, "utf8"));
    const snapshots = Array.isArray(parsed.snapshots) ? parsed.snapshots : [];
    return {
      status: parsed.version === 1 ? "healthy" : "degraded",
      schemaVersion: parsed.version || null,
      retainedSnapshotCount: snapshots.length,
      retainedProcessCount: parsed.records ? Object.keys(parsed.records).length : 0,
      oldestSnapshot: snapshots[0] ? snapshots[0].scannedAt : null,
      newestSnapshot: snapshots[snapshots.length - 1] ? snapshots[snapshots.length - 1].scannedAt : null,
      lastSuccessfulWrite: parsed.meta ? parsed.meta.lastSuccessfulWriteAt || null : null,
      warning: parsed.version === 1 ? null : "history schema version mismatch"
    };
  } catch {
    return {
      status: "degraded",
      schemaVersion: null,
      retainedSnapshotCount: 0,
      retainedProcessCount: 0,
      oldestSnapshot: null,
      newestSnapshot: null,
      lastSuccessfulWrite: null,
      warning: "history file is invalid JSON"
    };
  }
}

function valueStatus(value, source) {
  return {
    status: sourceToStatus(source),
    configuredValue: source.status === "configured" ? "configured" : null,
    effectiveValue: value,
    defaultedValue: source.status === "defaulted" ? value : null,
    invalidIgnoredValue: source.status === "invalid" ? source.error : null,
    sourceFile: source.sourceFile
  };
}

function sourceSummary(source) {
  return {
    sourceFile: source.sourceFile,
    status: sourceToStatus(source),
    configured: source.primaryConfigured,
    error: source.error
  };
}

function sourceToStatus(source) {
  if (source.status === "invalid") return "warning";
  if (source.status === "defaulted") return "healthy";
  return "healthy";
}

function anyInvalidSource(sources) {
  return Object.values(sources).some((source) => source.status === "invalid");
}

function overallStatus(sourceReport, configResult, lastScan, historyStorage) {
  if (anyInvalidSource(sourceReport) || configResult.status !== "healthy" || historyStorage.status === "degraded") return "degraded";
  if (!lastScan) return "warning";
  if ((lastScan.errors || []).length) return "degraded";
  return "healthy";
}

function scanErrorStatus(errors, source) {
  return errors.some((error) => error.source === source) ? "degraded" : "healthy";
}

function compactConfiguredValue(value) {
  if (value == null) return null;
  return safeDisplayPath(value);
}

function safeDisplayPath(value) {
  return redactConfiguredPath(value);
}

function isAbsoluteWindowsPath(value) {
  return /^[a-z]:\\/i.test(String(value || "")) || /^\\\\[^\\]+\\[^\\]+/.test(String(value || ""));
}

function isSupportedAbsolutePath(value) {
  return isAbsoluteWindowsPath(value) || path.isAbsolute(String(value || ""));
}

module.exports = {
  buildDiagnostics,
  inspectDevRoot,
  inspectHistoryStorage,
  readConfigSources
};
