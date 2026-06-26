# 06 — Testing Strategy

## Testing Philosophy

This project is only useful if it is safe. A flashy UI with reckless kill behavior is worse than no tool.

Prioritize tests in this order:

```txt
Safety tests → Parser tests → Action tests → UI tests → Tray tests
```

## Test Layers

### 1. Fixture Tests

Use captured command output fixtures instead of relying only on live system state.

Fixtures to create:

```txt
test/fixtures/windows/get-nettcpconnection.sample.txt
test/fixtures/windows/get-ciminstance.sample.json
test/fixtures/windows/netstat.sample.txt
test/fixtures/processes/protected.json
test/fixtures/processes/dev-node.json
test/fixtures/processes/dev-python.json
test/fixtures/processes/unknown.json
```

Purpose:

- Parser remains stable.
- Tests run on machines without active dev servers.
- Agent can refactor without breaking detection.

### 2. Unit Tests

Target modules:

```txt
scanner/normalize
classifier/confidence
classifier/categories
classifier/safety
actions/free-port
actions/dry-run
registry/projects
```

Must-have unit tests:

- Protected process always returns `safeToStop: false`.
- Unknown process returns no destructive actions.
- Dev runtime alone is not enough to stop.
- Dev folder + dev command + localhost port gets high confidence.
- Database category is not bulk-stoppable by default.
- Local AI category is not bulk-stoppable by default.
- Restart requires managed project data.

### 3. Integration Tests

Spawn known test servers during tests.

Node fixture server:

```js
const http = require('http');
const server = http.createServer((req, res) => res.end('watchdog fixture'));
server.listen(process.env.PORT || 0, '127.0.0.1');
```

Python fixture server:

```bash
python -m http.server 0 --bind 127.0.0.1
```

Integration test sequence:

1. Start fixture server.
2. Scan.
3. Verify server is detected.
4. Verify confidence score.
5. Dry-run stop.
6. Stop exact PID.
7. Wait for port to free.
8. Verify history record.

### 4. Destructive Action Tests

Every destructive action should have:

- positive test
- negative protected-process test
- dry-run test
- changed-PID abort test
- already-stopped test
- permission denied test

Changed-PID abort matters because a port may be reused between scan and action.

### 5. UI Tests

Use fake API data first.

Test cases:

- Running server card renders.
- Protected summary renders.
- Stop button only appears when `safeToStop` is true.
- Restart button only appears when `safeToRestart` is true.
- Unknown process has inspect/adopt only.
- Bulk stop button shows preview.
- Failed stop shows clear error.

### 6. Manual Windows QA

Run these scenarios manually before each release:

#### Scenario A — Node dev server

```bash
npm run dev
```

Expected:

- Detected.
- Categorized as dev server.
- Open button works.
- Stop button appears if confidence high.

#### Scenario B — Vite dev server

```bash
npm create vite@latest temp-watchdog-test
cd temp-watchdog-test
npm install
npm run dev
```

Expected:

- Port 5173 detected.
- Runtime/framework detected.
- Stop works.

#### Scenario C — Python server

```bash
python -m http.server 8000
```

Expected:

- Detected.
- Categorized as dev server or static server.
- Stop works only if confidence high.

#### Scenario D — Protected system process

Do not actually kill. Verify it is hidden or read-only.

Expected:

- No stop button.
- Hidden summary count increases.

#### Scenario E — Browser process

Open Chrome/Edge.

Expected:

- Browser is not offered as stoppable.

#### Scenario F — Local AI server

Run Ollama or LocAIly companion if available.

Expected:

- Visible as local AI/companion.
- Not included in “Stop All Safe Dev Servers” by default.

#### Scenario G — Database

Run Postgres/Redis/Supabase if available.

Expected:

- Categorized as database.
- Not bulk-stoppable by default.

## Golden Test Matrix

| Case | Visible | Stop | Restart | Bulk Stop |
|---|---:|---:|---:|---:|
| Managed Vite | yes | yes | yes | yes |
| Unmanaged Vite high confidence | yes | yes | no | yes |
| Unknown listener | maybe | no | no | no |
| Browser | no/read-only | no | no | no |
| Windows service | no | no | no | no |
| Database | yes | opt-in | managed only | no |
| Local AI server | yes | confirm | managed only | no |
| Docker Desktop core | no/read-only | no | no | no |

## CI Requirements

Initial CI can run:

```bash
npm test
npm run lint
npm run typecheck
```

Do not require live port scans in CI. Live scans are local/manual until the scanner can be mocked reliably.

## Regression Rule

Every bug involving unsafe stop, wrong process classification, or restart failure must add a fixture and a regression test.

## Agent Completion Report Format

After each phase, the agent should report:

```txt
## Summary
What changed.

## Files Changed
List files.

## Safety Impact
What destructive behavior changed, if any.

## Tests Run
Commands and results.

## Manual QA
What was manually verified.

## Risks
Known issues.

## Next Step
Recommended next task.
```
