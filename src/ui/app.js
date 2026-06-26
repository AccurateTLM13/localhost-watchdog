"use strict";

const format = window.WatchdogFormat;
const renderers = window.WatchdogRender;
const exportUi = window.WatchdogExportUi;
const state = {
  snapshot: null,
  diagnostics: null,
  dryRuns: {},
  dryRunStatusAccess: {},
  confirmations: {},
  confirmationAccess: {},
  session: null,
  filter: "all",
  sort: "port"
};

const els = {
  summary: document.getElementById("summary"),
  diagnostics: document.getElementById("diagnostics"),
  devRoots: document.getElementById("dev-roots"),
  servers: document.getElementById("servers"),
  refresh: document.getElementById("refresh"),
  status: document.getElementById("scan-status"),
  filters: document.getElementById("filters"),
  sort: document.getElementById("sort"),
  exportFormat: document.getElementById("export-format"),
  exportGenerate: document.getElementById("export-generate"),
  exportCopy: document.getElementById("export-copy"),
  exportDownload: document.getElementById("export-download"),
  exportStatus: document.getElementById("export-status"),
  exportPreview: document.getElementById("export-preview")
};

const exportController = exportUi.createExportController({
  elements: {
    format: els.exportFormat,
    generate: els.exportGenerate,
    copy: els.exportCopy,
    download: els.exportDownload,
    status: els.exportStatus,
    preview: els.exportPreview
  },
  fetchImpl: fetch,
  clipboard: navigator.clipboard,
  urlApi: URL,
  blobCtor: Blob,
  documentRef: document
});

els.refresh.addEventListener("click", refresh);
exportController.bind();
els.sort.addEventListener("change", () => {
  state.sort = els.sort.value;
  render();
});
els.filters.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-filter]");
  if (!button) return;
  state.filter = button.dataset.filter;
  for (const item of els.filters.querySelectorAll("button")) {
    const active = item === button;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  }
  render();
});
els.servers.addEventListener("click", handleServerClick);

refresh();

async function refresh() {
  setStatus("Scanning...");
  els.servers.innerHTML = renderers.renderLoadingState();
  els.refresh.disabled = true;
  try {
    const response = await fetch("/api/servers", { cache: "no-store" });
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    state.snapshot = await response.json();
    state.dryRuns = {};
    state.dryRunStatusAccess = {};
    state.confirmations = {};
    state.confirmationAccess = {};
    state.session = await fetchSession();
    state.diagnostics = await fetchDiagnostics();
    setStatus(`Updated ${new Date().toLocaleTimeString()}`);
    render();
  } catch (error) {
    setStatus("Scan failed");
    els.servers.innerHTML = renderers.renderErrorState(error.message);
  } finally {
    els.refresh.disabled = false;
  }
}

function render() {
  if (!state.snapshot) return;
  renderSummary(state.snapshot);
  renderDiagnostics(state.diagnostics);
  renderDevRoots(state.snapshot);
  renderServers(state.snapshot.servers || []);
}

function renderSummary(snapshot) {
  els.summary.innerHTML = renderers.renderSummary(snapshot);
}

function renderDiagnostics(diagnostics) {
  els.diagnostics.innerHTML = renderers.renderDiagnostics(diagnostics);
}

function renderDevRoots(snapshot) {
  els.devRoots.innerHTML = [
    renderers.renderDevRoots(snapshot.config && snapshot.config.devRoots ? snapshot.config.devRoots : []),
    renderers.renderHistoryStatus(snapshot.history)
  ].join("");
}

function renderServers(servers) {
  els.servers.innerHTML = renderers.renderServerList(servers, {
    filter: state.filter,
    sort: state.sort,
    dryRuns: state.dryRuns,
    confirmations: state.confirmations
  });
}

function setStatus(value) {
  els.status.textContent = value;
}

async function fetchDiagnostics() {
  try {
    const response = await fetch("/api/diagnostics", { cache: "no-store" });
    if (!response.ok) throw new Error(`Diagnostics returned ${response.status}`);
    return await response.json();
  } catch (error) {
    return {
      status: "unavailable",
      scanner: {
        scannerWarnings: [error.message]
      }
    };
  }
}

async function fetchSession() {
  const response = await fetch("/api/session", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: "{}"
  });
  if (!response.ok) throw new Error(`Session returned ${response.status}`);
  return response.json();
}

async function handleServerClick(event) {
  const confirmationButton = event.target.closest("button[data-confirmation-listener-id]");
  if (confirmationButton) return handleConfirmationCreate(confirmationButton.dataset.confirmationListenerId);

  const submitButton = event.target.closest("button[data-confirmation-submit-listener-id]");
  if (submitButton) return handleConfirmationSubmit(submitButton.dataset.confirmationSubmitListenerId);

  const cancelButton = event.target.closest("button[data-confirmation-cancel-listener-id]");
  if (cancelButton) return handleConfirmationCancel(cancelButton.dataset.confirmationCancelListenerId);

  const button = event.target.closest("button[data-dry-run-listener-id]");
  if (!button) return;
  const listenerId = button.dataset.dryRunListenerId;
  const record = (state.snapshot && state.snapshot.servers || []).find((item) => item.listenerId === listenerId);
  if (!record) return;
  state.dryRuns[listenerId] = {
    status: "evaluating",
    safeMessage: "Running read-only safety check. No action will be executed.",
    checks: []
  };
  render();
  try {
    const response = await fetch("/api/actions/stop/dry-run", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(buildDryRunRequest(record))
    });
    const result = await response.json();
    if (result.statusAccessToken) {
      state.dryRunStatusAccess[listenerId] = {
        requestId: result.requestId,
        statusAccessToken: result.statusAccessToken,
        expiresAt: result.expiresAt
      };
    }
    state.dryRuns[listenerId] = {
      ...stripStatusAccessToken(result),
      status: result.passed ? "passed" : "blocked"
    };
  } catch (error) {
    state.dryRuns[listenerId] = {
      status: "scanner-unavailable",
      passed: false,
      blockers: [{ code: "DRY_RUN_REQUEST_FAILED", status: "blocked", message: "Dry-run request failed safely." }],
      safeMessage: "Dry-run request failed safely. No action was executed.",
      actionExecuted: false
    };
  }
  render();
}

