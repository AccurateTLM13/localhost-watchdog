"use strict";

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
      available: false,
      elevated: false,
      integrityAvailable: false
    }
  };
}

function buildConfirmationSafety(proc, watchdog) {
  const watchdogSid = watchdog && (watchdog.CurrentSid || watchdog.currentSid || watchdog.sid) || null;
  const watchdogSessionId = watchdog && (watchdog.CurrentSessionId ?? watchdog.currentSessionId ?? watchdog.sessionId) != null ? Number(watchdog.CurrentSessionId ?? watchdog.currentSessionId ?? watchdog.sessionId) : null;
  const watchdogElevated = watchdog && (watchdog.CurrentElevated === true || watchdog.currentElevated === true || watchdog.elevated === true);
  const watchdogIntegrityAvailable = watchdog && (watchdog.CurrentIntegrityAvailable === true || watchdog.currentIntegrityAvailable === true || watchdog.integrityAvailable === true);
  const watchdogIntegrityLevel = watchdog && (watchdog.CurrentIntegrityLevel ?? watchdog.currentIntegrityLevel ?? watchdog.integrityLevel) != null ? Number(watchdog.CurrentIntegrityLevel ?? watchdog.currentIntegrityLevel ?? watchdog.integrityLevel) : null;
  
  const targetSid = proc && proc.ownerSid || null;
  const targetSessionId = proc && proc.sessionId != null ? Number(proc.sessionId) : null;
  const targetElevated = proc && proc.elevated === true;
  const targetIntegrityLevel = proc && proc.integrityLevel != null ? Number(proc.integrityLevel) : null;
  const ownerUser = proc && proc.ownerUser || "";
  const ownerDomain = proc && proc.ownerDomain || "";
  const username = ownerUser ? `${ownerDomain ? ownerDomain + '\\' : ''}${ownerUser}` : "";
  
  const ownerAvailable = targetSid != null;
  const sessionAvailable = targetSessionId != null;
  const elevationAvailable = targetElevated != null || targetIntegrityLevel != null;
  const targetIntegrityAvailable = targetIntegrityLevel != null;
  
  const watchdogAvailable = watchdogSid != null && watchdogSessionId != null && watchdogIntegrityAvailable === true;
  
  let ownerMatch = "unavailable";
  if (ownerAvailable && watchdogSid) {
    ownerMatch = targetSid === watchdogSid ? "same-user" : "different-user";
  } else if (!ownerAvailable) {
    ownerMatch = "owner-unavailable";
  }
  
  let sessionMatch = "unavailable";
  if (sessionAvailable && watchdogSessionId != null) {
    sessionMatch = targetSessionId === watchdogSessionId ? "same-session" : "different-session";
  } else if (!sessionAvailable) {
    sessionMatch = "session-unavailable";
  }
  
  // Account Type
  let accountType = "unknown";
  let systemOwned = false;
  let serviceOwned = false;
  
  if (targetSid) {
    if (targetSid === "S-1-5-18" || /system/i.test(username)) {
      accountType = "system";
      systemOwned = true;
    } else if (targetSid === "S-1-5-19" || targetSid === "S-1-5-20" || /local\s*service|network\s*service/i.test(username)) {
      accountType = "service";
      serviceOwned = true;
    } else {
      accountType = "user";
    }
  }
  
  // Elevation Match
  let elevationMatch = "unavailable";
  if (elevationAvailable && watchdogAvailable) {
    if (watchdogElevated && targetElevated) {
      elevationMatch = "compatible-elevated";
    } else if (watchdogElevated && !targetElevated) {
      elevationMatch = "watchdog-elevated";
    } else if (!watchdogElevated && targetElevated) {
      elevationMatch = "elevation-mismatch";
    } else {
      if (sessionMatch === "same-session") {
        elevationMatch = "same-non-elevated-session";
      } else {
        elevationMatch = "same-non-elevated";
      }
    }
  } else if (!elevationAvailable) {
    elevationMatch = "elevation-unavailable";
  }
  
  return {
    owner: {
      available: ownerAvailable,
      match: ownerMatch,
      accountType,
      systemOwned,
      serviceOwned
    },
    session: {
      available: sessionAvailable,
      match: sessionMatch
    },
    elevation: {
      available: elevationAvailable,
      targetIntegrityAvailable,
      targetElevated,
      match: elevationMatch
    },
    watchdog: {
      available: watchdogAvailable,
      elevated: watchdogElevated,
      integrityAvailable: watchdogIntegrityAvailable,
      integrityLevel: watchdogIntegrityLevel,
      sid: watchdogSid,
      sessionId: watchdogSessionId
    }
  };
}

