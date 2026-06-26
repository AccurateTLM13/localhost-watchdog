"use strict";

const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { classifyReadOnly } = require("../src/classifier/confidence");
const { normalizeConfig } = require("../src/config/load");
const { detectProjectOwnership, inferPathCandidates, redactPath } = require("../src/project/ownership");

function makeWorkspace() {
  const root = mkdtempSync(path.join(tmpdir(), "watchdog-projects-"));
  return {
    root,
    config: normalizeConfig({
      safety: {
        version: 1,
        devRoots: [root],
        protectedProcesses: ["System"],
        protectedPorts: [],
        protectedPortRanges: [],
        devRuntimes: ["node.exe", "python.exe", "flask.exe", "java.exe"],
        commonDevPorts: [3000, 5000, 5173, 8000, 8080]
      },
      projects: {
        version: 1,
        projects: []
      }
    })
  };
}

function writeProjectFile(root, relativePath, content = "") {
  const fullPath = path.join(root, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  return fullPath;
}

function recordFor(projectRoot, processName = "node.exe", port = 3000) {
  const file = path.join(projectRoot, "src", "server.js");
  return {
    id: `session-unstable-test-pid-1-listener-tcp-127-0-0-1-${port}`,
    pid: 1,
    port,
    host: "127.0.0.1",
    url: `http://localhost:${port}`,
    processName,
    commandLine: `${processName} "${file}"`,
    executablePath: `C:\\tools\\${processName}`
  };
}

test("detects Node project name from package.json", () => {
  const workspace = makeWorkspace();
  const projectRoot = path.join(workspace.root, "node-app");
  writeProjectFile(projectRoot, "package.json", JSON.stringify({ name: "node-owned-app" }));

  const project = detectProjectOwnership(recordFor(projectRoot), workspace.config);
  assert.equal(project.name, "node-owned-app");
  assert.equal(project.source, "marker:package.json");
  assert.equal(project.confidence, 85);
  assert.match(project.root, /node-app$/);
});

test("detects Next, Vite, and Astro config markers", () => {
  const markerCases = [
    ["next-app", "next.config.js", "marker:next.config.js"],
    ["vite-app", "vite.config.ts", "marker:vite.config.ts"],
    ["astro-app", "astro.config.mjs", "marker:astro.config.mjs"]
  ];

  for (const [folder, marker, source] of markerCases) {
    const workspace = makeWorkspace();
    const projectRoot = path.join(workspace.root, folder);
    writeProjectFile(projectRoot, marker, "export default {}");
    const project = detectProjectOwnership(recordFor(projectRoot), workspace.config);
    assert.equal(project.name, folder);
    assert.equal(project.source, source);
    assert.equal(project.confidence, 80);
  }
});

test("detects Python and Django project markers", () => {
  const markerCases = [
    ["fastapi-app", "pyproject.toml", "marker:pyproject.toml"],
    ["flask-app", "requirements.txt", "marker:requirements.txt"],
    ["django-app", "manage.py", "marker:manage.py"]
  ];

  for (const [folder, marker, source] of markerCases) {
    const workspace = makeWorkspace();
    const projectRoot = path.join(workspace.root, folder);
    writeProjectFile(projectRoot, marker, "");
    const project = detectProjectOwnership(recordFor(projectRoot, "python.exe", 8000), workspace.config);
    assert.equal(project.name, folder);
    assert.equal(project.source, source);
    assert.equal(project.confidence, 75);
  }
});

test("detects Java Maven and Gradle project markers", () => {
  const markerCases = [
    ["maven-app", "pom.xml", "marker:pom.xml"],
    ["gradle-app", "build.gradle", "marker:build.gradle"]
  ];

  for (const [folder, marker, source] of markerCases) {
    const workspace = makeWorkspace();
    const projectRoot = path.join(workspace.root, folder);
    writeProjectFile(projectRoot, marker, "");
    const project = detectProjectOwnership(recordFor(projectRoot, "java.exe", 8080), workspace.config);
    assert.equal(project.name, folder);
    assert.equal(project.source, source);
    assert.equal(project.confidence, 75);
  }
});

test("infers low-confidence ownership for unknown process inside dev root", () => {
  const workspace = makeWorkspace();
  const projectRoot = path.join(workspace.root, "unknown-tool");
  mkdirSync(path.join(projectRoot, "bin"), { recursive: true });
  const record = recordFor(projectRoot, "custom.exe", 45678);

  const project = detectProjectOwnership(record, workspace.config);
  assert.equal(project.name, "unknown-tool");
  assert.equal(project.source, "dev-root-path");
  assert.equal(project.confidence, 35);

  const classified = classifyReadOnly({ ...record, project }, { config: workspace.config });
  assert.equal(classified.safeToStop, false);
  assert.equal(classified.safeToRestart, false);
  assert.equal(classified.bulkStoppable, false);
  assert.equal(classified.evidence.some((item) => item.type === "project-ownership"), true);
});

test("does not infer ownership for known runtime outside configured dev roots", () => {
  const workspace = makeWorkspace();
  const outsideRoot = mkdtempSync(path.join(tmpdir(), "outside-watchdog-"));
  writeProjectFile(outsideRoot, "package.json", JSON.stringify({ name: "outside-app" }));

  const project = detectProjectOwnership(recordFor(outsideRoot, "node.exe", 3000), workspace.config);
  assert.equal(project, null);
});

test("handles missing or inaccessible working directory without throwing", () => {
  const workspace = makeWorkspace();
  const record = {
    id: "session-unstable-test-pid-2-listener-tcp-127-0-0-1-3000",
    pid: 2,
    port: 3000,
    host: "127.0.0.1",
    url: "http://localhost:3000",
    processName: "node.exe",
    commandLine: "node C:\\definitely-missing-watchdog\\server.js",
    executablePath: "C:\\tools\\node.exe"
  };

  assert.equal(detectProjectOwnership(record, workspace.config), null);
});

test("extracts path candidates and redacts user-profile paths", () => {
  const candidates = inferPathCandidates({
    commandLine: "node \"C:\\Users\\JP\\code\\app\\server.js\" --token [REDACTED]"
  });
  assert.equal(candidates[0], "C:\\Users\\JP\\code\\app\\server.js");

  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) {
    assert.equal(redactPath(path.join(home, "code", "app")), `%USERPROFILE%${path.sep}code${path.sep}app`);
  }
});