async function handleConfirmationCreate(listenerId) {
  const record = findRecord(listenerId);
  const dryRun = state.dryRuns[listenerId];
  const statusAccess = state.dryRunStatusAccess[listenerId];
  if (!record || !dryRun || !statusAccess || !state.session) return;
  state.confirmations[listenerId] = {
    state: "loading",
    message: "Generating confirmation review. No process action will be executed."
  };
  render();
  try {
    const result = await postConfirmation("/api/actions/stop/confirmations", {
      dryRunRequestId: dryRun.requestId,
      processInstanceId: record.processInstanceId,
      listenerId: record.listenerId,
      validationFingerprint: dryRun.validationFingerprint,
      statusAccessToken: statusAccess.statusAccessToken,
      idempotencyKey: `confirm-create-${record.listenerId}-${Date.now()}`
    }, {
      "x-dry-run-status-token": statusAccess.statusAccessToken
    });
    if (result.confirmationAccessToken) {
      state.confirmationAccess[listenerId] = {
        confirmationRequestId: result.confirmationRequestId,
        confirmationAccessToken: result.confirmationAccessToken,
        expiresAt: result.expiresAt
      };
    }
    state.confirmations[listenerId] = stripConfirmationAccessToken(result);
  } catch (error) {
    state.confirmations[listenerId] = {
      state: "not-available",
      message: "Confirmation review failed safely. No process action was executed.",
      actionExecuted: false,
      executionAuthorized: false
    };
  }
  render();
}

async function handleConfirmationSubmit(listenerId) {
  const access = state.confirmationAccess[listenerId];
  const dryRunAccess = state.dryRunStatusAccess[listenerId];
  const input = document.querySelector(`[data-confirmation-phrase-input="${cssEscape(listenerId)}"]`);
  if (!access || !dryRunAccess || !input) return;
  state.confirmations[listenerId] = {
    ...state.confirmations[listenerId],
    state: "recording",
    message: "Recording confirmation. No process action will be executed."
  };
  render();
  try {
    const result = await postConfirmation("/api/actions/stop/confirmations/submit", {
      confirmationRequestId: access.confirmationRequestId,
      typedPhrase: input.value,
      statusAccessToken: dryRunAccess.statusAccessToken,
      idempotencyKey: `confirm-submit-${access.confirmationRequestId}`
    }, {
      "x-confirmation-access-token": access.confirmationAccessToken,
      "x-dry-run-status-token": dryRunAccess.statusAccessToken
    });
    state.confirmations[listenerId] = result;
    if (result.state === "confirmation-accepted") delete state.confirmationAccess[listenerId];
  } catch (error) {
    state.confirmations[listenerId] = {
      state: "not-available",
      message: "Confirmation submission failed safely. No process action was executed.",
      actionExecuted: false,
      executionAuthorized: false
    };
  }
  render();
}

async function handleConfirmationCancel(listenerId) {
  const access = state.confirmationAccess[listenerId];
  if (!access) return;
  try {
    const result = await postConfirmation("/api/actions/stop/confirmations/cancel", {
      confirmationRequestId: access.confirmationRequestId
    }, {
      "x-confirmation-access-token": access.confirmationAccessToken
    });
    state.confirmations[listenerId] = result;
  } catch {
    state.confirmations[listenerId] = {
      state: "cancelled",
      actionExecuted: false,
      executionAuthorized: false
    };
  }
  delete state.confirmationAccess[listenerId];
  render();
}

async function postConfirmation(url, body, headers = {}) {
  const payload = {
    ...body,
    sessionNonce: state.session && state.session.sessionNonce,
    csrfToken: state.session && state.session.csrfToken
  };
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": state.session && state.session.csrfToken,
      ...headers
    },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || `Confirmation returned ${response.status}`);
  return result;
}

function stripStatusAccessToken(result) {
  const { statusAccessToken, ...safeResult } = result || {};
  return safeResult;
}

function stripConfirmationAccessToken(result) {
  const { confirmationAccessToken, ...safeResult } = result || {};
  return safeResult;
}

function findRecord(listenerId) {
  return (state.snapshot && state.snapshot.servers || []).find((item) => item.listenerId === listenerId);
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
  return String(value).replace(/"/g, "\\\"");
}

function buildDryRunRequest(record) {
  return {
    processInstanceId: record.processInstanceId,
    listenerId: record.listenerId,
    idempotencyKey: `dryrun-${record.listenerId}-${Date.now()}`,
    expected: {
      pid: record.pid,
      processName: record.processName,
      host: record.host,
      port: record.port,
      createdAt: record.createdAt,
      projectName: record.project && record.project.name,
      projectRoot: record.project && record.project.root,
      projectSource: record.project && record.project.source,
      category: record.category,
      confidenceLevel: record.confidenceLevel,
      validationFingerprint: record.actionEligibility && record.actionEligibility.validationFingerprint,
      scanId: state.snapshot && state.snapshot.generatedAt
    }
  };
}
