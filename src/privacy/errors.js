"use strict";

const { redactSensitiveText } = require("./redact");

const SOURCE_CODES = new Map([
  ["Get-NetTCPConnection", ["SCANNER_TCP_UNAVAILABLE", "scanner-capability"]],
  ["Get-CimInstance Win32_Process", ["SCANNER_PROCESS_METADATA_UNAVAILABLE", "scanner-metadata"]],
  ["netstat -ano", ["SCANNER_NETSTAT_UNAVAILABLE", "scanner-fallback"]],
  ["history", ["HISTORY_UNAVAILABLE", "history"]],
  ["server", ["REQUEST_FAILED", "api"]]
]);

const DEFAULT_MESSAGES = {
  SCANNER_TCP_UNAVAILABLE: "Primary listener scanner was unavailable; fallback may be used.",
  SCANNER_PROCESS_METADATA_UNAVAILABLE: "Process metadata was unavailable; records may have reduced context.",
  SCANNER_NETSTAT_UNAVAILABLE: "Fallback listener scanner was unavailable.",
  HISTORY_UNAVAILABLE: "History storage was unavailable; current scan results were still returned.",
  HISTORY_WRITE_FAILED: "History storage could not be updated; current scan results were still returned.",
  REQUEST_FAILED: "The request could not be completed safely.",
  PROBE_ERROR: "HTTP probe failed.",
  UNKNOWN_RECOVERABLE_ERROR: "A recoverable error occurred; current safe results were still returned."
};

function safeError(source, error, options = {}) {
  const sourceText = safeSource(source);
  const [sourceCode, category] = SOURCE_CODES.get(sourceText) || ["UNKNOWN_RECOVERABLE_ERROR", "recoverable"];
  const code = options.code || codeFromError(error) || sourceCode;
  return {
    source: sourceText,
    code,
    category: options.category || category,
    message: options.message || DEFAULT_MESSAGES[code] || DEFAULT_MESSAGES[sourceCode] || DEFAULT_MESSAGES.UNKNOWN_RECOVERABLE_ERROR
  };
}

function safeErrorMessage(source, error, options = {}) {
  return safeError(source, error, options).message;
}

function safeInternalLogMessage(error) {
  return redactSensitiveText(error && (error.stack || error.message) ? (error.stack || error.message) : error);
}

function codeFromError(error) {
  const code = error && error.code ? String(error.code).toUpperCase().replace(/[^A-Z0-9_]+/g, "_") : "";
  if (!code) return null;
  if (code.includes("EACCES") || code.includes("ACCESS")) return "PERMISSION_LIMITED";
  if (code.includes("ENOENT")) return "CAPABILITY_MISSING";
  return null;
}

function safeSource(source) {
  const value = String(source || "unknown");
  if (SOURCE_CODES.has(value)) return value;
  return value.replace(/[^\w .:-]/g, "").slice(0, 80) || "unknown";
}

module.exports = {
  safeError,
  safeErrorMessage,
  safeInternalLogMessage
};
