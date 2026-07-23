"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const test = require("node:test");
const { createAdoptionManager, validateAdoptionCandidate } = require("../src/project/adoption");

function candidate(overrides = {}) {
  const root = overrides.root || mkdtempSync(path.join(tmpdir(), "lw-adopt-project-"));
  return {
    confidenceScore: 88,
    category: "node-dev-server",
    processName: "node",
    commandLine: "npm run dev",
    port: 5173,
    project: { name: "Adopt Me", root },
    ...overrides
  };
}

test("adoption draft requires high confidence and rejects blocked categories", () => {
  assert.equal(validateAdoptionCandidate(candidate()).ok, true);
  const lowConfidence = validateAdoptionCandidate(candidate({ confidenceScore: 69 }));
  assert.equal(lowConfidence.ok, false);
  assert.equal(lowConfidence.code, "CONFIDENCE_TOO_LOW");
  const protectedRecord = validateAdoptionCandidate(candidate({ category: "system-or-protected" }));
  assert.equal(protectedRecord.ok, false);
  assert.equal(protectedRecord.code, "CATEGORY_BLOCKED");
});

test("adoption manager builds a safe editable draft without saving by default", () => {
  const manager = createAdoptionManager({ randomId: () => "abc" });
  const draft = manager.draftAdoption(candidate());
  assert.equal(draft.ok, true);
  assert.equal(draft.state, "adoption-draft-ready");
  assert.equal(draft.draft.id, "adopt-me-abc");
  assert.equal(draft.draft.preferredPort, 5173);
  assert.equal(draft.actionExecuted, false);
});

test("adoption save uses injected config writer and reports adopted project", async () => {
  const writes = [];
  const manager = createAdoptionManager({
    randomId: () => "def",
    configProvider: () => ({ projects: { projects: [] } }),
    configWriter: async (request) => { writes.push(request.project); return { ok: true }; }
  });
  const result = await manager.adoptProject({ record: candidate(), project: { name: "Saved App", id: "saved-app" } });
  assert.equal(result.ok, true);
  assert.equal(result.state, "project-adopted");
  assert.equal(result.project.id, "saved-app");
  assert.equal(result.actionExecuted, false);
  assert.equal(writes.length, 1);
});
