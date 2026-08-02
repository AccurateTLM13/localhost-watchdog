"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { createServer } = require("../src/server");

test("host shutdown requires the companion token and closes only the Watchdog backend", async () => {
  const server = createServer({ hostControlToken: "tray-host-token" });
  await listen(server);

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const unauthorized = await postJson(`${baseUrl}/api/host/shutdown`, {}, {
      "x-watchdog-host-token": "wrong-token"
    });
    assert.equal(unauthorized.statusCode, 403);
    assert.equal(unauthorized.body.code, "HOST_CONTROL_UNAUTHORIZED");
    assert.equal(unauthorized.body.serversTerminated, false);

    const authorized = await postJson(`${baseUrl}/api/host/shutdown`, {}, {
      "x-watchdog-host-token": "tray-host-token"
    });
    assert.equal(authorized.statusCode, 200);
    assert.equal(authorized.body.state, "watchdog-shutdown-requested");
    assert.equal(authorized.body.actionExecuted, false);
    assert.equal(authorized.body.serversTerminated, false);
    await waitFor(() => server.listening === false, 1000);
  } finally {
    if (server.listening) {
      await close(server);
    }
  }
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error("Timed out waiting for the Watchdog backend to close."));
      setTimeout(check, 10);
    };
    check();
  });
}

function postJson(url, body, extraHeaders = {}) {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...extraHeaders
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
      }));
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}
