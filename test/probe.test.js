"use strict";

const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const http = require("node:http");
const net = require("node:net");
const test = require("node:test");
const { classifyReadOnly } = require("../src/classifier/confidence");
const { normalizeConfig } = require("../src/config/load");
const {
  detectHints,
  enrichWithHttpProbes,
  extractTitle,
  probeHttpUrl,
  safeUrlForOutput,
  sanitizeProbeError
} = require("../src/scanner/probe");

test("successful HTML response captures title, content type, timing, and framework hints", async (t) => {
  const server = await listenHttp((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Vite App</title><script type=\"module\" src=\"/@vite/client\"></script>");
  });
  t.after(() => server.close());

  const result = await probeHttpUrl(`http://127.0.0.1:${server.address().port}`, { timeoutMs: 250 });
  assert.equal(result.attempted, true);
  assert.equal(result.reachable, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.contentType, "text/html; charset=utf-8");
  assert.equal(result.title, "Vite App");
  assert.equal(result.hints.includes("vite"), true);
  assert.equal(typeof result.responseTimeMs, "number");
  assert.equal("body" in result, false);
});

test("JSON API response captures status, content type, and API hints without body storage", async (t) => {
  const server = await listenHttp((request, response) => {
    response.writeHead(200, { "content-type": "application/json", "server": "uvicorn" });
    response.end(JSON.stringify({ ok: true, companion: true }));
  });
  t.after(() => server.close());

  const result = await probeHttpUrl(`http://localhost:${server.address().port}`, { timeoutMs: 250 });
  assert.equal(result.reachable, true);
  assert.equal(result.title, null);
  assert.equal(result.hints.includes("fastapi"), true);
  assert.equal(result.hints.includes("local-companion-api"), true);
  assert.equal("body" in result, false);
});

test("timeout is bounded and reported safely", async (t) => {
  const server = await listenHttp(() => {});
  t.after(() => server.close());

  const result = await probeHttpUrl(`http://127.0.0.1:${server.address().port}`, { timeoutMs: 50 });
  assert.equal(result.reachable, false);
  assert.equal(result.error, "Probe timed out");
  assert.ok(result.responseTimeMs < 1000);
});

test("refused or closed connection is reported safely", async () => {
  const server = await listenHttp((request, response) => response.end("closing"));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));

  const result = await probeHttpUrl(`http://127.0.0.1:${port}`, { timeoutMs: 250 });
  assert.equal(result.reachable, false);
  assert.equal(result.error, "Connection refused");
});

