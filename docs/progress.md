# Progress Log

## 2026-07-16 - Human safety review and Windows QA guide

Scope completed:
- Added a reusable reviewer guide that separates ready-for-review, ready-to-merge, and ready-to-release decisions.
- Added a PR #3-specific review checklist for execution proofs, fail-closed revalidation, backend injection, audit/privacy, and managed-project boundaries.
- Added safe manual Windows QA steps, explicit stop conditions, required evidence, future review routing, and a typed signoff template.
- Linked the guide from the README document map and release checklist.

Safety status:
- Documentation only; no runtime, action, scanner, backend, or UI behavior changed.
- The guide prohibits testing action flows against existing local processes and keeps production backend approval separate from PR #3 approval.

## 2026-07-11 - Phase B/C execution proof and guarded stop execution path

Scope completed:
- Mapped the future execution contract onto the current dry-run, confirmation, execution, audit, and server route flow.
- Added short-lived single-use execution proofs issued only after accepted confirmation; proofs are stored as hashes, bound to the accepted confirmation target, and consumed before final execution revalidation.
- Added a protected `POST /api/actions/stop/execute` route that requires the local session/CSRF envelope plus an execution access token and idempotency key.
- Split real execution mode from the existing non-destructive simulation path so `/api/actions/stop/simulate-execution` remains available for simulator checks.
- Added a guarded graceful-stop dispatcher seam and post-action verification flow for exact target listener disappearance, listener-still-active, respawn/reassignment, and verification-unavailable outcomes. The default dispatcher fails closed unless a platform-safe backend is supplied.
- Extended execution audit records to carry execution authorization/action flags and added tests for proof issuance, proof replay, audit-failure blocking before dispatch, successful injected stop dispatch, listener-still-active reporting, and API proof forwarding.

Safety status:
- No force-kill, process-tree kill, restart, cleanup, bulk action, `process.kill`, `taskkill`, or `Stop-Process` primitive was added.
- The dashboard still does not expose stop, restart, kill, cleanup, or bulk controls.
- Real execution remains single-target, proof-gated, audit-gated, and final-revalidation-gated; the default graceful-stop backend is unavailable/fail-closed in this environment.

Manual checks:
- `npm test` passes.
- `npm run lint` passes.

## 2026-06-26 - Execution Readiness milestone

Scope completed:
- Added `docs/execution-contract.md` defining the future stop execution contract, covering single-use execution proofs, final revalidation steps, graceful-stop console signals, timeout policies, post-action verification, audit logs, replay protection, and error behavior.
- Completed Windows process owner, SID, session, and elevation/integrity query template (`SEC_CMD_TEMPLATE`) utilizing inline C# P/Invoke compiled via `Add-Type` for targeted PIDs (listeners + ancestors).
- Added fail-closed logic to block actions when mandatory owner or security metadata is unavailable, elevated mismatch is detected, or SYSTEM/service ownership is found.
- Added a non-executing execution simulator (`src/actions/execution.js`) that performs all revalidation checks (PID exists, creation time matches, port ownership unchanged, owner/session matches, privilege safe) and always returns `actionExecuted: false` and `executionAuthorized: false`.
- Registered route `POST /api/actions/stop/simulate-execution` on the local HTTP server, returning simulation outcomes.
- Added extensive test fixtures and test cases (`test/action-execution.test.js`) covering same-user/session, different user/session, SYSTEM ownership, elevation mismatch, missing metadata, PID reuse, listener reassignment, and process exit during revalidation.
- Configured Windows GitHub Actions CI (`.github/workflows/ci.yml`) to automatically run `npm test` and `npm run lint`.

Safety status:
- The application remains strictly non-destructive.
- No stop, restart, tray, process killing, bulk cleanup, or process signaling is implemented in production source.
- `safeToStop`, `safeToRestart`, and `bulkStoppable` are always `false`.
- The execution simulator cannot authorize execution or execute actions.

## 2026-06-18 - Confirmation-only intent recording phase

Scope completed:

