"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { classifyReadOnly } = require("../src/classifier/confidence");
const { buildProcessTree } = require("../src/process/tree");

const CONFIG = {
  safety: {
    devRoots: [],
    protectedProcesses: ["system", "services.exe"],
    protectedPorts: [],
    protectedPortRanges: [],
    devRuntimes: ["node.exe", "python.exe", "java.exe"],
    commonDevPorts: [3000, 5173, 8000, 8080]
  },
  projects: {
    projects: []
  }
};

function process(pid, parentPid, processName, commandLine = processName, executablePath = `C:\\Tools\\${processName}`) {
  return {
    pid,
    parentPid,
    processName,
    commandLine,
    executablePath,
    creationTime: null
  };
}

function record(pid, parentPid, processName, commandLine, port = 3000) {
  return {
    id: `session-unstable-test-pid-${pid}-listener-tcp-127-0-0-1-${port}`,
    pid,
    parentPid,
    port,
    host: "127.0.0.1",
    protocol: "tcp",
    url: `http://localhost:${port}`,
    processName,
    commandLine,
    executablePath: `C:\\Runtimes\\${processName}`,
    project: null
  };
}

function labels(tree) {
  return tree.chain.map((item) => item.launcherName || item.processName);
}

test("builds VS Code -> PowerShell -> npm -> node ancestry", () => {
  const server = record(4, 3, "node.exe", "node vite.js --token raw-secret");
  const processes = new Map([
    [1, process(1, 0, "Code.exe", "Code.exe C:\\Users\\JP\\code\\app")],
    [2, process(2, 1, "powershell.exe", "powershell.exe npm run dev")],
    [3, process(3, 2, "npm.cmd", "npm run dev --password hunter2")]
  ]);
  const tree = buildProcessTree(server, processes, { safetyConfig: CONFIG.safety });

  assert.deepEqual(labels(tree), ["VS Code", "PowerShell", "npm", "node"]);
  assert.equal(tree.depth, 4);
  assert.equal(tree.truncated, false);
  assert.match(tree.evidence[0].message, /VS Code -> shell -> package manager -> node/);
  assert.equal(JSON.stringify(tree).includes("hunter2"), false);
  assert.equal(JSON.stringify(tree).includes("raw-secret"), false);
});

test("builds Cursor -> terminal -> pnpm -> vite ancestry", () => {
  const server = record(14, 13, "node.exe", "node vite.js", 5173);
  const processes = new Map([
    [11, process(11, 0, "Cursor.exe", "Cursor.exe C:\\Users\\JP\\code\\vite-app")],
    [12, process(12, 11, "pwsh.exe", "pwsh.exe pnpm dev")],
    [13, process(13, 12, "pnpm.cmd", "pnpm dev")]
  ]);
  const tree = buildProcessTree(server, processes, { safetyConfig: CONFIG.safety });

  assert.deepEqual(labels(tree), ["Cursor", "PowerShell", "pnpm", "node"]);
  assert.match(tree.evidence[0].message, /Cursor -> shell -> package manager -> node\/vite/);
});

test("builds Windows Terminal -> PowerShell -> python ancestry", () => {
  const server = record(24, 23, "python.exe", "python -m uvicorn app:app", 8000);
  const processes = new Map([
    [22, process(22, 0, "WindowsTerminal.exe", "WindowsTerminal.exe")],
    [23, process(23, 22, "powershell.exe", "powershell.exe python -m uvicorn app:app")]
  ]);
  const tree = buildProcessTree(server, processes, { safetyConfig: CONFIG.safety });

  assert.deepEqual(labels(tree), ["Windows Terminal", "PowerShell", "python"]);
  assert.match(tree.evidence[0].message, /Windows Terminal -> PowerShell -> python/);
});

test("builds cmd -> npm -> node ancestry", () => {
  const server = record(34, 33, "node.exe", "node server.js");
  const processes = new Map([
    [32, process(32, 0, "cmd.exe", "cmd.exe /d /s /c npm run dev")],
    [33, process(33, 32, "npm.cmd", "npm run dev")]
  ]);
  const tree = buildProcessTree(server, processes, { safetyConfig: CONFIG.safety });

  assert.deepEqual(labels(tree), ["Command Prompt", "npm", "node"]);
  assert.match(tree.evidence[0].message, /Command Prompt -> npm -> node/);
});

