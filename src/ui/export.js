(function initExportUi(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.WatchdogExportUi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createExportUiApi() {
  "use strict";

  function normalizeExportFormat(format) {
    return String(format || "markdown").toLowerCase() === "json" ? "json" : "markdown";
  }

  function exportEndpoint(format) {
    return `/api/diagnostics/export?format=${encodeURIComponent(normalizeExportFormat(format))}`;
  }

  function canUsePreview(preview) {
    return Boolean(preview && preview.ok && typeof preview.content === "string" && preview.validation && preview.validation.status === "passed");
  }

  function previewContent(preview) {
    return canUsePreview(preview) ? preview.content : "";
  }

  function previewFilename(preview, fallbackFormat) {
    if (preview && typeof preview.filename === "string" && /^localhost-watchdog-diagnostics-\d{8}\.(?:md|json)$/.test(preview.filename)) {
      return preview.filename;
    }
    const ext = normalizeExportFormat(fallbackFormat) === "json" ? "json" : "md";
    return `localhost-watchdog-diagnostics-${todayStamp()}.${ext}`;
  }

  function todayStamp(now = new Date()) {
    return now.toISOString().slice(0, 10).replace(/-/g, "");
  }

  function createExportController(options = {}) {
    const elements = options.elements || {};
    const fetchImpl = options.fetchImpl;
    const clipboard = options.clipboard;
    const urlApi = options.urlApi;
    const blobCtor = options.blobCtor;
    const documentRef = options.documentRef;
    const state = {
      exportPreview: null,
      loading: false,
      format: normalizeExportFormat(elements.format && elements.format.value)
    };

    initializeExportControls(elements, state);

    function bind() {
      if (elements.generate) elements.generate.addEventListener("click", generatePreview);
      if (elements.copy) elements.copy.addEventListener("click", copyPreview);
      if (elements.download) elements.download.addEventListener("click", downloadPreview);
      if (elements.format) {
        elements.format.addEventListener("change", () => {
          setFormat(elements.format.value);
        });
      }
    }

    function setFormat(value) {
      const nextFormat = normalizeExportFormat(value);
      if (elements.format) elements.format.value = nextFormat;
      state.format = nextFormat;
      invalidatePreview("Format changed. Generate a new preview before copying or downloading.");
    }

    async function generatePreview() {
      const format = normalizeExportFormat(elements.format && elements.format.value || state.format);
      state.format = format;
      state.loading = true;
      state.exportPreview = null;
      setPreviewText(elements, "");
      setExportStatus(elements, "Generating preview...");
      setExportButtons(elements, false);

      try {
        if (typeof fetchImpl !== "function") throw new Error("Export request failed.");
        const response = await fetchImpl(exportEndpoint(format), { cache: "no-store" });
        if (!response || typeof response.json !== "function") throw new Error("Export response was malformed.");
        const body = await response.json();
        if (!response.ok) throw new Error("Export request failed.");
        if (!isSupportedResponseFormat(body, format)) throw new Error("Export response format was unsupported.");
        if (!canUsePreview(body)) {
          const blocked = body && body.validation && body.validation.status === "blocked";
          throw new Error(blocked ? "Export validation blocked the preview." : "Export response was missing validated preview content.");
        }
        state.exportPreview = body;
        setPreviewText(elements, previewContent(body));
        setExportStatus(elements, `Preview ready: ${previewFilename(body, format)}`);
        setExportButtons(elements, true);
      } catch (error) {
        setExportStatus(elements, safeExportErrorMessage(error));
        setExportButtons(elements, false);
      } finally {
        state.loading = false;
      }
    }

    async function copyPreview() {
      if (!canUsePreview(state.exportPreview)) {
        setExportStatus(elements, "Generate a validated preview before copying.");
        return false;
      }
      try {
        if (!clipboard || typeof clipboard.writeText !== "function") throw new Error("Copy failed.");
        await clipboard.writeText(previewContent(state.exportPreview));
        setExportStatus(elements, "Preview copied.");
        return true;
      } catch {
        setExportStatus(elements, "Copy failed. The preview remains visible for manual selection.");
        return false;
      }
    }

    function downloadPreview() {
      if (!canUsePreview(state.exportPreview)) {
        setExportStatus(elements, "Generate a validated preview before downloading.");
        return false;
      }
      try {
        if (!blobCtor || !urlApi || !documentRef || typeof urlApi.createObjectURL !== "function") {
          throw new Error("Download failed.");
        }
        const format = normalizeExportFormat(state.exportPreview.format || state.format);
        const type = format === "json" ? "application/json" : "text/markdown";
        const blob = new blobCtor([previewContent(state.exportPreview)], { type: `${type}; charset=utf-8` });
        const url = urlApi.createObjectURL(blob);
        const link = documentRef.createElement("a");
        link.href = url;
        link.download = previewFilename(state.exportPreview, format);
        link.rel = "noreferrer";
        documentRef.body.appendChild(link);
        link.click();
        link.remove();
        if (typeof urlApi.revokeObjectURL === "function") urlApi.revokeObjectURL(url);
        setExportStatus(elements, `Downloaded ${link.download}.`);
        return true;
      } catch {
        setExportStatus(elements, "Download failed. The preview remains visible for manual saving.");
        return false;
      }
    }

    function invalidatePreview(message = "No preview generated.") {
      state.exportPreview = null;
      setPreviewText(elements, "");
      setExportButtons(elements, false);
      setExportStatus(elements, message);
    }

    return {
      bind,
      copyPreview,
      downloadPreview,
      generatePreview,
      invalidatePreview,
      setFormat,
      state
    };
  }

  function initializeExportControls(elements, state) {
    if (elements.format) elements.format.value = state.format;
    setExportButtons(elements, false);
    setPreviewText(elements, "");
    setExportStatus(elements, "No preview generated.");
  }

  function setExportButtons(elements, enabled) {
    if (elements.copy) elements.copy.disabled = !enabled;
    if (elements.download) elements.download.disabled = !enabled;
  }

  function setExportStatus(elements, value) {
    if (elements.status) elements.status.textContent = value;
  }

  function setPreviewText(elements, value) {
    if (elements.preview) elements.preview.textContent = value;
  }

  function isSupportedResponseFormat(body, requestedFormat) {
    if (!body || !body.format) return true;
    return normalizeExportFormat(body.format) === requestedFormat && (body.format === "markdown" || body.format === "json");
  }

  function safeExportErrorMessage(error) {
    const message = error && error.message ? error.message : "";
    const allowed = [
      "Export validation blocked the preview.",
      "Export request failed.",
      "Export response was malformed.",
      "Export response was missing validated preview content.",
      "Export response format was unsupported."
    ];
    return allowed.includes(message) ? message : "Export preview failed.";
  }

  return {
    canUsePreview,
    createExportController,
    exportEndpoint,
    normalizeExportFormat,
    previewContent,
    previewFilename,
    todayStamp
  };
});
