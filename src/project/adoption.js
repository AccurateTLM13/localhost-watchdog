"use strict";

const path = require("node:path");
const { createProjectRegistry } = require("./registry");
const { loadWatchdogConfig, normalizePath, redactConfiguredPath } = require("../config/load");

const MIN_ADOPTION_CONFIDENCE = 70;
const BLOCKED_CATEGORIES = new Set([
  "database",
  "local-ai-server",
  "browser-helper",
  "editor-helper",
  "system-or-protected",
  "unknown-listener"
]);

function createAdoptionManager(options = {}) {
  const configProvider = options.configProvider || (() => loadWatchdogConfig(options.configOptions || {}));
  const registry = options.registry || createProjectRegistry({ configProvider });
  const writer = options.configWriter || defaultAdoptionWriterUnavailable;
  const randomId = options.randomId || ((bytes = 6) => require("node:crypto").randomBytes(bytes).toString("hex"));

  function draftAdoption(input = {}) {
    const record = input.record || input;
    const validation = validateAdoptionCandidate(record);
    if (!validation.ok) return errorResponse(validation.code, validation.message, { reasons: validation.reasons || [] });
    const draft = buildAdoptionDraft(record, { randomId });
    return {
      ok: true,
      schemaVersion: "localhost-watchdog.project-adoption.v1",
      state: "adoption-draft-ready",
      draft,
      actionExecuted: false
    };
  }

  async function adoptProject(input = {}) {
    const validation = validateSaveRequest(input);
    if (!validation.ok) return errorResponse(validation.code, validation.message);
    const draftResult = draftAdoption(input.record);
    if (!draftResult.ok) return draftResult;
    const draft = { ...draftResult.draft, ...sanitizeOverrides(input.project || {}) };
    const projects = registry.listProjects();
    if (projects.some((project) => project.id === draft.id)) return errorResponse("PROJECT_ID_CONFLICT", "Project id already exists.");
    let writeResult;
    try {
      writeResult = await writer({ project: draft, config: configProvider() });
    } catch {
      writeResult = { ok: false, code: "PROJECT_ADOPTION_WRITE_FAILED", message: "Project adoption could not be saved." };
    }
    if (!writeResult || writeResult.ok !== true) return errorResponse(writeResult && writeResult.code || "PROJECT_ADOPTION_WRITE_UNAVAILABLE", writeResult && writeResult.message || "Project adoption writer is unavailable.");
    return {
      ok: true,
      schemaVersion: "localhost-watchdog.project-adoption.v1",
      state: "project-adopted",
      project: publicProject(draft),
      actionExecuted: false
    };
  }

  return { draftAdoption, adoptProject };
}

function validateAdoptionCandidate(record = {}) {
  const reasons = [];
  const confidence = Number(record.confidenceScore || record.confidence || 0);
  if (!Number.isFinite(confidence) || confidence < MIN_ADOPTION_CONFIDENCE) reasons.push({ code: "CONFIDENCE_TOO_LOW", message: "Adoption requires confidence of at least 70." });
  if (BLOCKED_CATEGORIES.has(record.category)) reasons.push({ code: "CATEGORY_BLOCKED", message: "This listener category cannot be adopted blindly." });
  const root = candidateRoot(record);
  if (!root) reasons.push({ code: "PROJECT_PATH_REQUIRED", message: "A project root is required for adoption." });
  if (root && !isSupportedAbsolutePath(root)) reasons.push({ code: "PROJECT_PATH_ABSOLUTE_REQUIRED", message: "Adoption requires an absolute project path." });
  const command = candidateCommand(record);
  if (!command) reasons.push({ code: "START_COMMAND_REQUIRED", message: "A start command is required for adoption." });
  return reasons.length ? { ok: false, code: reasons[0].code, message: reasons[0].message, reasons } : { ok: true };
}

function buildAdoptionDraft(record = {}, options = {}) {
  const randomId = options.randomId || (() => "adopted");
  const root = normalizePath(candidateRoot(record));
  const name = safeString(record.project && record.project.name) || path.basename(root) || "adopted-project";
  return {
    id: stableProjectId(name, randomId),
    name,
    path: root,
    displayPath: redactConfiguredPath(root),
    startCommand: candidateCommand(record),
    preferredPort: normalizePort(record.port),
    portStrategy: "strict",
    runtime: inferRuntime(record),
    tags: ["adopted"]
  };
}

function candidateRoot(record = {}) {
  return record.project && (record.project.root || record.project.path) || record.workingDirectory || null;
}

function candidateCommand(record = {}) {
  return safeString(record.startCommand) || safeString(record.commandLine) || safeString(record.processName);
}

function inferRuntime(record = {}) {
  const text = `${record.runtime || ""} ${record.processName || ""} ${record.commandLine || ""}`.toLowerCase();
  if (text.includes("python")) return "python";
  if (text.includes("java")) return "java";
  if (text.includes("node") || text.includes("npm") || text.includes("pnpm") || text.includes("yarn")) return "node";
  return safeString(record.runtime) || null;
}

function sanitizeOverrides(value = {}) {
  const result = {};
  if (safeString(value.id)) result.id = stableProjectId(value.id, () => "");
  if (safeString(value.name)) result.name = safeString(value.name);
  if (safeString(value.startCommand)) result.startCommand = safeString(value.startCommand);
  const port = normalizePort(value.preferredPort);
  if (port) result.preferredPort = port;
  if (["strict", "next-available"].includes(value.portStrategy)) result.portStrategy = value.portStrategy;
  return result;
}

function publicProject(project) {
  return {
    id: project.id,
    name: project.name,
    displayPath: project.displayPath || redactConfiguredPath(project.path),
    preferredPort: project.preferredPort,
    portStrategy: project.portStrategy,
    runtime: project.runtime,
    tags: project.tags
  };
}

function validateSaveRequest(input = {}) {
  if (!input || typeof input !== "object") return { ok: false, code: "INVALID_REQUEST", message: "Request body must be an object." };
  if (!input.record || typeof input.record !== "object") return { ok: false, code: "RECORD_REQUIRED", message: "Detected server record is required." };
  return { ok: true };
}

function stableProjectId(name, randomId) {
  const base = String(name || "project").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
  const suffix = randomId ? randomId(3) : "";
  return suffix ? `${base}-${suffix}` : base;
}

function isSupportedAbsolutePath(value) {
  return path.isAbsolute(value) || /^[a-z]:\\/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}

function normalizePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function safeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function errorResponse(code, message, extra = {}) {
  return { ok: false, code, category: "project-adoption", message, actionExecuted: false, ...extra };
}

function defaultAdoptionWriterUnavailable() {
  return { ok: false, code: "PROJECT_ADOPTION_WRITE_UNAVAILABLE", message: "Project adoption writer is unavailable." };
}

module.exports = { MIN_ADOPTION_CONFIDENCE, buildAdoptionDraft, createAdoptionManager, validateAdoptionCandidate };
