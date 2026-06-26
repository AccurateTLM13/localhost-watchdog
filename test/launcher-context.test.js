"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { classifyReadOnly } = require("../src/classifier/confidence");
const { redactPathText } = require("../src/privacy/redact");
const { detectLauncherContext, matchLauncher } = require("../src/process/launcher");

const CONFIG = {
  safety: {
    devRoots: [],
    protectedProcesses: [],
    protectedPorts: [],
    protectedPortRanges: [],
    devRuntimes: ["node.exe", "python.exe", "java.exe"],
    commonDevPorts: [3000, 5173, 8000, 8080]
  },
  projects: {
    projects: []
  }
};

function parent(processName, commandLine = processName, pid = 10, executablePath = `C:\\Tools\\${processName}`) {
  return {
    pid,
    parentPid: 1,
    processName,
    commandLine,
    executablePath,
    creationTime: null
  };
}

function record(processName = "node.exe", commandLine = "node server.js", parentPid = 10) {
  return {
    id: "session-unstable-test-pid-20-listener-tcp-127-0-0-1-3000",
    pid: 20,
    parentPid,
    port: 3000,
    host: "127.0.0.1",
    protocol: "tcp",
    url: "http://localhost:3000",
    processName,
    commandLine,
    executablePath: `C:\\Runtimes\\${processName}`,
    project: null
  };
}

test("detects VS Code-launched Node dev server", () => {
  const launcher = detectLauncherContext(record(), parent("Code.exe", "Code.exe --folder-uri C:\\Users\\JP\\code\\app"));

  assert.equal(launcher.parentProcessName, "Code.exe");
  assert.equal(launcher.parentCategory, "editor");
  assert.equal(launcher.launcherName, "VS Code");
  assert.equal(launcher.confidenceImpact > 0, true);
});

test("detects Cursor-launched Node dev server", () => {
  const launcher = detectLauncherContext(record(), parent("Cursor.exe", "Cursor.exe C:\\Users\\JP\\code\\app"));

  assert.equal(launcher.parentCategory, "editor");
  assert.equal(launcher.launcherName, "Cursor");
});

test("detects PowerShell-launched npm server", () => {
  const launcher = detectLauncherContext(record("node.exe", "node vite.js"), parent("powershell.exe", "powershell.exe -NoProfile npm run dev"));

  assert.equal(launcher.parentCategory, "terminal");
  assert.equal(launcher.launcherName, "PowerShell");
});

test("detects Windows Terminal-launched process", () => {
  const launcher = detectLauncherContext(record("node.exe"), parent("WindowsTerminal.exe", "WindowsTerminal.exe"));

  assert.equal(launcher.parentCategory, "terminal");
  assert.equal(launcher.launcherName, "Windows Terminal");
});

test("detects Python server launched from terminal", () => {
  const launcher = detectLauncherContext(record("python.exe", "python -m http.server", 11), parent("pwsh.exe", "pwsh.exe python -m http.server", 11));

  assert.equal(launcher.parentCategory, "terminal");
  assert.equal(launcher.launcherName, "PowerShell");
});

test("detects Java server launched from Gradle or Maven style command", () => {
  const gradle = detectLauncherContext(record("java.exe", "java -jar app.jar"), parent("java.exe", "java org.gradle.launcher.GradleMain bootRun"));
  const maven = detectLauncherContext(record("java.exe", "java -jar app.jar"), parent("java.exe", "java org.codehaus.plexus MavenCli spring-boot:run"));

  assert.equal(gradle.launcherName, "Gradle Java");
  assert.equal(maven.launcherName, "Maven Java");
});

test("detects package manager, Git Bash, node, python, java, and Docker launcher rules", () => {
  assert.equal(matchLauncher("npm.cmd", "npm run dev", null).name, "npm");
  assert.equal(matchLauncher("npx.cmd", "npx vite", null).name, "npx");
  assert.equal(matchLauncher("pnpm.cmd", "pnpm dev", null).name, "pnpm");
  assert.equal(matchLauncher("yarn.cmd", "yarn dev", null).name, "yarn");
  assert.equal(matchLauncher("bash.exe", "C:\\Program Files\\Git\\bin\\bash.exe", null).name, "Git Bash");
  assert.equal(matchLauncher("node.exe", "node server.js", null).name, "node");
  assert.equal(matchLauncher("python.exe", "python -m uvicorn app:app", null).name, "python");
  assert.equal(matchLauncher("java.exe", "java -jar app.jar", null).name, "java");
  assert.equal(matchLauncher("docker.exe", "docker compose up api", null).name, "docker compose");
});

test("handles missing or inaccessible parent process metadata", () => {
  const launcher = detectLauncherContext(record("node.exe", "node vite.js", 404), null);

  assert.equal(launcher.parentPid, 404);
  assert.equal(launcher.parentCategory, "missing");
  assert.equal(launcher.launcherName, "Parent process unknown");
  assert.equal(launcher.confidenceImpact, 0);
});

test("parent process outside dev root does not enable action flags", () => {
  const base = record("node.exe", "node server.js");
  const launcher = detectLauncherContext(base, parent("powershell.exe", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe node server.js"));
  const classified = classifyReadOnly({ ...base, launcher }, { config: CONFIG });

  assert.equal(classified.project, null);
  assert.equal(classified.safeToStop, false);
  assert.equal(classified.safeToRestart, false);
  assert.equal(classified.bulkStoppable, false);
  assert.equal(classified.evidence.some((item) => item.type === "launcher"), true);
});

test("redacts parent command line secrets and user-profile path text", () => {
  const home = process.env.USERPROFILE || process.env.HOME || "C:\\Users\\JP";
  const launcher = detectLauncherContext(
    record(),
    parent("powershell.exe", `powershell.exe ${home}\\code\\app --token raw-secret --password hunter2`)
  );

  assert.equal(launcher.parentCommandLine.includes("raw-secret"), false);
  assert.equal(launcher.parentCommandLine.includes("hunter2"), false);
  assert.match(launcher.parentCommandLine, /\[REDACTED\]/);
  assert.equal(redactPathText(`${home}\\code\\app`).includes(home), false);
});
