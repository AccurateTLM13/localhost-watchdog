"use strict";

const { execFile } = require("node:child_process");
const { existsSync, statSync } = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const {
  MANAGED_LAUNCH_CONTRACT_VERSION,
  buildProcessInstanceId,
  isManagedProcessName,
  validateManagedLaunchIdentity
} = require("./managed-contract");

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 5000;
const SCRIPT_PATH = path.join(__dirname, "windows-project-launcher.ps1");
const EXECUTABLE_EXTENSIONS = ["", ".exe", ".com", ".cmd", ".bat"];
const DIRECT_EXECUTABLE_EXTENSIONS = new Set([".exe", ".com"]);

function createManagedProjectLauncher(options = {}) {
  const platform = options.platform || process.platform;
  const powerShellPath = options.powerShellPath || process.env.LOCALHOST_WATCHDOG_POWERSHELL || "powershell.exe";
  const scriptPath = options.scriptPath || SCRIPT_PATH;
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const runner = options.runner || runWindowsProjectLauncher;

  return async function launchProject(request = {}) {
    if (platform !== "win32") {
      return failure("PROJECT_START_BACKEND_UNAVAILABLE", "Managed project launching is only available on Windows.");
    }

    const validation = validateLaunchRequest(request);
    if (!validation.ok) return validation;

    const parsed = parseConfiguredCommand(request.command, request.args || []);
    if (!parsed.ok) return parsed;

    const resolved = resolveExecutable(parsed.command, request.env || {});
    if (!resolved.ok) return resolved;

    if (!existsSync(scriptPath)) {
      return failure("PROJECT_START_BACKEND_UNAVAILABLE", "The Windows managed-project launcher helper is unavailable.");
    }

    let output;
    try {
      output = await runner({
        powerShellPath,
        scriptPath,
        executablePath: resolved.path,
        args: parsed.args,
        cwd: request.cwd,
        env: { ...process.env, ...(request.env || {}) },
        timeoutMs
      });
    } catch (error) {
      return failure(codeForRunnerError(error), messageForRunnerError(error));
    }

    const identity = parseLaunchOutput(output);
    if (!identity.ok) return identity;

    const processName = path.basename(resolved.path).toLowerCase();
    if (!isManagedProcessName(processName)) {
      return failure("PROJECT_START_RUNTIME_UNSUPPORTED", "The configured runtime is not supported by the managed graceful-stop contract.");
    }
    const result = {
      ok: true,
      code: "PROJECT_STARTED",
      contractVersion: MANAGED_LAUNCH_CONTRACT_VERSION,
      pid: identity.pid,
      processInstanceId: buildProcessInstanceId(identity.pid, identity.createdAt),
      processGroupId: identity.pid,
      createdAt: identity.createdAt,
      processName,
      cwd: request.cwd,
      selectedPort: request.selectedPort || null,
      mechanism: "CREATE_NEW_PROCESS_GROUP",
      message: "Managed project process was started in its configured working directory."
    };
    const identityValidation = validateManagedLaunchIdentity(result);
    if (!identityValidation.ok) return failure(identityValidation.code, "The managed launcher did not return a complete process identity.");
    return result;
  };
}

async function runWindowsProjectLauncher(request) {
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-File",
    request.scriptPath,
    "-ExecutablePath",
    request.executablePath,
    "-WorkingDirectory",
    request.cwd,
    "-ArgumentListJson",
    JSON.stringify(request.args || [])
  ];
  const result = await execFileAsync(request.powerShellPath, args, {
    env: request.env,
    windowsHide: true,
    timeout: request.timeoutMs,
    maxBuffer: 16 * 1024
  });
  return result.stdout;
}

function validateLaunchRequest(request) {
  if (!request || typeof request !== "object") {
    return failure("PROJECT_START_REQUEST_INVALID", "Managed project launch request must be an object.");
  }
  if (!isAbsolutePath(request.cwd)) {
    return failure("PROJECT_START_CWD_INVALID", "Managed project working directory must be absolute.");
  }
  try {
    if (!statSync(request.cwd).isDirectory()) {
      return failure("PROJECT_START_CWD_INVALID", "Managed project working directory must be an existing directory.");
    }
  } catch {
    return failure("PROJECT_START_CWD_INVALID", "Managed project working directory must be an existing directory.");
  }
  if (typeof request.command !== "string" || !request.command.trim()) {
    return failure("PROJECT_START_COMMAND_REQUIRED", "Managed project start command is required.");
  }
  if (/[\r\n]/.test(request.command)) {
    return failure("PROJECT_START_COMMAND_INVALID", "Managed project start command contains invalid control characters.");
  }
  if (request.args != null && (!Array.isArray(request.args) || !request.args.every((arg) => typeof arg === "string"))) {
    return failure("PROJECT_START_ARGS_INVALID", "Managed project start arguments must be strings.");
  }
  if (request.env != null && (typeof request.env !== "object" || Array.isArray(request.env))) {
    return failure("PROJECT_START_ENV_INVALID", "Managed project environment must be an object.");
  }
  return { ok: true };
}

