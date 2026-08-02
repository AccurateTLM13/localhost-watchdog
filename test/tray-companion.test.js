"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const companionPath = join(__dirname, "..", "scripts", "Start-LocalhostWatchdogTray.ps1");
const companionSource = readFileSync(companionPath, "utf8");

test("PowerShell tray companion uses the existing Node server and NotifyIcon", () => {
  assert.match(companionSource, /System\.Windows\.Forms\.NotifyIcon/);
  assert.match(companionSource, /watchdog\.js["'],\s*["']serve["']/);
  assert.match(companionSource, /\/api\/health/);
  assert.match(companionSource, /\/api\/servers/);
  assert.match(companionSource, /Open Watchdog/);
  assert.match(companionSource, /Refresh/);
  assert.match(companionSource, /Quit/);
});

test("PowerShell tray companion uses token-protected host shutdown and no force-stop primitive", () => {
  assert.match(companionSource, /WATCHDOG_HOST_TOKEN/);
  assert.match(companionSource, /X-Watchdog-Host-Token/);
  assert.match(companionSource, /\/api\/host\/shutdown/);
  assert.match(companionSource, /serversTerminated -ne \$false/);
  assert.doesNotMatch(companionSource, /\bStop-Process\b|\btaskkill(?:\.exe)?\b|process\.kill/i);
});

test("PowerShell tray companion does not claim ownership of an existing healthy backend", () => {
  const healthCheck = companionSource.indexOf("if (Test-WatchdogHealth)");
  const ownershipAssignment = companionSource.indexOf("$script:ownsBackend = $true");
  assert.notEqual(healthCheck, -1);
  assert.notEqual(ownershipAssignment, -1);
  assert.ok(healthCheck < ownershipAssignment);
  assert.match(companionSource, /if \(-not \$script:ownsBackend -or \$script:backendShutdownRequested\)/);
});
