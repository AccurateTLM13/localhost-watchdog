"use strict";

const SENSITIVE_KEYS = [
  "api_key",
  "apikey",
  "auth",
  "client_secret",
  "credential",
  "key",
  "password",
  "passwd",
  "secret",
  "session",
  "token"
];

function redactCommandLine(commandLine) {
  if (commandLine == null || commandLine === "") return null;

  let redacted = String(commandLine);

  redacted = redacted.replace(/([a-z][a-z0-9+.-]*:\/\/)([^:\s/@]+):([^@\s/]+)@/gi, "$1$2:[REDACTED]@");
  redacted = redacted.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]");

  for (const key of SENSITIVE_KEYS) {
    const optionKey = key.replace(/_/g, "[-_]?");
    redacted = redacted.replace(new RegExp(`(\\b[A-Z0-9_]*${key}[A-Z0-9_]*\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s]+)`, "gi"), "$1[REDACTED]");
    redacted = redacted.replace(new RegExp(`(--?[A-Z0-9_-]*${optionKey}[A-Z0-9_-]*=)("[^"]*"|'[^']*'|[^\\s]+)`, "gi"), "$1[REDACTED]");
    redacted = redacted.replace(new RegExp(`(--?[A-Z0-9_-]*${optionKey}[A-Z0-9_-]*\\s+)("[^"]*"|'[^']*'|[^\\s]+)`, "gi"), "$1[REDACTED]");
  }

  return redacted;
}

function redactPathText(value) {
  if (value == null || value === "") return null;

  let redacted = String(value);
  const homeValue = process.env.USERPROFILE || process.env.HOME || "";
  const home = normalizePath(homeValue);

  if (homeValue && home) {
    redacted = redacted.replace(new RegExp(escapeRegExp(homeValue), "gi"), "%USERPROFILE%");
    redacted = redacted.replace(new RegExp(escapeRegExp(home), "gi"), "%USERPROFILE%");
  }

  redacted = redacted.replace(/[a-z]:\\users\\[^\\\s"']+/gi, (match) => {
    const parts = match.split("\\");
    if (parts.length < 3) return match;
    return ["%USERPROFILE%", ...parts.slice(3)].join("\\");
  });

  redacted = redacted.replace(/%[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|AUTH|SESSION|CREDENTIAL|CLIENT_SECRET)[A-Z0-9_]*%/gi, "%[REDACTED]%");

  return redacted;
}

function redactSensitiveText(value) {
  if (value == null || value === "") return null;
  return redactPathText(redactCommandLine(value));
}

function safeUrlForOutput(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return redactSensitiveText(value);
  }
}

function normalizePath(value) {
  return String(value || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  SENSITIVE_KEYS,
  redactCommandLine,
  redactPathText,
  redactSensitiveText,
  safeUrlForOutput
};
