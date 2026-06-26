"use strict";

const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const test = require("node:test");
const { buildDiagnostics } = require("../src/diagnostics");
const { createServer } = require("../src/server");
const { renderDiagnostics } = require("../src/ui/render");

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "watchdog-diag-"));
  mkdirSync(join(root, "config"), { recursive: true });
  writeJson(join(root, "config", "safety.example.json"), safetyConfig());
  writeJson(join(root, "config", "projects.example.json"), { version: 1, projects: [] });
  writeJson(join(root, "config", "dev-roots.example.json"), { version: 1, devRoots: [] });
  writeFileSync(join(root, ".gitignore"), ".localhost-watchdog/\n");
  return root;
}

function safetyConfig(overrides = {}) {
  return {
    version: 1,
    devRoots: [],
    protectedProcesses: ["System", "svchost.exe"],
    devRuntimes: ["node.exe"],
    commonDevPorts: [3000, 5173],
    httpProbeTimeoutMs: 750,
    httpProbeMaxRedirects: 2,
    processTree: { maxDepth: 5 },
    lifecycle: {
      longRunningDevServerMs: 14400000,
      staleCandidateMinimumScore: 60,
      categoryExclusions: ["database", "local-ai-server", "browser-helper", "editor-helper", "system-or-protected", "unknown-listener"]
    },
    history: {
      enabled: true,
      storagePath: ".localhost-watchdog/history.json",
      maxSnapshots: 25,
      maxHistoryAgeMs: 1209600000,
      maxProcessRecords: 500
    },
    protectedPorts: [445],
    protectedPortRanges: [{ from: 0, to: 1023, reason: "well-known" }],
    redaction: { redactCommandLinesBeforeOutput: true },
    ...overrides
  };
}

function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2));
}

function lastScan(overrides = {}) {
  return {
    scanId: "scan-1",
    startedAt: "2026-06-17T10:00:00.000Z",
    endedAt: "2026-06-17T10:00:00.100Z",
    durationMs: 100,
    activeScannerSource: "netstat",
    visible: 2,
    hidden: 1,
    errors: [{ source: "Get-NetTCPConnection", message: "unavailable" }],
    warnings: ["scanner fallback used"],
    probeSummary: { enabled: true, attempted: 2, reachable: 1, timeout: 0, refused: 1, nonHttp: 0 },
    enrichment: { truncatedTreeCount: 1, missingParentMetadataCount: 1, missingCreationTimeCount: 1 },
    history: null,
    ...overrides
  };
}

test("all-default configuration reports effective safe defaults", () => {
  const diagnostics = buildDiagnostics({ lastScanDiagnostics: null });

  assert.equal(diagnostics.destructiveActionsAvailable, false);
  assert.equal(diagnostics.configuration.sources.safety.status, "healthy");
  assert.equal(diagnostics.configuration.httpProbeSettings.timeoutMs > 0, true);
  assert.equal(diagnostics.configuration.processTreeDepth.effectiveValue, 5);
  assert.equal(diagnostics.privacy.commandLineRedactionActive, true);
});

test("valid local overrides are reflected as configured values", () => {
  const root = makeRoot();
  const validRoot = join(root, "dev");
  mkdirSync(validRoot);
  writeJson(join(root, "config", "safety.json"), safetyConfig({
    devRoots: [validRoot],
    httpProbeTimeoutMs: 123,
    processTree: { maxDepth: 4 },
    history: { enabled: false, storagePath: ".localhost-watchdog/history.json" }
  }));

  const diagnostics = buildDiagnostics({ root, lastScanDiagnostics: lastScan() });

  assert.equal(diagnostics.configuration.sources.safety.configured, true);
  assert.equal(diagnostics.configuration.httpProbeSettings.timeoutMs, 123);
  assert.equal(diagnostics.configuration.processTreeDepth.effectiveValue, 4);
  assert.equal(diagnostics.history.enabled, false);
  assert.equal(diagnostics.configuration.devRoots.validRoots.length, 1);
});

test("invalid dev root is reported with visible rejection reason", () => {
  const root = makeRoot();
  writeJson(join(root, "config", "safety.json"), safetyConfig({
    devRoots: ["relative\\path", "C:\\definitely-missing-watchdog-root"]
  }));

  const diagnostics = buildDiagnostics({ root, lastScanDiagnostics: lastScan() });
  const ignored = diagnostics.configuration.devRoots.ignoredRoots;

  assert.equal(ignored.length >= 2, true);
  assert.equal(ignored.some((item) => item.reasonIgnored === "not an absolute Windows path"), true);
  assert.equal(ignored.some((item) => item.reasonIgnored === "path does not exist"), true);
});

test("missing configuration files are reported as defaulted", () => {
  const root = makeRoot();
  const diagnostics = buildDiagnostics({ root, lastScanDiagnostics: lastScan() });

  assert.equal(diagnostics.configuration.sources.safety.configured, false);
  assert.equal(diagnostics.configuration.sources.safety.status, "healthy");
  assert.equal(diagnostics.configuration.safety.defaultedValue, "config/safety.example.json");
});

test("malformed configuration files are degraded but diagnostics still returns", () => {
  const root = makeRoot();
  writeFileSync(join(root, "config", "safety.json"), "{bad-json");

  const diagnostics = buildDiagnostics({ root, lastScanDiagnostics: lastScan() });

  assert.equal(diagnostics.status, "degraded");
  assert.equal(diagnostics.configuration.sources.safety.status, "warning");
  assert.equal(diagnostics.configuration.safety.invalidIgnoredValue, "invalid JSON");
});