- Added local session bootstrap with server-generated session nonce and CSRF token.
- Added confirmation-only endpoints for creating, submitting, checking, and cancelling confirmation sessions.
- Added a separate short-lived `confirmationAccessToken` that authorizes confirmation submission only and never execution.
- Added strict confirmation Host/Origin validation, JSON content-type enforcement, request-size limits, session expiration, and server-restart invalidation through in-memory sessions.
- Added typed confirmation phrase handling with trim-only, case-sensitive server validation.
- Added fresh confirmation revalidation using the original dry-run expected values, a new scan, stable PID plus creation-time identity, listener identity, protected boundaries, project identity, owner/session policy, elevation policy, and audit availability.
- Added explicit owner/session/elevation metadata shape with fail-closed unavailable defaults in scanner output.
- Added privacy-safe confirmation audit records at `.localhost-watchdog/confirmation-audit.jsonl` with schema versioning, pruning, atomic compaction, temp-write cleanup, and serialized synchronous writes.
- Added dashboard confirmation review, typed phrase, record confirmation, cancel, accepted, blocked, and unavailable states.

Safety status:

- The app remains non-executing.
- No stop, restart, kill, cleanup, tray, process signaling, elevation, execution token, remediation, automatic cleanup, or bulk-action behavior was added.
- `safeToStop`, `safeToRestart`, and `bulkStoppable` remain false.
- Confirmation results always include `actionExecuted:false` and `executionAuthorized:false`.

## 2026-06-18 - Focused dry-run safety audit remediation

Scope completed:

- Replaced the old request-ID-only dry-run status lookup with `POST /api/actions/dry-runs/status`.
- Added a separate opaque `statusAccessToken` for status reads only; stored results keep only a hash and status lookup never returns the raw token.
- Removed status tokens from rendered dry-run UI state, audit records, diagnostics/export-safe surfaces, and retired token-in-query GET status lookup behavior.
- Added a machine-readable mandatory required-field policy for dry-run revalidation.
- Made mandatory missing, null, empty, malformed, unavailable, warning, or blocked checks fail closed instead of producing `confirmation-eligible`.
- Added additional fail-closed checks for project root drift, category/confidence drift, process-tree boundary availability, process-tree truncation, stale-candidate lifecycle, creation-time value, PID value, and audit-log availability.
- Added categorized safe API errors for unsupported method, unsupported content type, malformed JSON, oversized body, unsupported origin, and unavailable status lookup.

Safety status:

- The app remains read-only.
- No stop, restart, kill, cleanup, tray, confirmation, execution, remediation, automatic cleanup, or bulk-action behavior was added.
- `safeToStop`, `safeToRestart`, and `bulkStoppable` remain false.
- Dry-run results always include `actionExecuted:false`.

## 2026-06-17 - Dry-run eligibility and revalidation phase

Scope completed:

- Added read-only action eligibility metadata to visible scanner records.
- Added eligibility states: `ineligible`, `inspect-only`, `dry-run-eligible`, `confirmation-eligible`, and `blocked`.
- Added a dry-run evaluator that performs fresh scanner revalidation before returning a result.
- Revalidated stable PID plus creation-time identity, listener ID, port ownership, bind address, process name, category, confidence, project ownership, protected process/port/tree boundaries, metadata availability, and conflicting newer scanner evidence.
- Added short-lived dry-run status tokens tied to exact process/listener identity; tokens explicitly do not authorize confirmation or execution.
- Added read-only API endpoints: `POST /api/actions/stop/dry-run` and `POST /api/actions/dry-runs/status`.
- Added privacy-safe dry-run audit records at `.localhost-watchdog/dry-run-audit.jsonl`; audit write failure blocks dry-run eligibility but never affects the target process.
- Added dashboard rendering for read-only action readiness, safety-check status, block reasons, expired/changed/scanner-unavailable states, and explicit "permission not granted" text.
- Added tests for PID reuse, multiple ports, missing creation time, unstable IDs, process-name/host/project/category/fingerprint changes, protected categories/boundaries, scanner failure, audit failure, token expiry/binding, idempotency, API routing, UI states, and source-level absence of destructive primitives.

Safety status:

- The app remains read-only.
- No stop, restart, kill, cleanup, tray, confirmation, execution, remediation, automatic cleanup, or bulk-action behavior was added.
- `safeToStop`, `safeToRestart`, and `bulkStoppable` remain false.
- Dry-run results always include `actionExecuted:false`.

Manual checks:

- `npm test` passes.

## 2026-06-16 - Phase 0 and Phase 1 foundation

Scope completed:

