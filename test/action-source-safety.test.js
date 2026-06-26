"use strict";

const assert = require("node:assert/strict");
const { readFileSync, readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const ROOT = join(__dirname, "..");

test("source contains no destructive process-control primitives", () => {
  const text = sourceText("src");
  assert.doesNotMatch(text, /\bprocess\.kill\s*\(/);
  assert.doesNotMatch(text, /\bStop-Process\b/i);
  assert.doesNotMatch(text, /\btaskkill\b/i);
  assert.doesNotMatch(text, /\bTerminateProcess\b/i);
  assert.doesNotMatch(text, /\bSuspend-Process\b/i);
  assert.doesNotMatch(text, /\/api\/actions\/(?:restart|kill|cleanup)\/execute/i);
  assert.doesNotMatch(text, /\/api\/actions\/(?:restart|kill|cleanup|bulk)/i);
});

test("dry-run source keeps all action flags disabled", () => {
  const text = sourceText("src");
  assert.doesNotMatch(text, /safeToStop\s*:\s*true/);
  assert.doesNotMatch(text, /safeToRestart\s*:\s*true/);
  assert.doesNotMatch(text, /bulkStoppable\s*:\s*true/);
  assert.match(text, /actionExecuted:\s*false/);
});

test("dry-run status access is not wired through URLs or persistent browser storage", () => {
  const text = sourceText("src");
  assert.doesNotMatch(text, /GET["']?\s*&&\s*pathname\s*===\s*["']\/api\/actions\/dry-runs/i);
  assert.doesNotMatch(text, /\/api\/actions\/dry-runs\/\$\{[^}]+token/i);
  assert.doesNotMatch(text, /searchParams\.get\(["']token["']\)/i);
  assert.doesNotMatch(text, /localStorage|sessionStorage/i);
});

test("dashboard source has no destructive controls or bulk action controls", () => {
  const text = sourceText("src/ui");
  assert.doesNotMatch(text, /<button[^>]*>\s*(stop|restart|kill|cleanup|bulk)/i);
  assert.doesNotMatch(text, /data-action=["'](?:stop|restart|kill|cleanup|bulk)/i);
  assert.doesNotMatch(text, /bulk action/i);
});

function sourceText(relativePath) {
  return files(join(ROOT, relativePath))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
}

function files(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const fullPath = join(dir, name);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      found.push(...files(fullPath));
    } else if (/\.(js|html|css)$/.test(name)) {
      found.push(fullPath);
    }
  }
  return found;
}
