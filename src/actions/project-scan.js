"use strict";

const PROJECT_SCAN_UNAVAILABLE_CODE = "PROJECT_SCAN_UNAVAILABLE";

function normalizeProjectScanResult(result) {
  if (Array.isArray(result)) return { ok: true, records: result };
  if (result && Array.isArray(result.servers)) {
    if (result.ok === false) {
      return {
        ok: false,
        records: [],
        code: result.code || PROJECT_SCAN_UNAVAILABLE_CODE,
        message: result.message || "The project scanner reported that its snapshot is unavailable."
      };
    }
    return { ok: true, records: result.servers };
  }
  return {
    ok: false,
    records: [],
    code: PROJECT_SCAN_UNAVAILABLE_CODE,
    message: "The project scanner returned no usable snapshot."
  };
}

async function readProjectScan(scanProvider) {
  try {
    return normalizeProjectScanResult(await scanProvider());
  } catch {
    return {
      ok: false,
      records: [],
      code: PROJECT_SCAN_UNAVAILABLE_CODE,
      message: "The project scanner could not provide a usable snapshot."
    };
  }
}

module.exports = { PROJECT_SCAN_UNAVAILABLE_CODE, normalizeProjectScanResult, readProjectScan };