- Created Node project foundation with CLI, test, lint, and read-only server scripts.
- Added MIT license and config examples.
- Added Windows scanner that tries `Get-NetTCPConnection` first, enriches with `Get-CimInstance Win32_Process`, and falls back to `netstat -ano` for listening TCP ports.
- Added normalized JSON server records with redacted command lines.
- Added initial read-only classification confidence model for visibility, category, confidence, reasons, warnings, and hidden summaries.
- Added parser, redaction, protected process, and confidence tests using fixtures.
- Added a minimal browser inspector that shows raw `/api/servers` JSON only.

Safety status:

- No stop, restart, force-stop, process-tree, tray, bulk action, or destructive process code exists.
- `safeToStop`, `safeToRestart`, and `bulkStoppable` are always `false`.
- Protected process names are hidden and counted in the hidden summary.
- Command lines are redacted before normalized records are emitted.

Manual checks:

- `npm test` passes.
- `npm run lint` passes.

## 2026-06-17 - Read-only milestone audit remediation

Scope completed:

- Replaced PID/port-only visible record IDs with explicit process identity fields. Stable records use PID plus creation time; listener IDs add host/port only as secondary listener context; missing creation time produces `session-unstable-*` identifiers.
- Redacted top-level executable paths before normalized records leave the scanner boundary.
- Sanitized HTTP probe final URLs before output by removing query strings, fragments, and embedded credentials.
- Added duplicate-listener normalization for equivalent PID/protocol/address/port rows while preserving IPv4, IPv6, wildcard, and loopback meaning.
- Added safe error codes/categories and user-safe messages for scanner, diagnostics, history, API, and CLI error surfaces.
- Corrected current data-contract and architecture documentation so implemented API contracts remain read-only and future action concepts are clearly non-implemented.
- Added regression tests for identity, PID reuse, multi-port processes, unstable IDs, path and URL sanitization, duplicate listeners, safe errors, and documentation drift.

Safety status:

- The app remains read-only.
- `safeToStop`, `safeToRestart`, and `bulkStoppable` remain false.
- No stop, restart, kill, cleanup, tray, bulk-action, remediation, upload, sharing, or action endpoint behavior was added.

- `npm run scan -- --compact` emits JSON on Windows without requiring admin privileges in the current environment.

Known limitations:

- Working directory and user are currently `null`; Windows does not expose working directory through the first CIM query.
- HTTP probing is intentionally not implemented yet.
- Classification is conservative and read-only; it is not sufficient for stop/restart decisions.
- Some process metadata can be inaccessible without elevation and will be emitted as missing metadata.
- Localized or unusual `netstat` output may need more fixtures.

## 2026-06-16 - Phase 2 classifier hardening

Scope completed:

- Added config loading from `config/safety.json` and `config/projects.json`, with fallback to example config files when local config files do not exist.
- Added explicit read-only categories: `node-dev-server`, `python-dev-server`, `local-ai-server`, `database`, `browser-helper`, `editor-helper`, `java-dev-server`, `system-or-protected`, and `unknown-listener`.
- Added structured `evidence` arrays to classification output and preserved `reasons` as message-only compatibility output.
- Added confidence levels: `high`, `medium`, and `low`.
- Added dev-root and configured-project awareness without granting destructive permissions.
- Added protected process and protected port rules from config.
- Added fixture coverage for Node, Python, local AI, databases, browser helpers, editor helpers, Java/Spring, unknown listeners, and protected/security processes.

Safety status:

- The app remains read-only.
- No stop, restart, tray, process killing, bulk cleanup, or destructive process action was added.
- `safeToStop`, `safeToRestart`, and `bulkStoppable` remain always `false`.
- Browser/editor/database/local-AI categories are visible only for inspection and never manageable.

Manual checks:

- `npm test` passes.
- `npm run lint` passes.
- `node watchdog.js scan --compact` emits Phase 2 categories and evidence.

## 2026-06-16 - Phase 3 read-only HTTP probe enrichment

Scope completed:

- Added a read-only HTTP probe module for visible loopback scanner records.
- Probes use strict configurable timeouts and a small body read cap for metadata extraction only.
- Added safe metadata fields: reachability, status code, response time, final URL, content type, HTML title, hints, redirect-blocked state, and redacted errors.
- Added redirect handling that follows localhost redirects and blocks redirects to non-localhost destinations.
- Added framework/server hints for Vite, Next.js, Astro, React dev server, FastAPI, Flask, Django, Ollama, LM Studio, and local companion-style APIs.
- Added zero-score HTTP probe evidence to the existing evidence array.
- Added `networkExposure` output for loopback, all-interface, and non-loopback listeners.
- Added probe tests for HTML, JSON, timeout, refused connection, local redirect, external redirect blocking, non-HTTP listeners, all-interface warnings, and error redaction.

