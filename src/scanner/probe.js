"use strict";

const http = require("node:http");
const https = require("node:https");
const { performance } = require("node:perf_hooks");
const { redactSensitiveText, safeUrlForOutput } = require("../privacy/redact");

const DEFAULT_TIMEOUT_MS = 750;
const DEFAULT_MAX_REDIRECTS = 2;
const MAX_BODY_BYTES = 64 * 1024;

async function enrichWithHttpProbes(records, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const probe = options.probe || probeHttpUrl;

  return Promise.all(records.map(async (record) => {
    if (!shouldProbeRecord(record)) {
      const httpProbe = {
        attempted: false,
        skippedReason: "non-loopback-url"
      };
      const evidence = probeEvidence(httpProbe);
      return {
        ...record,
        httpProbe,
        evidence: [
          ...(record.evidence || []),
          evidence
        ],
        reasons: [
          ...(record.reasons || []),
          evidence.message
        ]
      };
    }

    const httpProbe = await probe(record.url, {
      timeoutMs,
      maxRedirects
    });

    const evidence = probeEvidence(httpProbe);
    return {
      ...record,
      httpProbe,
      evidence: [
        ...(record.evidence || []),
        evidence
      ],
      reasons: [
        ...(record.reasons || []),
        evidence.message
      ]
    };
  }));
}

async function probeHttpUrl(url, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const started = performance.now();

  try {
    const result = await probeOnce(new URL(url), {
      timeoutMs,
      redirectsRemaining: maxRedirects
    });
    return {
      attempted: true,
      reachable: true,
      responseTimeMs: Math.round(performance.now() - started),
      ...result
    };
  } catch (error) {
    return {
      attempted: true,
      reachable: false,
      responseTimeMs: Math.round(performance.now() - started),
      error: sanitizeProbeError(error)
    };
  }
}

function probeOnce(url, options) {
  if (!isLoopbackUrl(url)) {
    const error = new Error("Blocked redirect to non-localhost URL");
    error.code = "EXTERNAL_REDIRECT_BLOCKED";
    throw error;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    const error = new Error("Unsupported protocol");
    error.code = "UNSUPPORTED_PROTOCOL";
    throw error;
  }

  const client = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = client.request(url, {
      method: "GET",
      timeout: options.timeoutMs,
      headers: {
        "accept": "text/html,application/json;q=0.9,*/*;q=0.1",
        "user-agent": "LocalhostWatchdog/0.1 read-only-probe"
      }
    }, (response) => {
      const statusCode = response.statusCode || null;
      const headers = response.headers || {};
      const contentType = headerValue(headers["content-type"]);
      const location = headerValue(headers.location);

      if (isRedirectStatus(statusCode) && location) {
        const nextUrl = new URL(location, url);
        response.resume();
        if (!isLoopbackUrl(nextUrl)) {
          resolve({
            statusCode,
            finalUrl: safeUrlForOutput(url.toString()),
            contentType,
            title: null,
            hints: detectHints({ headers, contentType, body: "" }),
            redirectBlocked: true,
            error: "Blocked redirect to non-localhost URL"
          });
          return;
        }

        if (options.redirectsRemaining <= 0) {
          resolve({
            statusCode,
            finalUrl: safeUrlForOutput(url.toString()),
            contentType,
            title: null,
            hints: detectHints({ headers, contentType, body: "" }),
            redirectBlocked: true,
            error: "Redirect limit reached"
          });
          return;
        }

        probeOnce(nextUrl, {
          ...options,
          redirectsRemaining: options.redirectsRemaining - 1
        }).then(resolve, reject);
        return;
      }

      readSmallBody(response).then((body) => {
        resolve({
          statusCode,
          finalUrl: safeUrlForOutput(url.toString()),
          contentType,
          title: isHtml(contentType) ? extractTitle(body) : null,
          hints: detectHints({ headers, contentType, body }),
          redirectBlocked: false
        });
      }, reject);
    });

    request.on("timeout", () => {
      request.destroy(makeCodedError("Probe timed out", "ETIMEDOUT"));
    });
    request.on("error", reject);
    request.end();
  });
}

