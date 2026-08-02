# 05 — Phased Roadmap

## Phase 0 — Repo Setup and Research Lock

Goal: create a clean project foundation and lock the safety vision before code starts.

Deliverables:

- Project README
- `docs/` folder
- Research notes from similar GitHub projects
- Safety model draft
- License review notes

Exit criteria:

- Agent can explain what is in scope and out of scope.
- Agent has identified which external projects are references only versus reusable code candidates.

## Phase 1 — Windows Scanner MVP

Goal: produce a reliable JSON snapshot of active local listening ports on Windows.

Deliverables:

- Node script or backend route that runs a scan.
- Windows scanner using PowerShell/CIM and fallback `netstat`.
- Normalized server records.
- No stop buttons yet.

Required fields:

```txt
id
pid
port
host
url
processName
commandLine
executablePath
creationTime
uptimeMs
rawSource
```

Testing:

- Unit tests for parser fixtures.
- Fixture tests for PowerShell output.
- Fixture tests for netstat fallback.
- Manual test with `npm run dev`, Vite, Python HTTP server.

Exit criteria:

- Scanner produces stable JSON.
- Scanner does not crash when process details are missing.
- Scanner works without admin privileges for normal dev processes.

## Phase 2 — Classifier and Safety Engine

Goal: classify processes and decide safe actions.

Deliverables:

- Protected process list.
- Runtime allowlist.
- Dev folder allowlist.
- Confidence scoring.
- Category assignment.
- Action permission flags.

Output additions:

```txt
category
confidence
safeToShow
safeToStop
safeToRestart
reasons
warnings
hiddenReason
```

Testing:

- Unit tests for protected processes.
- Unit tests for confidence scoring.
- Tests that `svchost.exe`, `explorer.exe`, browser processes, antivirus, and OS services cannot be stopped.
- Tests that Node/Vite/Next/Python dev servers score high only when enough evidence exists.

Exit criteria:

- Stop permission never appears for protected processes.
- Unknown processes are read-only or hidden.
- All classification decisions include reasons.

## Phase 3 — Local Dashboard

Goal: make the tool useful visually without building the final tray app.

Deliverables:

- Local dashboard on `localhost:4545`.
- Running servers list.
- Hidden/protected summary.
- Filters by category/runtime/port.
- Open URL button.
- Inspect details panel.
- Refresh button and polling.

Testing:

- API tests for `/api/servers`.
- UI smoke test with fake scanner data.
- Accessibility pass for buttons and labels.
- Manual browser test.

Exit criteria:

- User can see active dev servers in under five seconds.
- No destructive actions are available yet.
- UI clearly distinguishes safe, unknown, and protected items.

## Phase 4 — Safe Stop

Goal: add controlled stop behavior for high-confidence dev servers.

Deliverables:

- Dry-run stop endpoint.
- Stop endpoint for exact PID.
- Stop confirmation UI.
- Action history.
- Failure handling.

Rules:

- No process tree killing in basic stop.
- No force kill in basic stop.
- Re-check PID and port immediately before stopping.
- If PID/port changed, abort.

Testing:

- Unit tests for dry-run.
- Integration test with a spawned local Node test server.
- Integration test with a spawned Python HTTP server.
- Negative tests for protected process names.
- Test that stop waits for port to free.

Exit criteria:

- Can stop a known Node or Python fixture server through the proof-gated Windows graceful-stop backend.
- Cannot stop protected fixtures or unsupported/non-grouped targets.
- History/audit records every attempt, including dispatch and verification failures.

Phase 4 status: completed 2026-07-31. The default backend uses `CloseMainWindow` for GUI targets and a targeted `CTRL+BREAK` console signal for supported runtimes. It never force-stops, kills a process tree, or escalates automatically. The managed-project launcher in Phase 5 must establish an explicit Windows console process group when it wants console-signal stop support.

## Phase 5 — Managed Projects and Start Button

Goal: allow known projects to be started from the dashboard.

Deliverables:

- `projects.json` registry.
- Add/edit project manually.
- Start project button.
- Preferred port handling.
- Free-port fallback.
- Project status detection.

Testing:

- Unit tests for config validation.
- Integration test with sample project fixture.
- Test preferred port occupied fallback.
- Test command launch from working directory.

Exit criteria:

- User can start a configured project.
- Tool detects when the project is running.
- Tool does not start duplicate processes accidentally.

Phase 5 status: completed 2026-07-31. The Windows direct-executable launcher implements the versioned managed-launch contract: absolute working directory, supported direct runtime, explicit process group owned by the launched PID, creation-time identity, and selected-port identity. Shell-wrapper commands such as `npm.cmd` remain fail-closed until wrapper/listener reconciliation is designed. The start manager rejects incomplete or incompatible launcher results before reporting a successful start.

## Phase 6 — Restart Flow

Goal: stop and restart managed servers safely.

Deliverables:

- Restart endpoint.
- Stop → wait → start flow.
- Startup health check.
- Restart failure rollback messaging.
- Restart history.

Rules:

- Restart only for managed/adopted servers.
- Working directory must exist.
- Start command must exist.
- If preferred port is busy, prompt or use configured alternate behavior.

