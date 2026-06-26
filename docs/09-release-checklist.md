# 09 — Release Checklist

## Pre-Release Rule

Never release a version that adds destructive behavior without new safety tests.

## General Checklist

- [ ] README updated.
- [ ] Config examples updated.
- [ ] Progress log updated.
- [ ] Safety model still matches implementation.
- [ ] All tests pass.
- [ ] Manual Windows QA completed.
- [ ] No raw system process dump exposed in UI.
- [ ] No stop action appears for protected processes.
- [ ] No bulk stop action includes databases or local AI by default.

## Scanner Release Gate

- [ ] Detects Node server.
- [ ] Detects Vite server.
- [ ] Detects Python HTTP server.
- [ ] Handles missing command line.
- [ ] Handles inaccessible process metadata.
- [ ] Produces stable JSON.

## Safety Release Gate

- [ ] Protected processes are blocked.
- [ ] Browser processes are blocked.
- [ ] Unknown processes are read-only or hidden.
- [ ] Every classification includes reasons.
- [ ] Confidence thresholds are tested.

## Stop Release Gate

- [ ] Dry-run exists.
- [ ] Exact PID re-check occurs before stop.
- [ ] Changed PID aborts.
- [ ] Changed port aborts.
- [ ] Stop failure is shown clearly.
- [ ] History record is written.

## Restart Release Gate

- [ ] Restart only works for managed/adopted servers.
- [ ] Working directory is validated.
- [ ] Start command is validated.
- [ ] Port free wait is tested.
- [ ] Health probe result is shown.
- [ ] Failed restart does not hide failure.

## Tray Release Gate

- [ ] Tray icon launches dashboard.
- [ ] Closing window does not kill servers.
- [ ] Quitting app does not kill servers.
- [ ] Notifications are not spammy.
- [ ] Live count matches dashboard.

## Security and Privacy Checklist

- [ ] No automatic public sharing.
- [ ] No upload of process data.
- [ ] Local-only by default.
- [ ] Command lines may contain secrets, so UI should allow hiding full command lines.
- [ ] Logs/history should be local-only.
- [ ] User can clear history.

## Packaging Checklist

- [ ] Windows build works.
- [ ] App starts without admin privileges.
- [ ] App handles permission denied gracefully.
- [ ] Installer/zip notes are clear.
- [ ] Version number updated.

## Known Risk List

Keep this section updated as the product evolves.

- Windows localized command output can break parsing.
- Some process metadata requires elevated privileges.
- Ports can be reused between scan and stop.
- Parent/child process trees can be misleading.
- Databases and local AI servers may be intentionally long-running.
- Some dev servers bind to `0.0.0.0`; treat carefully.
