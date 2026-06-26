"use strict";

const { findProjectForRecord, isInsideConfiguredRoot, loadWatchdogConfig, redactConfiguredPath } = require("../config/load");
const {
  BROWSER_NAMES,
  DATABASE_NAMES,
  EDITOR_NAMES,
  JAVA_DEV_KEYWORDS,
  JAVA_RUNTIMES,
  LOCAL_AI_KEYWORDS,
  LOCAL_AI_NAMES,
  NODE_DEV_KEYWORDS,
  NODE_RUNTIMES,
  PYTHON_DEV_KEYWORDS,
  PYTHON_RUNTIMES,
  isCommonDevPort,
  isLocalBind,
  isProtectedPort,
  isProtectedProcess,
  isRuntime,
  isWildcardBind,
  matchesAnyProcessName,
  normalizeName,
  protectedPortReason,
  textIncludesAny
} = require("./safety");

function classifyReadOnly(record, options = {}) {
  const config = options.config || loadWatchdogConfig();
  const safetyConfig = config.safety;
  const configuredProject = findProjectForRecord(record, config.projects);
  const project = record.project || (configuredProject ? {
    name: configuredProject.name || configuredProject.id || null,
    root: redactConfiguredPath(configuredProject.path) || null,
    confidence: 90,
    source: "config-project",
    evidence: ["record path matched configured project path"],
    workingDirectory: redactConfiguredPath(configuredProject.path) || null
  } : null);
  const evidence = [];
  const warnings = [];
  let confidence = 0;
  let category = "unknown-listener";
  let hiddenReason = null;

  if (isLocalBind(record.host)) {
    confidence += addEvidence(evidence, "network", 20, "listener is bound to localhost");
  } else if (isWildcardBind(record.host)) {
    confidence += addEvidence(evidence, "network", -20, "listener binds to all interfaces");
    warnings.push("binds to all interfaces");
  } else {
    hiddenReason = "non-localhost";
    confidence += addEvidence(evidence, "network", -40, "listener is not bound to localhost");
    warnings.push("not bound to localhost");
  }
  const networkExposure = getNetworkExposure(record.host);

  if (isProtectedProcess(record.processName, safetyConfig)) {
    category = "system-or-protected";
    hiddenReason = "protected";
    confidence += addEvidence(evidence, "protected-process", -100, "process name matches configured protected process rules");
  }

  if (isProtectedPort(record.port, safetyConfig)) {
    category = "system-or-protected";
    hiddenReason = "protected";
    confidence += addEvidence(evidence, "protected-port", -100, protectedPortReason(record.port, safetyConfig) || "port matches configured protected port rules");
  }

  const devRootEvidence = hasConfiguredDevRootEvidence(record, safetyConfig);
  if (devRootEvidence) {
    confidence += addEvidence(evidence, "dev-root", 15, "command or executable path is inside a configured dev root");
  }

  if (project) {
    const projectScore = projectConfidenceScore(project);
    confidence += addEvidence(evidence, "project-ownership", projectScore, `project ownership detected from ${project.source || "unknown source"}: ${project.name || "unnamed project"}`);
    for (const item of project.evidence || []) {
      evidence.push({
        type: "project-ownership",
        score: 0,
        message: item
      });
    }
  }

  const launcherImpact = launcherConfidenceImpact(record.launcher);
  if (record.launcher) {
    confidence += addEvidence(evidence, "launcher", launcherImpact, launcherEvidenceMessage(record.launcher));
    for (const item of record.launcher.evidence || []) {
      evidence.push({
        type: item.type || "launcher",
        score: 0,
        message: item.message || "launcher context evidence"
      });
    }
  }

  const treeImpact = processTreeConfidenceImpact(record.processTree);
  if (record.processTree) {
    confidence += addEvidence(evidence, "process-tree", treeImpact, processTreeEvidenceMessage(record.processTree));
    for (const item of record.processTree.evidence || []) {
      evidence.push({
        type: item.type || "process-tree",
        score: 0,
        message: item.message || "process-tree context evidence"
      });
    }
  }

  if (isCommonDevPort(record.port, safetyConfig)) {
    confidence += addEvidence(evidence, "port", 10, "port is configured as a common development port");
  }

  const categoryResult = chooseCategory(record, safetyConfig);
  category = category === "system-or-protected" ? category : categoryResult.category;
  confidence += categoryResult.score;
  evidence.push(...categoryResult.evidence);
  warnings.push(...categoryResult.warnings);

  const confidenceLevel = getConfidenceLevel(confidence, categoryResult.strongEvidence);
  const boundedConfidence = Math.max(0, Math.min(100, confidence));
  const usefulLowConfidence = isUsefulLowConfidenceCategory(category);
  const safeToShow = !hiddenReason && (
    confidenceLevel !== "low" ||
    usefulLowConfidence
  );

  if (!safeToShow && !hiddenReason) {
    hiddenReason = boundedConfidence < 40 ? "low-confidence" : "unknown";
  }

  const actions = safeToShow ? ["inspect"] : [];
  if (safeToShow && record.url) actions.unshift("open");

  return {
    category,
    runtime: inferRuntime(record.processName, category),
    project: project || null,
    projectId: configuredProject ? configuredProject.id || null : null,
    projectName: project ? project.name || null : null,
    managed: false,
    confidence: boundedConfidence,
    confidenceLevel,
    safeToShow,
    safeToStop: false,
    safeToRestart: false,
    bulkStoppable: false,
    actions,
    evidence,
    reasons: evidence.map((item) => item.message),
    warnings,
    networkExposure,
    hiddenReason,
    httpProbe: {
      attempted: false
    }
  };
}

