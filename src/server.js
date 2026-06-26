"use strict";

const http = require("node:http");
const { readFileSync } = require("node:fs");
const { extname, join } = require("node:path");
const { createConfirmationManager } = require("./actions/confirmation");
const { createDryRunManager } = require("./actions/dry-run");
const { buildDiagnostics } = require("./diagnostics");
const { buildDiagnosticsExport } = require("./diagnostics/export");
const { safeError, safeInternalLogMessage } = require("./privacy/errors");
const { scanWindows } = require("./scanner/windows");
const { createSessionManager } = require("./security/session");

const DEFAULT_PORT = Number(process.env.PORT || 4545);
const HOST = process.env.HOST || "127.0.0.1";
const UI_ROOT = join(__dirname, "ui");

function createServer(options = {}) {
  const dryRunManager = options.dryRunManager || createDryRunManager();
  const sessionManager = options.sessionManager || createSessionManager();
  const confirmationManager = options.confirmationManager || createConfirmationManager({
    dryRunManager,
    scanProvider: options.confirmationScanProvider,
    auditWriter: options.confirmationAuditWriter,
    watchdogPrivilege: options.watchdogPrivilege
  });

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const pathname = url.pathname;
      if (!isSupportedLocalRequest(request)) {
        return sendJson(response, 403, {
          ok: false,
          code: "UNSUPPORTED_ORIGIN",
          message: "Only local same-origin dry-run requests are supported.",
          actionExecuted: false
        });
      }

      if (request.method === "GET" && pathname === "/api/health") {
        return sendJson(response, 200, {
          ok: true,
          destructiveActionsAvailable: false
        });
      }

      if (pathname === "/api/session" && request.method !== "POST") {
        return sendJson(response, 405, safeApiError("METHOD_NOT_ALLOWED", "Only POST is supported for session bootstrap."));
      }

      if (request.method === "POST" && pathname === "/api/session") {
        return sendJson(response, 200, sessionManager.createSession());
      }

      if (request.method === "GET" && pathname === "/api/servers") {
        return sendJson(response, 200, await scanWindows());
      }

      if (request.method === "GET" && pathname === "/api/diagnostics") {
        return sendJson(response, 200, buildDiagnostics());
      }

      if (request.method === "GET" && pathname === "/api/diagnostics/export") {
        const result = buildDiagnosticsExport({
          diagnostics: buildDiagnostics(),
          format: url.searchParams.get("format") || "markdown"
        });
        return sendJson(response, result.ok ? 200 : 422, result);
      }

      if (pathname === "/api/actions/stop/dry-run" && request.method !== "POST") {
        return sendJson(response, 405, safeApiError("METHOD_NOT_ALLOWED", "Only POST is supported for dry-run requests."));
      }

      if (request.method === "POST" && pathname === "/api/actions/stop/dry-run") {
        if (!isJsonRequest(request)) return sendJson(response, 415, safeApiError("UNSUPPORTED_CONTENT_TYPE", "Dry-run requests require application/json."));
        const body = await readJsonBody(request);
        const result = await dryRunManager.requestDryRun(body);
        return sendJson(response, result.passed ? 200 : 422, result);
      }

      if (pathname === "/api/actions/dry-runs/status" && request.method !== "POST") {
        return sendJson(response, 405, safeApiError("METHOD_NOT_ALLOWED", "Only POST is supported for dry-run status retrieval."));
      }

      if (request.method === "POST" && pathname === "/api/actions/dry-runs/status") {
        if (!isJsonRequest(request)) return sendJson(response, 415, safeApiError("UNSUPPORTED_CONTENT_TYPE", "Dry-run status requests require application/json."));
        const body = await readJsonBody(request);
        const requestId = body.requestId;
        const result = dryRunManager.getDryRunStatus(requestId, {
          statusAccessToken: request.headers["x-dry-run-status-token"] || body.statusAccessToken,
          processInstanceId: body.processInstanceId || undefined
        });
        return sendJson(response, result.ok === false ? 404 : 200, result);
      }

      if (pathname.startsWith("/api/actions/stop/confirmations") && request.method !== "POST") {
        return sendJson(response, 405, safeApiError("METHOD_NOT_ALLOWED", "Only POST is supported for confirmation requests."));
      }

      if (request.method === "POST" && pathname === "/api/actions/stop/confirmations") {
        const body = await readProtectedJson(request, response);
        if (!body.ok) return;
        const session = sessionManager.validateRequest(request, body.body);
        if (!session.ok) return sendJson(response, 403, sessionError(session));
        const result = await confirmationManager.createConfirmation(body.body, { session });
        return sendJson(response, result.ok ? 200 : 422, result);
      }

      if (request.method === "POST" && pathname === "/api/actions/stop/confirmations/submit") {
        const body = await readProtectedJson(request, response);
        if (!body.ok) return;
        const session = sessionManager.validateRequest(request, body.body);
        if (!session.ok) return sendJson(response, 403, sessionError(session));
        const result = await confirmationManager.submitConfirmation(body.body, {
          session,
          confirmationAccessToken: request.headers["x-confirmation-access-token"] || body.body.confirmationAccessToken,
          statusAccessToken: request.headers["x-dry-run-status-token"] || body.body.statusAccessToken
        });
        return sendJson(response, result.ok ? 200 : 422, result);
      }

      if (request.method === "POST" && pathname === "/api/actions/stop/confirmations/status") {
        const body = await readProtectedJson(request, response);
        if (!body.ok) return;
        const session = sessionManager.validateRequest(request, body.body);
        if (!session.ok) return sendJson(response, 403, sessionError(session));
        const result = confirmationManager.getConfirmationStatus(body.body, {
          session,
          confirmationAccessToken: request.headers["x-confirmation-access-token"] || body.body.confirmationAccessToken
        });
        return sendJson(response, result.ok === false ? 404 : 200, result);
      }

      if (request.method === "POST" && pathname === "/api/actions/stop/confirmations/cancel") {
        const body = await readProtectedJson(request, response);
        if (!body.ok) return;
        const session = sessionManager.validateRequest(request, body.body);
        if (!session.ok) return sendJson(response, 403, sessionError(session));
        const result = confirmationManager.cancelConfirmation(body.body, {
          session,
          confirmationAccessToken: request.headers["x-confirmation-access-token"] || body.body.confirmationAccessToken
        });
        return sendJson(response, result.ok === false ? 422 : 200, result);
      }

      if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        return sendStatic(response, "index.html");
      }

      if (request.method === "GET" && ["/app.js", "/export.js", "/format.js", "/render.js", "/styles.css"].includes(pathname)) {
        return sendStatic(response, pathname.slice(1));
      }

      return sendJson(response, 404, {
        ok: false,
        code: "NOT_FOUND",
        message: "Endpoint not found."
      });
    } catch (error) {
      if (error && error.statusCode) {
        return sendJson(response, error.statusCode, safeApiError(error.code, error.message));
      }
      const safe = safeError("server", error);
      return sendJson(response, 500, {
        ok: false,
        code: safe.code,
        category: safe.category,
        message: safe.message
      });
    }
  });
}