function evaluateConfirmationPolicy(record, options = {}) {
  const safety = record && record.confirmationSafety || {};
  const owner = safety.owner || {};
  const session = safety.session || {};
  const elevation = safety.elevation || {};
  
  const recordWatchdog = safety.watchdog;
  const managerWatchdog = options.watchdogPrivilege || {};
  
  const watchdog = (recordWatchdog && recordWatchdog.available !== undefined) ? recordWatchdog : managerWatchdog;
  
  const watchdogSid = watchdog.sid || watchdog.CurrentSid || watchdog.currentSid || null;
  const watchdogSessionId = watchdog.sessionId ?? watchdog.CurrentSessionId ?? watchdog.currentSessionId ?? null;
  const watchdogElevated = watchdog.elevated === true || watchdog.CurrentElevated === true || watchdog.currentElevated === true;
  const watchdogIntegrityAvailable = watchdog.integrityAvailable === true || watchdog.CurrentIntegrityAvailable === true || watchdog.currentIntegrityAvailable === true;
  const watchdogAvailable = watchdog.available === true && (watchdogSid != null && watchdogSessionId != null && watchdogIntegrityAvailable === true);

  const ownerAvailable = owner.available === true;
  const sessionAvailable = session.available === true;
  const elevationAvailable = elevation.available === true;
  const targetIntegrityAvailable = elevation.targetIntegrityAvailable === true || elevation.integrityAvailable === true;
  const targetElevated = elevation.targetElevated === true || elevation.elevated === true;
  const systemOwned = owner.systemOwned === true || owner.accountType === "system";
  const serviceOwned = owner.serviceOwned === true || owner.accountType === "service";

  const ownerPassed = ownerAvailable &&
    sessionAvailable &&
    watchdogAvailable &&
    owner.match === "same-user" &&
    session.match === "same-session" &&
    !systemOwned &&
    !serviceOwned;

  const elevationPassed = elevationAvailable &&
    watchdogAvailable &&
    targetIntegrityAvailable &&
    watchdogIntegrityAvailable &&
    !(targetElevated === true && watchdogElevated === false) &&
    (elevation.match === "compatible-elevated" ||
     elevation.match === "watchdog-elevated" ||
     elevation.match === "same-non-elevated-session" ||
     elevation.match === "same-non-elevated");

  let failureReason = null;
  if (!ownerAvailable || !sessionAvailable || !elevationAvailable || !targetIntegrityAvailable) {
    failureReason = "TARGET_METADATA_UNAVAILABLE";
  } else if (!watchdogAvailable || !watchdogIntegrityAvailable) {
    failureReason = "WATCHDOG_METADATA_UNAVAILABLE";
  } else if (!ownerPassed) {
    if (owner.match === "different-user") {
      failureReason = "USER_MISMATCH";
    } else if (session.match === "different-session") {
      failureReason = "SESSION_MISMATCH";
    } else if (systemOwned || serviceOwned) {
      failureReason = "SYSTEM_SERVICE_BLOCKED";
    } else {
      failureReason = "OWNER_POLICY_BLOCKED";
    }
  } else if (!elevationPassed) {
    if (targetElevated === true && !watchdogElevated) {
      failureReason = "PRIVILEGE_MISMATCH";
    } else {
      failureReason = "ELEVATION_POLICY_BLOCKED";
    }
  }

  return {
    ownerPassed,
    elevationPassed,
    ownerSession: ownerPassed ? "same-user-same-session" : "blocked",
    elevation: elevationPassed ? "same-non-elevated-session" : "blocked",
    ownerMessage: ownerPassed ? "Owner and login-session policy passed." : "Owner or login-session policy blocked confirmation.",
    elevationMessage: elevationPassed ? "Elevation policy passed." : "Elevation or integrity policy blocked confirmation.",
    failureReason
  };
}

module.exports = {
  buildUnavailableConfirmationSafety,
  buildConfirmationSafety,
  evaluateConfirmationPolicy
};