test("redirect to localhost is followed", async (t) => {
  const target = await listenHttp((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<title>Redirect Target</title>");
  });
  const source = await listenHttp((request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/target` });
    response.end();
  });
  t.after(() => source.close());
  t.after(() => target.close());

  const result = await probeHttpUrl(`http://localhost:${source.address().port}`, { timeoutMs: 250 });
  assert.equal(result.reachable, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.finalUrl, `http://127.0.0.1:${target.address().port}/target`);
  assert.equal(result.title, "Redirect Target");
});

test("final URL strips localhost query, fragment, and embedded credentials", async (t) => {
  const target = await listenHttp((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<title>Safe Target</title>");
  });
  const source = await listenHttp((request, response) => {
    response.writeHead(302, { location: `http://user:pass@127.0.0.1:${target.address().port}/target?token=raw-secret#frag` });
    response.end();
  });
  t.after(() => source.close());
  t.after(() => target.close());

  const result = await probeHttpUrl(`http://localhost:${source.address().port}`, { timeoutMs: 250 });
  assert.equal(result.reachable, true);
  assert.equal(result.finalUrl, `http://127.0.0.1:${target.address().port}/target`);
  assert.equal(JSON.stringify(result).includes("raw-secret"), false);
  assert.equal(JSON.stringify(result).includes("user:pass"), false);
  assert.equal(result.finalUrl.includes("?"), false);
  assert.equal(result.finalUrl.includes("#"), false);
});

test("redirect to external URL is blocked", async (t) => {
  const server = await listenHttp((request, response) => {
    response.writeHead(302, { location: "https://example.com/path?token=secret" });
    response.end();
  });
  t.after(() => server.close());

  const result = await probeHttpUrl(`http://127.0.0.1:${server.address().port}`, { timeoutMs: 250 });
  assert.equal(result.reachable, true);
  assert.equal(result.statusCode, 302);
  assert.equal(result.redirectBlocked, true);
  assert.equal(result.error, "Blocked redirect to non-localhost URL");
  assert.equal(result.finalUrl, `http://127.0.0.1:${server.address().port}/`);
});

test("non-HTTP listener is reported without raw parser details", async (t) => {
  const server = await listenTcp((socket) => {
    socket.write("not http\r\n");
    socket.end();
  });
  t.after(() => server.close());

  const result = await probeHttpUrl(`http://127.0.0.1:${server.address().port}`, { timeoutMs: 250 });
  assert.equal(result.reachable, false);
  assert.equal(result.error, "Non-HTTP response");
});

test("all-interface listener keeps warning and receives zero-score probe evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "watchdog-probe-root-"));
  const projectRoot = join(root, "vite-app");
  mkdirSync(projectRoot, { recursive: true });
  const config = normalizeConfig({
    safety: {
      ...TEST_CONFIG.safety,
      devRoots: [root]
    },
    projects: TEST_CONFIG.projects,
    devRoots: {
      version: 1,
      devRoots: []
    }
  });
  const record = {
    id: "session-unstable-test-pid-1-listener-tcp-0-0-0-0-3000",
    pid: 1,
    port: 3000,
    host: "0.0.0.0",
    url: "http://localhost:3000",
    processName: "node.exe",
    commandLine: `node ${join(projectRoot, "node_modules", "vite", "bin", "vite.js")}`,
    executablePath: "C:\\Program Files\\nodejs\\node.exe"
  };
  const classified = classifyReadOnly(record, { config });
  const [enriched] = await enrichWithHttpProbes([classifiedRecord(record, classified)], {
    probe: async () => ({
      attempted: true,
      reachable: true,
      statusCode: 200,
      responseTimeMs: 3,
      finalUrl: "http://localhost:3000/",
      contentType: "text/html",
      title: "App",
      hints: ["vite"],
      redirectBlocked: false
    })
  });

  assert.equal(enriched.networkExposure.warning, true);
  assert.equal(enriched.safeToStop, false);
  assert.equal(enriched.safeToRestart, false);
  assert.equal(enriched.evidence.some((item) => item.type === "http-probe" && item.score === 0), true);
});

test("probe error redaction removes sensitive values", () => {
  const error = new Error("request failed --token secret-token https://user:pass@example.test");
  assert.equal(sanitizeProbeError(error).includes("secret-token"), false);
  assert.equal(sanitizeProbeError(error).includes("user:pass@"), false);
});

test("safe URL output strips credentials, query strings, and fragments", () => {
  const safe = safeUrlForOutput("http://user:pass@localhost:3000/path?api_key=raw-secret#debug");

  assert.equal(safe, "http://localhost:3000/path");
  assert.equal(safe.includes("raw-secret"), false);
  assert.equal(safe.includes("user:pass"), false);
});

test("framework hint helpers cover common local tools", () => {
  assert.deepEqual(extractTitle("<title> A &amp; B </title>"), "A & B");
  const hints = detectHints({
    headers: { "x-powered-by": "Next.js", server: "Werkzeug" },
    contentType: "text/html",
    body: "__NEXT_DATA__ Flask Django Astro React"
  });
  assert.equal(hints.includes("next.js"), true);
  assert.equal(hints.includes("flask"), true);
  assert.equal(hints.includes("django"), true);
  assert.equal(hints.includes("astro"), true);
  assert.equal(hints.includes("react-dev-server"), true);
});

function classifiedRecord(record, classified) {
  return {
    ...record,
    ...classified
  };
}

const TEST_CONFIG = normalizeConfig({
  safety: {
    version: 1,
    devRoots: ["C:\\Users\\JP\\code"],
    protectedProcesses: ["System"],
    protectedPorts: [],
    protectedPortRanges: [],
    devRuntimes: ["node.exe"],
    commonDevPorts: [3000]
  },
  projects: {
    version: 1,
    projects: []
  }
});

function listenHttp(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function listenTcp(handler) {
  const server = net.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}
