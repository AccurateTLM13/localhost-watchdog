"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const exportUi = require("../src/ui/export");

const MARKDOWN_PREVIEW = "# Localhost Watchdog Diagnostics Summary\n\nSchema: localhost-watchdog.diagnostics-export.v1\n";
const JSON_PREVIEW = "{\n  \"schemaVersion\": \"localhost-watchdog.diagnostics-export.v1\"\n}\n";

function makeElement(initialValue = "") {
  const listeners = {};
  return {
    value: initialValue,
    disabled: false,
    textContent: "",
    listeners,
    addEventListener(type, handler) {
      listeners[type] = handler;
    },
    trigger(type) {
      return listeners[type] ? listeners[type]({ target: this }) : undefined;
    }
  };
}

function makeHarness(options = {}) {
  const calls = {
    fetch: [],
    clipboard: [],
    blobs: [],
    objectUrls: [],
    revoked: [],
    appended: [],
    clicks: 0,
    removes: 0
  };
  const elements = {
    format: makeElement(options.format || "markdown"),
    generate: makeElement(),
    copy: makeElement(),
    download: makeElement(),
    status: makeElement(),
    preview: makeElement()
  };
  const fetchImpl = options.fetchImpl || (async (url) => {
    calls.fetch.push(url);
    return response(exportForUrl(url));
  });
  const clipboard = {
    writeText: async (value) => {
      calls.clipboard.push(value);
      if (options.copyReject) throw new Error("copy unavailable");
    }
  };
  class FakeBlob {
    constructor(parts, init) {
      this.parts = parts;
      this.type = init && init.type;
      calls.blobs.push(this);
    }
  }
  const urlApi = {
    createObjectURL(blob) {
      calls.objectUrls.push(blob);
      return "blob:fake-export";
    },
    revokeObjectURL(url) {
      calls.revoked.push(url);
    }
  };
  const documentRef = {
    body: {
      appendChild(link) {
        calls.appended.push(link);
      }
    },
    createElement(tagName) {
      assert.equal(tagName, "a");
      return {
        href: "",
        download: "",
        rel: "",
        click() {
          calls.clicks += 1;
        },
        remove() {
          calls.removes += 1;
        }
      };
    }
  };
  const controller = exportUi.createExportController({
    elements,
    fetchImpl,
    clipboard,
    urlApi,
    blobCtor: FakeBlob,
    documentRef
  });

  return { calls, controller, elements };
}

function exportForUrl(url) {
  if (url.includes("format=json")) {
    return {
      ok: true,
      format: "json",
      filename: "localhost-watchdog-diagnostics-20260617.json",
      content: JSON_PREVIEW,
      validation: { status: "passed" },
      actionFlags: {
        safeToStopEnabled: false,
        safeToRestartEnabled: false,
        bulkActionsEnabled: false
      }
    };
  }
  return {
    ok: true,
    format: "markdown",
    filename: "localhost-watchdog-diagnostics-20260617.md",
    content: MARKDOWN_PREVIEW,
    validation: { status: "passed" },
    actionFlags: {
      safeToStopEnabled: false,
      safeToRestartEnabled: false,
      bulkActionsEnabled: false
    }
  };
}