test("builds Gradle and Maven -> java ancestry", () => {
  const gradleServer = record(44, 43, "java.exe", "java -jar app.jar", 8080);
  const mavenServer = record(54, 53, "java.exe", "java -jar app.jar", 8080);

  const gradle = buildProcessTree(gradleServer, new Map([
    [43, process(43, 0, "java.exe", "java org.gradle.launcher.GradleMain bootRun")]
  ]), { safetyConfig: CONFIG.safety });
  const maven = buildProcessTree(mavenServer, new Map([
    [53, process(53, 0, "java.exe", "java org.codehaus.plexus MavenCli spring-boot:run")]
  ]), { safetyConfig: CONFIG.safety });

  assert.deepEqual(labels(gradle), ["Gradle Java", "java"]);
  assert.deepEqual(labels(maven), ["Maven Java", "java"]);
  assert.match(gradle.evidence[0].message, /Gradle\/Maven -> java/);
  assert.match(maven.evidence[0].message, /Gradle\/Maven -> java/);
});

test("handles missing parent metadata", () => {
  const tree = buildProcessTree(record(64, 63, "node.exe", "node server.js"), new Map(), { safetyConfig: CONFIG.safety });

  assert.deepEqual(labels(tree), ["node"]);
  assert.equal(tree.truncated, false);
  assert.equal(tree.stopReason, "missing-parent-metadata");
  assert.match(tree.evidence.at(-1).message, /parent metadata is unavailable/);
});

test("detects process-tree cycles", () => {
  const tree = buildProcessTree(record(74, 73, "node.exe", "node server.js"), new Map([
    [72, process(72, 73, "powershell.exe", "powershell.exe npm run dev")],
    [73, process(73, 72, "npm.cmd", "npm run dev")]
  ]), { safetyConfig: CONFIG.safety });

  assert.equal(tree.truncated, true);
  assert.equal(tree.stopReason, "cycle");
});

test("truncates at max depth", () => {
  const tree = buildProcessTree(record(85, 84, "node.exe", "node server.js"), new Map([
    [81, process(81, 0, "Code.exe", "Code.exe")],
    [82, process(82, 81, "powershell.exe", "powershell.exe")],
    [83, process(83, 82, "cmd.exe", "cmd.exe")],
    [84, process(84, 83, "npm.cmd", "npm run dev")]
  ]), { safetyConfig: CONFIG.safety, maxDepth: 3 });

  assert.deepEqual(labels(tree), ["Command Prompt", "npm", "node"]);
  assert.equal(tree.depth, 3);
  assert.equal(tree.truncated, true);
  assert.equal(tree.stopReason, "max-depth");
});

test("stops at protected system boundary", () => {
  const tree = buildProcessTree(record(94, 93, "node.exe", "node server.js"), new Map([
    [93, process(93, 1, "services.exe", "services.exe")]
  ]), { safetyConfig: CONFIG.safety });

  assert.equal(tree.chain[0].category, "system-or-protected");
  assert.equal(tree.stopReason, "protected-boundary");
});

test("process-tree evidence does not enable action flags", () => {
  const server = record(104, 103, "node.exe", "node server.js");
  const processTree = buildProcessTree(server, new Map([
    [101, process(101, 0, "Code.exe", "Code.exe")],
    [102, process(102, 101, "powershell.exe", "powershell.exe npm run dev")],
    [103, process(103, 102, "npm.cmd", "npm run dev")]
  ]), { safetyConfig: CONFIG.safety });
  const classified = classifyReadOnly({ ...server, processTree }, { config: CONFIG });

  assert.equal(classified.safeToStop, false);
  assert.equal(classified.safeToRestart, false);
  assert.equal(classified.bulkStoppable, false);
  assert.equal(classified.evidence.some((item) => item.type === "process-tree"), true);
});
