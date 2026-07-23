# Phase Completion Review

This review records the issues found after the proof-gated stop, managed project, adoption, and tray-shell work, plus the fixes applied in the completion pass.

## Issues found

1. **Managed project config was too narrow.** The registry accepted only a flat `startCommand` string and did not normalize structured `start` config (`command`, `args`, `cwd`, `env`) from the roadmap.
2. **Duplicate project IDs were not rejected.** A duplicate `id` could make project lookup ambiguous and undermine idempotent project actions.
3. **`next-available` port strategy was declared but not implemented.** Start requests with a busy preferred port only avoided blocking when strategy was not `strict`, but they did not select and pass a fallback port to the launcher.
4. **Adoption had save and draft paths but no protected draft API.** The user-confirm/edit workflow needs a separate draft endpoint before save.
5. **Tray implementation is a reusable shell adapter, not a packaged Tauri app.** The repository now has a non-destructive tray service layer that can be bound by a native wrapper, but native packaging/assets/manual Windows QA remain outside this container pass.

## Fixes applied

- Extended project registry normalization to support structured start config, start args, start cwd, merged env, managed metadata, and duplicate-id validation.
- Added next-available port selection to the start manager and passed the selected fallback port into injected launch requests.
- Added a protected adoption draft API route so the UI/native layer can request an editable draft before saving an adopted project.
- Added regression tests for duplicate IDs, structured start config, next-available fallback dispatch, and protected adoption draft routing.

## Known remaining non-blockers

- Native tray packaging still needs a Windows/Tauri integration pass with manual QA on a Windows desktop session.
- Real process launch/stop implementations remain intentionally injected and fail-closed by default; platform-specific dispatchers should be implemented and audited separately.