Safety status:

- The app remains read-only.
- Probes are only attempted for visible localhost/loopback URLs.
- Probe evidence cannot grant stop/restart permissions.
- No response bodies are stored in scanner output.
- No stop, restart, tray, process killing, or bulk action behavior was added.

## 2026-06-16 - Phase 4 read-only dashboard rendering

Scope completed:

- Replaced the raw JSON page with a plain HTML/CSS/JS dashboard.
- Added top summary counts for scanned, visible, hidden, reachable HTTP, network-exposed, and unknown listeners.
- Added visible listener cards showing title, port, bind address, URL, process name, category, confidence, HTTP probe metadata, page title hints, content type, framework/server hints, network exposure, safety state, evidence, and redacted command line.
- Added filters for all visible, dev servers, local AI, databases, browser/editor helpers, unknown, network-exposed, and protected/read-only records.
- Added sorting by port, confidence, category, and process.
- Added dashboard formatting helpers and tests.

Safety status:

- The dashboard renders only scanner/API data.
- Command lines remain redacted before display.
- Framework/probe values are labeled as hints.
- No destructive controls, bulk controls, stop/restart endpoints, tray behavior, or process killing was added.

Manual checks:

- `npm test` passes.
- `npm run lint` passes.
- Dashboard served locally and renders scanner cards from `/api/servers`.

## 2026-06-16 - Phase 4.5 dashboard smoke tests with fake API data

Scope completed:

- Extracted dashboard rendering into shared plain-JS helpers used by both the browser UI and tests.
- Added a fake `/api/servers` snapshot fixture for dashboard smoke coverage.
- Added smoke tests for reachable HTTP dev servers, unreachable/non-HTTP listeners, network-exposed listeners, unknown listeners, local AI servers, database listeners, browser/editor helpers, protected/read-only records, empty visible lists, loading state, and API error state.
- Added tests for all current dashboard filters.
- Added tests for port, category, confidence, and process-name sorting.
- Added tests that framework/server values are labeled as hints.
- Added tests that rendered command lines remain redacted and that stop/restart/kill/bulk controls are absent from generated markup.

Safety status:

- The app remains read-only.
- No frontend framework or browser-test dependency was added.
- No stop, restart, tray, process killing, destructive, or bulk-action behavior was added.

Manual checks:

- `npm test` passes.
- `npm run lint` passes.
- Static dashboard assets are served by the local Node server.

## 2026-06-16 - Phase 4.6 dashboard accessibility and keyboard smoke checks

Scope completed:

- Added accessibility-focused dashboard tests using the existing Node test runner and shared render helpers.
- Added explicit accessible names for the refresh button, filter group, sort control, open links, server cards, and evidence disclosure summaries.
- Added `aria-pressed` state to filter buttons and updated it when filters change.
- Added `role="status"` and `aria-live="polite"` for scan/loading status.
- Added `role="alert"` for API error state.
- Added list/listitem semantics for server result cards.
- Added text labels for HTTP probe status and network exposure warnings so state is not color-only.
- Added visible `:focus-visible` CSS for buttons, selects, links, and summaries.
- Added tests that no stop, restart, kill, or bulk controls appear in accessibility markup.

Safety status:

- The app remains read-only.
- No browser automation dependency was added.
- No stop, restart, tray, process killing, destructive, or bulk-action behavior was added.

Manual checks:

- `npm test` passes.
- `npm run lint` passes.

## 2026-06-16 - Phase 5 read-only project ownership detection

Scope completed:

- Added project ownership detection for visible server records.
- Added inference from configured project paths, configured dev roots, command-line path candidates, executable paths, and marker files.
- Added project markers: `package.json`, `.git`, `vite.config.*`, `next.config.*`, `astro.config.*`, `pyproject.toml`, `requirements.txt`, `manage.py`, `pom.xml`, and `build.gradle`.
- Added safe display name extraction from `package.json` name or nearest folder name.
- Added `project` output with `name`, `root`, `confidence`, `source`, `evidence`, and `workingDirectory`.
- Added project ownership evidence to the existing evidence model.
- Added dashboard project ownership rendering.
- Added tests for Node, Next, Vite, Astro, Python, Django, Java/Maven/Gradle, unknown processes inside dev roots, known runtimes outside dev roots, missing paths, and path redaction.

