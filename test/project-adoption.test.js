"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdtempSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const test = require("node:test");
const { createAdoptionManager, validateAdoptionCandidate } = require("../src/project/adoption");
const { normalizeProjectRoot } = require("../src/config/load");

function candidate(overrides = {}) {
  const root = overrides.root || mkdtempSync(path.join(tmpdir(), "lw-adopt-project-"));
  return {
    confidenceScore: 88,
    category: "node-dev-server",
    processName: "node",
    commandLine: "node server.js",
    host: "127.0.0.1",
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

test("adoption rejects shell-wrapper commands that cannot satisfy the managed launch contract", () => {
  const result = validateAdoptionCandidate(candidate({ commandLine: "npm run dev" }));
  assert.equal(result.ok, false);
  assert.equal(result.reasons.some((reason) => reason.code === "START_WRAPPER_UNSUPPORTED"), true);
});

test("adoption manager builds a safe editable draft without saving by default", () => {
  const manager = createAdoptionManager({ randomId: () => "abc" });
  const record = candidate();
  const draft = manager.draftAdoption(record);
  assert.equal(draft.ok, true);
  assert.equal(draft.state, "adoption-draft-ready");
  assert.equal(draft.draft.id, "adopt-me-abc");
  assert.equal(draft.draft.preferredPort, 5173);
  assert.equal(draft.draft.root, normalizeProjectRoot(record.project.root));
  assert.equal(draft.draft.displayRoot, record.project.root);
  assert.equal(draft.actionExecuted, false);
});

test("adoption save uses injected config writer and reports adopted project", async () => {
  const writes = [];
  const manager = createAdoptionManager({
    randomId: () => "def",
    configProvider: () => ({ projects: { projects: [] }, safety: { protectedProcesses: [], protectedPorts: [], protectedPortRanges: [] } }),
    configWriter: async (request) => { writes.push(request.project); return { ok: true }; }
  });
  const result = await manager.adoptProject({ record: candidate(), project: { name: "Saved App", id: "saved-app" } });
  assert.equal(result.ok, true);
  assert.equal(result.state, "project-adopted");
  assert.equal(result.project.id, "saved-app");
  assert.equal(result.project.root, writes[0].root);
  assert.equal(result.project.displayRoot, writes[0].displayRoot);
  assert.equal(result.actionExecuted, false);
  assert.equal(writes.length, 1);
});

test("adoption default writer persists an explicit project registry entry atomically", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lw-adopt-default-project-"));
  const configRoot = mkdtempSync(path.join(tmpdir(), "lw-adopt-default-config-"));
  const projectsPath = path.join(configRoot, "config", "projects.json");
  const manager = createAdoptionManager({
    randomId: () => "persisted",
    projectsPath,
    configProvider: () => ({ projects: { projects: [] }, safety: { protectedProcesses: [], protectedPorts: [], protectedPortRanges: [] } })
  });
  const result = await manager.adoptProject({ record: candidate({ root }), project: { id: "persisted-app" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  const saved = JSON.parse(readFileSync(projectsPath, "utf8"));
  assert.equal(saved.projects.length, 1);
  assert.equal(saved.projects[0].id, "persisted-app");
  assert.equal(saved.projects[0].root, result.project.root);
  assert.equal(saved.projects[0].displayRoot, result.project.displayRoot);
});

test("adoption fails closed when safety configuration is unavailable", async () => {
  let wrote = false;
  const manager = createAdoptionManager({
    configProvider: () => { throw new Error("config unavailable"); },
    configWriter: async () => { wrote = true; return { ok: true }; }
  });
  const result = await manager.adoptProject({ record: candidate() });
  assert.equal(result.ok, false);
  assert.equal(result.code, "SAFETY_CONFIG_UNAVAILABLE");
  assert.equal(wrote, false);
});