function response(body, ok = true) {
  return {
    ok,
    json: async () => body
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

test("export UI initial state is inert and accessible", () => {
  const { calls, controller, elements } = makeHarness();
  controller.bind();

  assert.equal(elements.format.value, "markdown");
  assert.equal(elements.copy.disabled, true);
  assert.equal(elements.download.disabled, true);
  assert.equal(elements.status.textContent, "No preview generated.");
  assert.equal(elements.preview.textContent, "");
  assert.equal(calls.fetch.length, 0);
  assert.equal(calls.clipboard.length, 0);
  assert.equal(calls.clicks, 0);

  const html = readFileSync(join(__dirname, "..", "src", "ui", "index.html"), "utf8");
  assert.match(html, /<label class="sort-label" for="export-format">/);
  assert.match(html, /aria-label="Diagnostics export format"/);
  assert.match(html, /aria-label="Generate diagnostics export preview"/);
  assert.match(html, /aria-label="Copy generated diagnostics summary"/);
  assert.match(html, /aria-label="Download generated diagnostics summary"/);
  assert.match(html, /role="status" aria-live="polite">No preview generated/);
  assert.match(html, /Exports are built from approved summary fields only/);
  assert.match(html, /<button id="export-copy"[^>]*disabled/);
  assert.match(html, /<button id="export-download"[^>]*disabled/);
});

test("successful Markdown generation is explicit and enables copy/download after validation", async () => {
  const pending = deferred();
  const { calls, controller, elements } = makeHarness({
    fetchImpl: (url) => {
      calls.fetch.push(url);
      return pending.promise;
    }
  });

  const generating = elements.generate.trigger("click") || controller.generatePreview();
  assert.equal(elements.status.textContent, "Generating preview...");
  assert.equal(elements.copy.disabled, true);
  assert.equal(elements.download.disabled, true);
  assert.equal(calls.fetch[0], "/api/diagnostics/export?format=markdown");

  pending.resolve(response(exportForUrl("format=markdown")));
  await generating;

  assert.match(elements.preview.textContent, /localhost-watchdog\.diagnostics-export\.v1/);
  assert.match(elements.status.textContent, /localhost-watchdog-diagnostics-20260617\.md/);
  assert.equal(elements.copy.disabled, false);
  assert.equal(elements.download.disabled, false);
});

test("successful JSON generation changes request format and copy/download use current JSON preview only", async () => {
  const { calls, controller, elements } = makeHarness();

  await controller.generatePreview();
  await controller.copyPreview();
  assert.equal(calls.clipboard.at(-1), MARKDOWN_PREVIEW);

  controller.setFormat("json");
  assert.equal(elements.copy.disabled, true);
  assert.equal(elements.download.disabled, true);
  assert.equal(elements.preview.textContent, "");
  assert.equal(await controller.copyPreview(), false);
  assert.notEqual(calls.clipboard.at(-1), JSON_PREVIEW);

  await controller.generatePreview();
  assert.equal(calls.fetch.at(-1), "/api/diagnostics/export?format=json");
  assert.equal(elements.preview.textContent, JSON_PREVIEW);
  assert.match(elements.status.textContent, /localhost-watchdog-diagnostics-20260617\.json/);

  await controller.copyPreview();
  assert.equal(calls.clipboard.at(-1), JSON_PREVIEW);

  assert.equal(controller.downloadPreview(), true);
  assert.equal(calls.blobs.at(-1).parts[0], JSON_PREVIEW);
  assert.equal(calls.blobs.at(-1).type, "application/json; charset=utf-8");
  assert.equal(calls.appended.at(-1).download, "localhost-watchdog-diagnostics-20260617.json");
});

test("format switching invalidates stale previews", async () => {
  const { calls, controller, elements } = makeHarness();

  await controller.generatePreview();
  assert.equal(elements.preview.textContent, MARKDOWN_PREVIEW);

  controller.setFormat("json");
  assert.equal(controller.state.exportPreview, null);
  assert.equal(elements.preview.textContent, "");
  assert.equal(elements.copy.disabled, true);
  assert.equal(elements.download.disabled, true);
  assert.match(elements.status.textContent, /Format changed/);

  await controller.copyPreview();
  assert.equal(calls.clipboard.length, 0);
  assert.equal(controller.downloadPreview(), false);
  assert.equal(calls.blobs.length, 0);
});

test("validation failure rejects preview and does not echo suspected sensitive values", async () => {
  const { controller, elements } = makeHarness({
    fetchImpl: async () => response({
      ok: false,
      format: "markdown",
      filename: "localhost-watchdog-diagnostics-20260617.md",
      content: "",
      validation: {
        status: "blocked",
        message: "raw secret token abc123"
      }
    })
  });

  await controller.generatePreview();

  assert.equal(elements.preview.textContent, "");
  assert.equal(elements.copy.disabled, true);
  assert.equal(elements.download.disabled, true);
  assert.equal(elements.status.textContent, "Export validation blocked the preview.");
  assert.doesNotMatch(elements.status.textContent, /abc123|raw secret token/i);
});

test("request, malformed response, missing content, unsupported format, and retry states are handled", async () => {
  const failures = [
    async () => response({ message: "nope" }, false),
    async () => ({ ok: true }),
    async () => response({ ok: true, format: "markdown", validation: { status: "passed" } }),
    async () => response({ ok: true, format: "xml", content: "bad", validation: { status: "passed" } })
  ];

  for (const fetchImpl of failures) {
    const { controller, elements } = makeHarness({ fetchImpl });
    await controller.generatePreview();
    assert.equal(elements.copy.disabled, true);
    assert.equal(elements.download.disabled, true);
    assert.match(elements.status.textContent, /Export (request failed|response was|response format was unsupported)/);
  }

  let fail = true;
  const { controller, elements } = makeHarness({
    fetchImpl: async () => {
      if (fail) return response({ ok: false }, false);
      return response(exportForUrl("format=markdown"));
    }
  });
  await controller.generatePreview();
  assert.equal(elements.copy.disabled, true);
  fail = false;
  await controller.generatePreview();
  assert.equal(elements.copy.disabled, false);
  assert.equal(elements.preview.textContent, MARKDOWN_PREVIEW);
});

test("copy uses preview state only and reports success or failure without real clipboard", async () => {
  const { calls, controller, elements } = makeHarness();
  elements.preview.textContent = "hidden DOM content";

  await controller.generatePreview();
  elements.preview.textContent = "tampered hidden DOM content";
  assert.equal(await controller.copyPreview(), true);
  assert.equal(calls.clipboard.at(-1), MARKDOWN_PREVIEW);
  assert.equal(elements.status.textContent, "Preview copied.");

  const failing = makeHarness({ copyReject: true });
  await failing.controller.generatePreview();
  assert.equal(await failing.controller.copyPreview(), false);
  assert.match(failing.elements.status.textContent, /Copy failed/);
});

test("download uses preview state only and cleans up object URLs without writing files", async () => {
  const { calls, controller, elements } = makeHarness();

  assert.equal(controller.downloadPreview(), false);
  assert.equal(calls.blobs.length, 0);
  assert.match(elements.status.textContent, /Generate a validated preview/);

  await controller.generatePreview();
  elements.preview.textContent = "tampered DOM content";
  assert.equal(controller.downloadPreview(), true);

  assert.equal(calls.blobs.length, 1);
  assert.equal(calls.blobs[0].parts[0], MARKDOWN_PREVIEW);
  assert.equal(calls.blobs[0].type, "text/markdown; charset=utf-8");
  assert.equal(calls.appended[0].download, "localhost-watchdog-diagnostics-20260617.md");
  assert.equal(calls.clicks, 1);
  assert.equal(calls.removes, 1);
  assert.deepEqual(calls.revoked, ["blob:fake-export"]);
});

test("no automatic upload, sharing, telemetry, or destructive controls exist in export UI", () => {
  const combined = [
    readFileSync(join(__dirname, "..", "src", "ui", "index.html"), "utf8"),
    readFileSync(join(__dirname, "..", "src", "ui", "app.js"), "utf8"),
    readFileSync(join(__dirname, "..", "src", "ui", "export.js"), "utf8")
  ].join("\n");

  assert.doesNotMatch(combined, /\/api\/(?:upload|share|telemetry|stop|restart|kill|cleanup|bulk)/i);
  assert.doesNotMatch(combined, /https?:\/\//i);
  assert.doesNotMatch(combined, /<button[^>]*>\s*(stop|restart|kill|cleanup|bulk)/i);
  assert.doesNotMatch(combined, /data-action=["'](?:stop|restart|kill|cleanup|bulk)/i);
  assert.doesNotMatch(combined, /safeToStopEnabled:\s*true|safeToRestartEnabled:\s*true|bulkActionsEnabled:\s*true/);
});
