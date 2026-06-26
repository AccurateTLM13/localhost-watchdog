"use strict";

const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { classifyReadOnly } = require("../src/classifier/confidence");
const { isProtectedProcess } = require("../src/classifier/safety");
const { loadWatchdogConfig, normalizeConfig } = require("../src/config/load");
const { redactCommandLine } = require("../src/privacy/redact");

const TEST_CONFIG = normalizeConfig({
  safety: {
    version: 1,
    devRoots: [
      "C:\\Users\\JP\\code",
      "C:\\Users\\JP\\Desktop"
    ],
    protectedProcesses: [
      "System",
      "svchost.exe",
      "MsMpEng.exe"
    ],
    protectedPorts: [445],
    protectedPortRanges: [
      {
        from: 0,
        to: 1023,
        reason: "well-known system port range"
      }
    ],
    devRuntimes: [
      "node.exe",
      "python.exe",
      "flask.exe",
      "java.exe",
      "ollama.exe"
    ],
    commonDevPorts: [3000, 4321, 5000, 5173, 8000, 8001, 8080, 31313]
  },
  projects: {
    version: 1,
    projects: [
      {
        id: "vite-app",
        name: "Vite App",
        path: "C:\\Users\\JP\\code\\vite-app"
      }
    ]
  }
});

function processFixture(name) {
  return JSON.parse(readFileSync(join(__dirname, "fixtures", "processes", `${name}.json`), "utf8"));
}

function classify(name) {
  return classifyReadOnly(processFixture(name), { config: TEST_CONFIG });
}

test("config loader falls back to example config files", () => {
  const config = loadWatchdogConfig();
  assert.equal(config.safety.protectedPorts.includes(445), true);
  assert.equal(Array.isArray(config.projects.projects), true);
});

test("config loader uses local config files when they exist", () => {
  const root = mkdtempSync(join(tmpdir(), "watchdog-config-"));
  const configDir = join(root, "config");
  const customRoot = join(root, "custom-root");
  const customProject = join(customRoot, "app");
  mkdirSync(customProject, { recursive: true });
  require("node:fs").mkdirSync(configDir);
  writeFileSync(join(configDir, "safety.json"), JSON.stringify({
    version: 1,
    devRoots: [customRoot],
    protectedProcesses: ["custom.exe"],
    protectedPorts: [123],
    protectedPortRanges: [],
    devRuntimes: ["custom-runtime.exe"],
    commonDevPorts: [456]
  }));
  writeFileSync(join(configDir, "projects.json"), JSON.stringify({
    version: 1,
    projects: [{ id: "custom", path: customProject }]
  }));

  const config = loadWatchdogConfig({ root });
  assert.deepEqual(config.safety.protectedPorts, [123]);
  assert.equal(config.safety.devRoots.some((rootPath) => rootPath.includes("custom-root\\app")), true);
});

test("Vite, Next, and Astro style Node dev servers are categorized with evidence", () => {
  for (const name of ["node-vite", "node-next", "node-astro"]) {
    const result = classify(name);
    assert.equal(result.category, "node-dev-server");
    assert.equal(result.safeToShow, true);
    assert.equal(result.safeToStop, false);
    assert.equal(result.safeToRestart, false);
    assert.equal(result.confidenceLevel, "high");
    assert.ok(result.evidence.length >= 3);
  }
});

test("Python HTTP, FastAPI, and Flask style servers are categorized", () => {
  for (const name of ["python-http", "python-fastapi", "python-flask"]) {
    const result = classify(name);
    assert.equal(result.category, "python-dev-server");
    assert.equal(result.safeToShow, true);
    assert.notEqual(result.confidenceLevel, "low");
    assert.equal(result.safeToStop, false);
  }
});

test("Ollama, LM Studio, and local companion servers are local AI servers", () => {
  for (const name of ["ollama", "lm-studio", "local-companion"]) {
    const result = classify(name);
    assert.equal(result.category, "local-ai-server");
    assert.equal(result.safeToShow, true);
    assert.equal(result.safeToStop, false);
    assert.equal(result.bulkStoppable, false);
  }
});

test("Postgres, Redis, and MySQL style listeners are databases", () => {
  for (const name of ["postgres", "redis", "mysql"]) {
    const result = classify(name);
    assert.equal(result.category, "database");
    assert.equal(result.safeToShow, true);
    assert.equal(result.safeToStop, false);
    assert.equal(result.warnings.some((warning) => warning.includes("database")), true);
  }
});

test("Chrome and Edge helper listeners are visible but read-only", () => {
  for (const name of ["chrome-helper", "edge-helper"]) {
    const result = classify(name);
    assert.equal(result.category, "browser-helper");
    assert.equal(result.safeToShow, true);
    assert.equal(result.confidenceLevel, "low");
    assert.deepEqual(result.actions, ["open", "inspect"]);
    assert.equal(result.safeToStop, false);
  }
});

test("VS Code and Cursor helper listeners are visible but read-only", () => {
  for (const name of ["vscode-helper", "cursor-helper"]) {
    const result = classify(name);
    assert.equal(result.category, "editor-helper");
    assert.equal(result.safeToShow, true);
    assert.equal(result.safeToStop, false);
  }
});

test("Java Spring style dev server is categorized separately from editor helpers", () => {
  const result = classify("java-spring");
  assert.equal(result.category, "java-dev-server");
  assert.notEqual(result.confidenceLevel, "low");
  assert.equal(result.safeToStop, false);
});

test("unknown listeners stay hidden unless they have useful evidence", () => {
  const result = classify("unknown");
  assert.equal(result.category, "unknown-listener");
  assert.equal(result.safeToShow, false);
  assert.equal(result.hiddenReason, "low-confidence");
  assert.equal(result.safeToStop, false);
});

test("protected process and protected port rules produce system-or-protected", () => {
  for (const name of ["protected-system", "protected-security"]) {
    const result = classify(name);
    assert.equal(result.category, "system-or-protected");
    assert.equal(result.safeToShow, false);
    assert.equal(result.hiddenReason, "protected");
    assert.equal(result.safeToStop, false);
  }
  assert.equal(isProtectedProcess("MsMpEng.exe", TEST_CONFIG.safety), true);
});

test("dev-root evidence alone does not make an unknown listener visible or manageable", () => {
  const root = mkdtempSync(join(tmpdir(), "watchdog-dev-root-"));
  const projectPath = join(root, "unknown-tool");
  mkdirSync(projectPath, { recursive: true });
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
  const result = classifyReadOnly({
    ...processFixture("unknown"),
    executablePath: join(projectPath, "custom.exe"),
    commandLine: "custom.exe --listen"
  }, { config });

  assert.equal(result.category, "unknown-listener");
  assert.equal(result.confidenceLevel, "low");
  assert.equal(result.safeToShow, false);
  assert.equal(result.safeToStop, false);
  assert.equal(result.evidence.some((item) => item.type === "dev-root"), true);
});

test("redacts command-line secrets in flag, env, auth, and URL forms", () => {
  const command = "OPENAI_API_KEY=sk-test node server.js --password hunter2 --client-secret=abc Bearer token123 https://user:pass@example.test";
  const redacted = redactCommandLine(command);
  assert.equal(redacted.includes("sk-test"), false);
  assert.equal(redacted.includes("hunter2"), false);
  assert.equal(redacted.includes("abc"), false);
  assert.equal(redacted.includes("token123"), false);
  assert.equal(redacted.includes("user:pass@"), false);
});