Safety status:

- Project ownership can raise confidence but cannot grant `safeToStop`, `safeToRestart`, or `bulkStoppable`.
- The app remains read-only.
- No stop, restart, tray, process killing, destructive, or bulk-action behavior was added.

Manual checks:

- `npm test` passes.
- `npm run lint` passes.

## 2026-06-16 - Phase 6A user-configured dev roots

Scope completed:

- Added optional `config/dev-roots.json` support with `config/dev-roots.example.json`.
- Merged user dev roots with safety defaults and explicit project paths after normalization.
- Ignored missing, invalid, or non-absolute dev-root entries as ownership search boundaries.
- Exposed redacted configured dev roots in scanner API output under `config.devRoots`.
- Rendered redacted project search boundaries in the dashboard.
- Kept ownership marker search inside configured dev roots unless a project is explicitly configured in `config/projects.json`.
- Added tests for configured root matching, multiple roots, nested project detection, path redaction, invalid roots, outside-root processes, explicit project exceptions, and action flags staying disabled.

Safety status:

- Ownership evidence can still raise confidence.
- Ownership evidence cannot enable `safeToStop`, `safeToRestart`, or `bulkStoppable`.
- The app remains read-only.
- No stop, restart, tray, process killing, destructive, or bulk-action behavior was added.

Manual checks:

- `npm test` passes.
- `npm run lint` passes.

## 2026-06-16 - Parent-process and launcher context detection

Scope completed:

- Added read-only parent-process resolution from Windows CIM process metadata.
- Added normalized `launcher` output with parent PID, parent process name, parent category, launcher name, bounded confidence impact, redacted parent command information, redacted parent executable path, and launcher evidence.
- Added launch-context detection for VS Code, Cursor, Windows Terminal, PowerShell, Command Prompt, Git Bash, npm/npx/pnpm/yarn, node, python, java, Docker Desktop, and `docker compose`.
- Added launcher evidence to the existing evidence model.
- Added dashboard rendering for launcher context, including "Launched from VS Code", "Launched from PowerShell", and "Parent process unknown" style states.
- Added tests for editor, terminal, package-manager, runtime, Java Gradle/Maven, Docker, missing parent, parent outside dev root, redacted parent command lines, and action flags staying disabled.

Safety status:

- Launcher evidence can raise display confidence only.
- Launcher evidence cannot enable `safeToStop`, `safeToRestart`, or `bulkStoppable`.
- The app remains read-only.
- No stop, restart, tray, process killing, destructive, or bulk-action behavior was added.

Manual checks:

- `npm test` passes.
- `npm run lint` passes.

## 2026-06-17 - Multi-hop process-tree enrichment

Scope completed:

- Added bounded multi-hop process ancestry for visible server records.
- Added `processTree` output with `depth`, `truncated`, `stopReason`, `rootLauncher`, `chain`, and `evidence`.
- Added a strict default traversal depth of `5`.
- Added traversal stops for missing parent PID, unavailable parent metadata, repeated parent PID/cycles, protected/system boundaries, and max-depth truncation.
- Added redacted chain items with PID, process name, category, launcher name, command line, and executable path.
- Added ancestry pattern detection for VS Code, Cursor, Windows Terminal, PowerShell, Command Prompt, Git Bash, npm/pnpm/yarn, node, python, Gradle/Maven Java, Docker Desktop, and `docker compose` contexts.
- Added process-tree evidence to the existing evidence model.
- Added dashboard rendering for compact launcher chains and detailed redacted process-tree data.
- Added tests for common ancestry patterns, missing metadata, cycle detection, max-depth truncation, protected boundary stops, command-line redaction, and disabled action flags.

Safety status:

- Process-tree context can raise display confidence only within a bounded score.
- Process-tree context cannot enable `safeToStop`, `safeToRestart`, or `bulkStoppable`.
- The app remains read-only.
- No stop, restart, tray, process killing, destructive, or bulk-action behavior was added.

Manual checks:

- `npm test` passes.
- `npm run lint` passes.

## 2026-06-17 - Process age, detached-launcher, and stale-candidate context

Scope completed:

