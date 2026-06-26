"use strict";

const crypto = require("node:crypto");

const DEFAULT_SESSION_TTL_MS = 10 * 60 * 1000;
const SESSION_TOKEN_BYTES = 32;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function createSessionManager(options = {}) {
  const sessions = new Map();
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_SESSION_TTL_MS;
  const clock = options.clock || (() => new Date());
  const randomId = options.randomId || randomHex;
  const instanceId = `session-instance-${randomId(16)}`;

  function createSession() {
    const now = clock();
    prune(now);
    const sessionNonce = `lw-session-${randomId(SESSION_TOKEN_BYTES)}`;
    const csrfToken = `lw-csrf-${randomId(SESSION_TOKEN_BYTES)}`;
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    sessions.set(sessionNonce, {
      sessionNonce,
      csrfHash: tokenHash(csrfToken),
      expiresAt,
      instanceId
    });
    return {
      ok: true,
      sessionNonce,
      csrfToken,
      expiresAt,
      actionExecuted: false,
      executionAuthorized: false
    };
  }

  function validateRequest(request, body = {}, options = {}) {
    const now = options.now || clock();
    prune(now);
    const host = validateHost(request && request.headers && request.headers.host);
    if (!host.ok) return blocked("host", "HOST_BLOCKED", "Request host is not an allowed localhost origin.");

    const origin = validateOrigin(request && request.headers && request.headers.origin, host.host);
    if (!origin.ok) return blocked("origin", "ORIGIN_BLOCKED", "Request origin is missing, malformed, null, or not same-origin.");

    const sessionNonce = body.sessionNonce;
    if (!safeSessionNonce(sessionNonce)) return blocked("session", "SESSION_INVALID", "Session validation failed.");
    const session = sessions.get(sessionNonce);
    if (!session || session.instanceId !== instanceId || new Date(session.expiresAt).getTime() <= now.getTime()) {
      return blocked("session", "SESSION_INVALID", "Session validation failed.");
    }

    const csrfToken = (request.headers && request.headers["x-csrf-token"]) || body.csrfToken;
    if (!safeCsrfToken(csrfToken) || !timingSafeHashEqual(csrfToken, session.csrfHash)) {
      return blocked("csrf", "CSRF_BLOCKED", "CSRF validation failed.");
    }

    return {
      ok: true,
      sessionNonce,
      expiresAt: session.expiresAt,
      validation: {
        host: "passed",
        origin: "passed",
        session: "passed",
        csrf: "passed"
      }
    };
  }

  function reset() {
    sessions.clear();
  }

  function prune(now = clock()) {
    const cutoff = now.getTime();
    for (const [key, value] of sessions) {
      if (new Date(value.expiresAt).getTime() <= cutoff) sessions.delete(key);
    }
  }

  return {
    createSession,
    reset,
    validateRequest
  };
}

function validateHost(value) {
  const host = hostNameFromHeader(value || "127.0.0.1");
  if (!LOCAL_HOSTS.has(host)) return { ok: false };
  return { ok: true, host };
}

function validateOrigin(value, expectedHost) {
  if (typeof value !== "string" || !value.trim() || value === "null") return { ok: false };
  try {
    const parsed = new URL(value);
    const originHost = parsed.hostname.toLowerCase();
    if (!LOCAL_HOSTS.has(originHost)) return { ok: false };
    if (expectedHost && originHost !== expectedHost && !(originHost === "localhost" && expectedHost === "127.0.0.1") && !(originHost === "127.0.0.1" && expectedHost === "localhost")) {
      return { ok: false };
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

function hostNameFromHeader(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    return end === -1 ? text : text.slice(1, end);
  }
  return text.split(":")[0];
}

function blocked(field, code, message) {
  return {
    ok: false,
    code,
    field,
    message,
    validation: {
      host: field === "host" ? "blocked" : "passed",
      origin: field === "origin" ? "blocked" : field === "host" ? "not-evaluated" : "passed",
      session: field === "session" ? "blocked" : ["host", "origin"].includes(field) ? "not-evaluated" : "passed",
      csrf: field === "csrf" ? "blocked" : field === "session" || field === "host" || field === "origin" ? "not-evaluated" : "passed"
    }
  };
}

function safeSessionNonce(value) {
  return typeof value === "string" && /^lw-session-[a-f0-9]{64}$/i.test(value);
}

function safeCsrfToken(value) {
  return typeof value === "string" && /^lw-csrf-[a-f0-9]{64}$/i.test(value);
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function timingSafeHashEqual(token, expectedHash) {
  if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/i.test(expectedHash)) return false;
  const actual = Buffer.from(tokenHash(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

module.exports = {
  createSessionManager,
  hostNameFromHeader,
  validateHost,
  validateOrigin
};
