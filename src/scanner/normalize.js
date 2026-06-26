"use strict";

const { classifyReadOnly } = require("../classifier/confidence");
const { redactSensitiveText } = require("../privacy/redact");
const { detectLauncherContext } = require("../process/launcher");
const { attachLifecycleContext } = require("../process/lifecycle");
const { buildProcessTiming } = require("../process/timing");
const { buildProcessTree } = require("../process/tree");
const { detectProjectOwnership } = require("../project/ownership");

function parseJsonArray(output) {
  const text = String(output || "").trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function parsePowerShellTcpConnections(output) {
  return parseJsonArray(output)
    .map((item) => ({
      host: item.LocalAddress || "",
      port: Number(item.LocalPort),
      pid: Number(item.OwningProcess),
      state: item.State || "Listen",
      protocol: "tcp"
    }))
    .filter((item) => Number.isInteger(item.port) && Number.isInteger(item.pid));
}

function parseWindowsProcesses(output) {
  const processes = new Map();

  for (const item of parseJsonArray(output)) {
    const pid = Number(item.ProcessId);
    if (!Number.isInteger(pid)) continue;

    processes.set(pid, {
      pid,
      parentPid: nullableNumber(item.ParentProcessId),
      processName: item.Name || null,
      commandLine: item.CommandLine || null,
      executablePath: item.ExecutablePath || null,
      creationTime: parseWindowsDate(item.CreationDate)
    });
  }

  return processes;
}

function parseNetstatOutput(output) {
  const connections = [];
  const lines = String(output || "").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !/^TCP\s+/i.test(trimmed)) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length < 5 || !/^LISTENING$/i.test(parts[3])) continue;

    const local = parseAddressPort(parts[1]);
    const pid = Number(parts[4]);
    if (!local || !Number.isInteger(pid)) continue;

    connections.push({
      host: local.host,
      port: local.port,
      pid,
      state: "Listen",
      protocol: "tcp"
    });
  }

  return connections;
}

function normalizeConnections(connections, processes, options = {}) {
  const now = options.now || new Date();
  const rawSource = options.rawSource || "powershell";
  const config = options.config;
  const normalizedConnections = normalizeListenerConnections(connections);
  const visible = [];
  const hidden = {
    protected: 0,
    unknown: 0,
    nonLocalhost: 0,
    lowConfidence: 0,
    duplicate: Math.max(0, connections.length - normalizedConnections.length)
  };

  for (const connection of normalizedConnections) {
    const host = normalizeHost(connection.host);
    const process = processes.get(connection.pid) || {};
    const parentProcess = process.parentPid == null ? null : processes.get(process.parentPid);
    const creationTime = process.creationTime || null;
    const timing = buildProcessTiming(creationTime, now);
    const identity = buildRecordIdentity({
      pid: connection.pid,
      createdAt: timing.createdAt,
      host,
      port: connection.port,
      protocol: connection.protocol || "tcp",
      rawSource,
      now
    });
    const record = {
      id: identity.listenerId,
      processInstanceId: identity.processInstanceId,
      listenerId: identity.listenerId,
      identity,
      pid: connection.pid,
      parentPid: process.parentPid ?? null,
      port: connection.port,
      host,
      protocol: "tcp",
      url: buildUrl(host, connection.port),
      processName: process.processName || null,
      commandLine: redactSensitiveText(process.commandLine),
      executablePath: redactSensitiveText(process.executablePath),
      workingDirectory: null,
      creationTime: timing.createdAt,
      uptimeMs: timing.ageMs,
      createdAt: timing.createdAt,
      ageMs: timing.ageMs,
      ageLabel: timing.ageLabel,
      timingSource: timing.timingSource,
      timingStatus: timing.timingStatus,
      timingError: timing.timingError,
      user: null,
      confirmationSafety: buildUnavailableConfirmationSafety(),
      rawSource,
      raw: {
        source: rawSource
      }
    };
    const analysisRecord = {
      ...record,
      commandLine: process.commandLine || null,
      executablePath: process.executablePath || null
    };
    record.launcher = detectLauncherContext(record, parentProcess);
    record.processTree = buildProcessTree(analysisRecord, processes, {
      safetyConfig: config && config.safety,
      maxDepth: options.processTreeMaxDepth
    });

    const project = detectProjectOwnership({
      ...analysisRecord,
      launcher: record.launcher,
      processTree: record.processTree
    }, config);
    if (project) {
      record.project = project;
      record.workingDirectory = project.workingDirectory;
    } else {
      record.project = null;
    }

    const classifiedRecord = {
      ...record,
      ...classifyReadOnly({
        ...analysisRecord,
        launcher: record.launcher,
        processTree: record.processTree,
        project: record.project,
        workingDirectory: record.workingDirectory
      }, { config })
    };
    const finalRecord = attachLifecycleContext(classifiedRecord, { config });

    if (finalRecord.safeToShow) {
      visible.push(finalRecord);
    } else if (finalRecord.hiddenReason === "protected") {
      hidden.protected += 1;
    } else if (finalRecord.hiddenReason === "non-localhost") {
      hidden.nonLocalhost += 1;
    } else if (finalRecord.hiddenReason === "low-confidence") {
      hidden.lowConfidence += 1;
    } else {
      hidden.unknown += 1;
    }
  }

  visible.sort((a, b) => a.port - b.port || a.pid - b.pid);

  return {
    total: normalizedConnections.length,
    visible,
    hidden
  };
}

