"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { createServer } = require("../src/server");

test("dry-run request endpoint returns read-only eligibility result", async () => {
  const server = createServer({
    dryRunManager: {
      requestDryRun: async (body) => ({
        ok: true,
        requestId: "dryrun-test",
        processInstanceId: body.processInstanceId,
        listenerId: body.listenerId,
        eligibilityState: "confirmation-eligible",
        passed: true,
        checks: [{ code: "REQUEST_SHAPE", status: "pass", message: "valid" }],
        warnings: [],
        blockers: [],
        safeMessage: "Dry-run safety check passed. No action was executed.",
        statusAccessToken: "dryrun-status-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        actionExecuted: false
      }),
      getDryRunStatus: () => ({ ok: false, actionExecuted: false })
    }
  });

  await withListeningServer(server, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/api/actions/stop/dry-run`, {
      processInstanceId: "pid-1-created-2026-06-17t12-00-00-000z",
      listenerId: "pid-1-created-2026-06-17t12-00-00-000z-listener-tcp-127-0-0-1-3000"
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.actionExecuted, false);
    assert.equal(response.body.eligibilityState, "confirmation-eligible");
  });
});

test("dry-run status endpoint requires POST body or header token and never executes action", async () => {
  const server = createServer({
    dryRunManager: {
      requestDryRun: async () => ({ passed: false, actionExecuted: false }),
      getDryRunStatus: (requestId, options) => ({
        ok: true,
        requestId,
        tokenObserved: Boolean(options.statusAccessToken),
        processInstanceId: options.processInstanceId,
        status: "available",
        actionExecuted: false
      })
    }
  });

  await withListeningServer(server, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/api/actions/dry-runs/status`, {
      requestId: "dryrun-123",
      processInstanceId: "pid-1-created-2026-06-17t12-00-00-000z"
    }, {
      "x-dry-run-status-token": "dryrun-status-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.requestId, "dryrun-123");
    assert.equal(response.body.tokenObserved, true);
    assert.equal(response.body.processInstanceId, "pid-1-created-2026-06-17t12-00-00-000z");
    assert.equal(response.body.actionExecuted, false);

    const retiredGet = await getJson(`${baseUrl}/api/actions/dry-runs/dryrun-123?token=dryrun-status-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`);
    assert.equal(retiredGet.statusCode, 404);
    assert.equal(retiredGet.body.code, "NOT_FOUND");
  });
});

test("dry-run API rejects unsafe request shapes with categorized safe errors", async () => {
  const server = createServer({
    dryRunManager: {
      requestDryRun: async () => ({ passed: false, actionExecuted: false }),
      getDryRunStatus: () => ({ ok: false, actionExecuted: false })
    }
  });

  await withListeningServer(server, async (baseUrl) => {
    const blocked = await postJson(`${baseUrl}/api/actions/stop/dry-run`, {}, {
      Origin: "http://example.com"
    });
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.body.code, "UNSUPPORTED_ORIGIN");
    assert.equal(blocked.body.actionExecuted, false);

    const wrongMethod = await getJson(`${baseUrl}/api/actions/dry-runs/status`);
    assert.equal(wrongMethod.statusCode, 405);
    assert.equal(wrongMethod.body.code, "METHOD_NOT_ALLOWED");
    assert.equal(wrongMethod.body.actionExecuted, false);

    const wrongType = await requestJson(`${baseUrl}/api/actions/dry-runs/status`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}"
    });
    assert.equal(wrongType.statusCode, 415);
    assert.equal(wrongType.body.code, "UNSUPPORTED_CONTENT_TYPE");
    assert.equal(wrongType.body.actionExecuted, false);

    const malformed = await requestJson(`${baseUrl}/api/actions/dry-runs/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json"
    });
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.body.code, "INVALID_JSON");
    assert.equal(JSON.stringify(malformed.body).includes("not-json"), false);

    const oversized = await requestJson(`${baseUrl}/api/actions/dry-runs/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "dryrun-123", padding: "x".repeat(70 * 1024) })
    });
    assert.equal(oversized.statusCode, 413);
    assert.equal(oversized.body.code, "REQUEST_BODY_TOO_LARGE");
    assert.equal(oversized.body.actionExecuted, false);

    const badHost = await requestJson(`${baseUrl}/api/actions/dry-runs/status`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "example.com"
      },
      body: "{}"
    });
    assert.equal(badHost.statusCode, 403);
    assert.equal(badHost.body.code, "UNSUPPORTED_ORIGIN");
    assert.equal(badHost.body.actionExecuted, false);

    const missing = await getJson(`${baseUrl}/api/actions/stop/simulate-execution`);
    assert.equal(missing.statusCode, 405);
    assert.equal(missing.body.code, "METHOD_NOT_ALLOWED");
  });
});