function projectConfidenceScore(project) {
  const value = Number(project.confidence || 0);
  if (value >= 80) return 20;
  if (value >= 60) return 12;
  if (value >= 35) return 5;
  return 0;
}

function launcherConfidenceImpact(launcher) {
  const value = Number(launcher && launcher.confidenceImpact);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(10, value);
}

function launcherEvidenceMessage(launcher) {
  if (!launcher || launcher.parentCategory === "missing") return "parent process context unavailable";
  if (launcher.parentCategory === "unknown") return `parent process detected but launch context is unknown: ${launcher.parentProcessName || "unknown"}`;
  return `launched from ${launcher.launcherName}`;
}

function processTreeConfidenceImpact(processTree) {
  const scores = (processTree && processTree.evidence || [])
    .map((item) => Number(item.score || 0))
    .filter((score) => Number.isFinite(score) && score > 0);
  if (scores.length === 0) return 0;
  return Math.min(8, Math.max(...scores));
}

function processTreeEvidenceMessage(processTree) {
  if (!processTree || !Array.isArray(processTree.chain) || processTree.chain.length <= 1) {
    return "process-tree ancestry unavailable";
  }
  const labels = processTree.chain
    .map((item) => item.launcherName || item.processName)
    .filter(Boolean);
  return `process-tree ancestry: ${labels.join(" -> ")}`;
}

function getNetworkExposure(host) {
  if (isWildcardBind(host)) {
    return {
      level: "all-interfaces",
      warning: true,
      message: "Listener binds to all interfaces; probe uses localhost only."
    };
  }

  if (isLocalBind(host)) {
    return {
      level: "loopback",
      warning: false,
      message: "Listener is bound to loopback."
    };
  }

  return {
    level: "non-loopback",
    warning: true,
    message: "Listener is not bound to loopback and is not probed by default."
  };
}

