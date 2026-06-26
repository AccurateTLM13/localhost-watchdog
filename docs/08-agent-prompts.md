# 08 — Agent Prompts

## Prompt 1 — Repo Setup

```txt
Set up the Localhost Watchdog project foundation.

Requirements:
- Use Node.js for the first implementation.
- Use plain HTML/CSS/JS for the dashboard.
- Do not use React yet.
- Create src/, test/, config/, and docs/ folders.
- Add scripts for test, lint, and start.
- Add example config files for projects and safety settings.
- Do not implement destructive process actions yet.

Deliverables:
- package.json
- README.md
- config/projects.example.json
- config/safety.example.json
- basic health endpoint or CLI placeholder
- docs/progress.md with what was created

After finishing, report files changed and tests run.
```

## Prompt 2 — Windows Scanner

```txt
Implement the Windows scanner MVP for Localhost Watchdog.

Goal:
Detect listening localhost TCP ports and normalize them into server records.

Requirements:
- Use PowerShell Get-NetTCPConnection for primary scan.
- Use Get-CimInstance Win32_Process to resolve PID metadata.
- Add netstat fallback if PowerShell parsing fails.
- Normalize output into JSON records with pid, port, host, processName, commandLine, executablePath, creationTime, uptimeMs, and url.
- Do not add stop/restart actions yet.
- Add parser fixtures and unit tests.

Safety:
- This phase is read-only.
- Do not kill, stop, restart, or modify any process.

Deliverables:
- scanner module
- fixtures for sample PowerShell/netstat outputs
- tests
- docs/progress.md update

Report exact commands used for testing.
```

## Prompt 3 — Safety Classifier

```txt
Implement the classifier and safety engine.

Goal:
Classify scanner records and decide which actions are allowed.

Requirements:
- Add protected process list.
- Add dev runtime allowlist.
- Add dev folder allowlist from config.
- Add common dev ports list.
- Add confidence scoring.
- Add category assignment: dev-server, database, local-ai, container, tunnel, test-runner, system, unknown.
- Add safeToShow, safeToStop, safeToRestart, bulkStoppable, reasons, and warnings fields.

Safety:
- Protected processes must never get safeToStop=true.
- Unknown processes must not get destructive actions.
- Dev runtime alone is not enough to stop.

Testing:
- Add unit tests for protected processes.
- Add fixture tests for Node/Vite/Python dev servers.
- Add negative tests for browsers and Windows services.

Do not build stop actions yet.
```

## Prompt 4 — Local Dashboard

```txt
Build the first Localhost Watchdog dashboard.

Goal:
Show scanner/classifier results in a local browser dashboard.

Requirements:
- Serve dashboard on localhost:4545.
- Use plain HTML/CSS/JS.
- Add /api/servers endpoint.
- Show Running Now, Managed Projects placeholder, Hidden Summary, and Recent Actions placeholder.
- Each server card should show project guess, port, URL, runtime, PID, process name, uptime, confidence, category, reasons, and allowed actions.
- Add Open and Inspect actions only.
- Do not add Stop/Restart buttons yet.

Testing:
- API test for /api/servers.
- UI smoke test with fake data.
- Manual test with a local dev server.

Update docs/progress.md.
```

## Prompt 5 — Safe Stop

```txt
Add safe stop behavior to Localhost Watchdog.

Goal:
Allow stopping only high-confidence safe dev servers.

Requirements:
- Add dry-run stop endpoint.
- Add stop endpoint.
- Re-scan immediately before stopping.
- Abort if PID or port changed.
- Stop only exact PID by default.
- Do not kill process tree.
- Do not force kill in basic stop.
- Add confirmation UI showing process name, PID, port, command, and reasons.
- Add action history.

Safety:
- Protected processes cannot be stopped.
- Low-confidence processes cannot be stopped.
- Databases and local AI servers are not bulk-stoppable by default.

Testing:
- Integration test with spawned Node fixture server.
- Integration test with spawned Python fixture server if available.
- Negative tests for protected process fixtures.
- Test changed PID/port abort.

Update docs/progress.md.
```

## Prompt 6 — Managed Projects and Start

```txt
Add managed project support.

Goal:
Let users configure known projects and start them from the dashboard.

Requirements:
- Implement config/projects.json.
- Add project registry module.
- Add API endpoints for listing and starting projects.
- Project fields: id, name, path, startCommand, preferredPort, portStrategy, runtime, env, tags.
- Start command must run from the project path.
- Detect if preferred port is already occupied.
- Support next-available port strategy.
- Prevent duplicate starts for the same project when already running.

Testing:
- Config validation tests.
- Fixture project start test.
- Preferred port conflict test.
- Duplicate start prevention test.

Do not build tray app yet.
```

## Prompt 7 — Restart Managed Server

```txt
Add restart support for managed servers.

Goal:
Restart only managed/adopted servers safely.

Requirements:
- Add dry-run restart endpoint.
- Add restart endpoint.
- Restart flow: dry-run → stop exact PID → wait for port free → run start command → probe health → update history.
- Restart only when project config includes startCommand and path.
- Show clear error if working directory is missing or stop fails.

Testing:
- Integration test with fixture project.
- Test stop failure aborts restart.
- Test health probe timeout.
- Test restart history.

Update docs/progress.md.
```

## Prompt 8 — Adopt Detected Server

```txt
Add Adopt as Managed Project.

Goal:
Allow a safely detected external server to become managed.

Requirements:
- Add Adopt button only when confidence >= 70 and process is not protected.
- Pre-fill project name, path, command, runtime, and port from detected metadata.
- User must confirm/edit before saving.
- Adopted servers should become restartable if start command and path are valid.

Testing:
- Adopt high-confidence server.
- Reject protected or unknown process adoption.
- Restart adopted fixture server.

Update docs/progress.md.
```

## Prompt 9 — Tray Wrapper

```txt
Wrap Localhost Watchdog in a Windows tray app.

Recommended approach:
Use Tauri and reuse the existing dashboard UI/service layer.

Requirements:
- Add tray icon.
- Add menu actions: Open Watchdog, Refresh, Stop All Safe Dev Servers, Quit.
- Show live count of visible dev servers.
- Add native notification for stale servers.
- Closing the window should not kill servers.
- Quitting Watchdog should not kill servers unless the user explicitly chooses a cleanup action.

Testing:
- Manual Windows tray QA.
- Verify scanner still works.
- Verify stop/restart calls use the same safety engine.

Do not add public tunnels or advanced integrations yet.
```

## Prompt 10 — Advanced Cleanup

```txt
Add advanced cleanup features behind explicit confirmations.

Candidates:
- Stop all safe dev servers.
- Zombie warnings based on uptime.
- Watch ports.
- Favorite/pinned ports.
- Process tree view.
- Force stop.

Requirements:
- Bulk stop must show preview.
- Force stop and stop tree must be hidden under Advanced.
- Pinned servers must be excluded from bulk stop.
- Databases and local AI servers must be excluded from bulk stop by default.

Testing:
- Bulk preview test.
- Pinned server exclusion test.
- Advanced confirmation test.
- Protected child process test for stop tree.
```