function parseConfiguredCommand(command, explicitArgs) {
  const tokens = tokenizeWindowsCommandLine(command);
  if (!tokens.length) return failure("PROJECT_START_COMMAND_REQUIRED", "Managed project start command is required.");
  const args = explicitArgs.length ? explicitArgs.slice() : tokens.slice(1);
  if (explicitArgs.length && tokens.length !== 1) {
    const explicitPath = String(command).trim();
    if (isAbsolutePath(explicitPath) && existsSync(explicitPath)) {
      return { ok: true, command: explicitPath, args };
    }
    return failure("PROJECT_START_COMMAND_INVALID", "Use either a single executable command with structured arguments or one legacy command line.");
  }
  return { ok: true, command: tokens[0], args };
}

function resolveExecutable(command, env) {
  const value = String(command || "").trim();
  const hasPath = /[\\/]/.test(value) || /^[a-z]:/i.test(value) || value.startsWith("\\\\");
  const candidates = [];

  if (hasPath) {
    candidates.push(value);
  } else {
    const pathValue = String(env.PATH || process.env.PATH || "");
    for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
      for (const extension of EXECUTABLE_EXTENSIONS) candidates.push(path.join(directory, value + extension));
    }
  }

  const found = candidates.find((candidate) => {
    try { return existsSync(candidate) && statSync(candidate).isFile(); } catch { return false; }
  });
  if (!found) return failure("PROJECT_START_COMMAND_NOT_FOUND", "The configured managed project executable could not be found.");

  const extension = path.extname(found).toLowerCase();
  if (!DIRECT_EXECUTABLE_EXTENSIONS.has(extension)) {
    return failure("PROJECT_START_WRAPPER_UNSUPPORTED", "Shell wrapper commands are not supported because they cannot guarantee Phase 4 process-group ownership.");
  }
  return { ok: true, path: found };
}

function tokenizeWindowsCommandLine(value) {
  const tokens = [];
  let token = "";
  let quoted = false;
  let index = 0;

  while (index < value.length) {
    const char = value[index];
    if (char === "\\") {
      let slashes = 0;
      while (value[index + slashes] === "\\") slashes += 1;
      if (value[index + slashes] === '"') {
        token += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2 === 0) {
          quoted = !quoted;
        } else {
          token += '"';
        }
        index += slashes + 1;
        continue;
      }
      token += "\\".repeat(slashes);
      index += slashes;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      index += 1;
      continue;
    }
    if (/\s/.test(char) && !quoted) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      index += 1;
      continue;
    }
    token += char;
    index += 1;
  }
  if (token) tokens.push(token);
  return tokens;
}

function parseLaunchOutput(output) {
  const line = String(output || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
  const separator = line.indexOf("|");
  const pid = Number(separator >= 0 ? line.slice(0, separator) : NaN);
  const createdAt = separator >= 0 ? line.slice(separator + 1).trim() : "";
  if (!Number.isInteger(pid) || pid <= 0 || Number.isNaN(Date.parse(createdAt))) {
    return failure("PROJECT_START_BACKEND_INVALID", "The Windows launcher returned an invalid process identity.");
  }
  return { ok: true, pid, createdAt: new Date(createdAt).toISOString() };
}

function isAbsolutePath(value) {
  return typeof value === "string" && (path.isAbsolute(value) || /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value));
}

function codeForRunnerError(error) {
  if (error && error.code === "ENOENT") return "PROJECT_START_BACKEND_UNAVAILABLE";
  if (error && error.killed) return "PROJECT_START_TIMEOUT";
  return "PROJECT_START_FAILED";
}

function messageForRunnerError(error) {
  return ({
    PROJECT_START_BACKEND_UNAVAILABLE: "The Windows managed-project launcher helper is unavailable.",
    PROJECT_START_TIMEOUT: "The Windows managed-project launcher timed out before returning process identity.",
    PROJECT_START_FAILED: "The managed project could not be started safely."
  })[codeForRunnerError(error)];
}

function failure(code, message) {
  return { ok: false, code, category: "project-action", message, actionExecuted: false };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MANAGED_LAUNCH_CONTRACT_VERSION,
  buildProcessInstanceId,
  createManagedProjectLauncher,
  parseConfiguredCommand,
  parseLaunchOutput,
  resolveExecutable,
  tokenizeWindowsCommandLine
};
