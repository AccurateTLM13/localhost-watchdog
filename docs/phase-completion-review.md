# Phase Completion Review

This review records the issues found after the proof-gated stop, managed project, adoption, and tray-shell work, plus the fixes applied in the completion pass.

## 2026-07-31 - Phase 4 closure and parallel Phase 5/7/8 slices

The proof-gated stop path now has a real Windows graceful-stop backend. It uses `CloseMainWindow` for GUI targets and a targeted `CTRL+BREAK` console signal for explicitly grouped Node, Python, Java, Bun, and Deno runtimes. The helper revalidates PID/name, times out after five seconds, and returns safe failure codes; the existing audit and post-action listener verification remain authoritative.

The disposable Windows integration gate now covers Node and Python fixtures launched in hidden, explicit console process groups. A normal unmanaged process without an independently verified console-group boundary still fails closed, which is intentional and becomes a managed-launcher responsibility in Phase 5.

The parallel follow-on slices are also present: Phase 5 has a Windows direct-executable launcher that creates the required process group and returns process identity; Phase 7 has stricter loopback/high-confidence profile extraction and adoption draft validation; Phase 8 has a reusable tray host callback boundary with lifecycle/error/idempotency tests. None of these changes add force-stop, process-tree, or bulk behavior.

The project-root identity migration is also complete: normalized records now separate canonical `root` from presentation `displayRoot`, legacy `path` input and root-only records have compatibility fallbacks, and registry/ownership/adoption/API/UI tests keep machine comparisons separate from display assertions. The full suite was green at 234/234 before the Phase 6-8 acceptance additions.

## Issues found

1. **Managed project config was too narrow.** The registry accepted only a flat `startCommand` string and did not normalize structured `start` config (`command`, `args`, `cwd`, `env`) from the roadmap.
2. **Duplicate project IDs were not rejected.** A duplicate `id` could make project lookup ambiguous and undermine idempotent project actions.
3. **`next-available` port strategy was declared but not implemented.** Start requests with a busy preferred port only avoided blocking when strategy was not `strict`, but they did not select and pass a fallback port to the launcher.
4. **Adoption had save and draft paths but no protected draft API.** The user-confirm/edit workflow needs a separate draft endpoint before save.
5. **Tray implementation is a reusable shell adapter plus a Windows companion.** The repository now has a non-destructive tray service layer and a PowerShell/.NET `NotifyIcon` host with scanner-envelope, live-count, native-callback, host-shutdown, and server-preservation coverage. Manual Windows QA remains outside automated verification.

## Fixes applied

- Extended project registry normalization to support structured start config, start args, start cwd, merged env, managed metadata, and duplicate-id validation.
- Added next-available port selection to the start manager and passed the selected fallback port into injected launch requests.
- Added a protected adoption draft API route so the UI/native layer can request an editable draft before saving an adopted project.
- Added regression tests for duplicate IDs, structured start config, next-available fallback dispatch, and protected adoption draft routing.

## Known remaining non-blockers

- Manual Windows tray QA still needs to run on a desktop session using `scripts/Start-LocalhostWatchdogTray.ps1` and a disposable fixture.
- Phase 6 managed restart and the Phase 7 adoption → restart acceptance are complete. The PowerShell/.NET tray companion is implemented; only manual Windows tray QA remains outstanding.
