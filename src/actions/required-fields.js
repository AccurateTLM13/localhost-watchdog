"use strict";

const REQUIRED_EXPECTED_FIELDS = Object.freeze([
  { path: "expected.pid", code: "EXPECTED_PID_REQUIRED", type: "integer" },
  { path: "expected.createdAt", code: "EXPECTED_CREATION_TIME_REQUIRED", type: "iso-date" },
  { path: "processInstanceId", code: "PROCESS_INSTANCE_ID_REQUIRED", type: "identity" },
  { path: "listenerId", code: "LISTENER_ID_REQUIRED", type: "identity" },
  { path: "expected.port", code: "EXPECTED_PORT_REQUIRED", type: "port" },
  { path: "expected.host", code: "EXPECTED_HOST_REQUIRED", type: "string" },
  { path: "expected.processName", code: "EXPECTED_PROCESS_NAME_REQUIRED", type: "string" },
  { path: "expected.category", code: "EXPECTED_CATEGORY_REQUIRED", type: "string" },
  { path: "expected.confidenceLevel", code: "EXPECTED_CONFIDENCE_LEVEL_REQUIRED", type: "string" },
  { path: "expected.validationFingerprint", code: "EXPECTED_VALIDATION_FINGERPRINT_REQUIRED", type: "sha256" },
  { path: "expected.projectName", code: "EXPECTED_PROJECT_NAME_REQUIRED", type: "string" },
  { path: "expected.projectRoot", code: "EXPECTED_PROJECT_ROOT_REQUIRED", type: "string" },
  { path: "expected.projectSource", code: "EXPECTED_PROJECT_SOURCE_REQUIRED", type: "string" }
]);

const MANDATORY_CHECK_CODES = Object.freeze(new Set([
  "REQUEST_SHAPE",
  "PID_EXISTS",
  "PID_MATCH",
  "STABLE_IDENTITY",
  "CREATION_TIME_MATCH",
  "CREATION_TIME_VALUE_MATCH",
  "LISTENER_ID_MATCH",
  "PROCESS_NAME_MATCH",
  "LISTENER_PORT_OWNERSHIP",
  "HOST_BIND_MATCH",
  "DEV_CATEGORY",
  "HIGH_CONFIDENCE",
  "CATEGORY_MATCH",
  "CONFIDENCE_LEVEL_MATCH",
  "PROTECTED_PROCESS",
  "PROTECTED_PORT",
  "PROCESS_TREE_BOUNDARY_AVAILABLE",
  "PROTECTED_TREE_BOUNDARY",
  "PROCESS_TREE_NOT_TRUNCATED",
  "PRIVILEGE_SAFE",
  "PROJECT_OWNERSHIP",
  "PROJECT_NAME_MATCH",
  "PROJECT_ROOT_MATCH",
  "PROJECT_SOURCE_MATCH",
  "CREATION_TIME_AVAILABLE",
  "PROCESS_METADATA_AVAILABLE",
  "LIFECYCLE_NOT_STALE",
  "CONFLICTING_NEWER_SCAN",
  "OWNER_POLICY",
  "ELEVATION_POLICY",
  ...REQUIRED_EXPECTED_FIELDS.map((field) => field.code)
]));

function getPathValue(input, path) {
  return String(path).split(".").reduce((value, part) => value && value[part], input);
}

function validateRequiredExpectedFields(input) {
  const checks = [];
  for (const field of REQUIRED_EXPECTED_FIELDS) {
    const value = getPathValue(input, field.path);
    if (!isValidFieldValue(value, field.type)) {
      checks.push({
        code: field.code,
        status: "blocked",
        mandatory: true,
        message: `Required dry-run field ${field.path} is missing or invalid.`
      });
    }
  }
  return checks;
}

function isValidFieldValue(value, type) {
  if (value == null || value === "") return false;
  if (type === "integer") {
    const number = Number(value);
    return Number.isInteger(number) && number > 0;
  }
  if (type === "port") {
    const port = Number(value);
    return Number.isInteger(port) && port > 0 && port <= 65535;
  }
  if (type === "identity") return typeof value === "string" && /^[a-z0-9_.:-]+$/i.test(value) && value.length <= 220 && !value.toLowerCase().startsWith("session-unstable-");
  if (type === "iso-date") {
    if (typeof value !== "string") return false;
    const parsed = new Date(value);
    return !Number.isNaN(parsed.getTime());
  }
  if (type === "sha256") return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
  if (type === "string") return typeof value === "string" && value.trim().length > 0;
  return value != null;
}

function isMandatoryCheck(code) {
  return MANDATORY_CHECK_CODES.has(String(code || "").toUpperCase());
}

module.exports = {
  MANDATORY_CHECK_CODES,
  REQUIRED_EXPECTED_FIELDS,
  isMandatoryCheck,
  validateRequiredExpectedFields
};
