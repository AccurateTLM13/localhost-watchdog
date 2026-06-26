"use strict";

const os = require("node:os");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const EXPORT_SCHEMA_VERSION = "localhost-watchdog.diagnostics-export.v1";
const DEFAULT_FORMAT = "markdown";
const ALLOWED_FORMATS = new Set(["markdown", "json"]);
const REPO_ROOT = join(__dirname, "..", "..");

function buildDiagnosticsExport(options = {}) {
  const format = normalizeFormat(options.format);
  const now = options.now || new Date();
  const diagnostics = isObject(options.diagnostics) ? options.diagnostics : {};
  const snapshot = isObject(options.snapshot) ? options.snapshot : {};
  const appVersion = options.appVersion || readPackageVersion();
  const bundle = buildAllowlistedBundle({
    diagnostics,
    snapshot,
    now,
    appVersion,
    runtime: options.runtime
  });
  const content = format === "json" ? JSON.stringify(bundle, null, 2) : renderMarkdown(bundle);
  const validation = validateExportContent(content);

  if (!validation.ok) {
    return {
      ok: false,
      schemaVersion: EXPORT_SCHEMA_VERSION,
      format,
      filename: buildExportFilename(format, now),
      content: "",
      validation: {
        status: "blocked",
        code: validation.code,
        message: validation.message
      }
    };
  }

  return {
    ok: true,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    format,
    filename: buildExportFilename(format, now),
    content,
    validation: {
      status: "passed",
      checkedAt: now.toISOString()
    }
  };
}