test("real stop execution endpoint requires protected session and forwards execution proof", async () => {
  const calls = [];
  const server = createServer({
    executionManager: {
      executeStop: async (body, context) => {
        calls.push({ body, sessionNonce: context.session.sessionNonce });
        return {
          ok: true,
          state: "success",
          actionExecuted: true,
          executionAuthorized: true
        };
      }
    }
  });

  await withListeningServer(server, async (baseUrl) => {
    const session = await postJson(`${baseUrl}/api/session`, {});
    assert.equal(session.statusCode, 200);

    const wrongMethod = await getJson(`${baseUrl}/api/actions/stop/execute`);
    assert.equal(wrongMethod.statusCode, 405);
    assert.equal(wrongMethod.body.code, "METHOD_NOT_ALLOWED");

    const noOrigin = await postJson(`${baseUrl}/api/actions/stop/execute`, {
      sessionNonce: session.body.sessionNonce,
      csrfToken: session.body.csrfToken
    }, {
      "x-csrf-token": session.body.csrfToken
    });
    assert.equal(noOrigin.statusCode, 403);
    assert.equal(noOrigin.body.code, "ORIGIN_BLOCKED");

    const executed = await postJson(`${baseUrl}/api/actions/stop/execute`, {
      sessionNonce: session.body.sessionNonce,
      csrfToken: session.body.csrfToken,
      confirmationRequestId: "confirm-" + "a".repeat(32),
      processInstanceId: "pid-1-created-2026-06-18t12-00-00-000z",
      listenerId: "pid-1-created-2026-06-18t12-00-00-000z-listener-tcp-127-0-0-1-5173",
      idempotencyKey: "execute-api"
    }, localHeaders(baseUrl, session.body.csrfToken, {
      "x-execution-access-token": "exec-access-" + "b".repeat(64)
    }));

    assert.equal(executed.statusCode, 200);
    assert.equal(executed.body.state, "success");
    assert.equal(executed.body.actionExecuted, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.executionMode, "execute");
    assert.equal(calls[0].body.executionAccessToken, "exec-access-" + "b".repeat(64));
    assert.equal(calls[0].sessionNonce, session.body.sessionNonce);
  });
});

