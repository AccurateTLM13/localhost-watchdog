"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { safeErrorMessage } = require("../privacy/errors");

const HISTORY_VERSION = 1;
const DEFAULT_HISTORY_CONFIG = {
  enabled: true,
  storagePath: ".localhost-watchdog/history.json",
  maxSnapshots: 25,
  maxHistoryAgeMs: 14 * 24 * 60 * 60 * 1000,
  maxProcessRecords: 500
};

function applyHistoryToSnapshot(snapshot, options = {}) {
  const now = options.now || new Date();
  const config = normalizeHistoryConfig(options.history || options.config && options.config.safety && options.config.safety.history, options.root);
  const io = options.io || fs;

  if (!config.enabled) {
    return {
      ...snapshot,
      servers: (snapshot.servers || []).map((record) => attachUnavailableHistory(record, "disabled", "history is disabled")),
      history: historyStatus({
        enabled: false,
        storageHealth: "disabled",
        warning: "history is disabled"
      })
    };
  }

  const scanId = buildScanId(now);
  const readResult = readHistory(config.storagePath, io);
  const history = readResult.history;
  const previousSnapshot = history.snapshots[history.snapshots.length - 1] || null;
  const previousIds = new Set(previousSnapshot ? previousSnapshot.processInstanceIds || [] : []);
  const currentIds = new Set();
  const updatedRecords = [];

  for (const record of snapshot.servers || []) {
    const processInstanceId = buildProcessInstanceId(record);
    if (!processInstanceId) {
      updatedRecords.push(attachUnavailableHistory(record, readResult.status, "stable process identity unavailable because creation time is missing or invalid"));
      continue;
    }

    const existing = history.records[processInstanceId] || null;
    const previouslySeen = Boolean(existing);
    const reappeared = previouslySeen && !previousIds.has(processInstanceId);
    const consecutiveSeenCount = previouslySeen && previousIds.has(processInstanceId)
      ? Number(existing.consecutiveSeenCount || 0) + 1
      : 1;
    const seenCount = previouslySeen ? Number(existing.seenCount || 0) + 1 : 1;
    const firstSeenAt = existing ? existing.firstSeenAt : now.toISOString();
    const safeRecord = toHistoryRecord(record, {
      processInstanceId,
      firstSeenAt,
      lastSeenAt: now.toISOString(),
      seenCount,
      consecutiveSeenCount,
      scanId
    });

    history.records[processInstanceId] = safeRecord;
    currentIds.add(processInstanceId);
    updatedRecords.push(attachHistoryContext(record, safeRecord, {
      previouslySeen,
      reappeared,
      storageHealth: readResult.status
    }));
  }

  const disappearedSincePrevious = previousSnapshot
    ? [...previousIds].filter((id) => !currentIds.has(id)).length
    : 0;

  history.snapshots.push({
    scanId,
    scannedAt: now.toISOString(),
    processInstanceIds: [...currentIds]
  });

  const pruned = pruneHistory(history, config, now);
  const finalHistory = {
    ...pruned,
    meta: {
      ...pruned.meta,
      lastSuccessfulWriteAt: now.toISOString()
    }
  };
  const writeResult = writeHistory(config.storagePath, finalHistory, io);
  const storageHealth = writeResult.ok
    ? successfulStorageHealth(readResult.status)
    : "write-failed";
  const warning = writeResult.ok ? readResult.warning : writeResult.warning;

  return {
    ...snapshot,
    servers: updatedRecords.map((record) => storageHealth === "write-failed"
      ? attachHistoryWarning(record, "write-failed", warning)
      : normalizeRecordHistoryStatus(record, storageHealth)),
    history: historyStatus({
      enabled: true,
      storageHealth,
      retainedSnapshotCount: finalHistory.snapshots.length,
      oldestRetainedSnapshot: finalHistory.snapshots[0] ? finalHistory.snapshots[0].scannedAt : null,
      lastSuccessfulHistoryWrite: finalHistory.meta.lastSuccessfulWriteAt || null,
      disappearedSincePrevious,
      warning
    })
  };
}

