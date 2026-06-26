"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const {
  renderErrorState,
  renderLoadingState,
  renderServerList,
  serverAccessibleLabel
} = require("../src/ui/render");

const snapshot = JSON.parse(readFileSync(join(__dirname, "fixtures", "api", "dashboard-snapshot.json"), "utf8"));
const indexHtml = readFileSync(join(__dirname, "..", "src", "ui", "index.html"), "utf8");
const css = readFileSync(join(__dirname, "..", "src", "ui", "styles.css"), "utf8");

test("dashboard shell exposes accessible names for refresh, filters, and sort control", () => {
  assert.match(indexHtml, /id="scan-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(indexHtml, /aria-label="Refresh scanner data"/);
  assert.match(indexHtml, /id="filters"[^>]*role="group"[^>]*aria-label="Filter visible listeners"/);
  assert.match(indexHtml, /data-filter="all"[^>]*aria-pressed="true"/);
  assert.match(indexHtml, /data-filter="dev"[^>]*aria-pressed="false"/);
  assert.match(indexHtml, /<label class="sort-label" for="sort">/);
  assert.match(indexHtml, /Sort visible listeners/);
});

test("server open links include context in accessible labels", () => {
  const html = renderServerList(snapshot.servers, { filter: "dev", sort: "port" });
  assert.match(html, /aria-label="Open Next Dev App on port 3000"/);
  assert.match(html, />Open 3000</);
  assert.doesNotMatch(html, /aria-label="Open"/);
});

test("details disclosures are native and have contextual labels", () => {
  const html = renderServerList(snapshot.servers, { filter: "all", sort: "port" });
  assert.match(html, /<details>/);
  assert.match(html, /<summary aria-label="Show evidence and redacted process details for/);
  assert.match(html, /Evidence and redacted process details/);
});

test("loading, empty, and API error states expose readable status semantics", () => {
  assert.match(renderLoadingState(), /role="status"/);
  assert.match(renderLoadingState(), /aria-live="polite"/);
  assert.match(renderLoadingState(), /Scanning visible localhost listeners/);
  assert.match(renderServerList([], { filter: "all" }), /No visible listeners match this filter/);
  assert.match(renderErrorState("API returned 500"), /role="alert"/);
  assert.match(renderErrorState("API returned 500"), /Scanner request failed: API returned 500/);
});

test("network exposure warnings and HTTP probe labels are text, not color-only", () => {
  const html = renderServerList(snapshot.servers, { filter: "all", sort: "port" });
  assert.match(html, /role="note" aria-label="Network exposure warning"/);
  assert.match(html, /Listener binds to all interfaces; probe uses localhost only/);
  assert.match(html, /HTTP probe status: Reachable/);
  assert.match(html, /HTTP probe status: Unreachable or non-HTTP/);
  assert.match(html, /status-text/);
  assert.match(css, /Warning: /);
  assert.match(css, /Reachable: /);
  assert.match(css, /Problem: /);
});

test("server cards have accessible list semantics and safety labels", () => {
  const html = renderServerList(snapshot.servers, { filter: "all", sort: "port" });
  assert.match(html, /role="list"/);
  assert.match(html, /role="listitem"/);
  assert.match(html, /aria-label="Next Dev App, port 3000, node-dev-server, High-confidence dev, Reachable"/);
  assert.equal(serverAccessibleLabel(snapshot.servers[0], "Next Dev App"), "Next Dev App, port 3000, node-dev-server, High-confidence dev, Reachable");
});

test("focus states are visible for keyboard users", () => {
  assert.match(css, /button:focus-visible/);
  assert.match(css, /select:focus-visible/);
  assert.match(css, /a:focus-visible/);
  assert.match(css, /summary:focus-visible/);
  assert.match(css, /outline:\s*3px solid/);
});

test("no destructive controls appear in accessibility markup", () => {
  const combined = [
    indexHtml,
    renderServerList(snapshot.servers, { filter: "all", sort: "port" }),
    renderLoadingState(),
    renderErrorState("failed")
  ].join("\n");

  assert.doesNotMatch(combined, /aria-label="[^"]*(stop|restart|kill|bulk)[^"]*"/i);
  assert.doesNotMatch(combined, /<button[^>]*>\s*(stop|restart|kill|stop all|bulk)/i);
  assert.doesNotMatch(combined, /data-action=["'](?:stop|restart|kill|bulk)/i);
});
