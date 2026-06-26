#!/usr/bin/env node
"use strict";

const { scanWindows } = require("./src/scanner/windows");
const { startServer } = require("./src/server");
const { safeInternalLogMessage } = require("./src/privacy/errors");

async function main() {
  const command = process.argv[2] || "scan";

  if (command === "scan") {
    const snapshot = await scanWindows();
    const compact = process.argv.includes("--compact");
    process.stdout.write(JSON.stringify(snapshot, null, compact ? 0 : 2));
    process.stdout.write("\n");
    return;
  }

  if (command === "serve" || command === "start") {
    await startServer();
    return;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write([
      "Localhost Watchdog",
      "",
      "Commands:",
      "  node watchdog.js scan [--compact]  Emit a read-only JSON scanner snapshot",
      "  node watchdog.js serve             Start the local read-only inspector",
      "",
      "No stop, restart, or destructive actions exist in this phase."
    ].join("\n") + "\n");
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n`);
  process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${safeInternalLogMessage(error)}\n`);
  process.exitCode = 1;
});
