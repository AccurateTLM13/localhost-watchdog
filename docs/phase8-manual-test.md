# Phase 8 Manual Test Plan

## Current repository gate

Phase 8 uses the existing Node backend and browser dashboard with a Windows PowerShell/.NET `NotifyIcon` tray companion. It does not require Rust, Tauri, a native compiler, or an embedded webview. The companion starts the Node backend only when the local health endpoint is unavailable, opens the dashboard in the default browser, refreshes scanner counts, and owns a token-protected shutdown path for its own backend only.

The Windows test machine needs:

- Node.js 22 or newer on PATH, unless `-NodePath` is provided.
- Windows PowerShell 5.1 or PowerShell 7 started with `-STA`.
- A clean disposable project fixture and a second local listener for count/stale testing.

Do not use a production project or an important local server as the fixture.

## Browser/backend smoke test that can run now

From the repository root:

```powershell
npm test
npm run lint
npm start
```

In a second PowerShell window, start the disposable fixture:

```powershell
node test/fixtures/server.js phase8-manual-fixture 43113
Invoke-WebRequest http://127.0.0.1:43113/
```

Open `http://127.0.0.1:4545` and verify:

1. Refresh shows the fixture listener and the visible count changes.
2. The dashboard remains inspect-first; no generic stop, restart, force-kill, or bulk controls appear.
3. Closing or restarting the dashboard process does not stop the fixture.
4. The fixture still answers at `http://127.0.0.1:43113/` after the dashboard is closed.

Stop the disposable fixture only after the test:

```powershell
Get-NetTCPConnection -LocalPort 43113 -State Listen | Select-Object OwningProcess
Stop-Process -Id <fixture-pid>
```

## Tray companion launch

Stop the standalone `npm start` process before this test so the companion can demonstrate ownership of its own backend:

```powershell
powershell.exe -NoProfile -STA -File .\scripts\Start-LocalhostWatchdogTray.ps1
```

Useful options:

```powershell
powershell.exe -NoProfile -STA -File .\scripts\Start-LocalhostWatchdogTray.ps1 -NoBrowser
powershell.exe -NoProfile -STA -File .\scripts\Start-LocalhostWatchdogTray.ps1 -NodePath "C:\Program Files\nodejs\node.exe" -RefreshSeconds 30
powershell.exe -NoProfile -STA -File .\scripts\Start-LocalhostWatchdogTray.ps1 -SmokeTest -Port 4546
```

The companion records only its own backend stdout/stderr under `.localhost-watchdog\tray\`. It never writes to managed project configuration and never uses `Stop-Process`, `taskkill`, process-tree termination, or force-kill escalation.

## Native tray acceptance checklist

Run the script from the repository root and verify:

1. The browser dashboard opens at `http://127.0.0.1:4545` without a console window for the Node backend.
2. The Watchdog tray icon appears with `Open Watchdog`, `Refresh`, and `Quit` menu entries.
3. The tray tooltip shows the visible server count after refresh.
4. A stale disposable fixture produces one clear warning notification and no destructive action.
5. Closing the browser window leaves the tray companion running and does not stop, signal, restart, or alter the fixture listener.
6. `Refresh` updates the count from the scanner envelope; an unavailable backend produces a safe refresh-unavailable state rather than stale data.
7. `Quit` closes the companion-owned Node backend through `/api/host/shutdown`, reports `serversTerminated:false`, and leaves the fixture reachable.
8. After `Quit`, port `4545` is no longer listening when the companion started the backend.
9. If a healthy `npm start` backend is already running before the companion launches, `Quit` leaves that external backend running because the companion does not own it.
10. Project start/restart/adoption actions remain protected by the existing local session and managed identity contracts; tray lifecycle actions do not bypass them.

Capture screenshots of the tray menu, count tooltip, stale notification, quit result, and the fixture URL still responding after quit. Record whether the backend was companion-owned or pre-existing.

## Failure boundary

Stop the manual run and report the exact state if any test suggests that closing or quitting the watchdog terminates the fixture, that the tray shows stale data after scanner failure, that the dashboard cannot be reopened, that the companion-owned backend cannot close through the host-control route, or that a tray callback reports an executed/destructive action. Do not compensate with Task Manager or force-kill commands until the fixture identity and port are recorded.
