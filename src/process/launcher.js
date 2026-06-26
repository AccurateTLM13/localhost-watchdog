"use strict";

const { redactSensitiveText } = require("../privacy/redact");

const LAUNCHER_RULES = [
  { name: "VS Code", category: "editor", impact: 8, names: ["code.exe"], patterns: ["\\microsoft vs code\\", "\\vscode\\"] },
  { name: "Cursor", category: "editor", impact: 8, names: ["cursor.exe"], patterns: ["\\cursor\\"] },
  { name: "Windows Terminal", category: "terminal", impact: 6, names: ["windowsterminal.exe", "wt.exe"], patterns: ["windows terminal"] },
  { name: "PowerShell", category: "terminal", impact: 6, names: ["powershell.exe", "pwsh.exe"], patterns: ["powershell", "pwsh"] },
  { name: "Command Prompt", category: "terminal", impact: 6, names: ["cmd.exe"], patterns: ["cmd.exe"] },
  { name: "Git Bash", category: "terminal", impact: 6, names: ["bash.exe", "sh.exe"], patterns: ["\\git\\bin\\bash", "\\usr\\bin\\bash", "git bash"] },
  { name: "npm", category: "package-manager", impact: 8, names: ["npm.cmd", "npm.exe"], patterns: ["npm run", " npm "] },
  { name: "npx", category: "package-manager", impact: 8, names: ["npx.cmd", "npx.exe"], patterns: ["npx "] },
  { name: "pnpm", category: "package-manager", impact: 8, names: ["pnpm.cmd", "pnpm.exe"], patterns: ["pnpm "] },
  { name: "yarn", category: "package-manager", impact: 8, names: ["yarn.cmd", "yarn.exe"], patterns: ["yarn "] },
  { name: "docker compose", category: "container", impact: 5, names: ["docker.exe"], patterns: ["docker compose"] },
  { name: "Docker Desktop", category: "container", impact: 5, names: ["docker desktop.exe", "com.docker.backend.exe"], patterns: ["docker desktop", "com.docker.backend"] },
  { name: "node", category: "runtime", impact: 5, names: ["node.exe"], patterns: ["node "] },
  { name: "python", category: "runtime", impact: 5, names: ["python.exe", "python3.exe", "py.exe"], patterns: ["python ", "uvicorn", "flask", "django"] },
  { name: "Maven Java", category: "runtime", impact: 5, names: [], patterns: ["maven", "mvn "] },
  { name: "Gradle Java", category: "runtime", impact: 5, names: [], patterns: ["gradle", "bootrun"] },
  { name: "java", category: "runtime", impact: 5, names: ["java.exe", "javaw.exe"], patterns: ["java "] }
];

function detectLauncherContext(record, parentProcess) {
  const parentPid = record && record.parentPid != null ? Number(record.parentPid) : null;
  const base = {
    parentPid: Number.isInteger(parentPid) ? parentPid : null,
    parentProcessName: null,
    parentCategory: "missing",
    launcherName: "Parent process unknown",
    confidenceImpact: 0,
    parentCommandLine: null,
    parentExecutablePath: null,
    evidence: []
  };

  if (!parentProcess) {
    base.evidence.push({
      type: "launcher",
      score: 0,
      message: base.parentPid == null ? "parent process id is unavailable" : `parent process metadata unavailable for pid ${base.parentPid}`
    });
    return base;
  }

  const parentName = parentProcess.processName || parentProcess.Name || null;
  const commandLine = redactSensitiveText(parentProcess.commandLine || parentProcess.CommandLine);
  const executablePath = redactSensitiveText(parentProcess.executablePath || parentProcess.ExecutablePath);
  const detected = matchLauncher(parentName, parentProcess.commandLine || parentProcess.CommandLine, parentProcess.executablePath || parentProcess.ExecutablePath);

  return {
    parentPid: Number.isInteger(base.parentPid) ? base.parentPid : nullableNumber(parentProcess.pid || parentProcess.ProcessId),
    parentProcessName: parentName,
    parentCategory: detected.category,
    launcherName: detected.name,
    confidenceImpact: detected.impact,
    parentCommandLine: commandLine,
    parentExecutablePath: executablePath,
    evidence: [
      {
        type: "launcher",
        score: detected.impact,
        message: detected.matched
          ? `parent process suggests launch context: ${detected.name}`
          : "parent process did not match a known launch context"
      }
    ]
  };
}

function matchLauncher(processName, commandLine, executablePath) {
  const name = normalizeName(processName);
  const haystack = normalizeText(`${processName || ""} ${commandLine || ""} ${executablePath || ""}`);

  for (const rule of LAUNCHER_RULES) {
    if (rule.names.includes(name) || rule.patterns.some((pattern) => haystack.includes(pattern))) {
      return {
        name: rule.name,
        category: rule.category,
        impact: rule.impact,
        matched: true
      };
    }
  }

  return {
    name: processName || "Unknown parent process",
    category: "unknown",
    impact: 0,
    matched: false
  };
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeText(value) {
  return String(value || "").replace(/\//g, "\\").toLowerCase();
}

function nullableNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

module.exports = {
  detectLauncherContext,
  matchLauncher
};
