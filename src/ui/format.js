(function initFormat(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.WatchdogFormat = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createFormatApi() {
  "use strict";

  const DEV_CATEGORIES = new Set([
    "node-dev-server",
    "python-dev-server",
    "java-dev-server"
  ]);

  const HELPER_CATEGORIES = new Set([
    "browser-helper",
    "editor-helper"
  ]);

  function formatMs(value) {
    if (value == null || value === "") return "n/a";
    if (!Number.isFinite(Number(value))) return "n/a";
    return `${Math.round(Number(value))} ms`;
  }

  function formatConfidence(record) {
    const score = Number.isFinite(Number(record.confidence)) ? record.confidence : 0;
    const level = record.confidenceLevel || "unknown";
    return `${score} / ${level}`;
  }

  function safetyState(record) {
    if (record.category === "system-or-protected" || record.hiddenReason === "protected") return "protected";
    if (record.category === "unknown-listener" || record.hiddenReason) return "unknown";
    if (record.networkExposure && record.networkExposure.warning) return "network-exposed";
    if (record.confidenceLevel === "high" && DEV_CATEGORIES.has(record.category)) return "high-confidence-dev";
    if (record.confidenceLevel === "medium") return "medium-confidence";
    return "read-only";
  }

  function safetyLabel(record) {
    const state = safetyState(record);
    const labels = {
      "protected": "Protected/system",
      "unknown": "Unknown listener",
      "network-exposed": "Network-exposed",
      "high-confidence-dev": "High-confidence dev",
      "medium-confidence": "Medium confidence",
      "read-only": "Read-only"
    };
    return labels[state] || "Read-only";
  }

  function httpProbeLabel(probe) {
    if (!probe || !probe.attempted) return "Not probed";
    if (probe.reachable) return "Reachable";
    return "Unreachable or non-HTTP";
  }

  function matchesFilter(record, filter) {
    if (filter === "all") return true;
    if (filter === "dev") return DEV_CATEGORIES.has(record.category);
    if (filter === "local-ai") return record.category === "local-ai-server";
    if (filter === "database") return record.category === "database";
    if (filter === "helpers") return HELPER_CATEGORIES.has(record.category);
    if (filter === "unknown") return record.category === "unknown-listener";
    if (filter === "network") return Boolean(record.networkExposure && record.networkExposure.warning);
    if (filter === "readonly") return record.category === "system-or-protected" || record.safeToStop === false;
    return true;
  }

  function compareRecords(a, b, sortKey) {
    if (sortKey === "confidence") return Number(b.confidence || 0) - Number(a.confidence || 0) || a.port - b.port;
    if (sortKey === "category") return String(a.category || "").localeCompare(String(b.category || "")) || a.port - b.port;
    if (sortKey === "process") return String(a.processName || "").localeCompare(String(b.processName || "")) || a.port - b.port;
    return Number(a.port || 0) - Number(b.port || 0);
  }

  function summarize(snapshot) {
    const servers = snapshot.servers || [];
    return {
      scanned: snapshot.totals ? snapshot.totals.scanned : servers.length,
      visible: snapshot.totals ? snapshot.totals.visible : servers.length,
      hidden: snapshot.totals ? snapshot.totals.hidden : 0,
      reachable: servers.filter((record) => record.httpProbe && record.httpProbe.reachable).length,
      networkExposed: servers.filter((record) => record.networkExposure && record.networkExposure.warning).length,
      unknown: servers.filter((record) => record.category === "unknown-listener").length
    };
  }

  function compactUrl(value) {
    if (!value) return "n/a";
    try {
      const url = new URL(value);
      return `${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname === "/" ? "" : url.pathname}`;
    } catch {
      return String(value);
    }
  }

  return {
    compareRecords,
    compactUrl,
    formatConfidence,
    formatMs,
    httpProbeLabel,
    matchesFilter,
    safetyLabel,
    safetyState,
    summarize
  };
});
