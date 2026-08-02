"use strict";

const MANAGED_LAUNCH_CONTRACT_VERSION = "localhost-watchdog.managed-launch.v1";
const MANAGED_PROCESS_NAMES = new Set([
  "node.exe",
  "python.exe",
  "python3.exe",
  "java.exe",
  "javaw.exe",
  "bun.exe",
  "deno.exe"
]);

function normalizeManagedProcessName(value) {
  const name = String(value || "").replace(/^.*[\\/]/, "").trim().toLowerCase();
  if (!name) return "";
  return name.endsWith(".exe") ? name : `${name}.exe`;
}

function isManagedProcessName(value) {
  return MANAGED_PROCESS_NAMES.has(normalizeManagedProcessName(value));
}

function validateManagedLaunchIdentity(identity = {}) {
  const problems = [];
  const pid = Number(identity.pid);
  const processGroupId = Number(identity.processGroupId);
  const processName = normalizeManagedProcessName(identity.processName);

  if (!Number.isInteger(pid) || pid <= 0) problems.push("PID is unavailable.");
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) problems.push("Process-group identity is unavailable.");
  if (Number.isInteger(pid) && Number.isInteger(processGroupId) && pid !== processGroupId) {
    problems.push("Managed launch must own its process group.");
  }
  if (!isManagedProcessName(processName)) problems.push("The launched runtime is not supported by the graceful-stop contract.");
  if (typeof identity.createdAt !== "string" || Number.isNaN(Date.parse(identity.createdAt))) problems.push("Process creation time is unavailable.");
  if (typeof identity.processInstanceId !== "string" || !identity.processInstanceId.trim()) problems.push("Process instance identity is unavailable.");
  if (typeof identity.processInstanceId === "string" && Number.isInteger(pid) && typeof identity.createdAt === "string" && !Number.isNaN(Date.parse(identity.createdAt)) && identity.processInstanceId !== buildProcessInstanceId(pid, identity.createdAt)) {
    problems.push("Process instance identity does not match PID and creation time.");
  }
  if (identity.mechanism !== "CREATE_NEW_PROCESS_GROUP") problems.push("The managed process-group mechanism is not confirmed.");
  if (identity.cwd != null && !isAbsolutePath(identity.cwd)) problems.push("Managed launch working directory is not absolute.");
  if (identity.selectedPort != null) {
    const selectedPort = Number(identity.selectedPort);
    if (!Number.isInteger(selectedPort) || selectedPort <= 0 || selectedPort > 65535) problems.push("Selected port is invalid.");
  }

  return problems.length
    ? { ok: false, code: "PROJECT_START_IDENTITY_INVALID", problems }
    : { ok: true };
}

function buildProcessInstanceId(pid, createdAt) {
  return `pid-${Number(pid)}-created-${safeIdentityPart(createdAt)}`;
}

function safeIdentityPart(value) {
  return String(value == null ? "unknown" : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function isAbsolutePath(value) {
  return typeof value === "string" && (/^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value) || /^\//.test(value));
}

module.exports = {
  MANAGED_LAUNCH_CONTRACT_VERSION,
  MANAGED_PROCESS_NAMES,
  buildProcessInstanceId,
  isManagedProcessName,
  normalizeManagedProcessName,
  validateManagedLaunchIdentity
};