function buildUnavailableConfirmationSafety() {
  return {
    owner: {
      available: false,
      match: "unavailable",
      accountType: "unknown",
      systemOwned: false,
      serviceOwned: false
    },
    session: {
      available: false,
      match: "unavailable"
    },
    elevation: {
      available: false,
      targetIntegrityAvailable: false,
      targetElevated: null,
      match: "unavailable"
    },
    watchdog: {
      available: true,
      elevated: false,
      integrityAvailable: true
    }
  };
}

function normalizeListenerConnections(connections) {
  const seen = new Map();
  for (const connection of connections || []) {
    const host = normalizeHost(connection.host);
    const protocol = connection.protocol || "tcp";
    const key = `${Number(connection.pid)}|${protocol}|${host}|${Number(connection.port)}`;
    if (!seen.has(key)) {
      seen.set(key, {
        ...connection,
        host,
        protocol
      });
    }
  }
  return [...seen.values()];
}

function buildRecordIdentity({ pid, createdAt, host, port, protocol, rawSource, now }) {
  const listenerKey = `listener-${safeIdentityPart(protocol)}-${safeIdentityPart(host)}-${Number(port)}`;
  if (createdAt) {
    const processInstanceId = `pid-${Number(pid)}-created-${safeIdentityPart(createdAt)}`;
    return {
      status: "stable",
      scope: "process-instance",
      processInstanceId,
      listenerId: `${processInstanceId}-${listenerKey}`,
      listenerKey,
      pid: Number(pid),
      createdAt,
      source: "pid-and-creation-time",
      evidence: [
        "process identity uses PID plus Win32_Process.CreationDate",
        "listener host and port are secondary listener identity only"
      ]
    };
  }

  const sessionId = `session-unstable-${safeIdentityPart(now.toISOString())}-pid-${Number(pid)}-${listenerKey}`;
  return {
    status: "unstable",
    scope: "session-listener",
    processInstanceId: null,
    listenerId: sessionId,
    listenerKey,
    pid: Number(pid),
    createdAt: null,
    source: "session-scoped-missing-creation-time",
    rawSource,
    evidence: [
      "stable process identity unavailable because creation time is missing or invalid",
      "identifier is session-scoped and must not be used as durable process identity"
    ]
  };
}

function safeIdentityPart(value) {
  return String(value == null ? "unknown" : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function normalizeHost(host) {
  const value = String(host || "").trim();
  if (value === "::" || value === "[::]") return "::";
  if (value === "::1" || value === "[::1]") return "::1";
  if (value === "*" || value === "0.0.0.0") return "0.0.0.0";
  if (value === "127.0.0.1" || value.toLowerCase() === "localhost") return "127.0.0.1";
  return value;
}

function buildUrl(host, port) {
  if (host === "::1" || host === "::" || host === "0.0.0.0" || host === "127.0.0.1" || host === "localhost") {
    return `http://localhost:${port}`;
  }
  return `http://${host}:${port}`;
}

function parseAddressPort(value) {
  const text = String(value || "").trim();
  const ipv6 = text.match(/^\[([^\]]+)]:(\d+)$/);
  if (ipv6) {
    return {
      host: ipv6[1],
      port: Number(ipv6[2])
    };
  }

  const lastColon = text.lastIndexOf(":");
  if (lastColon === -1) return null;

  const host = text.slice(0, lastColon);
  const port = Number(text.slice(lastColon + 1));
  if (!Number.isInteger(port)) return null;

  return { host, port };
}

function parseWindowsDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const text = String(value);
  const jsonDate = text.match(/^\/Date\((-?\d+)\)\/$/);
  if (jsonDate) {
    const parsed = new Date(Number(jsonDate[1]));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const wmi = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,6}))?([+-])(\d{3})$/);
  if (wmi) {
    const [, year, month, day, hour, minute, second, fraction = "0", sign, offsetMinutes] = wmi;
    const millis = Number(fraction.padEnd(3, "0").slice(0, 3));
    const utc = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      millis
    );
    const offset = Number(offsetMinutes) * 60 * 1000;
    return new Date(sign === "+" ? utc - offset : utc + offset);
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function nullableNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

module.exports = {
  buildUrl,
  buildUnavailableConfirmationSafety,
  buildRecordIdentity,
  normalizeConnections,
  normalizeHost,
  normalizeListenerConnections,
  parseAddressPort,
  parseJsonArray,
  parseNetstatOutput,
  parsePowerShellTcpConnections,
  parseWindowsDate,
  parseWindowsProcesses
};
