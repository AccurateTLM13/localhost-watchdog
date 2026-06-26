"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

test("data-contract documentation presents only read-only endpoints as implemented", () => {
  const contracts = readFileSync(join(__dirname, "..", "docs", "07-data-contracts.md"), "utf8");
  const architecture = readFileSync(join(__dirname, "..", "docs", "03-architecture.md"), "utf8");
  const implementedSection = contracts.split("## Future Action Contract Design Notes")[0];

  assert.match(implementedSection, /## Current Read-Only API Endpoints/);
  assert.match(implementedSection, /POST\s+\/api\/actions\/stop\/dry-run/);
  assert.match(implementedSection, /POST\s+\/api\/actions\/dry-runs\/status/);
  assert.match(implementedSection, /POST\s+\/api\/actions\/stop\/confirmations/);
  assert.match(implementedSection, /POST\s+\/api\/actions\/stop\/confirmations\/submit/);
  assert.doesNotMatch(implementedSection, /GET\s+\/api\/actions\/dry-runs\/:requestId/);
  assert.doesNotMatch(implementedSection, /"dryRunToken"\s*:/);
  assert.doesNotMatch(implementedSection, /POST\s+\/api\/actions\/(?:stop|restart|kill|cleanup)\/execute/i);
  assert.doesNotMatch(implementedSection, /POST\s+\/api\/actions\/(?:restart|kill|cleanup|bulk)/i);
  assert.doesNotMatch(implementedSection, /\/api\/servers\/:id\/(?:stop|restart|kill|cleanup)/i);
  assert.doesNotMatch(architecture, /POST\s+\/api\/servers/i);
  assert.match(contracts, /This section is not an implemented contract/);
});