async function readProtectedJson(request, response) {
  if (!isJsonRequest(request)) {
    sendJson(response, 415, safeApiError("UNSUPPORTED_CONTENT_TYPE", "Confirmation requests require application/json."));
    return { ok: false };
  }
  const body = await readJsonBody(request);
  return { ok: true, body };
}

function sessionError(result) {
  return {
    ok: false,
    state: result.code === "CSRF_BLOCKED" ? "csrf-blocked" : "session-invalid",
    code: result.code,
    category: "session",
    message: result.message,
    actionExecuted: false,
    executionAuthorized: false
  };
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(httpError(413, "REQUEST_BODY_TOO_LARGE", "Request body is too large."));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        return resolve(JSON.parse(text));
      } catch {
        return reject(httpError(400, "INVALID_JSON", "Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function isJsonRequest(request) {
  const contentType = String(request.headers["content-type"] || "").toLowerCase();
  return contentType.startsWith("application/json");
}

function safeApiError(code, message) {
  return {
    ok: false,
    code,
    category: "api",
    message,
    actionExecuted: false
  };
}

function httpError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function isSupportedLocalRequest(request) {
  const host = hostNameFromHeader(request.headers.host || "127.0.0.1");
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
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

function startServer(port = DEFAULT_PORT, host = HOST) {
  const server = createServer();
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = `http://${host}:${port}`;
      process.stdout.write(`Localhost Watchdog read-only inspector: ${address}\n`);
      resolve(server);
    });
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body, null, 2));
}

function sendStatic(response, filename) {
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8"
  };
  const filePath = join(UI_ROOT, filename);
  const contentType = contentTypes[extname(filename)] || "application/octet-stream";
  response.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  response.end(readFileSync(filePath));
}

if (require.main === module) {
  startServer().catch((error) => {
    process.stderr.write(`${safeInternalLogMessage(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  createServer,
  startServer
};