- Added process timing fields for visible listener records: `createdAt`, `ageMs`, `ageLabel`, `timingSource`, `timingStatus`, and `timingError`.
- Added read-only `lifecycleContext` with process age, parent/root launcher availability, tree stop reason, detached/stale candidates, stale score, signals, and limitations.
- Added cautious lifecycle labels: `active`, `long-running`, `possibly-detached`, `stale-candidate`, and `unknown`.
- Added configurable lifecycle thresholds in `config/safety.example.json`.
- Added category-aware stale scoring with default exclusions for databases, local AI servers, browser/editor helpers, protected/system processes, and unknown listeners.
- Added false-positive protections so age alone cannot produce `stale-candidate`, max-depth truncation is treated as a limitation, and healthy detached dev servers stay `possibly-detached`.
- Added dashboard rendering for start time, running duration, lifecycle label, lifecycle warning text, signals, and limitations.
- Added tests for recent and long-running Vite servers, missing parent metadata, detached healthy servers, stale candidates with multiple signals, long-running Postgres, long-running Ollama, protected/system listeners, invalid/skewed timing, truncation, and disabled action flags.

Safety status:

- Detached and stale labels are cautious heuristics, not facts.
- Lifecycle context cannot enable `safeToStop`, `safeToRestart`, or `bulkStoppable`.
- The app remains read-only.
- No stop, restart, tray, process killing, destructive, automatic cleanup, or bulk-action behavior was added.

Manual checks:

- `npm test` passes.
- `npm run lint` passes.

## 2026-06-17 - Privacy-safe historical snapshot comparison

Scope completed:

- Added lightweight file-backed local scan history with atomic JSON writes.
- Added stable process-instance identity from PID plus process creation time.
- Added privacy-safe persisted fields only; command lines, paths, response bodies, process trees, and raw CIM data are not persisted.
- Added local retention controls for maximum snapshots, maximum history age, and maximum tracked process records.
- Added recovery for missing history files, invalid JSON, schema mismatches, interrupted temp writes, disabled history, and write failures.
- Added per-record `historyContext` with first seen, last seen, seen count, consecutive seen count, persisted-across-scans, previously seen, reappeared, history status, and evidence.
- Added top-level `history` status with enabled state, storage health, retained snapshot count, oldest retained snapshot, last successful write, disappeared count, and privacy status.
- Added dashboard rendering for history status, first/last seen, scan observation counts, continuous observation, reappearance, and history warnings.
- Added tests for first observation, repeat observation, consecutive scans, disappearance/reappearance, PID reuse, port changes, invalid history, atomic-write recovery, retention pruning, missing creation time, disabled history, write failure, privacy exclusions, stale false-positive protection, and disabled action flags.

Safety status:

- Historical context is informational only.
- History cannot mark a process stale by itself.
- History cannot enable `safeToStop`, `safeToRestart`, or `bulkStoppable`.
- The app remains read-only.
- No stop, restart, cleanup, tray, process killing, destructive, automatic cleanup, recommendation-to-kill, or bulk-action behavior was added.

Manual checks:

- `npm test` passes.
- `npm run lint` passes.

## 2026-06-17 - Configuration and Diagnostics Center

Scope completed:

- Added read-only `GET /api/diagnostics`.
- Added diagnostics for effective configuration sources, safety config, protected processes, protected ports, common dev ports, HTTP probe settings, process-tree depth, lifecycle thresholds, history settings, retention limits, and redaction/privacy status.
- Added dev-root diagnostics that show loaded, valid, and ignored roots with safe display paths, source files, environment-variable expansion status, and rejection reasons.
- Added scanner/runtime diagnostics for active scanner source, PowerShell/CIM/netstat health, metadata limitations, last scan timings, visible/hidden totals, warnings, and recoverable errors.
- Added HTTP probe diagnostics for timeout, redirect limit, response-body metadata cap, localhost-only redirect policy, and last probe summary.
- Added process-enrichment diagnostics for project ownership, launcher context, process-tree depth, truncated trees, missing parent metadata, missing creation time, and lifecycle evaluation.
- Added history diagnostics for enabled state, safe storage location, schema version, storage health, retained snapshots/processes, oldest/newest snapshot, last write, retention limits, pruning status, and overlap warning.
- Added privacy diagnostics for command-line redaction, path redaction, disabled HTTP body persistence, disabled raw CIM persistence, disabled process-tree persistence, protected-details aggregation, and Git ignore status.
- Added dashboard diagnostics sections for System, Scanner, Dev Roots, Probing, Process Context, Lifecycle, History, and Privacy and Safety.
- Added tests for default config, valid local overrides, invalid dev roots, missing and malformed config files, scanner fallback degradation, history states, redaction/privacy, diagnostics rendering, diagnostics endpoint output, and absence of destructive controls.