Testing:

- Integration test with a fixture server.
- Test restart keeps same project association.
- Test restart aborts if stop fails.
- Test restart displays failure reason.

Exit criteria:

- Restart reliably works on fixture project.
- Failed restarts do not leave confusing state.

Phase 6 status: completed 2026-07-31. The protected restart endpoint now accepts both array and scanner-envelope snapshots, revalidates the managed PID/process/listener/port identity, reuses the Phase 4 graceful-stop dispatcher, waits for the previous identity and port to disappear, dispatches the Phase 5 managed launcher, and waits for the replacement process identity to reappear on the expected port. Restart history is retained in memory and appended to `.localhost-watchdog/restart-history.jsonl` through a privacy-safe allowlist. Stop timeout, port-owner change, startup timeout, scanner-unavailable, start failure, and successful fixture paths are covered by tests. There is no force-kill or automatic rollback; failure responses explicitly identify the completed boundary.

## Phase 7 — Adopt Detected Server

Goal: turn a safely detected external server into a managed project.

Deliverables:

- Adopt button for likely dev servers.
- Extract command, directory, port, runtime.
- Save to project registry.
- Mark future instances as managed.

Testing:

- Test adopt requires confidence threshold.
- Test protected/unknown processes cannot be adopted blindly.
- Test adopted project can restart.

Exit criteria:

- A manually started Vite/Next/Python server can be adopted and restarted later.

Phase 7 status: completed 2026-07-31. Safe loopback/high-confidence profile extraction, structured adoption drafts, protected-path/port checks, duplicate registry validation, direct-runtime launch-contract compatibility checks, default atomic registry persistence, and the complete adoption → restart acceptance path are implemented. Shell-wrapper candidates are rejected rather than saved as projects that Phase 5 cannot safely launch.

## Phase 8 — Tray App Wrapper

Goal: provide the taskbar/tray experience.

Recommended stack:

- PowerShell/.NET `NotifyIcon` companion + existing Node/browser UI.
- Keep scanner/action logic reusable and keep the tray host lifecycle-only.

Deliverables:

- Tray icon.
- Browser dashboard open action.
- Live visible/stale count in tooltip and notifications.
- Open dashboard action.
- Token-protected Quit action for the companion-owned Node backend.
- Native notifications.

Testing:

- Manual Windows tray test.
- App close behavior test.
- Verify quitting Watchdog does not kill dev servers unless explicitly requested.
- Verify tray icon persists correctly.

Exit criteria:

- User can open the dashboard from the tray, refresh local server state, and quit the Watchdog companion without changing a managed dev server.

Phase 8 status: the reusable native-host bridge and the Windows PowerShell/.NET tray companion are implemented. The companion consumes the existing scanner API, opens the browser dashboard, reports visible/stale status, and can close only a backend it started through the token-protected host-control route. Manual Windows tray QA remains the final host-owned gate. See `docs/phase8-manual-test.md` for the exact manual checklist.

## Parallelization review for Phases 5-8

The phases are not one fully serial chain. The safest parallel split is:

- Phase 5 is the critical backend track. It owns the managed-project launcher, working-directory validation, port selection, process-group creation, and running-status reconciliation.
- Phase 7 can proceed in parallel with the early Phase 5 work for candidate validation, command/directory extraction, protected/unknown rejection, draft editing, and registry persistence. Its “adopt then restart” acceptance test must wait for Phase 6.
- Phase 8 can proceed in parallel as a packaging/integration track because the tray companion calls reusable dashboard/refresh/quit adapters. The PowerShell/.NET host does not need the Phase 5 launcher, while wiring tray controls to start/restart should wait for the backend route contracts.
- Phase 6 follows the stabilized Phase 5 launcher contract. Its restart implementation now reuses the Phase 4 stop backend, adds port-free verification and startup health checks, and remains isolated from generic scanner `safeToRestart` flags.

Recommended order: run Phase 5 backend and the independent portions of Phases 7 and 8 in parallel; then complete Phase 6 against the stabilized managed-launcher contract; finally run the cross-phase adoption/restart and native tray acceptance tests together.

## Phase 9 — Advanced Actions

Goal: add power-user features after safety is proven.

Candidates:

- Force stop.
- Stop process tree.
- Stop all safe dev servers.
- Watched ports.
- Zombie warnings.
- CPU/memory badges.
- Docker labels.
- Test runner detection.
- Local AI server category.

Testing:

- Advanced actions require explicit confirmation.
- Bulk actions show preview.
- Stop tree never includes protected child processes.

Exit criteria:

- Advanced actions do not weaken default safety.

## Phase 10 — LocAIly Tool Pack

Goal: expose Watchdog actions as structured tools for LocAIly or other local agents.

Deliverables:

- Tool manifest.
- JSON-only action outputs.
- Read-only scan tool.
- Confirm-before-write destructive tools.

Tool examples:

```txt
scan_local_servers
inspect_local_server
stop_dev_server
restart_dev_server
start_project_server
find_free_port
```

Exit criteria:

- Agents can safely request scans.
- Destructive actions require confirmation.
