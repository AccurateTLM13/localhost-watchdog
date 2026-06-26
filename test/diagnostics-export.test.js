"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const {
  EXPORT_SCHEMA_VERSION,
  buildDiagnosticsExport,
  buildExportFilename,
  validateExportContent
} = require("../src/diagnostics/export");
const exportUi = require("../src/ui/export");
const { createServer } = require("../src/server");

function diagnostics(overrides = {}) {
  return {
    status: "healthy",
    destructiveActionsAvailable: false,
    configuration: {
      sources: {
        safety: { status: "healthy", configured: true, sourceFile: "C:\\Users\\johnp\\secret\\safety.json" },
        projects: { status: "healthy", configured: false, sourceFile: "C:\\Users\\johnp\\secret\\projects.json" },
        devRoots: { status: "healthy", configured: false, sourceFile: "C:\\Users\\johnp\\secret\\dev-roots.json" }
      },
      devRoots: {
        loadedRoots: [
          { safeDisplayPath: "C:\\Users\\johnp\\code", status: "valid" },
          { safeDisplayPath: "C:\\Users\\johnp\\missing", status: "ignored", reasonIgnored: "path does not exist" }
        ],
        validRoots: [{ safeDisplayPath: "C:\\Users\\johnp\\code", status: "valid" }],
        ignoredRoots: [{ safeDisplayPath: "C:\\Users\\johnp\\missing", status: "ignored", reasonIgnored: "path does not exist" }]
      }
    },
    scanner: {
      status: "degraded",
      activeScannerSource: "netstat",
      powerShellAvailability: "healthy",
      getNetTcpConnectionAvailability: "degraded",
      getCimInstanceAvailability: "healthy",
      netstatFallbackAvailability: "healthy",
      visible: 2,
      hidden: 1,
      scannerWarnings: ["scanner fallback used --password raw-secret %USERPROFILE%"],
      recoverableErrors: [{ source: "Get-NetTCPConnection", message: "token=raw-secret" }]
    },
    probing: {
      status: "healthy",
      enabled: true,
      timeoutMs: 750,
      redirectLimit: 2,
      responseBodyMetadataCapBytes: 65536,
      localhostOnlyRedirectPolicy: "redirects to non-localhost destinations are blocked",
      lastProbeSummary: { attempted: 2, reachable: 1, timeout: 0, refused: 1, nonHttp: 0 },
      timeoutCount: 0,
      refusedCount: 1,
      nonHttpCount: 0
    },
    processContext: {
      status: "healthy",
      projectOwnership: { status: "healthy" },
      launcherContext: { status: "healthy" },
      maxProcessTreeDepth: 5,
      truncatedTreeCount: 0,
      missingParentMetadataCount: 1,
      missingCreationTimeCount: 0,
      lifecycleEvaluation: { status: "healthy" }
    },
    lifecycle: {
      status: "healthy",
      labels: ["active", "long-running", "possibly-detached", "stale-candidate", "unknown"],
      staleWarning: "informational only"
    },
    history: {
      enabled: true,
      status: "healthy",
      safeDisplayLocation: "C:\\Users\\johnp\\code\\.localhost-watchdog\\history.json",
      storageHealth: "healthy",
      retainedSnapshotCount: 3,
      retainedProcessCount: 4,
      retentionLimits: { maxSnapshots: 25, maxHistoryAgeMs: 1209600000, maxProcessRecords: 500 },
      lastWarningOrError: "secret=raw-secret"
    },
    privacy: {
      status: "healthy",
      commandLineRedactionActive: true,
      pathRedactionActive: true,
      httpBodyPersistenceDisabled: true,
      rawCimPersistenceDisabled: true,
      processTreePersistenceDisabled: true,
      protectedDetailsAggregationActive: true,
      historyFileIgnoredByGit: true
    },
    ...overrides
  };
}

function snapshot() {
  return {
    totals: { scanned: 3, visible: 2, hidden: 1 },
    servers: [
      {
        port: 3000,
        category: "node-dev-server",
        confidenceLevel: "high",
        commandLine: "node server.js --token raw-secret",
        executablePath: "C:\\Users\\johnp\\code\\app\\node.exe",
        processTree: { chain: [{ commandLine: "powershell.exe -NoProfile" }] },
        project: { name: "safe-project", root: "C:\\Users\\johnp\\code\\app" },
        httpProbe: { reachable: true, finalUrl: "http://127.0.0.1:3000/?token=raw-secret" },
        networkExposure: { warning: false },
        lifecycleContext: { label: "active" },
        safeToStop: false,
        safeToRestart: false,
        bulkStoppable: false
      },
      {
        port: 5432,
        category: "database",
        confidenceLevel: "high",
        httpProbe: { reachable: false },
        networkExposure: { warning: true },
        lifecycleContext: { label: "long-running" },
        safeToStop: false,
        safeToRestart: false,
        bulkStoppable: false
      }
    ]
  };
}

