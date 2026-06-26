"use strict";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function buildProcessTiming(creationTime, now = new Date()) {
  const source = "Win32_Process.CreationDate";
  if (!creationTime) {
    return {
      createdAt: null,
      ageMs: null,
      ageLabel: "unknown age",
      timingSource: source,
      timingStatus: "unavailable",
      timingError: "creation time unavailable"
    };
  }

  const created = creationTime instanceof Date ? creationTime : new Date(creationTime);
  if (Number.isNaN(created.getTime())) {
    return {
      createdAt: null,
      ageMs: null,
      ageLabel: "unknown age",
      timingSource: source,
      timingStatus: "invalid",
      timingError: "creation time could not be parsed"
    };
  }

  const ageMs = now.getTime() - created.getTime();
  if (ageMs < 0) {
    return {
      createdAt: created.toISOString(),
      ageMs: null,
      ageLabel: "clock skew",
      timingSource: source,
      timingStatus: "skewed",
      timingError: "creation time is in the future relative to scan time"
    };
  }

  return {
    createdAt: created.toISOString(),
    ageMs,
    ageLabel: formatAge(ageMs),
    timingSource: source,
    timingStatus: "available",
    timingError: null
  };
}

function formatAge(ageMs) {
  const value = Number(ageMs);
  if (!Number.isFinite(value) || value < 0) return "unknown age";
  if (value < MINUTE_MS) return "less than 1 minute";
  if (value < HOUR_MS) return plural(Math.floor(value / MINUTE_MS), "minute");
  if (value < DAY_MS) return plural(Math.floor(value / HOUR_MS), "hour");
  return plural(Math.floor(value / DAY_MS), "day");
}

function plural(value, unit) {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

module.exports = {
  buildProcessTiming,
  formatAge
};