function readHistory(storagePath, io) {
  if (!io.existsSync(storagePath)) {
    return {
      status: "missing",
      warning: null,
      history: emptyHistory()
    };
  }

  try {
    const parsed = JSON.parse(io.readFileSync(storagePath, "utf8"));
    if (!parsed || parsed.version !== HISTORY_VERSION) {
      return {
        status: "schema-mismatch",
        warning: "history schema version mismatch; started a fresh in-memory history",
        history: emptyHistory()
      };
    }
    return {
      status: "available",
      warning: null,
      history: {
        version: HISTORY_VERSION,
        snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : [],
        records: parsed.records && typeof parsed.records === "object" ? parsed.records : {},
        meta: parsed.meta && typeof parsed.meta === "object" ? parsed.meta : {}
      }
    };
  } catch {
    return {
      status: "corrupt-recovered",
      warning: "history file was invalid JSON; started a fresh in-memory history",
      history: emptyHistory()
    };
  }
}

function writeHistory(storagePath, history, io) {
  try {
    const directory = path.dirname(storagePath);
    io.mkdirSync(directory, { recursive: true });
    const tempPath = `${storagePath}.tmp`;
    io.writeFileSync(tempPath, JSON.stringify(history, null, 2));
    io.renameSync(tempPath, storagePath);
    return { ok: true, warning: null };
  } catch (error) {
    return {
      ok: false,
      warning: safeErrorMessage("history", error, {
        code: "HISTORY_WRITE_FAILED"
      })
    };
  }
}

function pruneHistory(history, config, now) {
  const cutoff = now.getTime() - config.maxHistoryAgeMs;
  const snapshots = history.snapshots
    .filter((snapshot) => new Date(snapshot.scannedAt).getTime() >= cutoff)
    .slice(-config.maxSnapshots);
  const retainedIds = new Set(snapshots.flatMap((snapshot) => snapshot.processInstanceIds || []));
  const records = {};

  for (const [id, record] of Object.entries(history.records)) {
    const lastSeen = new Date(record.lastSeenAt).getTime();
    if (retainedIds.has(id) || lastSeen >= cutoff) {
      records[id] = record;
    }
  }

  const limitedRecords = Object.fromEntries(Object.entries(records)
    .sort((a, b) => new Date(b[1].lastSeenAt).getTime() - new Date(a[1].lastSeenAt).getTime())
    .slice(0, config.maxProcessRecords));

  return {
    version: HISTORY_VERSION,
    snapshots,
    records: limitedRecords,
    meta: history.meta || {}
  };
}

function toHistoryRecord(record, identity) {
  return {
    processInstanceId: identity.processInstanceId,
    firstSeenAt: identity.firstSeenAt,
    lastSeenAt: identity.lastSeenAt,
    seenCount: identity.seenCount,
    consecutiveSeenCount: identity.consecutiveSeenCount,
    mostRecentPort: record.port || null,
    category: record.category || null,
    confidenceLevel: record.confidenceLevel || null,
    projectIdentity: safeProjectIdentity(record),
    httpReachable: record.httpProbe && record.httpProbe.attempted ? Boolean(record.httpProbe.reachable) : null,
    lifecycleLabel: record.lifecycleContext ? record.lifecycleContext.label || null : null,
    previousLifecycleScore: record.lifecycleContext ? Number(record.lifecycleContext.staleScore || 0) : null,
    scanId: identity.scanId
  };
}

function attachHistoryContext(record, historyRecord, options) {
  const persistedAcrossScans = historyRecord.seenCount > 1;
  const evidence = [
    {
      type: "history",
      score: 0,
      message: persistedAcrossScans
        ? `process instance observed in ${historyRecord.seenCount} scans`
        : "process instance seen for the first time"
    }
  ];

  if (historyRecord.consecutiveSeenCount > 1) {
    evidence.push({
      type: "history",
      score: 0,
      message: `process instance continuously observed for ${historyRecord.consecutiveSeenCount} scans`
    });
  }

  if (options.reappeared) {
    evidence.push({
      type: "history",
      score: 0,
      message: "process instance reappeared after absence"
    });
  }

  const historyContext = {
    firstSeenAt: historyRecord.firstSeenAt,
    lastSeenAt: historyRecord.lastSeenAt,
    seenCount: historyRecord.seenCount,
    consecutiveSeenCount: historyRecord.consecutiveSeenCount,
    persistedAcrossScans,
    previouslySeen: options.previouslySeen,
    reappeared: options.reappeared,
    historyStatus: options.storageHealth,
    evidence
  };

  return appendHistory(record, historyContext);
}

