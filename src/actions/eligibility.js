"use strict";

const crypto = require("node:crypto");

const ELIGIBILITY_STATES = new Set([
  "ineligible",
  "inspect-only",
  "dry-run-eligible",
  "confirmation-eligible",
  "blocked"
]);

const DEV_CATEGORIES = new Set(["node-dev-server", "python-dev-server", "java-dev-server"]);
const ABSOLUTE_BLOCK_CATEGORIES = new Set([
  "system-or-protected",
  "database",
  "local-ai-server",
  "unknown-listener"
]);

function evaluateRecordEligibility(record) {
  const checks = [];

  addCheck(checks, record && record.identity && record.identity.status === "stable", "STABLE_IDENTITY", "Stable PID plus creation-time identity is available.", "Stable process identity is unavailable.");
  addCheck(checks, Boolean(record && record.processInstanceId), "PROCESS_INSTANCE_ID", "Process instance ID is available.", "Process instance ID is unavailable.");
  addCheck(checks, Boolean(record && record.listenerId), "LISTENER_ID", "Listener ID is available.", "Listener ID is unavailable.");
  addCheck(checks, Boolean(record && record.createdAt), "CREATION_TIME_AVAILABLE", "Process creation time is available.", "Process creation time is missing.");
  addCheck(checks, Boolean(record && record.processName), "PROCESS_METADATA_AVAILABLE", "Process metadata is available.", "Required process metadata is missing.");

  if (!record) {
    return withFingerprint(record, buildEligibility("ineligible", checks, "Record is unavailable."));
  }

  if (ABSOLUTE_BLOCK_CATEGORIES.has(record.category)) {
    checks.push(block(`${safeCode(record.category)}_CATEGORY_BLOCKED`, `Category ${record.category} is blocked for dry-run actions.`));
  }
  if (hasProtectedAncestor(record)) {
    checks.push(block("PROTECTED_ANCESTOR", "Process tree contains a protected boundary."));
  }
  if (hasProtectedPortEvidence(record)) {
    checks.push(block("PROTECTED_PORT", "Listener uses a protected port."));
  }
  if (record.timingStatus && record.timingStatus !== "available") {
    checks.push(block("TIMING_UNAVAILABLE", "Reliable process creation time is unavailable."));
  }

  const blockers = checks.filter((item) => item.status === "blocked");
  if (blockers.length) {
    return withFingerprint(record, buildEligibility("ineligible", checks, "This listener is not eligible for a safety check."));
  }

  if (!DEV_CATEGORIES.has(record.category)) {
    checks.push(warning("NON_DEV_CATEGORY", "Only high-confidence development server categories can run stop safety checks."));
    return withFingerprint(record, buildEligibility("inspect-only", checks, "This listener is inspect-only."));
  }

  if (record.confidenceLevel !== "high") {
    checks.push(warning("CONFIDENCE_NOT_HIGH", "Display confidence is not high enough for dry-run eligibility."));
    return withFingerprint(record, buildEligibility("inspect-only", checks, "This listener is inspect-only until stronger evidence is available."));
  }

  if (!hasStrongProjectOwnership(record)) {
    checks.push(warning("PROJECT_OWNERSHIP_WEAK", "Project ownership is missing or weak."));
    return withFingerprint(record, buildEligibility("inspect-only", checks, "Project ownership is not strong enough for a safety check."));
  }

  if (record.processTree && record.processTree.truncated) {
    checks.push(warning("PROCESS_TREE_TRUNCATED", "Process tree is truncated; this listener remains inspect-only."));
    return withFingerprint(record, buildEligibility("inspect-only", checks, "Process tree is truncated, so this listener is inspect-only."));
  }

  if (record.lifecycleContext && record.lifecycleContext.label === "stale-candidate") {
    checks.push(warning("LIFECYCLE_STALE_CANDIDATE", "Lifecycle context is stale-candidate; this listener remains inspect-only."));
    return withFingerprint(record, buildEligibility("inspect-only", checks, "Lifecycle context blocks dry-run eligibility."));
  }

  return withFingerprint(record, buildEligibility("dry-run-eligible", checks, "This listener can run a read-only safety check."));
}

