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
      available: true,
      elevated: false,
      integrityAvailable: true
    }
  };
}

function buildConfirmationSafety(proc, watchdog) {
  const watchdogSid = watchdog && watchdog.currentSid || null;
  const watchdogSessionId = watchdog && watchdog.currentSessionId != null ? Number(watchdog.currentSessionId) : null;
  const watchdogElevated = watchdog && watchdog.currentElevated === true;
  
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
  if (elevationAvailable && watchdogSid) {
    if (watchdogElevated && targetElevated) {
      elevationMatch = "elevation-mismatch";
    } else if (watchdogElevated && !targetElevated) {
      elevationMatch = "watchdog-elevated";
    } else if (!watchdogElevated && targetElevated) {
      elevationMatch = "target-elevated";
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
      targetIntegrityAvailable: targetIntegrityLevel != null,
      targetElevated,
      match: elevationMatch
    },
    watchdog: {
      available: watchdogSid != null,
      elevated: watchdogElevated,
      integrityAvailable: true
    }
  };
}

function evaluateConfirmationPolicy(record, options = {}) {
  const safety = record && record.confirmationSafety || {};
  const owner = safety.owner || {};
  const session = safety.session || {};
  const elevation = safety.elevation || {};
  const watchdog = options.watchdogPrivilege || {};
  const ownerAvailable = owner.available === true;
  const sessionAvailable = session.available === true;
  const targetIntegrityAvailable = elevation.targetIntegrityAvailable === true || elevation.integrityAvailable === true;
  const watchdogIntegrityAvailable = watchdog.integrityAvailable === true;
  const targetElevated = elevation.targetElevated === true || elevation.elevated === true;
  const watchdogElevated = watchdog.elevated === true;
  const systemOwned = owner.systemOwned === true || owner.accountType === "system";
  const serviceOwned = owner.serviceOwned === true || owner.accountType === "service";

  const ownerPassed = ownerAvailable &&
    sessionAvailable &&
    owner.match === "same-user" &&
    session.match === "same-session" &&
    !systemOwned &&
    !serviceOwned;
  const elevationPassed = targetIntegrityAvailable &&
    watchdogIntegrityAvailable &&
    elevation.available === true &&
    watchdog.available !== false &&
    targetElevated === false &&
    watchdogElevated === false &&
    (elevation.match === "same-non-elevated-session" || elevation.match === "same-non-elevated");

  return {
    ownerPassed,
    elevationPassed,
    ownerSession: ownerPassed ? "same-user-same-session" : "blocked",
    elevation: elevationPassed ? "same-non-elevated-session" : "blocked",
    ownerMessage: ownerPassed ? "Owner and login-session policy passed." : "Owner or login-session policy blocked confirmation.",
    elevationMessage: elevationPassed ? "Elevation policy passed." : "Elevation or integrity policy blocked confirmation."
  };
}

module.exports = {
  buildUnavailableConfirmationSafety,
  buildConfirmationSafety,
  evaluateConfirmationPolicy
};
