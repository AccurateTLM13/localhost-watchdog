"use strict";

const assert = require("node:assert/strict");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const test = require("node:test");
const { loadWatchdogConfig } = require("../src/config/load");
const { resolveRuntimePaths } = require("../src/runtime/paths");

const trayScript = readFileSync(join(__dirname, "..", "scripts", "Start-LocalhostWatchdogTray.ps1"), "utf8");
const buildScript = readFileSync(join(__dirname, "..", "packaging", "windows", "build-release.ps1"), "utf8");
const installerScript = readFileSync(join(__dirname, "..", "packaging", "windows", "LocalhostWatchdog.iss"), "utf8");

test("packaging stages a bundled runtime and does not require destination Node or Git", () => {
  assert.match(buildScript, /runtime\\node/);
  assert.match(buildScript, /SHA256SUMS\.txt/);
  assert.match(buildScript, /version 22 or newer/);
  assert.match(installerScript, /PrivilegesRequired=lowest/);
  assert.match(installerScript, /WindowsPowerShell\\v1\.0\\powershell\.exe/);
  assert.match(installerScript, /Localhost Watchdog/);
});

test("installed tray prefers bundled Node and redirects mutable state", () => {
  assert.match(trayScript, /runtime\\node\\node\.exe/);
  assert.match(trayScript, /LOCALHOST_WATCHDOG_APP_ROOT/);
  assert.match(trayScript, /LOCALHOST_WATCHDOG_DATA_DIR/);
  assert.match(trayScript, /Join-Path \$DataRoot "tray"/);
});

test("runtime config reads user data without writing into installed app files", () => {
  const appRoot = mkdtempSync(join(tmpdir(), "watchdog-install-app-"));
  const dataRoot = mkdtempSync(join(tmpdir(), "watchdog-install-data-"));
  mkdirSync(join(appRoot, "config"), { recursive: true });
  mkdirSync(join(dataRoot, "config"), { recursive: true });

  for (const filename of ["safety.example.json", "projects.example.json", "dev-roots.example.json"]) {
    writeFileSync(join(appRoot, "config", filename), readFileSync(join(__dirname, "..", "config", filename)));
  }
  const projectRoot = mkdtempSync(join(tmpdir(), "watchdog-install-project-"));
  writeFileSync(join(dataRoot, "config", "projects.json"), JSON.stringify({
    version: 1,
    projects: [{ id: "installed-project", root: projectRoot, displayRoot: "C:\\Users\\Test\\Installed Project" }]
  }));

  const config = loadWatchdogConfig({ root: appRoot, dataRoot });
  const paths = resolveRuntimePaths({ root: appRoot, dataRoot });
  assert.equal(config.projects.projects[0].id, "installed-project");
  assert.equal(config.safety.history.storagePath, join(dataRoot, "history.json"));
  assert.equal(paths.configRoot, join(dataRoot, "config"));
  assert.equal(existsSync(join(appRoot, "history.json")), false);
});