Safety status:

- Diagnostics is read-only and informational.
- Diagnostics exposes no stop, restart, cleanup, process killing, tray, destructive, cleanup recommendation, or bulk-action behavior.
- Diagnostics avoids secrets, raw command lines, raw CIM snapshots, complete process trees, full response bodies, and unredacted user paths.

Manual checks:

- `npm test` passes.
- `npm run lint` passes.

## 2026-06-17 - Privacy-safe diagnostics export and troubleshooting summary

Scope completed:

- Added read-only `GET /api/diagnostics/export` with Markdown as the default format and JSON via `?format=json`.
- Added an export schema/version identifier: `localhost-watchdog.diagnostics-export.v1`.
- Added an allowlisted diagnostics export builder for application/runtime version, diagnostics status, scanner capability status, aggregate scanner counts, warning categories, HTTP probe settings/outcomes, process-context status, lifecycle status, history health/retention, dev-root counts/rejection reasons, configuration-source states, privacy flags, action flags, and export timestamp.
- Added export validation that blocks likely bearer tokens, API keys, passwords, sensitive command arguments, Windows user-profile paths, raw command fragments, credential-like query strings, cookies, authorization headers, and raw environment-variable references without echoing suspected values.
- Added a dashboard export panel with format selector, explicit Generate Preview, redaction notice, preview area, Copy Summary, Download Summary, and status text.
- Ensured copy uses only the generated preview content and download uses generic timestamped filenames.
- Added tests for Markdown/JSON export, malformed input, missing optional sections, invalid dev roots without paths, prohibited field exclusion, validation blocking, explicit preview behavior, copy preview source, generic filenames, no automatic upload/sharing, no destructive controls, and disabled action flags.

Safety status:

- Export is read-only and built from an explicit allowlist rather than full object serialization.
- Export excludes raw command lines, parent command lines, process trees, raw CIM data, raw environment values, secrets/tokens, full user paths, raw history records, response bodies, query strings, cookies/headers, protected-process details, complete process lists, local usernames, machine identifiers, and external IP addresses.
- The app remains read-only.
- No stop, restart, cleanup, tray, process killing, destructive, cleanup recommendation, automatic upload/sharing, or bulk-action behavior was added.

Manual checks:

- `npm test` passes.
- `npm run lint` passes.

## 2026-06-17 - Export UI smoke-test phase

Scope completed:

- Refactored diagnostics export UI behavior into an injectable read-only controller for Node smoke tests.
- Added smoke tests with fake diagnostics/export responses and fake clipboard, Blob, URL, and document APIs.
- Covered initial export UI state, default Markdown selection, disabled copy/download controls, redaction notice visibility, explicit Markdown and JSON preview generation, loading/success/error status text, schema/version display, filename behavior, validation-gated enablement, format-switch invalidation, retry after failure, copy source isolation, download Blob/filename/URL cleanup behavior, accessibility labels, and absence of automatic upload/sharing/destructive controls.

Safety status:

- Export UI tests do not use the real clipboard, write files, upload data, or automate a browser.
- Copy and download remain explicit user actions against the validated preview only.
- The app remains read-only.
- No stop, restart, cleanup, tray, process killing, destructive, cleanup recommendation, automatic upload/sharing, telemetry, or bulk-action behavior was added.

Manual checks:

- `npm test` passes.
- `npm run lint` passes.

## Phase D/E managed project actions

- Added a managed project registry module that normalizes `config/projects.json` entries into validated project records with redacted display paths, preferred-port metadata, runtime tags, and fail-closed validation details.
- Added a proof-safe project start manager that refuses to launch without an injected launcher backend, requires idempotency keys, detects already-running configured projects, and reports `actionExecuted` only when dispatch is attempted.
- Added a managed restart manager that requires a configured startable project, dispatches graceful stop through the existing injected seam, verifies listener disappearance, and only then dispatches the configured start action.
- Added protected local API endpoints for listing configured projects and requesting managed start/restart while preserving session and CSRF checks.