function buildAllowlistedBundle({ diagnostics, snapshot, now, appVersion, runtime }) {
  const configuration = diagnostics.configuration || {};
  const scanner = diagnostics.scanner || {};
  const probing = diagnostics.probing || {};
  const processContext = diagnostics.processContext || {};
  const lifecycle = diagnostics.lifecycle || {};
  const history = diagnostics.history || {};
  const privacy = diagnostics.privacy || {};
  const devRoots = configuration.devRoots || {};
  const totals = snapshot.totals || {};
  const servers = Array.isArray(snapshot.servers) ? snapshot.servers : [];

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    createdAt: now.toISOString(),
    application: {
      name: "localhost-watchdog",
      version: appVersion
    },
    runtime: {
      osFamily: safeOsFamily(runtime && runtime.platform ? runtime.platform : process.platform),
      nodeVersion: safeNodeVersion(runtime && runtime.nodeVersion ? runtime.nodeVersion : process.versions.node)
    },
    diagnostics: {
      status: safeStatus(diagnostics.status),
      destructiveActionsAvailable: false
    },
    configurationSources: buildConfigurationSources(configuration.sources),
    scanner: {
      status: safeStatus(scanner.status),
      activeScannerSource: safeScannerSource(scanner.activeScannerSource),
      capabilities: {
        powerShell: safeStatus(scanner.powerShellAvailability),
        getNetTcpConnection: safeStatus(scanner.getNetTcpConnectionAvailability),
        getCimInstance: safeStatus(scanner.getCimInstanceAvailability),
        netstatFallback: safeStatus(scanner.netstatFallbackAvailability)
      },
      totals: {
        visible: safeNumber(scanner.visible, totals.visible),
        hidden: safeNumber(scanner.hidden, totals.hidden),
        scanned: safeNumber(totals.scanned, null)
      },
      warningCategories: scannerWarningCategories(scanner)
    },
    probing: {
      status: safeStatus(probing.status),
      enabled: Boolean(probing.enabled),
      timeoutMs: safeNumber(probing.timeoutMs, null),
      redirectLimit: safeNumber(probing.redirectLimit, null),
      responseBodyMetadataCapBytes: safeNumber(probing.responseBodyMetadataCapBytes, null),
      localhostOnlyRedirectPolicy: probing.localhostOnlyRedirectPolicy ? "enabled" : "unknown",
      outcomes: {
        attempted: safeNumber(probing.lastProbeSummary && probing.lastProbeSummary.attempted, countProbe(servers, "attempted")),
        reachable: safeNumber(probing.lastProbeSummary && probing.lastProbeSummary.reachable, countProbe(servers, "reachable")),
        timeout: safeNumber(probing.timeoutCount, null),
        refused: safeNumber(probing.refusedCount, null),
        nonHttp: safeNumber(probing.nonHttpCount, null)
      }
    },
    processContext: {
      status: safeStatus(processContext.status),
      projectOwnershipStatus: nestedStatus(processContext.projectOwnership),
      launcherContextStatus: nestedStatus(processContext.launcherContext),
      maxProcessTreeDepth: safeNumber(processContext.maxProcessTreeDepth, null),
      truncatedTreeCount: safeNumber(processContext.truncatedTreeCount, null),
      missingParentMetadataCount: safeNumber(processContext.missingParentMetadataCount, null),
      missingCreationTimeCount: safeNumber(processContext.missingCreationTimeCount, null)
    },
    lifecycle: {
      status: safeStatus(lifecycle.status),
      evaluationStatus: nestedStatus(processContext.lifecycleEvaluation),
      labels: Array.isArray(lifecycle.labels) ? lifecycle.labels.filter(isSafeToken) : [],
      staleWarning: lifecycle.staleWarning ? "informational-only" : "unknown"
    },
    history: {
      enabled: Boolean(history.enabled),
      status: safeStatus(history.status),
      storageHealth: safeStatus(history.storageHealth),
      retainedSnapshotCount: safeNumber(history.retainedSnapshotCount, null),
      retainedProcessCount: safeNumber(history.retainedProcessCount, null),
      retention: {
        maxSnapshots: safeNumber(history.retentionLimits && history.retentionLimits.maxSnapshots, null),
        maxHistoryAgeMs: safeNumber(history.retentionLimits && history.retentionLimits.maxHistoryAgeMs, null),
        maxProcessRecords: safeNumber(history.retentionLimits && history.retentionLimits.maxProcessRecords, null)
      },
      pruningStatus: history.pruningStatus ? "automatic-pruning-configured" : "unknown"
    },
    devRoots: {
      totalConfigured: Array.isArray(devRoots.loadedRoots) ? devRoots.loadedRoots.length : 0,
      totalValid: Array.isArray(devRoots.validRoots) ? devRoots.validRoots.length : 0,
      totalIgnored: Array.isArray(devRoots.ignoredRoots) ? devRoots.ignoredRoots.length : 0,
      ignored: summarizeIgnoredDevRoots(devRoots.ignoredRoots)
    },
    privacy: {
      status: safeStatus(privacy.status),
      commandLineRedactionActive: Boolean(privacy.commandLineRedactionActive),
      pathRedactionActive: Boolean(privacy.pathRedactionActive),
      httpBodyPersistenceDisabled: Boolean(privacy.httpBodyPersistenceDisabled),
      rawCimPersistenceDisabled: Boolean(privacy.rawCimPersistenceDisabled),
      processTreePersistenceDisabled: Boolean(privacy.processTreePersistenceDisabled),
      protectedDetailsAggregationActive: Boolean(privacy.protectedDetailsAggregationActive),
      historyFileIgnoredByGit: Boolean(privacy.historyFileIgnoredByGit)
    },
    scannerAggregates: buildServerAggregates(servers),
    actionFlags: {
      safeToStopEnabled: false,
      safeToRestartEnabled: false,
      bulkActionsEnabled: false,
      destructiveActionsAvailable: false,
      automaticSharingEnabled: false
    }
  };
}

