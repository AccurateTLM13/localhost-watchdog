"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const {
  filterAndSortServers,
  renderErrorState,
  renderDevRoots,
  renderHistoryStatus,
  renderLoadingState,
  renderServerList,
  renderSummary
} = require("../src/ui/render");

const snapshot = JSON.parse(readFileSync(join(__dirname, "fixtures", "api", "dashboard-snapshot.json"), "utf8"));

test("renders fake API normal, unreachable, network, unknown, local AI, database, helper, and protected states", () => {
  const html = renderServerList(snapshot.servers, { filter: "all", sort: "port" });

  assert.equal(countCards(html), 8);
  assert.match(html, /Next Dev App/);
  assert.match(html, /Project ownership/);
  assert.match(html, /next-owned-app/);
  assert.match(html, /marker:package\.json/);
  assert.match(html, /Launcher context/);
  assert.match(html, /Launched from VS Code/);
  assert.match(html, /Parent process unknown/);
  assert.match(html, /Process chain/);
  assert.match(html, /VS Code -&gt; PowerShell -&gt; npm -&gt; node/);
  assert.match(html, /Parent chain unavailable/);
  assert.match(html, /Lifecycle context/);
  assert.match(html, /long-running/);
  assert.match(html, /Running duration/);
  assert.match(html, /Lifecycle signals/);
  assert.match(html, /not permission to stop/);
  assert.match(html, /History context/);
  assert.match(html, /Repeatedly seen/);
  assert.match(html, /Continuously observed/);
  assert.match(html, /corrupt-recovered/);
  assert.match(html, /Unreachable or non-HTTP/);
  assert.match(html, /Listener binds to all interfaces/);
  assert.match(html, /unknown-listener/);
  assert.match(html, /local-ai-server/);
  assert.match(html, /database/);
  assert.match(html, /browser-helper/);
  assert.match(html, /Protected\/system/);
});

test("renders empty visible list, loading state, and API error state", () => {
  assert.match(renderServerList([], { filter: "all" }), /No visible listeners match this filter/);
  assert.match(renderLoadingState(), /Scanning visible localhost listeners/);
  assert.match(renderErrorState("API returned 500"), /Scanner request failed: API returned 500/);
});

test("summary renders compact counts from fake API data", () => {
  const html = renderSummary(snapshot);
  assert.match(html, /Total scanned/);
  assert.match(html, /Reachable HTTP/);
  assert.match(html, /Network-exposed/);
  assert.match(html, /Unknown/);
  assert.match(html, />12</);
  assert.match(html, />8</);
});

test("renders redacted configured dev root search boundaries", () => {
  const html = renderDevRoots(snapshot.config.devRoots);
  assert.match(html, /Project search boundaries/);
  assert.match(html, /%USERPROFILE%\\code/);
  assert.match(html, /D:\\localhost-watchdog/);
});

test("renders read-only history status area", () => {
  const html = renderHistoryStatus(snapshot.history);
  assert.match(html, /History status/);
  assert.match(html, /History <strong>enabled/);
  assert.match(html, /Storage <strong>available/);
  assert.match(html, /Snapshots <strong>3/);
  assert.match(html, /privacy-safe normalized fields only/);
});

test("filters cover all dashboard categories", () => {
  const expectedCounts = {
    all: 8,
    dev: 2,
    "local-ai": 1,
    database: 1,
    helpers: 2,
    unknown: 1,
    network: 1,
    readonly: 8
  };

  for (const [filter, count] of Object.entries(expectedCounts)) {
    const filtered = filterAndSortServers(snapshot.servers, { filter, sort: "port" });
    assert.equal(filtered.length, count, `filter ${filter}`);
  }
});

test("sorting covers port, category, confidence, and process name", () => {
  assert.deepEqual(filterAndSortServers(snapshot.servers, { sort: "port" }).map((record) => record.port), [
    445, 3000, 5173, 5432, 7000, 9222, 11434, 45678
  ]);

  assert.equal(filterAndSortServers(snapshot.servers, { sort: "category" })[0].category, "browser-helper");
  assert.equal(filterAndSortServers(snapshot.servers, { sort: "confidence" })[0].confidence, 92);
  assert.equal(filterAndSortServers(snapshot.servers, { sort: "process" })[0].processName, "chrome.exe");
});

test("framework and page-title values are labeled as hints, not facts", () => {
  const html = renderServerList(snapshot.servers, { filter: "dev", sort: "port" });
  assert.match(html, /Page title hint/);
  assert.match(html, /Framework\/server hints/);
  assert.match(html, /next\.js/);
  assert.doesNotMatch(html, /Framework fact/);
});

test("redacted command lines render without leaked secret values", () => {
  const html = renderServerList(snapshot.servers, { filter: "all", sort: "port" });
  assert.match(html, /Redacted command line/);
  assert.match(html, /Redacted parent command line/);
  assert.match(html, /Redacted process tree/);
  assert.match(html, /\[REDACTED\]/);
  assert.doesNotMatch(html, /secret-token|hunter2|raw-password/i);
});

test("no destructive controls are present in dashboard markup", () => {
  const combinedHtml = [
    renderServerList(snapshot.servers, { filter: "all", sort: "port" }),
    renderSummary(snapshot),
    renderLoadingState(),
    renderErrorState("failed")
  ].join("\n");

  assert.doesNotMatch(combinedHtml, /<button[^>]*>\s*(stop|restart|kill|stop all|bulk)/i);
  assert.doesNotMatch(combinedHtml, /data-action=["'](?:stop|restart|kill|bulk)/i);
  assert.doesNotMatch(combinedHtml, /\/api\/servers\/[^"']*\/(?:stop|restart|kill)/i);
});

function countCards(html) {
  return (html.match(/class="server-card/g) || []).length;
}