test("confirmation API requires session, CSRF, status proof, and never executes action", async () => {
  const calls = [];
  const server = createServer({
    confirmationManager: {
      createConfirmation: async (body) => {
        calls.push(["create", body.dryRunRequestId]);
        return {
          ok: true,
          confirmationRequestId: "confirm-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          dryRunRequestId: body.dryRunRequestId,
          state: "awaiting-confirmation",
          expiresAt: "2026-06-18T12:01:00.000Z",
          confirmationAccessToken: "confirm-access-" + "a".repeat(64),
          displayChallenge: {
            requiredPhrase: "CONFIRM PORT 5173 ABCD"
          },
          authorization: {
            authorizesConfirmation: true,
            authorizesExecution: false
          },
          actionExecuted: false,
          executionAuthorized: false
        };
      },
      submitConfirmation: async () => ({
        ok: true,
        confirmationRequestId: "confirm-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        state: "confirmation-accepted",
        message: "Confirmation recorded. No process action was executed.",
        authorization: {
          authorizesConfirmation: false,
          authorizesExecution: false
        },
        actionExecuted: false,
        executionAuthorized: false
      }),
      getConfirmationStatus: () => ({
        ok: true,
        confirmationRequestId: "confirm-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        state: "awaiting-confirmation",
        actionExecuted: false,
        executionAuthorized: false
      }),
      cancelConfirmation: () => ({
        ok: false,
        confirmationRequestId: "confirm-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        state: "cancelled",
        actionExecuted: false,
        executionAuthorized: false
      })
    }
  });

  await withListeningServer(server, async (baseUrl) => {
    const session = await postJson(`${baseUrl}/api/session`, {});
    assert.equal(session.statusCode, 200);
    assert.match(session.body.sessionNonce, /^lw-session-/);

    const noOrigin = await postJson(`${baseUrl}/api/actions/stop/confirmations`, {
      sessionNonce: session.body.sessionNonce,
      csrfToken: session.body.csrfToken
    }, {
      "x-csrf-token": session.body.csrfToken
    });
    assert.equal(noOrigin.statusCode, 403);
    assert.equal(noOrigin.body.code, "ORIGIN_BLOCKED");
    assert.equal(noOrigin.body.actionExecuted, false);

    const created = await postJson(`${baseUrl}/api/actions/stop/confirmations`, {
      sessionNonce: session.body.sessionNonce,
      csrfToken: session.body.csrfToken,
      dryRunRequestId: "dryrun-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }, localHeaders(baseUrl, session.body.csrfToken, {
      "x-dry-run-status-token": "dryrun-status-" + "a".repeat(64)
    }));
    assert.equal(created.statusCode, 200);
    assert.equal(created.body.state, "awaiting-confirmation");
    assert.equal(created.body.authorization.authorizesExecution, false);
    assert.equal(created.body.actionExecuted, false);

    const status = await postJson(`${baseUrl}/api/actions/stop/confirmations/status`, {
      sessionNonce: session.body.sessionNonce,
      csrfToken: session.body.csrfToken,
      confirmationRequestId: created.body.confirmationRequestId
    }, localHeaders(baseUrl, session.body.csrfToken, {
      "x-confirmation-access-token": created.body.confirmationAccessToken
    }));
    assert.equal(status.statusCode, 200);
    assert.equal(status.body.confirmationAccessToken, undefined);

    const submitted = await postJson(`${baseUrl}/api/actions/stop/confirmations/submit`, {
      sessionNonce: session.body.sessionNonce,
      csrfToken: session.body.csrfToken,
      confirmationRequestId: created.body.confirmationRequestId,
      typedPhrase: "CONFIRM PORT 5173 ABCD"
    }, localHeaders(baseUrl, session.body.csrfToken, {
      "x-confirmation-access-token": created.body.confirmationAccessToken
    }));
    assert.equal(submitted.statusCode, 200);
    assert.equal(submitted.body.state, "confirmation-accepted");
    assert.equal(submitted.body.executionAuthorized, false);
    assert.equal(submitted.body.actionExecuted, false);

    const wrongMethod = await getJson(`${baseUrl}/api/actions/stop/confirmations/status?confirmationAccessToken=${created.body.confirmationAccessToken}`);
    assert.equal(wrongMethod.statusCode, 405);
    assert.equal(JSON.stringify(wrongMethod.body).includes(created.body.confirmationAccessToken), false);

    assert.deepEqual(calls, [["create", "dryrun-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]]);
  });
});

function withListeningServer(server, fn) {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", async () => {
      const { port } = server.address();
      try {
        await fn(`http://127.0.0.1:${port}`);
        server.close((error) => error ? reject(error) : resolve());
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

function postJson(url, body, headers = {}) {
  return requestJson(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });
}

function localHeaders(baseUrl, csrfToken, extra = {}) {
  return {
    Origin: baseUrl,
    "x-csrf-token": csrfToken,
    ...extra
  };
}

function getJson(url) {
  return requestJson(url, { method: "GET" });
}

function requestJson(url, options) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: options.method,
      headers: options.headers
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
        });
      });
    });
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

test("project start and restart endpoints require protected sessions and call injected managers", async () => {
  const calls = [];
  const server = createServer({
    startManager: {
      listProjects: async () => ({ ok: true, projects: [{ id: "web", status: "stopped" }], actionExecuted: false }),
      startProject: async (body, context) => { calls.push(["start", body.projectId, context.session.sessionNonce]); return { ok: true, state: "start-dispatched", actionExecuted: true }; }
    },
    restartManager: {
      restartProject: async (body, context) => { calls.push(["restart", body.projectId, context.session.sessionNonce]); return { ok: true, state: "restart-completed", actionExecuted: true, executionAuthorized: true }; }
    }
  });

  await withListeningServer(server, async (baseUrl) => {
    const listed = await getJson(`${baseUrl}/api/projects`);
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.body.projects[0].id, "web");

    const session = await postJson(`${baseUrl}/api/session`, {});
    const start = await postJson(`${baseUrl}/api/projects/start`, {
      sessionNonce: session.body.sessionNonce,
      csrfToken: session.body.csrfToken,
      projectId: "web",
      idempotencyKey: "start-api"
    }, localHeaders(baseUrl, session.body.csrfToken));
    assert.equal(start.statusCode, 200);
    assert.equal(start.body.actionExecuted, true);

    const restart = await postJson(`${baseUrl}/api/projects/restart`, {
      sessionNonce: session.body.sessionNonce,
      csrfToken: session.body.csrfToken,
      projectId: "web",
      idempotencyKey: "restart-api"
    }, localHeaders(baseUrl, session.body.csrfToken));
    assert.equal(restart.statusCode, 200);
    assert.equal(restart.body.state, "restart-completed");
    assert.deepEqual(calls, [["start", "web", session.body.sessionNonce], ["restart", "web", session.body.sessionNonce]]);
  });
});
