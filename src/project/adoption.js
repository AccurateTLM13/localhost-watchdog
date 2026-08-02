"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createProjectRegistry, normalizeProject } = require("./registry");
const {
  loadWatchdogConfig,
  normalizeProjectRoot,
  preserveProjectDisplayRoot,
  projectDisplayRootSource
} = require("../config/load");
const { isLocalBind, isProtectedPort, isProtectedProcess } = require("../classifier/safety");
const { isManagedProcessName } = require("./managed-contract");

const MIN_ADOPTION_CONFIDENCE = 70;
const ADOPTABLE_CATEGORIES = new Set(["node-dev-server", "python-dev-server"]);
const BLOCKED_CATEGORIES = new Set([
  "database",
  "local-ai-server",
  "browser-helper",
  "editor-helper",
  "system-or-protected",
  "unknown-listener"
]);
const SAFE_LAUNCHERS = new Set([
  "bun",
  "bun.exe",
  "deno",
  "deno.exe",
  "django-admin",
  "django-admin.exe",
  "flask",
  "flask.exe",
  "node",
  "node.exe",
  "npm",
  "npm.cmd",
  "pnpm",
  "pnpm.cmd",
  "py",
  "py.exe",
  "python",
  "python.exe",
  "python3",
  "python3.exe",
  "uvicorn",
  "uvicorn.exe",
  "yarn",
  "yarn.cmd"
]);
const NODE_SCRIPT_PROFILES = [
  { name: "vite", marker: /(?:^|[\\/\s"'._-])vite(?=$|[\\/\s"'._-])/i },
  { name: "next", marker: /(?:^|[\\/\s"'._-])next(?=$|[\\/\s"'._-])/i },
  { name: "node", marker: /(?:^|[\\/\s"'._-])node(?:\.exe)?\s+/i },
  { name: "node", marker: /(?:^|[\\/\s"'._-])(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:run\s+)?dev(?=$|[\\/\s"'._-])/i }
];
const PYTHON_SERVER_MARKER = /(?:uvicorn|fastapi|flask|django|manage\.py\s+runserver|python\s+-m\s+http\.server)/i;
const UNSAFE_ARGUMENT_MARKER = /(?:^|[-_])(api[_-]?key|auth|client[_-]?secret|credential|password|passwd|secret|session|token)(?:$|[-_=])/i;

function createAdoptionManager(options = {}) {
  const configProvider = options.configProvider || (() => loadWatchdogConfig(options.configOptions || {}));
  const registry = options.registry || createProjectRegistry({ configProvider });
  const writer = options.configWriter || createDefaultAdoptionWriter(options);
  const randomId = options.randomId || ((bytes = 6) => require("node:crypto").randomBytes(bytes).toString("hex"));

  function draftAdoption(input = {}) {
    const record = input.record || input;
    const validation = validateAdoptionCandidate(record, { config: safeConfig(configProvider) });
    if (!validation.ok) return errorResponse(validation.code, validation.message, { reasons: validation.reasons || [] });
    const draft = buildAdoptionDraft(record, { randomId, candidate: validation.candidate });
    return {
      ok: true,
      schemaVersion: "localhost-watchdog.project-adoption.v1",
      state: "adoption-draft-ready",
      draft,
      actionExecuted: false
    };
  }

  async function adoptProject(input = {}) {
    const validation = validateSaveRequest(input);
    if (!validation.ok) return errorResponse(validation.code, validation.message);
    const config = safeConfig(configProvider);
    const candidateValidation = validateAdoptionCandidate(input.record, { config });
    if (!candidateValidation.ok) return errorResponse(candidateValidation.code, candidateValidation.message, { reasons: candidateValidation.reasons || [] });
    const draftResult = draftAdoption(input.record);
    if (!draftResult.ok) return draftResult;
    const overrides = sanitizeOverrides(input.project || {}, draftResult.draft, config);
    if (!overrides.ok) return errorResponse(overrides.code, overrides.message, { reasons: overrides.reasons || [] });
    const draft = overrides.project;
    let projects;
    try {
      projects = registry.listProjects();
    } catch {
      return errorResponse("PROJECT_REGISTRY_UNAVAILABLE", "The project registry could not be read safely.");
    }
    if (projects.some((project) => project.id === draft.id)) return errorResponse("PROJECT_ID_CONFLICT", "Project id already exists.");
    if (projects.some((project) => sameProjectPath(project.root || project.path, draft.root))) return errorResponse("PROJECT_PATH_CONFLICT", "This project path is already registered.");
    const normalized = normalizeProject(draft, { io: fs });
    if (!normalized.valid) {
      return errorResponse("PROJECT_ADOPTION_INVALID", "The adoption draft is not valid for the project registry.", { reasons: normalized.validation.problems || [] });
    }
    let writeResult;
    try {
      writeResult = await writer({ project: draft, config });
    } catch {
      writeResult = { ok: false, code: "PROJECT_ADOPTION_WRITE_FAILED", message: "Project adoption could not be saved." };
    }
    if (!writeResult || writeResult.ok !== true) return errorResponse(writeResult && writeResult.code || "PROJECT_ADOPTION_WRITE_UNAVAILABLE", writeResult && writeResult.message || "Project adoption writer is unavailable.");
    return {
      ok: true,
      schemaVersion: "localhost-watchdog.project-adoption.v1",
      state: "project-adopted",
      project: publicProject(draft),
      actionExecuted: false
    };
  }

  return { draftAdoption, adoptProject };
}

function validateAdoptionCandidate(record = {}, options = {}) {
  const reasons = [];
  let config;
  try {
    config = Object.prototype.hasOwnProperty.call(options, "config")
      ? options.config
      : loadWatchdogConfig(options.configOptions || {});
  } catch {
    config = null;
  }
  if (!config || !config.safety) {
    return {
      ok: false,
      code: "SAFETY_CONFIG_UNAVAILABLE",
      message: "Safety configuration is unavailable, so adoption is blocked.",
      reasons: [{ code: "SAFETY_CONFIG_UNAVAILABLE", message: "Safety configuration is unavailable, so adoption is blocked." }]
    };
  }
  const safety = config.safety || {};
  const confidence = Number(record.confidenceScore || record.confidence || 0);
  if (!Number.isFinite(confidence) || confidence < MIN_ADOPTION_CONFIDENCE) reasons.push({ code: "CONFIDENCE_TOO_LOW", message: "Adoption requires confidence of at least 70." });
  if (record.confidenceLevel && record.confidenceLevel !== "high") reasons.push({ code: "CONFIDENCE_LEVEL_NOT_HIGH", message: "Adoption requires a high-confidence classification." });
  if (BLOCKED_CATEGORIES.has(record.category)) reasons.push({ code: "CATEGORY_BLOCKED", message: "This listener category cannot be adopted blindly." });
  if (!ADOPTABLE_CATEGORIES.has(record.category)) reasons.push({ code: "CATEGORY_NOT_ADOPTABLE", message: "Only supported high-confidence development server categories may be adopted." });
  if (isProtectedProcess(record.processName, safety) || isProtectedPort(record.port, safety)) reasons.push({ code: "PROTECTED_TARGET", message: "Protected processes and ports cannot be adopted." });
  if (!isLocalBind(record.host)) reasons.push({ code: "LOOPBACK_BIND_REQUIRED", message: "Adoption requires a listener bound to localhost." });
  if (record.safeToShow === false) reasons.push({ code: "RECORD_NOT_SAFE_TO_SHOW", message: "This detected record is not safe to adopt." });

  const candidate = extractAdoptionCandidate(record);
  if (!candidate.ok) reasons.push(...candidate.reasons);

  const root = candidate.root || normalizeCandidatePath(candidateRoot(record));
  if (!root) reasons.push({ code: "PROJECT_PATH_REQUIRED", message: "A project root is required for adoption." });
  if (root && !isSupportedAbsolutePath(root)) reasons.push({ code: "PROJECT_PATH_ABSOLUTE_REQUIRED", message: "Adoption requires an absolute project path." });
  if (root && !isExistingDirectory(root)) reasons.push({ code: "PROJECT_PATH_UNAVAILABLE", message: "The detected project root must exist and be a directory." });
  if (candidate.workingDirectory && root && !isPathWithin(candidate.workingDirectory, root)) reasons.push({ code: "PROJECT_CWD_OUTSIDE_ROOT", message: "The detected start directory must remain inside the project root." });
  if (!normalizePort(record.port)) reasons.push({ code: "LISTENER_PORT_REQUIRED", message: "A valid listener port is required for adoption." });

  return reasons.length
    ? { ok: false, code: reasons[0].code, message: reasons[0].message, reasons, candidate }
    : { ok: true, candidate: { ...candidate, root, workingDirectory: candidate.workingDirectory || root } };
}

function buildAdoptionDraft(record = {}, options = {}) {
  const randomId = options.randomId || (() => "adopted");
  const candidate = options.candidate || extractAdoptionCandidate(record);
  const root = candidate.root || normalizeCandidatePath(candidateRoot(record));
  const name = safeString(record.project && record.project.name) || path.basename(root) || "adopted-project";
  const start = {
    command: candidate.start.command,
    args: candidate.start.args,
    cwd: candidate.workingDirectory || root,
    env: {},
    preferredPort: normalizePort(record.port),
    portStrategy: "strict"
  };
  return {
    id: stableProjectId(name, randomId),
    name,
    root,
    displayRoot: candidate.displayRoot || root,
    managed: true,
    start,
    preferredPort: normalizePort(record.port),
    portStrategy: "strict",
    runtime: candidate.runtime,
    profile: candidate.profile,
    tags: ["adopted", candidate.profile]
  };
}

function candidateRoot(record = {}) {
  return record.project && (record.project.root || record.project.path) || record.workingDirectory || null;
}

function candidateDisplayRoot(record = {}) {
  if (record.project) return projectDisplayRootSource(record.project);
  return record.workingDirectory || null;
}

function extractAdoptionCandidate(record = {}) {
  const commandLine = safeString(record.commandLine) || safeString(record.startCommand);
  const tokens = tokenizeCommandLine(commandLine);
  const launcherToken = tokens[0];
  const launcherName = executableName(launcherToken);
  const profile = detectProfile(record, commandLine);
  const reasons = [];

  if (!commandLine || !tokens.length) reasons.push({ code: "START_COMMAND_REQUIRED", message: "A start command is required for adoption." });
  if (!profile) reasons.push({ code: "SERVER_PROFILE_UNSUPPORTED", message: "The detected command is not a supported Vite, Next, or Python server profile." });
  if (launcherName && !SAFE_LAUNCHERS.has(launcherName)) reasons.push({ code: "START_COMMAND_UNSAFE", message: "The detected launcher is not on the adoption allowlist." });

  const start = profile && launcherName && SAFE_LAUNCHERS.has(launcherName)
    ? buildStartDefinition(profile, launcherToken, launcherName, tokens)
    : null;
  if (start && start.reasons) reasons.push(...start.reasons);
  if (start && !isManagedProcessName(launcherName)) reasons.push({ code: "START_WRAPPER_UNSUPPORTED", message: "Adoption requires a direct executable supported by the managed graceful-stop contract." });
  if (!start && commandLine) reasons.push({ code: "START_COMMAND_UNSAFE", message: "The detected command could not be reduced to a safe structured start definition." });

  const root = normalizeCandidatePath(candidateRoot(record));
  const displayRoot = preserveProjectDisplayRoot(candidateDisplayRoot(record));
  const workingDirectory = normalizeCandidatePath(record.project && record.project.workingDirectory || record.workingDirectory);
  return {
    ok: reasons.length === 0,
    reasons,
    profile,
    runtime: profile === "python" ? "python" : "node",
    root,
    displayRoot,
    workingDirectory,
    start: start && { command: start.command, args: start.args }
  };
}

function detectProfile(record = {}, commandLine = "") {
  const category = String(record.category || "").toLowerCase();
  const text = `${commandLine} ${record.processName || ""} ${record.executablePath || ""}`;
  if (category === "node-dev-server") {
    const match = NODE_SCRIPT_PROFILES.find((profile) => profile.marker.test(text));
    return match && match.name;
  }
  if (category === "python-dev-server" && PYTHON_SERVER_MARKER.test(text)) return "python";
  return null;
}

function buildStartDefinition(profile, launcherToken, launcherName, tokens) {
  const reasons = [];
  const args = tokens.slice(1);
  const normalizedLauncher = launcherName.replace(/\.(?:exe|cmd)$/i, "");
  let safeArgs;

  if (["npm", "pnpm", "yarn", "bun"].includes(normalizedLauncher)) {
    const isRunDev = args[0] === "run" && args[1] === "dev";
    const isDirectDev = args[0] === "dev";
    if (!isRunDev && !isDirectDev) reasons.push({ code: "START_COMMAND_UNSAFE", message: "Package-manager adoption requires a direct dev script." });
    safeArgs = isRunDev ? ["run", "dev"] : ["dev"];
  } else if (normalizedLauncher === "node" || normalizedLauncher === "deno") {
    if (!args[0]) reasons.push({ code: "START_COMMAND_REQUIRED", message: "A runtime script is required for adoption." });
    if (args.slice(1).some((arg) => UNSAFE_ARGUMENT_MARKER.test(String(arg)))) reasons.push({ code: "START_ARGUMENT_UNSAFE", message: "The detected start arguments contain a secret-bearing option." });
    safeArgs = profile === "next" && args[1] === "dev" ? [args[0], "dev"] : [args[0]];
  } else if (["python", "python3", "py"].includes(normalizedLauncher)) {
    safeArgs = pythonStartArgs(profile, args, reasons);
  } else if (["uvicorn", "flask", "django-admin"].includes(normalizedLauncher)) {
    safeArgs = args.slice(0, 2);
    if (!safeArgs.length) reasons.push({ code: "START_COMMAND_REQUIRED", message: "A Python server entrypoint is required for adoption." });
  } else {
    reasons.push({ code: "START_COMMAND_UNSAFE", message: "The detected launcher is not a supported structured runtime." });
    safeArgs = [];
  }

  return { command: launcherToken, args: safeArgs || [], reasons };
}

function pythonStartArgs(profile, args, reasons) {
  if (args[0] === "-m" && ["uvicorn", "http.server", "flask"].includes(String(args[1] || "").toLowerCase())) {
    if (args[1].toLowerCase() === "uvicorn" && !args[2]) reasons.push({ code: "START_TARGET_REQUIRED", message: "The detected Uvicorn application target is required." });
    return args[1].toLowerCase() === "uvicorn" ? args.slice(0, 3) : args.slice(0, 2);
  }
  if (profile === "python" && ["run", "runserver"].includes(String(args[0] || "").toLowerCase())) return args.slice(0, 1);
  reasons.push({ code: "START_COMMAND_UNSAFE", message: "The detected Python command is not a supported structured server entrypoint." });
  return [];
}

function sanitizeOverrides(value = {}, draft = {}, config = {}) {
  const result = {};
  if (value == null || typeof value !== "object" || Array.isArray(value)) return { ok: false, code: "INVALID_PROJECT_OVERRIDES", message: "Project overrides must be an object." };
  if (safeString(value.id)) result.id = stableProjectId(value.id, () => "");
  if (safeString(value.name)) result.name = safeString(value.name).slice(0, 120);
  if (Object.prototype.hasOwnProperty.call(value, "startCommand") || Object.prototype.hasOwnProperty.call(value, "start")) {
    return { ok: false, code: "START_CONFIG_OVERRIDE_NOT_ALLOWED", message: "Adoption cannot replace the detected safe start definition." };
  }
  if (Object.prototype.hasOwnProperty.call(value, "preferredPort")) {
    const port = normalizePort(value.preferredPort);
    if (!port || isProtectedPort(port, config.safety || {})) return { ok: false, code: "PREFERRED_PORT_UNSAFE", message: "The preferred port override is invalid or protected." };
    result.preferredPort = port;
  }
  if (Object.prototype.hasOwnProperty.call(value, "portStrategy")) {
    if (!["strict", "next-available"].includes(value.portStrategy)) return { ok: false, code: "PORT_STRATEGY_INVALID", message: "The port strategy override is invalid." };
    result.portStrategy = value.portStrategy;
  }
  const project = { ...draft, ...result, start: { ...(draft.start || {}), preferredPort: result.preferredPort || draft.preferredPort, portStrategy: result.portStrategy || draft.portStrategy } };
  return { ok: true, project };
}

function publicProject(project) {
  return {
    id: project.id,
    name: project.name,
    managed: true,
    root: project.root,
    displayRoot: project.displayRoot || project.root,
    startCommand: project.start && project.start.command,
    startArgs: project.start && project.start.args,
    startCwd: project.start && project.start.cwd,
    preferredPort: project.preferredPort,
    portStrategy: project.portStrategy,
    runtime: project.runtime,
    tags: project.tags
  };
}

function validateSaveRequest(input = {}) {
  if (!input || typeof input !== "object") return { ok: false, code: "INVALID_REQUEST", message: "Request body must be an object." };
  if (!input.record || typeof input.record !== "object") return { ok: false, code: "RECORD_REQUIRED", message: "Detected server record is required." };
  return { ok: true };
}

function safeConfig(configProvider) {
  try {
    return configProvider() || null;
  } catch {
    return null;
  }
}

function normalizeCandidatePath(value) {
  return normalizeProjectRoot(value);
}

function isExistingDirectory(value) {
  try {
    return fs.existsSync(value) && fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function isPathWithin(value, root) {
  const child = comparablePath(value);
  const parent = comparablePath(root);
  return child === parent || child.startsWith(`${parent}${parent.includes("\\") ? "\\" : path.sep}`);
}

function sameProjectPath(left, right) {
  return Boolean(left && right && comparablePath(left) === comparablePath(right));
}

function comparablePath(value) {
  const normalized = normalizeCandidatePath(value) || String(value || "");
  return /^[a-z]:\\|^\\\\/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function executableName(value) {
  const text = safeString(value);
  if (!text) return null;
  return text.replace(/^.*[\\/]/, "").toLowerCase();
}

function tokenizeCommandLine(value) {
  const text = safeString(value);
  if (!text) return [];
  const tokens = [];
  let current = "";
  let quoted = false;
  for (const character of text) {
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (/\s/.test(character) && !quoted) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current);
  return tokens;
}

function stableProjectId(name, randomId) {
  const base = String(name || "project").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
  const suffix = randomId ? randomId(3) : "";
  return suffix ? `${base}-${suffix}` : base;
}

function isSupportedAbsolutePath(value) {
  return path.isAbsolute(value) || /^[a-z]:\\/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}

function normalizePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function safeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function errorResponse(code, message, extra = {}) {
  return { ok: false, code, category: "project-adoption", message, actionExecuted: false, ...extra };
}

function defaultAdoptionWriterUnavailable() {
  return { ok: false, code: "PROJECT_ADOPTION_WRITE_UNAVAILABLE", message: "Project adoption writer is unavailable." };
}

function createDefaultAdoptionWriter(options = {}) {
  const configRoot = options.configOptions && options.configOptions.root || path.join(__dirname, "..", "..");
  const projectsPath = options.projectsPath || path.join(configRoot, "config", "projects.json");
  return async function writeAdoptedProject({ project }) {
    const directory = path.dirname(projectsPath);
    const temporaryPath = `${projectsPath}.${process.pid}.${Date.now()}.tmp`;
    let source = { version: 1, projects: [] };
    try {
      if (fs.existsSync(projectsPath)) {
        source = JSON.parse(fs.readFileSync(projectsPath, "utf8"));
      }
      if (!source || !Array.isArray(source.projects)) {
        return { ok: false, code: "PROJECT_ADOPTION_CONFIG_INVALID", message: "The project registry file is not a valid project configuration." };
      }
      fs.mkdirSync(directory, { recursive: true });
      const next = {
        ...source,
        version: source.version || 1,
        projects: [...source.projects, project]
      };
      fs.writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      fs.renameSync(temporaryPath, projectsPath);
      return { ok: true, path: projectsPath };
    } catch {
      try { if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath); } catch { /* best-effort cleanup */ }
      return { ok: false, code: "PROJECT_ADOPTION_WRITE_FAILED", message: "Project adoption could not be saved safely." };
    }
  };
}

module.exports = {
  MIN_ADOPTION_CONFIDENCE,
  buildAdoptionDraft,
  createDefaultAdoptionWriter,
  createAdoptionManager,
  extractAdoptionCandidate,
  validateAdoptionCandidate
};