function hasStrongProjectOwnership(record) {
  const project = record && record.project;
  if (!project) return false;
  if (project.source === "config-project") return true;
  if (String(project.source || "").startsWith("marker:")) return true;
  return Number(project.confidence || 0) >= 80;
}

function hasProtectedAncestor(record) {
  const chain = record && record.processTree && Array.isArray(record.processTree.chain) ? record.processTree.chain : [];
  return record && record.processTree && record.processTree.stopReason === "protected-boundary" ||
    chain.some((item) => item.category === "system-or-protected");
}

function hasProtectedPortEvidence(record) {
  return (record.evidence || []).some((item) => item.type === "protected-port") ||
    (record.category === "system-or-protected" && record.hiddenReason === "protected");
}

function buildEligibility(state, checks, message) {
  const normalized = ELIGIBILITY_STATES.has(state) ? state : "ineligible";
  return {
    state: normalized,
    canDryRun: normalized === "dry-run-eligible",
    safeMessage: message,
    validationFingerprint: null,
    checks
  };
}

function withFingerprint(record, eligibility) {
  return {
    ...eligibility,
    validationFingerprint: record ? buildValidationFingerprint(record) : null
  };
}

function attachActionEligibility(record) {
  return {
    ...record,
    actionEligibility: evaluateRecordEligibility(record),
    safeToStop: false,
    safeToRestart: false,
    bulkStoppable: false
  };
}

function attachActionEligibilityToSnapshot(snapshot) {
  return {
    ...snapshot,
    servers: (snapshot.servers || []).map(attachActionEligibility)
  };
}

function buildValidationFingerprint(record) {
  const project = record && record.project ? record.project : {};
  const tree = record && record.processTree ? record.processTree : {};
  const lifecycle = record && record.lifecycleContext ? record.lifecycleContext : {};
  const exposure = record && record.networkExposure ? record.networkExposure : {};
  const probe = record && record.httpProbe ? record.httpProbe : {};
  const chain = Array.isArray(tree.chain) ? tree.chain.map((item) => ({
    pid: item.pid || null,
    processName: item.processName || null,
    category: item.category || null,
    launcherName: item.launcherName || null
  })) : [];
  const payload = {
    processInstanceId: record && record.processInstanceId || null,
    listenerId: record && record.listenerId || null,
    pid: record && record.pid || null,
    createdAt: record && record.createdAt || null,
    processName: record && record.processName || null,
    host: record && record.host || null,
    port: record && record.port || null,
    category: record && record.category || null,
    confidenceLevel: record && record.confidenceLevel || null,
    projectName: project.name || null,
    projectRoot: project.root || null,
    projectWorkingDirectory: project.workingDirectory || record && record.workingDirectory || null,
    projectSource: project.source || null,
    projectConfidence: project.confidence || null,
    timingStatus: record && record.timingStatus || null,
    networkExposureLevel: exposure.level || null,
    networkExposureWarning: Boolean(exposure.warning),
    httpReachable: probe.reachable == null ? null : Boolean(probe.reachable),
    lifecycleLabel: lifecycle.label || null,
    lifecycleStaleCandidate: Boolean(lifecycle.staleCandidate),
    treeStopReason: tree.stopReason || null,
    treeRootLauncher: tree.rootLauncher || null,
    treeChain: chain,
    treeTruncated: Boolean(tree.truncated),
    protectedBoundary: hasProtectedAncestor(record),
    protectedPort: hasProtectedPortEvidence(record)
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function addCheck(checks, ok, code, passMessage, blockMessage) {
  checks.push(ok ? pass(code, passMessage) : block(code, blockMessage));
}

function pass(code, message) {
  return { code, status: "pass", message };
}

function warning(code, message) {
  return { code, status: "warning", message };
}

function block(code, message) {
  return { code, status: "blocked", message };
}

function safeCode(value) {
  return String(value || "unknown").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

module.exports = {
  ABSOLUTE_BLOCK_CATEGORIES,
  DEV_CATEGORIES,
  ELIGIBILITY_STATES,
  attachActionEligibility,
  attachActionEligibilityToSnapshot,
  buildValidationFingerprint,
  evaluateRecordEligibility,
  hasProtectedAncestor,
  hasProtectedPortEvidence,
  hasStrongProjectOwnership
};