test("healthy Markdown export uses allowlisted summary fields", () => {
  const result = buildDiagnosticsExport({
    diagnostics: diagnostics(),
    snapshot: snapshot(),
    now: new Date("2026-06-17T12:00:00.000Z"),
    appVersion: "0.1.0",
    runtime: { platform: "win32", nodeVersion: "22.16.0" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.format, "markdown");
  assert.equal(result.schemaVersion, EXPORT_SCHEMA_VERSION);
  assert.match(result.content, /# Localhost Watchdog Diagnostics Summary/);
  assert.match(result.content, /Schema: localhost-watchdog\.diagnostics-export\.v1/);
  assert.match(result.content, /Configured: 2/);
  assert.match(result.content, /Dev Root 1: path does not exist/);
  assert.match(result.content, /safeToStop enabled: false/);
  assert.doesNotMatch(result.content, /C:\\Users\\johnp|%USERPROFILE%/);
  assert.doesNotMatch(result.content, /raw-secret|--token|--password|CommandLine|processTree/i);
});

test("healthy JSON export is parseable and excludes prohibited details", () => {
  const result = buildDiagnosticsExport({
    diagnostics: diagnostics(),
    snapshot: snapshot(),
    format: "json",
    now: new Date("2026-06-17T12:00:00.000Z")
  });
  const parsed = JSON.parse(result.content);

  assert.equal(result.ok, true);
  assert.equal(parsed.schemaVersion, EXPORT_SCHEMA_VERSION);
  assert.equal(parsed.devRoots.totalConfigured, 2);
  assert.deepEqual(parsed.devRoots.ignored, [{ label: "Dev Root 1", reasonIgnored: "path does not exist" }]);
  assert.equal(parsed.actionFlags.destructiveActionsAvailable, false);
  assert.equal(parsed.actionFlags.safeToStopEnabled, false);
  assert.equal(parsed.actionFlags.safeToRestartEnabled, false);
  assert.equal(parsed.actionFlags.bulkActionsEnabled, false);
  assert.doesNotMatch(result.content, /C:\\Users\\johnp|%USERPROFILE%|raw-secret|server\.js|powershell\.exe|\?token=/i);
});

test("malformed diagnostics input and missing optional sections still export safely", () => {
  const result = buildDiagnosticsExport({ diagnostics: null, snapshot: null, now: new Date("2026-06-17T12:00:00.000Z") });
  const parsed = JSON.parse(buildDiagnosticsExport({ diagnostics: {}, snapshot: {}, format: "json" }).content);

  assert.equal(result.ok, true);
  assert.match(result.content, /Diagnostics status: unavailable/);
  assert.equal(parsed.scanner.totals.visible, null);
  assert.equal(parsed.history.enabled, false);
});

test("validation blocks likely secrets without returning the secret value", () => {
  const validation = validateExportContent("Authorization: Bearer secret-token-value");

  assert.equal(validation.ok, false);
  assert.equal(validation.code, "BEARER_TOKEN");
  assert.doesNotMatch(validation.message, /secret-token-value/);
});

test("generic timestamped filenames are format-specific", () => {
  const now = new Date("2026-06-17T12:00:00.000Z");

  assert.equal(buildExportFilename("markdown", now), "localhost-watchdog-diagnostics-20260617.md");
  assert.equal(buildExportFilename("json", now), "localhost-watchdog-diagnostics-20260617.json");
  assert.equal(exportUi.previewFilename({ filename: "localhost-watchdog-diagnostics-20260617.md" }, "markdown"), "localhost-watchdog-diagnostics-20260617.md");
});

test("export UI helpers generate only local export endpoints and preview content", () => {
  const preview = { ok: true, content: "approved preview", filename: "localhost-watchdog-diagnostics-20260617.md", validation: { status: "passed" } };

  assert.equal(exportUi.exportEndpoint("markdown"), "/api/diagnostics/export?format=markdown");
  assert.equal(exportUi.exportEndpoint("json"), "/api/diagnostics/export?format=json");
  assert.equal(exportUi.previewContent(preview), "approved preview");
  assert.equal(exportUi.previewContent({ ok: false, content: "blocked" }), "");
});

test("dashboard export markup is inert until explicit preview generation", () => {
  const html = readFileSync(join(__dirname, "..", "src", "ui", "index.html"), "utf8");
  const app = readFileSync(join(__dirname, "..", "src", "ui", "app.js"), "utf8");

  assert.match(html, /Generate Preview/);
  assert.match(html, /Copy Summary/);
  assert.match(html, /Download Summary/);
  assert.match(html, /id="export-preview"[^>]*><\/pre>/);
  assert.match(html, /id="export-copy"[^>]*disabled/);
  assert.match(html, /id="export-download"[^>]*disabled/);
  assert.match(app, /exportUi\.createExportController/);
  assert.match(app, /exportController\.bind\(\)/);
  assert.match(app, /clipboard: navigator\.clipboard/);
});

test("no automatic upload, sharing, or destructive controls are introduced", () => {
  const combined = [
    readFileSync(join(__dirname, "..", "src", "ui", "index.html"), "utf8"),
    readFileSync(join(__dirname, "..", "src", "ui", "app.js"), "utf8"),
    readFileSync(join(__dirname, "..", "src", "ui", "export.js"), "utf8")
  ].join("\n");

  assert.doesNotMatch(combined, /\/api\/(?:upload|share|stop|restart|kill|cleanup|bulk)/i);
  assert.doesNotMatch(combined, /<button[^>]*>\s*(stop|restart|kill|cleanup|bulk)/i);
  assert.doesNotMatch(combined, /fetch\(["']https?:\/\//i);
});

test("diagnostics export endpoint returns Markdown by default and JSON on request", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const markdown = await fetch(`http://127.0.0.1:${address.port}/api/diagnostics/export`);
    const markdownBody = await markdown.json();
    const json = await fetch(`http://127.0.0.1:${address.port}/api/diagnostics/export?format=json`);
    const jsonBody = await json.json();

    assert.equal(markdown.status, 200);
    assert.equal(markdownBody.format, "markdown");
    assert.match(markdownBody.content, /Localhost Watchdog Diagnostics Summary/);
    assert.equal(json.status, 200);
    assert.equal(jsonBody.format, "json");
    assert.equal(JSON.parse(jsonBody.content).schemaVersion, EXPORT_SCHEMA_VERSION);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