function renderMarkdown(bundle) {
  return [
    "# Localhost Watchdog Diagnostics Summary",
    "",
    `Schema: ${bundle.schemaVersion}`,
    `Created: ${bundle.createdAt}`,
    `Application: ${bundle.application.name} ${bundle.application.version}`,
    `Runtime: ${bundle.runtime.osFamily}; Node.js ${bundle.runtime.nodeVersion}`,
    "",
    "## Overall",
    "",
    `- Diagnostics status: ${bundle.diagnostics.status}`,
    "- Destructive actions available: false",
    "- Automatic sharing enabled: false",
    "",
    "## Configuration Sources",
    "",
    ...sourceLines(bundle.configurationSources),
    "",
    "## Scanner",
    "",
    `- Status: ${bundle.scanner.status}`,
    `- Active source: ${bundle.scanner.activeScannerSource}`,
    `- Capabilities: PowerShell ${bundle.scanner.capabilities.powerShell}; Get-NetTCPConnection ${bundle.scanner.capabilities.getNetTcpConnection}; Get-CimInstance ${bundle.scanner.capabilities.getCimInstance}; netstat fallback ${bundle.scanner.capabilities.netstatFallback}`,
    `- Counts: visible ${displayValue(bundle.scanner.totals.visible)}, hidden ${displayValue(bundle.scanner.totals.hidden)}, scanned ${displayValue(bundle.scanner.totals.scanned)}`,
    `- Warning categories: ${bundle.scanner.warningCategories.length ? bundle.scanner.warningCategories.join(", ") : "none"}`,
    "",
    "## HTTP Probing",
    "",
    `- Status: ${bundle.probing.status}`,
    `- Enabled: ${bundle.probing.enabled}`,
    `- Timeout: ${displayValue(bundle.probing.timeoutMs)} ms`,
    `- Redirect limit: ${displayValue(bundle.probing.redirectLimit)}`,
    `- Body metadata cap: ${displayValue(bundle.probing.responseBodyMetadataCapBytes)} bytes`,
    `- Localhost-only redirect policy: ${bundle.probing.localhostOnlyRedirectPolicy}`,
    `- Outcomes: attempted ${displayValue(bundle.probing.outcomes.attempted)}, reachable ${displayValue(bundle.probing.outcomes.reachable)}, timeout ${displayValue(bundle.probing.outcomes.timeout)}, refused ${displayValue(bundle.probing.outcomes.refused)}, non-HTTP ${displayValue(bundle.probing.outcomes.nonHttp)}`,
    "",
    "## Process Context",
    "",
    `- Status: ${bundle.processContext.status}`,
    `- Project ownership: ${bundle.processContext.projectOwnershipStatus}`,
    `- Launcher context: ${bundle.processContext.launcherContextStatus}`,
    `- Max process-tree depth: ${displayValue(bundle.processContext.maxProcessTreeDepth)}`,
    `- Truncated trees: ${displayValue(bundle.processContext.truncatedTreeCount)}`,
    `- Missing parent metadata: ${displayValue(bundle.processContext.missingParentMetadataCount)}`,
    `- Missing creation time: ${displayValue(bundle.processContext.missingCreationTimeCount)}`,
    "",
    "## Lifecycle",
    "",
    `- Status: ${bundle.lifecycle.status}`,
    `- Evaluation: ${bundle.lifecycle.evaluationStatus}`,
    `- Labels: ${bundle.lifecycle.labels.length ? bundle.lifecycle.labels.join(", ") : "none"}`,
    `- Stale warning mode: ${bundle.lifecycle.staleWarning}`,
    "",
    "## History",
    "",
    `- Enabled: ${bundle.history.enabled}`,
    `- Status: ${bundle.history.status}`,
    `- Storage health: ${bundle.history.storageHealth}`,
    `- Retained snapshots: ${displayValue(bundle.history.retainedSnapshotCount)}`,
    `- Retained process records: ${displayValue(bundle.history.retainedProcessCount)}`,
    `- Retention: max snapshots ${displayValue(bundle.history.retention.maxSnapshots)}, max age ${displayValue(bundle.history.retention.maxHistoryAgeMs)} ms, max process records ${displayValue(bundle.history.retention.maxProcessRecords)}`,
    "",
    "## Dev Roots",
    "",
    `- Configured: ${bundle.devRoots.totalConfigured}`,
    `- Valid: ${bundle.devRoots.totalValid}`,
    `- Ignored: ${bundle.devRoots.totalIgnored}`,
    ...ignoredDevRootLines(bundle.devRoots.ignored),
    "",
    "## Scanner Aggregates",
    "",
    `- Network-exposed visible listeners: ${bundle.scannerAggregates.networkExposedCount}`,
    `- HTTP reachable visible listeners: ${bundle.scannerAggregates.httpReachableCount}`,
    `- Categories: ${aggregateLines(bundle.scannerAggregates.categories)}`,
    `- Confidence levels: ${aggregateLines(bundle.scannerAggregates.confidenceLevels)}`,
    `- Lifecycle labels: ${aggregateLines(bundle.scannerAggregates.lifecycleLabels)}`,
    "",
    "## Privacy And Safety",
    "",
    `- Privacy status: ${bundle.privacy.status}`,
    `- Command-line redaction active: ${bundle.privacy.commandLineRedactionActive}`,
    `- Path redaction active: ${bundle.privacy.pathRedactionActive}`,
    `- HTTP body persistence disabled: ${bundle.privacy.httpBodyPersistenceDisabled}`,
    `- Raw CIM persistence disabled: ${bundle.privacy.rawCimPersistenceDisabled}`,
    `- Process-tree persistence disabled: ${bundle.privacy.processTreePersistenceDisabled}`,
    `- Protected details aggregation active: ${bundle.privacy.protectedDetailsAggregationActive}`,
    `- History file ignored by Git: ${bundle.privacy.historyFileIgnoredByGit}`,
    "",
    "## Action Flags",
    "",
    "- safeToStop enabled: false",
    "- safeToRestart enabled: false",
    "- bulk actions enabled: false",
    "- destructive actions available: false"
  ].join("\n");
}

