"use strict";

const { spawnSync } = require("node:child_process");
const { readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");

const roots = ["watchdog.js", "src", "scripts", "test"];
const files = [];

for (const root of roots) {
  collect(root);
}

let failed = false;
for (const file of files.filter((name) => name.endsWith(".js"))) {
  const result = spawnSync(process.execPath, ["--check", file], {
    stdio: "inherit",
    windowsHide: true
  });
  if (result.status !== 0) failed = true;
}

if (failed) {
  process.exitCode = 1;
}

function collect(path) {
  const stats = statSync(path);
  if (stats.isFile()) {
    files.push(path);
    return;
  }

  for (const entry of readdirSync(path)) {
    collect(join(path, entry));
  }
}