test("PowerShell scanner degraded with netstat fallback is reported operational", () => {
  const diagnostics = buildDiagnostics({ root: makeRoot(), lastScanDiagnostics: lastScan() });

  assert.equal(diagnostics.scanner.status, "degraded");
  assert.equal(diagnostics.scanner.activeScannerSource, "netstat");
  assert.equal(diagnostics.scanner.getNetTcpConnectionAvailability, "degraded");
  assert.equal(diagnostics.scanner.netstatFallbackAvailability, "healthy");
});

test("history disabled, corrupt, unavailable, and healthy states are reported", () => {
  const disabledRoot = makeRoot();
  writeJson(join(disabledRoot, "config", "safety.json"), safetyConfig({ history: { enabled: false } }));
  assert.equal(buildDiagnostics({ root: disabledRoot, lastScanDiagnostics: lastScan() }).history.status, "disabled");

  const corruptRoot = makeRoot();
  mkdirSync(join(corruptRoot, ".localhost-watchdog"), { recursive: true });
  writeFileSync(join(corruptRoot, ".localhost-watchdog", "history.json"), "{bad");
  assert.equal(buildDiagnostics({ root: corruptRoot, lastScanDiagnostics: lastScan() }).history.storageHealth, "degraded");

  const missingRoot = makeRoot();
  assert.equal(buildDiagnostics({ root: missingRoot, lastScanDiagnostics: lastScan() }).history.storageHealth, "unavailable");

  const healthyRoot = makeRoot();
  mkdirSync(join(healthyRoot, ".localhost-watchdog"), { recursive: true });
  writeJson(join(healthyRoot, ".localhost-watchdog", "history.json"), {
    version: 1,
    snapshots: [{ scannedAt: "2026-06-17T10:00:00.000Z", processInstanceIds: [] }],
    records: {},
    meta: { lastSuccessfulWriteAt: "2026-06-17T10:00:00.000Z" }
  });
  assert.equal(buildDiagnostics({ root: healthyRoot, lastScanDiagnostics: lastScan() }).history.storageHealth, "healthy");
});

test("diagnostics output omits sensitive values and raw command data", () => {
  const root = makeRoot();
  writeJson(join(root, "config", "safety.json"), safetyConfig({
    devRoots: ["%SECRET_TOKEN%\\private", "%USERPROFILE%\\code"]
  }));
  const diagnostics = buildDiagnostics({ root, lastScanDiagnostics: lastScan({
    errors: [{ source: "Get-CimInstance Win32_Process", message: "access denied" }]
  }) });
  const text = JSON.stringify(diagnostics);

  assert.equal(text.includes("raw-secret"), false);
  assert.equal(text.includes("CommandLine"), false);
  assert.equal(text.includes(process.env.USERPROFILE || "NO_USERPROFILE"), false);
  assert.equal(diagnostics.privacy.rawCimPersistenceDisabled, true);
  assert.equal(diagnostics.privacy.processTreePersistenceDisabled, true);
});

test("raw scanner errors are categorized before diagnostics or UI rendering", () => {
  const diagnostics = buildDiagnostics({ root: makeRoot(), lastScanDiagnostics: lastScan({
    errors: [
      {
        source: "Get-NetTCPConnection",
        code: "SCANNER_TCP_UNAVAILABLE",
        category: "scanner-capability",
        message: "Primary listener scanner was unavailable; fallback may be used."
      },
      {
        source: "Get-CimInstance Win32_Process",
        code: "SCANNER_PROCESS_METADATA_UNAVAILABLE",
        category: "scanner-metadata",
        message: "raw C:\\Users\\JP\\secret --token raw-secret"
      }
    ],
    warnings: ["fallback used %SECRET_TOKEN% C:\\Users\\JP\\private"]
  }) });
  const html = renderDiagnostics(diagnostics);
  const text = JSON.stringify(diagnostics);

  assert.equal(text.includes("raw-secret"), false);
  assert.equal(text.includes("C:\\Users\\JP"), false);
  assert.equal(text.includes("%SECRET_TOKEN%"), false);
  assert.equal(diagnostics.scanner.recoverableErrors[0].code, "SCANNER_TCP_UNAVAILABLE");
  assert.match(html, /SCANNER_TCP_UNAVAILABLE/);
  assert.match(html, /SCANNER_PROCESS_METADATA_UNAVAILABLE/);
  assert.doesNotMatch(html, /raw-secret|%SECRET_TOKEN%|C:\\Users\\JP/i);
});

test("diagnostics rendering is read-only and status text is visible", () => {
  const diagnostics = buildDiagnostics({ root: makeRoot(), lastScanDiagnostics: lastScan() });
  const html = renderDiagnostics(diagnostics);

  assert.match(html, /Configuration and Diagnostics/);
  assert.match(html, /System/);
  assert.match(html, /Scanner/);
  assert.match(html, /Dev Roots/);
  assert.match(html, /Probing/);
  assert.match(html, /Process Context/);
  assert.match(html, /Lifecycle/);
  assert.match(html, /History/);
  assert.match(html, /Privacy and Safety/);
  assert.doesNotMatch(html, /<button[^>]*>\s*(stop|restart|kill|cleanup|bulk)/i);
});

test("diagnostics API endpoint returns read-only diagnostics fields", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/diagnostics`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.destructiveActionsAvailable, false);
    assert.equal(Boolean(body.configuration), true);
    assert.equal(Boolean(body.scanner), true);
    assert.equal(Boolean(body.privacy), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