function attachUnavailableHistory(record, status, message) {
  return appendHistory(record, {
    firstSeenAt: null,
    lastSeenAt: null,
    seenCount: 0,
    consecutiveSeenCount: 0,
    persistedAcrossScans: false,
    previouslySeen: false,
    reappeared: false,
    historyStatus: status,
    evidence: [
      {
        type: "history",
        score: 0,
        message
      }
    ]
  });
}

function attachHistoryWarning(record, status, warning) {
  const warningEvidence = {
    type: "history",
    score: 0,
    message: warning || "history unavailable"
  };
  const evidence = [
    ...(record.evidence || []),
    warningEvidence
  ];
  return {
    ...record,
    evidence,
    reasons: evidence.map((item) => item.message),
    historyContext: {
      ...(record.historyContext || {}),
      historyStatus: status,
      evidence: [
        ...(record.historyContext && record.historyContext.evidence || []),
        warningEvidence
      ]
    }
  };
}

function normalizeRecordHistoryStatus(record, status) {
  if (!record.historyContext) return record;
  return {
    ...record,
    historyContext: {
      ...record.historyContext,
      historyStatus: status
    }
  };
}

function appendHistory(record, historyContext) {
  const evidence = [
    ...(record.evidence || []).filter((item) => item.type !== "history"),
    ...(historyContext.evidence || [])
  ];
  return {
    ...record,
    historyContext,
    evidence,
    reasons: evidence.map((item) => item.message)
  };
}

function historyStatus(input) {
  return {
    enabled: Boolean(input.enabled),
    storageHealth: input.storageHealth || "unknown",
    retainedSnapshotCount: input.retainedSnapshotCount || 0,
    oldestRetainedSnapshot: input.oldestRetainedSnapshot || null,
    lastSuccessfulHistoryWrite: input.lastSuccessfulHistoryWrite || null,
    disappearedSincePrevious: input.disappearedSincePrevious || 0,
    redactionPrivacyStatus: "privacy-safe normalized fields only; no command lines, paths, response bodies, or process trees persisted",
    warning: input.warning || null
  };
}

function successfulStorageHealth(readStatus) {
  return readStatus === "missing" ? "available" : readStatus;
}

function buildProcessInstanceId(record) {
  if (!record || !Number.isInteger(Number(record.pid)) || !record.createdAt) return null;
  return `pid:${Number(record.pid)}|created:${record.createdAt}`;
}

function safeProjectIdentity(record) {
  if (record.project && record.project.name) return record.project.name;
  if (record.projectName) return record.projectName;
  return null;
}

function buildScanId(now) {
  return `scan-${now.toISOString()}`;
}

function emptyHistory() {
  return {
    version: HISTORY_VERSION,
    snapshots: [],
    records: {},
    meta: {}
  };
}

function normalizeHistoryConfig(value = {}, root = process.cwd()) {
  const enabled = value.enabled !== false;
  const storagePath = path.resolve(root, value.storagePath || DEFAULT_HISTORY_CONFIG.storagePath);
  return {
    enabled,
    storagePath,
    maxSnapshots: positiveInteger(value.maxSnapshots, DEFAULT_HISTORY_CONFIG.maxSnapshots),
    maxHistoryAgeMs: positiveInteger(value.maxHistoryAgeMs, DEFAULT_HISTORY_CONFIG.maxHistoryAgeMs),
    maxProcessRecords: positiveInteger(value.maxProcessRecords, DEFAULT_HISTORY_CONFIG.maxProcessRecords)
  };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

module.exports = {
  DEFAULT_HISTORY_CONFIG,
  HISTORY_VERSION,
  applyHistoryToSnapshot,
  buildProcessInstanceId,
  normalizeHistoryConfig,
  pruneHistory,
  readHistory
};