function readSmallBody(response) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    response.on("data", (chunk) => {
      if (total >= MAX_BODY_BYTES) return;
      const remaining = MAX_BODY_BYTES - total;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(slice);
      total += slice.length;
    });

    response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    response.on("error", reject);
  });
}

function shouldProbeRecord(record) {
  if (!record || !record.url || !record.safeToShow) return false;
  try {
    return isLoopbackUrl(new URL(record.url));
  } catch {
    return false;
  }
}

function isLoopbackUrl(url) {
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function isRedirectStatus(statusCode) {
  return [301, 302, 303, 307, 308].includes(Number(statusCode));
}

function isHtml(contentType) {
  return String(contentType || "").toLowerCase().includes("text/html");
}

function extractTitle(body) {
  const match = String(body || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  return collapseWhitespace(decodeHtml(match[1])).slice(0, 160) || null;
}

function detectHints({ headers, contentType, body }) {
  const haystack = `${JSON.stringify(headers || {})}\n${contentType || ""}\n${body || ""}`.toLowerCase();
  const hints = [];

  addHint(hints, haystack.includes("/@vite/client") || haystack.includes("vite"), "vite");
  addHint(hints, haystack.includes("__next") || haystack.includes("next.js") || haystack.includes("x-nextjs"), "next.js");
  addHint(hints, haystack.includes("astro"), "astro");
  addHint(hints, haystack.includes("react-refresh") || haystack.includes("create react app") || haystack.includes("react"), "react-dev-server");
  addHint(hints, haystack.includes("fastapi") || haystack.includes("uvicorn"), "fastapi");
  addHint(hints, haystack.includes("flask") || haystack.includes("werkzeug"), "flask");
  addHint(hints, haystack.includes("django") || haystack.includes("csrfmiddlewaretoken"), "django");
  addHint(hints, haystack.includes("ollama"), "ollama");
  addHint(hints, haystack.includes("lm studio") || haystack.includes("lmstudio"), "lm-studio");
  addHint(hints, haystack.includes("/api/health") || haystack.includes("\"ok\":true") || haystack.includes("companion"), "local-companion-api");

  return hints;
}

function addHint(hints, condition, hint) {
  if (condition && !hints.includes(hint)) hints.push(hint);
}

function probeEvidence(httpProbe) {
  if (!httpProbe.attempted) {
    return {
      type: "http-probe",
      score: 0,
      message: `HTTP probe skipped: ${httpProbe.skippedReason || "not eligible"}`
    };
  }

  if (httpProbe.reachable) {
    const hintText = httpProbe.hints && httpProbe.hints.length > 0 ? `; hints: ${httpProbe.hints.join(", ")}` : "";
    return {
      type: "http-probe",
      score: 0,
      message: `HTTP probe reached localhost with status ${httpProbe.statusCode || "unknown"}${hintText}`
    };
  }

  return {
    type: "http-probe",
    score: 0,
    message: `HTTP probe did not reach service: ${httpProbe.error || "unknown error"}`
  };
}

function sanitizeProbeError(error) {
  const code = error && error.code ? String(error.code) : "PROBE_ERROR";
  if (code === "ECONNREFUSED") return "Connection refused";
  if (code === "ETIMEDOUT" || code === "ABORT_ERR") return "Probe timed out";
  if (code === "ECONNRESET") return "Connection reset";
  if (code === "EXTERNAL_REDIRECT_BLOCKED") return "Blocked redirect to non-localhost URL";
  if (code === "UNSUPPORTED_PROTOCOL") return "Unsupported URL protocol";
  if (code && code.startsWith("HPE_")) return "Non-HTTP response";
  return redactSensitiveText(error && error.message ? error.message : code);
}

function makeCodedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function headerValue(value) {
  if (Array.isArray(value)) return value.join(", ");
  return value || null;
}

function collapseWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_BODY_BYTES,
  detectHints,
  enrichWithHttpProbes,
  extractTitle,
  isLoopbackUrl,
  probeEvidence,
  probeHttpUrl,
  safeUrlForOutput,
  sanitizeProbeError
};