function validateExportContent(content) {
  const checks = [
    ["BEARER_TOKEN", /\bbearer\s+[a-z0-9._~+/=-]{8,}/i],
    ["API_KEY", /\b(?:api[_-]?key|x-api-key|secret[_-]?key)\b\s*[:=]\s*["']?[a-z0-9._-]{8,}/i],
    ["PASSWORD_OR_SECRET_ARGUMENT", /(?:--?(?:password|passwd|pwd|token|secret|api-key|apikey|access-token|auth-token)\s+|(?:password|passwd|pwd|token|secret|api[_-]?key)=)\S+/i],
    ["WINDOWS_USER_PROFILE_PATH", /[a-z]:\\users\\[^\\\s"]+/i],
    ["RAW_COMMAND_FRAGMENT", /\b(?:node|python|java|npm|npx|pnpm|yarn|powershell|cmd)(?:\.exe)?\s+[^,\n]*(?:--|\/[a-z])/i],
    ["CREDENTIAL_QUERY", /\?[^#\s]*(?:token|secret|password|passwd|pwd|api[_-]?key|access[_-]?token|auth)=/i],
    ["COOKIE_OR_AUTH_HEADER", /\b(?:cookie|set-cookie|authorization)\s*:/i],
    ["ENVIRONMENT_VALUE", /%[a-z0-9_]+%/i]
  ];

  for (const [code, pattern] of checks) {
    if (pattern.test(content)) {
      return {
        ok: false,
        code,
        message: "Export validation blocked output because it matched a prohibited sensitive pattern."
      };
    }
  }

  return { ok: true, code: null, message: null };
}

function buildExportFilename(format, now = new Date()) {
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const ext = normalizeFormat(format) === "json" ? "json" : "md";
  return `localhost-watchdog-diagnostics-${date}.${ext}`;
}

function normalizeFormat(format) {
  const value = String(format || DEFAULT_FORMAT).toLowerCase();
  return ALLOWED_FORMATS.has(value) ? value : DEFAULT_FORMAT;
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    return String(pkg.version || "unknown");
  } catch {
    return "unknown";
  }
}

function buildConfigurationSources(sources) {
  const safeSources = sources || {};
  return {
    safety: sourceState(safeSources.safety),
    projects: sourceState(safeSources.projects),
    devRoots: sourceState(safeSources.devRoots)
  };
}

function sourceState(source) {
  if (!source) return { status: "unavailable", configured: false };
  return {
    status: safeStatus(source.status),
    configured: Boolean(source.configured)
  };
}

function scannerWarningCategories(scanner) {
  const categories = new Set();
  for (const warning of scanner.scannerWarnings || []) {
    const text = String(warning || "").toLowerCase();
    if (text.includes("fallback") || text.includes("netstat")) categories.add("fallback-used");
    else if (text.includes("metadata") || text.includes("access") || text.includes("elevation")) categories.add("metadata-limited");
    else categories.add("scanner-warning");
  }
  for (const error of scanner.recoverableErrors || []) {
    if (error && error.source) categories.add(`recoverable-${safeToken(error.source)}`);
  }
  return [...categories].sort();
}

function summarizeIgnoredDevRoots(ignoredRoots) {
  return (ignoredRoots || []).map((root, index) => ({
    label: `Dev Root ${index + 1}`,
    reasonIgnored: safeReason(root && root.reasonIgnored)
  }));
}

function buildServerAggregates(servers) {
  return {
    categoryCounts: countBy(servers, (record) => record.category || "unknown"),
    categories: countBy(servers, (record) => record.category || "unknown"),
    confidenceLevels: countBy(servers, (record) => record.confidenceLevel || "unknown"),
    lifecycleLabels: countBy(servers, (record) => record.lifecycleContext && record.lifecycleContext.label || "unknown"),
    networkExposedCount: servers.filter((record) => record.networkExposure && record.networkExposure.warning).length,
    httpReachableCount: servers.filter((record) => record.httpProbe && record.httpProbe.reachable).length
  };
}

function countBy(items, getKey) {
  const counts = {};
  for (const item of items || []) {
    const key = safeToken(getKey(item));
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function countProbe(servers, field) {
  if (!Array.isArray(servers) || servers.length === 0) return null;
  return servers.filter((record) => record.httpProbe && record.httpProbe[field]).length;
}

function sourceLines(sources) {
  return Object.entries(sources).map(([name, source]) => `- ${name}: ${source.status}; configured ${source.configured}`);
}

function ignoredDevRootLines(ignored) {
  if (!ignored.length) return ["- Ignored root reasons: none"];
  return ignored.map((root) => `- ${root.label}: ${root.reasonIgnored}`);
}

function aggregateLines(counts) {
  const entries = Object.entries(counts || {});
  if (!entries.length) return "none";
  return entries.map(([key, value]) => `${key} ${value}`).join(", ");
}

function nestedStatus(value) {
  return value && value.status ? safeStatus(value.status) : "unavailable";
}

function safeStatus(value) {
  const status = safeToken(value || "unavailable");
  const allowed = new Set(["healthy", "degraded", "disabled", "warning", "unavailable", "configured", "defaulted", "unknown"]);
  return allowed.has(status) ? status : "unknown";
}

function safeScannerSource(value) {
  const source = String(value || "unavailable");
  if (/Get-NetTCPConnection/i.test(source)) return "Get-NetTCPConnection";
  if (/netstat/i.test(source)) return "netstat";
  if (/unavailable/i.test(source)) return "unavailable";
  return "unknown";
}

function safeOsFamily(value) {
  const platform = String(value || "").toLowerCase();
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  return "unknown";
}

function safeNodeVersion(value) {
  const match = String(value || "").match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return "unknown";
  return `${match[1]}.${match[2]}.${match[3]}`;
}

function safeNumber(primary, fallback) {
  const value = primary == null ? fallback : primary;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeReason(value) {
  const reason = String(value || "ignored").toLowerCase();
  if (reason.includes("not an absolute")) return "not an absolute Windows path";
  if (reason.includes("does not exist")) return "path does not exist";
  if (reason.includes("not a directory")) return "path is not a directory";
  if (reason.includes("inaccessible")) return "path is inaccessible";
  if (reason.includes("empty")) return "empty value";
  return "ignored";
}

function safeToken(value) {
  return String(value || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "unknown";
}

function isSafeToken(value) {
  return /^[a-z0-9-]+$/i.test(String(value || ""));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function displayValue(value) {
  return value == null ? "n/a" : value;
}

module.exports = {
  EXPORT_SCHEMA_VERSION,
  buildDiagnosticsExport,
  buildExportFilename,
  validateExportContent
};
