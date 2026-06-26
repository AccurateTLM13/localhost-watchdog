"use strict";

const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { classifyReadOnly } = require("../src/classifier/confidence");
const { normalizeConfig } = require("../src/config/load");
const { detectProjectOwnership } = require("../src/project/ownership");
const { renderDevRoots } = require("../src/ui/render");

function makeRoot(name) {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "watchdog-roots-")), name);
  mkdirSync(root, { recursive: true });
  return root;
}

function configWithRoots(roots, projects = []) {
  return normalizeConfig({
    safety: {
      version: 1,
      devRoots: [],
      protectedProcesses: ["System"],
      protectedPorts: [],
      protectedPortRanges: [],
      devRuntimes: ["node.exe"],
      commonDevPorts: [3000, 5173]
    },
    devRoots: {
      version: 1,
      devRoots: roots
    },
    projects: {
      version: 1,
      projects
    }
  });
}

function recordFor(projectRoot, port = 3000) {
  return {
    id: `session-unstable-test-pid-10-listener-tcp-127-0-0-1-${port}`,
    pid: 10,
    port,
    host: "127.0.0.1",
    url: `http://localhost:${port}`,
    processName: "node.exe",
    commandLine: `node "${path.join(projectRoot, "src", "server.js")}"`,
    executablePath: "C:\\tools\\node.exe"
  };
}

test("configured dev root match enables marker search within that root", () => {
  const devRoot = makeRoot("dev");
  const projectRoot = path.join(devRoot, "app");
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ name: "configured-root-app" }));

  const config = configWithRoots([devRoot]);
  const project = detectProjectOwnership(recordFor(projectRoot), config);

  assert.equal(project.name, "configured-root-app");
  assert.equal(project.source, "marker:package.json");
});

test("multiple configured dev roots are normalized and searched independently", () => {
  const firstRoot = makeRoot("first");
  const secondRoot = makeRoot("second");
  const projectRoot = path.join(secondRoot, "api");
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(path.join(projectRoot, "vite.config.ts"), "");

  const config = configWithRoots([firstRoot, secondRoot]);
  const project = detectProjectOwnership(recordFor(projectRoot, 5173), config);

  assert.equal(config.devRoots.devRoots.length, 2);
  assert.equal(project.name, "api");
  assert.equal(project.source, "marker:vite.config.ts");
});

test("nested project root detection stops at nearest marker under configured root", () => {
  const devRoot = makeRoot("dev");
  const parentRoot = path.join(devRoot, "monorepo");
  const nestedRoot = path.join(parentRoot, "packages", "web");
  mkdirSync(nestedRoot, { recursive: true });
  writeFileSync(path.join(parentRoot, "package.json"), JSON.stringify({ name: "parent" }));
  writeFileSync(path.join(nestedRoot, "package.json"), JSON.stringify({ name: "nested-web" }));

  const config = configWithRoots([devRoot]);
  const project = detectProjectOwnership(recordFor(nestedRoot), config);

  assert.equal(project.name, "nested-web");
  assert.match(project.root, /packages\\web$/);
});

test("configured dev roots are redacted for API and UI display", () => {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return;

  const devRoot = path.join(home, "watchdog-test-dev-root");
  mkdirSync(devRoot, { recursive: true });
  const config = configWithRoots([devRoot]);
  const html = renderDevRoots(config.safety.devRootsDisplay);

  assert.equal(config.safety.devRootsDisplay[0], `%USERPROFILE%\\watchdog-test-dev-root`);
  assert.match(html, /%USERPROFILE%\\watchdog-test-dev-root/);
});

test("missing and invalid dev roots are ignored as search boundaries", () => {
  const validRoot = makeRoot("valid");
  const missingRoot = path.join(tmpdir(), "missing-watchdog-root-does-not-exist");
  const config = configWithRoots([validRoot, missingRoot, "", "not-a-path", null]);

  assert.equal(config.devRoots.devRoots.length, 1);
  assert.equal(config.safety.devRoots.length, 1);
});

test("process outside configured dev roots is ignored", () => {
  const devRoot = makeRoot("dev");
  const outsideRoot = makeRoot("outside");
  writeFileSync(path.join(outsideRoot, "package.json"), JSON.stringify({ name: "outside" }));

  const config = configWithRoots([devRoot]);
  assert.equal(detectProjectOwnership(recordFor(outsideRoot), config), null);
});

test("explicit configured project outside dev roots is still allowed", () => {
  const devRoot = makeRoot("dev");
  const outsideRoot = makeRoot("explicit-project");
  writeFileSync(path.join(outsideRoot, "package.json"), JSON.stringify({ name: "explicit" }));
  const config = configWithRoots([devRoot], [{ id: "explicit", name: "Explicit Project", path: outsideRoot }]);

  const project = detectProjectOwnership(recordFor(outsideRoot), config);
  const classified = classifyReadOnly(recordFor(outsideRoot), { config });
  assert.equal(project.name, "Explicit Project");
  assert.equal(project.source, "config-project");
  assert.equal(classified.project.name, "Explicit Project");
  assert.equal(JSON.stringify(classified.project).includes(process.env.USERPROFILE || "NO_USERPROFILE"), false);
});

test("ownership from configured dev roots does not enable action flags", () => {
  const devRoot = makeRoot("dev");
  const projectRoot = path.join(devRoot, "safe-readonly");
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ name: "safe-readonly" }));
  const config = configWithRoots([devRoot]);
  const record = recordFor(projectRoot);
  const project = detectProjectOwnership(record, config);
  const classified = classifyReadOnly({ ...record, project }, { config });

  assert.equal(Boolean(project), true);
  assert.equal(project.confidence > 0, true);
  assert.equal(classified.safeToStop, false);
  assert.equal(classified.safeToRestart, false);
  assert.equal(classified.bulkStoppable, false);
});
