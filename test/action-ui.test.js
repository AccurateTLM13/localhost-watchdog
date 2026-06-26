"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { attachActionEligibility } = require("../src/actions/eligibility");
const { renderServerList } = require("../src/ui/render");

test("dashboard renders dry-run available state without destructive controls", () => {
  const record = attachActionEligibility(devRecord());
  const html = renderServerList([record], { filter: "all", sort: "port" });

  assert.match(html, /Read-only action readiness/);
  assert.match(html, /Safety check available/);
  assert.match(html, /Run safety check/);
  assert.match(html, /Permission <strong>not granted/);
  assert.match(html, /Read-only eligibility checks/);
  assert.doesNotMatch(html, /<button[^>]*>\s*(stop|restart|kill|cleanup|bulk)/i);
  assert.doesNotMatch(html, /data-action=["'](?:stop|restart|kill|cleanup|bulk)/i);
});

test("dashboard renders dry-run evaluating, passed, warning, blocked, expired, identity changed, and scanner unavailable states", () => {
  const record = attachActionEligibility(devRecord());
  const scenarios = [
    [{ status: "evaluating", safeMessage: "Running read-only safety check." }, /Evaluating/],
    [{ status: "passed", passed: true, warnings: [], blockers: [], checks: [], safeMessage: "passed" }, /Safety check complete/],
    [{ status: "passed", passed: true, warnings: [{ code: "NON_BLOCKING_CONTEXT" }], blockers: [], checks: [], safeMessage: "warning" }, /Safety check complete with warnings/],
    [{ status: "blocked", passed: false, warnings: [], blockers: [{ code: "CATEGORY_BLOCKED" }], checks: [], safeMessage: "blocked" }, /Blocked/],
    [{ status: "expired", passed: false, warnings: [], blockers: [], checks: [], safeMessage: "expired" }, /Expired/],
    [{ status: "blocked", passed: false, blockers: [{ code: "CREATION_TIME_MATCH" }], checks: [], safeMessage: "identity" }, /Identity changed/],
    [{ status: "blocked", passed: false, blockers: [{ code: "SCANNER_UNAVAILABLE" }], checks: [], safeMessage: "scanner" }, /Scanner unavailable/]
  ];

  for (const [dryRun, expected] of scenarios) {
    const html = renderServerList([record], {
      filter: "all",
      sort: "port",
      dryRuns: {
        [record.listenerId]: dryRun
      }
    });
    assert.match(html, expected);
    assert.doesNotMatch(html, /dryrun-status-/);
    assert.match(html, /No action|Permission <strong>not granted|Running read-only/);
  }
});

test("dashboard renders confirmation review and accepted states without tokens or destructive controls", () => {
  const record = attachActionEligibility(devRecord());
  const dryRun = {
    status: "passed",
    passed: true,
    warnings: [],
    blockers: [],
    checks: [],
    requestId: "dryrun-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    validationFingerprint: "a".repeat(64),
    safeMessage: "Dry-run safety check completed. No action was executed."
  };
  const awaiting = {
    state: "awaiting-confirmation",
    confirmationRequestId: "confirm-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    displayChallenge: {
      requiredPhrase: "CONFIRM PORT 5173 ABCD"
    },
    review: {
      ownerSessionPolicy: "same-user-same-session",
      elevationPolicy: "same-non-elevated-session"
    },
    actionExecuted: false,
    executionAuthorized: false
  };
  const html = renderServerList([record], {
    filter: "all",
    sort: "port",
    dryRuns: { [record.listenerId]: dryRun },
    confirmations: { [record.listenerId]: awaiting }
  });

  assert.match(html, /Confirmation intent/);
  assert.match(html, /Record confirmation/);
  assert.match(html, /Cancel confirmation/);
  assert.match(html, /No process action will execute/);
  assert.match(html, /same-user-same-session/);
  assert.doesNotMatch(html, /confirm-access-/);
  assert.doesNotMatch(html, /dryrun-status-/);
  assert.doesNotMatch(html, /<button[^>]*>\s*(stop|restart|kill|cleanup|execute|terminate|bulk)/i);

  const accepted = renderServerList([record], {
    filter: "all",
    sort: "port",
    dryRuns: { [record.listenerId]: dryRun },
    confirmations: {
      [record.listenerId]: {
        state: "confirmation-accepted",
        message: "Confirmation recorded. No process action was executed.",
        actionExecuted: false,
        executionAuthorized: false
      }
    }
  });

  assert.match(accepted, /Confirmation recorded/);
  assert.match(accepted, /No process action was executed/);
  assert.doesNotMatch(accepted, /confirm-access-/);
});

test("dashboard renders inspect-only and ineligible action states", () => {
  const inspectOnly = attachActionEligibility(devRecord({ confidenceLevel: "medium" }));
  const ineligible = attachActionEligibility(devRecord({ category: "database", processName: "postgres.exe" }));
  const html = renderServerList([inspectOnly, ineligible], { filter: "all", sort: "port" });

  assert.match(html, /Inspect-only/);
  assert.match(html, /Ineligible/);
  assert.doesNotMatch(html, /data-dry-run-listener-id="[^"]*database/i);
});

function devRecord(overrides = {}) {
  const base = {
    id: "pid-4242-created-2026-06-17t11-00-00-000z-listener-tcp-127-0-0-1-5173",
    processInstanceId: "pid-4242-created-2026-06-17t11-00-00-000z",
    listenerId: "pid-4242-created-2026-06-17t11-00-00-000z-listener-tcp-127-0-0-1-5173",
    identity: {
      status: "stable"
    },
    pid: 4242,
    port: 5173,
    host: "127.0.0.1",
    protocol: "tcp",
    url: "http://localhost:5173",
    processName: "node.exe",
    createdAt: "2026-06-17T11:00:00.000Z",
    timingStatus: "available",
    category: "node-dev-server",
    confidence: 92,
    confidenceLevel: "high",
    safeToShow: true,
    safeToStop: false,
    safeToRestart: false,
    bulkStoppable: false,
    project: {
      name: "watchdog-app",
      root: "%USERPROFILE%\\code\\watchdog-app",
      source: "marker:package.json",
      confidence: 90
    },
    networkExposure: {
      warning: false,
      message: "Loopback listener."
    },
    httpProbe: {
      attempted: true,
      reachable: true,
      statusCode: 200,
      responseTimeMs: 12,
      hints: ["vite"],
      title: "Vite App"
    },
    evidence: [],
    processTree: {
      truncated: false,
      stopReason: "root-reached",
      chain: [{ category: "node-runtime", processName: "node.exe", launcherName: "node" }]
    },
    launcher: {
      parentCategory: "terminal",
      launcherName: "PowerShell"
    },
    lifecycleContext: {
      label: "active",
      processAge: { label: "1 hour" },
      signals: [],
      limitations: []
    },
    historyContext: {
      historyStatus: "available",
      seenCount: 1,
      consecutiveSeenCount: 1,
      persistedAcrossScans: false,
      reappeared: false,
      evidence: []
    }
  };
  return {
    ...base,
    ...overrides,
    project: overrides.project === undefined ? base.project : overrides.project,
    processTree: overrides.processTree === undefined ? base.processTree : overrides.processTree
  };
}
