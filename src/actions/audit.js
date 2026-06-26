"use strict";

const { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { redactSensitiveText } = require("../privacy/redact");

const DEFAULT_DRY_RUN_AUDIT_PATH = join(process.cwd(), ".localhost-watchdog", "dry-run-audit.jsonl");
const DEFAULT_CONFIRMATION_AUDIT_PATH = join(process.cwd(), ".localhost-watchdog", "confirmation-audit.jsonl");
const CONFIRMATION_AUDIT_SCHEMA = "localhost-watchdog.confirmation-audit.v1";
const DEFAULT_CONFIRMATION_RETENTION = Object.freeze({
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  maxRecords: 5000
});

function writeDryRunAudit(result, options = {}) {
  const filePath = options.filePath || DEFAULT_DRY_RUN_AUDIT_PATH;
  const writer = options.writer || defaultWriter;
  const record = buildDryRunAuditRecord(result);
  writer(filePath, `${JSON.stringify(record)}\n`);
  return record;
}

function buildDryRunAuditRecord(result) {
  return {
    schemaVersion: 1,
    type: "dry-run-eligibility",
    requestId: safeValue(result && result.requestId),
    evaluatedAt: safeValue(result && result.evaluatedAt),
    expiresAt: safeValue(result && result.expiresAt),
    processInstanceId: safeValue(result && result.processInstanceId),
    listenerId: safeValue(result && result.listenerId),
    category: safeValue(result && result.category),
    confidenceLevel: safeValue(result && result.confidenceLevel),
    eligibilityState: safeValue(result && result.eligibilityState),
    passed: Boolean(result && result.passed),
    actionExecuted: false,
    checks: (result && result.checks || []).map((check) => ({
      code: safeValue(check.code),
      status: safeValue(check.status),
      message: safeValue(check.message)
    })),
    warnings: (result && result.warnings || []).map((check) => safeValue(check.code || check.message)),
    blockers: (result && result.blockers || []).map((check) => safeValue(check.code || check.message))
  };
}

function defaultWriter(filePath, line) {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, line, "utf8");
}

function writeConfirmationAudit(input, options = {}) {
  const filePath = options.filePath || DEFAULT_CONFIRMATION_AUDIT_PATH;
  const retention = {
    ...DEFAULT_CONFIRMATION_RETENTION,
    ...(options.retention || {})
  };
  const writer = options.writer || defaultConfirmationWriter;
  const record = buildConfirmationAuditRecord(input);
  writer(filePath, record, retention);
  return record;
}

function buildConfirmationAuditRecord(input = {}) {
  const redactedIdentity = input.redactedIdentity || {};
  return {
    schemaVersion: CONFIRMATION_AUDIT_SCHEMA,
    recordType: "confirmation",
    confirmationRequestId: safeValue(input.confirmationRequestId),
    dryRunRequestId: safeValue(input.dryRunRequestId),
    timestamp: safeValue(input.timestamp),
    redactedIdentity: {
      processInstanceId: safeValue(redactedIdentity.processInstanceId),
      listenerId: safeValue(redactedIdentity.listenerId),
      port: safeNumber(redactedIdentity.port),
      bindHostClass: safeValue(redactedIdentity.bindHostClass),
      processName: safeValue(redactedIdentity.processName),
      category: safeValue(redactedIdentity.category),
      confidenceLevel: safeValue(redactedIdentity.confidenceLevel),
      projectDisplayName: safeValue(redactedIdentity.projectDisplayName)
    },
    sessionValidation: safeOutcomeMap(input.sessionValidation),
    csrf: safeValue(input.csrf),
    ownerSession: safeValue(input.ownerSession),
    elevation: safeValue(input.elevation),
    phrase: {
      challengeId: safeValue(input.phrase && input.phrase.challengeId),
      accepted: Boolean(input.phrase && input.phrase.accepted)
    },
    finalState: safeValue(input.finalState),
    expiresAt: safeValue(input.expiresAt),
    actionExecuted: false,
    executionAuthorized: false
  };
}

function defaultConfirmationWriter(filePath, record, retention) {
  mkdirSync(dirname(filePath), { recursive: true });
  recoverInterruptedWrite(filePath);
  pruneConfirmationAudit(filePath, retention);
  appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

function pruneConfirmationAudit(filePath, retention = DEFAULT_CONFIRMATION_RETENTION, now = new Date()) {
  if (!existsSync(filePath)) return { retained: 0, pruned: 0 };
  recoverInterruptedWrite(filePath);
  const parsed = readConfirmationAuditRecords(filePath);
  const cutoff = now.getTime() - retention.maxAgeMs;
  const filtered = parsed.records
    .filter((record) => {
      const time = new Date(record.timestamp || 0).getTime();
      return Number.isFinite(time) && time >= cutoff;
    })
    .slice(-retention.maxRecords);
  const pruned = parsed.records.length - filtered.length;
  if (pruned <= 0 && parsed.invalidLines === 0) return { retained: filtered.length, pruned: 0 };
  const tempPath = `${filePath}.tmp`;
  writeFileSync(tempPath, filtered.map((record) => JSON.stringify(record)).join("\n") + (filtered.length ? "\n" : ""), "utf8");
  renameSync(tempPath, filePath);
  return { retained: filtered.length, pruned };
}

function readConfirmationAuditRecords(filePath) {
  if (!existsSync(filePath)) return { records: [], invalidLines: 0 };
  const text = readFileSync(filePath, "utf8");
  const records = [];
  let invalidLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.schemaVersion === CONFIRMATION_AUDIT_SCHEMA) records.push(parsed);
      else invalidLines += 1;
    } catch {
      invalidLines += 1;
    }
  }
  return { records, invalidLines };
}

function recoverInterruptedWrite(filePath) {
  const tempPath = `${filePath}.tmp`;
  if (existsSync(tempPath)) unlinkSync(tempPath);
}

function safeValue(value) {
  if (value == null) return null;
  return redactSensitiveText(String(value)).slice(0, 400);
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeOutcomeMap(value) {
  const source = value && typeof value === "object" ? value : {};
  const result = {};
  for (const [key, item] of Object.entries(source)) {
    result[safeValue(key)] = safeValue(item);
  }
  return result;
}

module.exports = {
  CONFIRMATION_AUDIT_SCHEMA,
  DEFAULT_DRY_RUN_AUDIT_PATH,
  DEFAULT_CONFIRMATION_AUDIT_PATH,
  buildDryRunAuditRecord,
  buildConfirmationAuditRecord,
  pruneConfirmationAudit,
  readConfirmationAuditRecords,
  writeConfirmationAudit,
  writeDryRunAudit
};