function chooseCategory(record, safetyConfig) {
  if (matchesAnyProcessName(record.processName, BROWSER_NAMES)) {
    return categoryEvidence("browser-helper", 20, "browser process owns a localhost listener", false);
  }

  if (matchesAnyProcessName(record.processName, EDITOR_NAMES) || textIncludesAny(record, ["\\.vscode\\", "\\cursor\\", "\\antigravity-ide\\", "\\jetbrains\\"])) {
    return categoryEvidence("editor-helper", 20, "editor or IDE helper owns a localhost listener", false);
  }

  if (textIncludesAny(record, DATABASE_NAMES)) {
    return categoryEvidence("database", 35, "database process or command detected", true, ["database listeners are read-only in this phase"]);
  }

  if (textIncludesAny(record, LOCAL_AI_NAMES) || textIncludesAny(record, LOCAL_AI_KEYWORDS)) {
    return categoryEvidence("local-ai-server", 45, "local AI or companion server detected", true, ["local AI listeners are read-only in this phase"]);
  }

  if (isRuntime(record, NODE_RUNTIMES, safetyConfig) && textIncludesAny(record, NODE_DEV_KEYWORDS)) {
    return categoryEvidence("node-dev-server", 45, "Node runtime and dev-server command detected", true);
  }

  if (isRuntime(record, NODE_RUNTIMES, safetyConfig)) {
    return categoryEvidence("node-dev-server", 25, "Node runtime detected without strong dev command", false);
  }

  if (isRuntime(record, PYTHON_RUNTIMES, safetyConfig) && textIncludesAny(record, PYTHON_DEV_KEYWORDS)) {
    return categoryEvidence("python-dev-server", 45, "Python runtime and web-server command detected", true);
  }

  if (isRuntime(record, PYTHON_RUNTIMES, safetyConfig)) {
    return categoryEvidence("python-dev-server", 25, "Python runtime detected without strong web command", false);
  }

  if (isRuntime(record, JAVA_RUNTIMES, safetyConfig) && textIncludesAny(record, JAVA_DEV_KEYWORDS)) {
    return categoryEvidence("java-dev-server", 40, "Java runtime and development server command detected", true);
  }

  if (isRuntime(record, JAVA_RUNTIMES, safetyConfig)) {
    return categoryEvidence("java-dev-server", 20, "Java runtime detected without strong development command", false);
  }

  return categoryEvidence("unknown-listener", 0, "no explicit category rule matched", false);
}

function categoryEvidence(category, score, message, strongEvidence, warnings = []) {
  return {
    category,
    score,
    strongEvidence,
    evidence: [
      {
        type: "category",
        score,
        message
      }
    ],
    warnings
  };
}

function hasConfiguredDevRootEvidence(record, safetyConfig) {
  const value = `${record.commandLine || ""} ${record.executablePath || ""}`;
  const normalized = String(value || "").replace(/\//g, "\\").toLowerCase();
  return (safetyConfig.devRoots || []).some((root) => normalized.includes(`${root}\\`) || normalized.includes(`"${root}\\`));
}

function addEvidence(evidence, type, score, message) {
  evidence.push({ type, score, message });
  return score;
}

function getConfidenceLevel(score, strongEvidence) {
  if (score >= 75 && strongEvidence) return "high";
  if (score >= 45) return "medium";
  return "low";
}

function isUsefulLowConfidenceCategory(category) {
  return [
    "browser-helper",
    "editor-helper",
    "database",
    "local-ai-server",
    "java-dev-server"
  ].includes(category);
}

function inferRuntime(processName, category) {
  const name = normalizeName(processName);
  if (category === "node-dev-server" || name.includes("node") || name.includes("npm") || name.includes("pnpm") || name.includes("yarn") || name.includes("bun")) return "node";
  if (category === "python-dev-server" || name.includes("python") || name.includes("uvicorn") || name.includes("flask")) return "python";
  if (category === "java-dev-server" || name.includes("java")) return "java";
  if (category === "local-ai-server" || name.includes("ollama")) return "local-ai";
  if (category === "database") return "database";
  return null;
}

module.exports = {
  classifyReadOnly,
  getConfidenceLevel,
  getNetworkExposure,
  inferRuntime
};
