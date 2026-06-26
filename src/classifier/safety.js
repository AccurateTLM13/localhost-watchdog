"use strict";

const DEFAULT_PROTECTED_PROCESS_NAMES = [
  "system",
  "idle",
  "registry",
  "svchost.exe",
  "csrss.exe",
  "wininit.exe",
  "winlogon.exe",
  "services.exe",
  "lsass.exe",
  "explorer.exe",
  "dwm.exe",
  "searchindexer.exe",
  "msmpeng.exe",
  "securityhealthservice.exe",
  "onedrive.exe",
  "dropbox.exe"
];

const BROWSER_NAMES = [
  "chrome.exe",
  "msedge.exe",
  "firefox.exe",
  "brave.exe",
  "opera.exe"
];

const EDITOR_NAMES = [
  "code.exe",
  "cursor.exe",
  "windsurf.exe",
  "antigravity.exe",
  "idea64.exe",
  "webstorm64.exe",
  "devenv.exe"
];

const DRIVER_PREFIXES = [
  "nvidia",
  "amd",
  "intel",
  "audio"
];

const DATABASE_NAMES = [
  "postgres",
  "postgres.exe",
  "mysql",
  "mysqld",
  "mongod",
  "redis-server",
  "redis-server.exe",
  "supabase"
];

const LOCAL_AI_NAMES = [
  "ollama",
  "ollama.exe",
  "lm studio",
  "lmstudio",
  "lmstudio.exe",
  "locailly",
  "companion"
];

const NODE_DEV_KEYWORDS = [
  "npm run dev",
  "pnpm dev",
  "yarn dev",
  "bun dev",
  "next dev",
  "next\\dist\\server",
  "vite",
  "astro dev",
  "astro",
  "remix dev",
  "nuxt dev",
  "svelte-kit"
];

const PYTHON_DEV_KEYWORDS = [
  "python -m http.server",
  "uvicorn",
  "fastapi",
  "flask run",
  "flask",
  "manage.py runserver"
];

const JAVA_DEV_KEYWORDS = [
  "spring-boot",
  "spring",
  "springframework",
  "bootrun",
  "gradle",
  "maven",
  "tomcat",
  "jetty"
];

const LOCAL_AI_KEYWORDS = [
  "ollama serve",
  "lm studio",
  "lmstudio",
  "locailly",
  "companion"
];

const NODE_RUNTIMES = [
  "node.exe",
  "npm.cmd",
  "pnpm.cmd",
  "yarn.cmd",
  "bun.exe",
  "deno.exe"
];

const PYTHON_RUNTIMES = [
  "python.exe",
  "python3.exe",
  "py.exe",
  "uvicorn.exe",
  "flask.exe",
  "django-admin.exe"
];

const JAVA_RUNTIMES = [
  "java.exe",
  "javaw.exe"
];

function isProtectedProcess(processName, config = {}) {
  const name = normalizeName(processName);
  if (!name) return false;

  const configured = (config.protectedProcesses || DEFAULT_PROTECTED_PROCESS_NAMES).map((value) => String(value).toLowerCase());
  return configured.some((pattern) => wildcardMatches(name, pattern)) || DRIVER_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function isProtectedPort(port, config = {}) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort)) return false;

  if ((config.protectedPorts || []).includes(numericPort)) return true;
  return (config.protectedPortRanges || []).some((range) => numericPort >= range.from && numericPort <= range.to);
}

function protectedPortReason(port, config = {}) {
  const numericPort = Number(port);
  if ((config.protectedPorts || []).includes(numericPort)) return "configured protected port";
  const range = (config.protectedPortRanges || []).find((item) => numericPort >= item.from && numericPort <= item.to);
  return range ? range.reason : null;
}

function isLocalBind(host) {
  return host === "127.0.0.1" || host === "::1" || String(host || "").toLowerCase() === "localhost";
}

function isWildcardBind(host) {
  return host === "0.0.0.0" || host === "::";
}

function matchesAnyProcessName(processName, names) {
  const name = normalizeName(processName);
  return names.some((candidate) => name === candidate);
}

function textIncludesAny(record, keywords) {
  const haystack = normalizeText(`${record.processName || ""} ${record.commandLine || ""} ${record.executablePath || ""}`);
  return keywords.some((keyword) => haystack.includes(keyword));
}

function isRuntime(record, runtimes, config = {}) {
  const processName = normalizeName(record.processName);
  const configured = (config.devRuntimes || []).map((name) => String(name).toLowerCase());
  return runtimes.includes(processName) && configured.includes(processName);
}

function isCommonDevPort(port, config = {}) {
  return (config.commonDevPorts || []).includes(Number(port));
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeText(value) {
  return String(value || "").replace(/\//g, "\\").toLowerCase();
}

function wildcardMatches(value, pattern) {
  const escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

module.exports = {
  BROWSER_NAMES,
  DATABASE_NAMES,
  DEFAULT_PROTECTED_PROCESS_NAMES,
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
  normalizeText,
  protectedPortReason,
  textIncludesAny,
  wildcardMatches
};
