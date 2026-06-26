# Localhost Watchdog Read-Only Milestone Audit

Date: 2026-06-17  
Scope: README, specifications, documentation, configuration examples, source code, API contracts, UI, fixtures, and test suite.  
Mode: Read-only audit. No product code, tests, fixtures, or configuration were changed.

## 1. Executive Verdict

Verdict: PASS WITH CONDITIONS

Read-only completion percentage: 88%

The read-only foundation is substantially complete: the scanner is Windows-first, classification is explainable, action flags are hard-disabled, HTTP probing is bounded, history is privacy-minimized, diagnostics/export are allowlist-oriented, dashboard states are covered, and the full test/lint suites pass.

The project should remediate specific read-only findings before beginning action-contract design. The highest-risk issues are not implemented destructive behavior; they are identity, privacy, and contract-readiness issues that would become dangerous if future actions used the current records directly.

Final recommendation: remediate specific findings first, then begin action-contract design.

## 2. Commands Run and Results

| Command | Result |
| --- | --- |
| `npm test` | PASS. Node test runner reported 140 tests, 140 pass, 0 fail. |
| `npm run lint` | PASS. `node scripts/lint.js` exited 0. |
| `git status --short` | Failed in this environment because `git` is not available on PATH. This is an environment limitation, not a project failure. |
| `node .\watchdog.js scan --compact` | PASS. Returned `ok=True`, `platform=win32`, scanner source `Get-NetTCPConnection`, process metadata `Get-CimInstance Win32_Process`, fallback `netstat -ano`, `destructiveActionsAvailable=False`, totals `scanned=48`, `visible=9`, `hidden=39`, errors `0`. |
| `rg -n "request\.method === \"POST\"\|taskkill\|Stop-Process\|Terminate\|process\.kill\|execFile\(\|spawn\(\|/api/servers/.*/(stop\|restart\|kill\|cleanup)\|bulk" src test docs README.md` | Runtime source showed no destructive endpoint or process-kill implementation. Documentation still contains future stop/restart endpoint examples. |
| `rg -n "safeToStop\|safeToRestart\|bulkStoppable\|stop\|restart\|kill\|cleanup\|bulk" src\ui src\server.js src\classifier` | Confirmed runtime action flags are false. Found UI wording for process-tree stop reason and lifecycle text saying no stop/cleanup permission. |
| `Select-String` checks on scanner, server, probe, history files | Confirmed PID/port record ID, redacted command line, unredacted top-level executable path, GET-only runtime endpoints, probe final URL handling, and history PID-plus-createdAt identity. |

Sample live scanner record, reduced to audit-safe fields:

```json
{
  "id": "pid-38216-port-4545",
  "pid": 38216,
  "port": 4545,
  "host": "127.0.0.1",
  "url": "http://localhost:4545",
  "processName": "node.exe",
  "category": "node-dev-server",
  "safeToStop": false,
  "safeToRestart": false,
  "bulkStoppable": false,
  "commandLine": "\"C:\\Program Files\\nodejs\\node.exe\" src/server.js ",
  "executablePath": "C:\\Program Files\\nodejs\\node.exe",
  "finalUrl": "http://localhost:4545/"
}
```

## 3. Findings by Severity

### Blocker

No current read-only runtime blocker was found. No destructive endpoint or process action implementation was found in `src/`.

### High

#### H-001: Visible API record IDs do not include process creation time

Area: Process identity, API/data contracts  
Severity: High  
Evidence: `src/scanner/normalize.js:96` builds `id` as `pid-${connection.pid}-port-${connection.port}`. `docs/07-data-contracts.md:55` documents the same shape. History identity correctly uses `pid:${pid}|created:${createdAt}` in `src/history/store.js:341-343`.  
Affected files: `src/scanner/normalize.js`, `src/history/store.js`, `docs/07-data-contracts.md`  
Why it matters: PID/port is not a stable process-instance identity. PID reuse or port movement can make a future action target ambiguous. Current history avoids this, but the visible API/UI identity does not.  
Recommended correction: Add a read-only `processInstanceId` or `identity` object to visible records using PID plus creation time when available, explicitly mark PID/port `id` as display/session-only, and document missing-creation-time behavior.  
Blocks action-contract design: Yes.

#### H-002: Top-level `executablePath` can be emitted unredacted

Area: Privacy and redaction  
Severity: High  
Evidence: `src/scanner/normalize.js:104` redacts `commandLine`, but `src/scanner/normalize.js:105` emits `executablePath: process.executablePath || null`. Project, launcher, and process-tree paths are redacted elsewhere, but the top-level field is not.  
Affected files: `src/scanner/normalize.js`, `src/ui/render.js`, `docs/scanner-policy.md`, `docs/privacy.md`, tests covering scanner redaction  
Why it matters: A user-profile executable path can expose local usernames or private project structure through CLI output, `/api/servers`, fixtures, UI details, diagnostics inputs, or future exports if a caller serializes records.  
Recommended correction: Redact or compact top-level `executablePath` before normalized records leave the scanner, and add a regression test using a user-profile executable path.  
Blocks action-contract design: Yes.

#### H-003: HTTP probe `finalUrl` may preserve credential-like query strings

Area: HTTP probing, privacy, dashboard/API  
Severity: High  
Evidence: `src/scanner/probe.js:109`, `src/scanner/probe.js:122`, and `src/scanner/probe.js:142` return `finalUrl: url.toString()`. `src/ui/render.js:217` renders final URL directly. Export tests exclude query strings from export output, but API/UI can still contain a localhost redirect target with query credentials.  
Affected files: `src/scanner/probe.js`, `src/ui/render.js`, `docs/privacy.md`, `docs/07-data-contracts.md`, probe/UI tests  
Why it matters: The policy prohibits query credentials from persisted/exported data. Even if exports are allowlisted, the live API and dashboard are still privacy surfaces.  
Recommended correction: Normalize probe final URLs before emitting them by stripping query and fragment, or store separate safe origin/path fields with explicit redaction. Add tests for localhost redirects containing `?token=...`.  
Blocks action-contract design: Yes.

#### H-004: Current data-contract documentation includes future destructive endpoints

Area: API/data-contract consistency, documentation drift  
Severity: High  
Evidence: `docs/07-data-contracts.md:529-595` documents action request/result objects and `POST /api/servers/:id/stop`, `/restart`, and `/adopt`. `src/server.js:17-45` only implements read-only GET endpoints. `docs/03-architecture.md:208-209` also lists stop/restart routes.  
Affected files: `docs/07-data-contracts.md`, `docs/03-architecture.md`, `src/server.js`  
Why it matters: The authoritative contract document mixes current read-only API with future action ideas. That can mislead implementation, tests, or external callers during the action-contract phase.  
Recommended correction: Split current read-only API contracts from future action-contract sketches, clearly version them, and mark future endpoints as non-implemented design notes.  
Blocks action-contract design: Yes.

### Medium

#### M-001: Duplicate listener normalization is not clearly implemented or tested

Area: Scanner correctness  
Severity: Medium  
Evidence: `src/scanner/normalize.js:77` normalizes connection rows directly; inspected code did not show a de-duplication pass for equivalent PID/host/port/protocol records. Tests cover PowerShell and netstat parsing, but not dual-stack or duplicate listener collapse.  
Affected files: `src/scanner/normalize.js`, `test/scanner.test.js`  
Why it matters: Windows may report IPv4 and IPv6 dual-stack listeners, wildcard aliases, or duplicate rows. Duplicate cards could inflate totals and confuse future revalidation.  
Recommended correction: Define duplicate semantics and add tests for IPv4/IPv6/wildcard duplicates before changing behavior.  
Blocks action-contract design: Yes, because target enumeration must be deterministic.

#### M-002: Recoverable and unexpected error messages may be surfaced too directly

Area: Privacy, diagnostics, API error handling  
Severity: Medium  
Evidence: `src/scanner/windows.js` records `error.message` for scanner and history failures; `src/diagnostics/index.js:213` returns recoverable error messages; `src/server.js:58` returns `message: error.message` for unexpected API failures; `src/ui/app.js` renders API error messages.  
Affected files: `src/scanner/windows.js`, `src/diagnostics/index.js`, `src/server.js`, `src/ui/app.js`, diagnostics tests  
Why it matters: Most expected errors are benign, but command/runtime exceptions can include paths, arguments, or environment-derived text.  
Recommended correction: Convert errors to redacted safe categories plus short safe messages before API/diagnostics/UI surfaces, and log raw errors only if a future local debug mode is explicitly designed.  
Blocks action-contract design: No, but should be fixed before action work.

#### M-003: History has no inter-process write lock

Area: History reliability, concurrency  
Severity: Medium  
Evidence: `src/history/store.js:156-157` uses temp-write plus rename for atomic replacement, which protects partial writes. No lock or compare-and-swap mechanism was found. Diagnostics mention possible overlapping-scan warning where detectable.  
Affected files: `src/history/store.js`, diagnostics docs/tests  
Why it matters: Concurrent scans can lose a history update even though each write is atomic. This does not block live scans, but historical context can become inaccurate.  
Recommended correction: Add a read-only-safe single-writer guard, advisory lock, or generation check before relying on history for future action context.  
Blocks action-contract design: No, if history remains informational only.

#### M-004: Medium confidence can be reached by stacking partial signals

Area: Classification and confidence  
Severity: Medium  
Evidence: `src/classifier/confidence.js` adds local bind, common port, dev-root, runtime, launcher, process-tree, and project evidence. High confidence requires strong evidence, but medium confidence can still result from several weak or contextual signals.  
Affected files: `src/classifier/confidence.js`, classifier tests, data contracts  
Why it matters: This is acceptable for read-only visibility, but it is not sufficient for action permission.  
Recommended correction: Document that display confidence is not action confidence, and create a separate future action eligibility model with negative evidence and revalidation gates.  
Blocks action-contract design: No, if action confidence is separate.

#### M-005: `netstat` fallback necessarily loses metadata

Area: Scanner correctness, fallback behavior  
Severity: Medium  
Evidence: `src/scanner/windows.js` falls back to `netstat -ano` when PowerShell TCP collection fails or returns no connections. `netstat` supplies host/port/PID, but not creation time, command line, executable path, or parent metadata; those still depend on CIM.  
Affected files: `src/scanner/windows.js`, `src/scanner/normalize.js`, docs/scanner-policy.md  
Why it matters: Fallback can preserve listener enumeration while losing process metadata, lowering confidence and history identity availability. If `Get-NetTCPConnection` returns zero for reasons other than failure, fallback use may also change the interpretation of an empty result.  
Recommended correction: Keep fallback visibly degraded, add tests for partial CIM absence plus netstat fallback, and make metadata-loss limitations explicit in scanner diagnostics.  
Blocks action-contract design: No, but action design must treat fallback records as non-actionable until revalidated.

#### M-006: Export route matching is broader than needed

Area: API routing  
Severity: Medium  
Evidence: `src/server.js:32` handles any GET URL beginning with `/api/diagnostics/export`, not just the exact endpoint plus query string.  
Affected files: `src/server.js`, API tests  
Why it matters: This is not destructive, but strict routing matters before adding any future action API surface.  
Recommended correction: Parse URLs and match pathname exactly.  
Blocks action-contract design: No, but should be fixed before adding new endpoints.

### Low

#### L-001: Launcher UI wording can overstate certainty

Area: Launcher/process-tree context, dashboard wording  
Severity: Low  
Evidence: Dashboard copy can render phrases such as "Launched from VS Code" based on parent metadata heuristics. Source evidence treats launcher as inferred context.  
Affected files: `src/ui/render.js`, launcher tests/docs  
Why it matters: Parent ancestry is strong context, but it is still observed metadata, not proof of user intent.  
Recommended correction: Prefer wording such as "Parent suggests VS Code" or "Observed parent: VS Code" in UI labels.  
Blocks action-contract design: No.

#### L-002: Export validation is heuristic

Area: Export safety  
Severity: Low  
Evidence: `src/diagnostics/export.js` uses an allowlist builder plus regex validation for common secret patterns. This is strong defense-in-depth, but regex validation can miss uncommon standalone tokens or over-block benign strings.  
Affected files: `src/diagnostics/export.js`, export tests, docs/privacy.md  
Why it matters: Allowlisting mitigates most risk, but validation should be treated as a backstop, not a complete sanitizer.  
Recommended correction: Keep export source allowlisted and add test cases for JWT-like tokens, private key markers, AWS-style key IDs, URL userinfo, and UNC/user-share paths.  
Blocks action-contract design: No.

#### L-003: Process-tree "Stop" label can be confused with an action

Area: Dashboard wording  
Severity: Low  
Evidence: `src/ui/render.js:337` renders `Stop <strong>{stopReason}</strong>` for process-tree traversal stop reason. It is not a control, but the word "Stop" appears near lifecycle text.  
Affected files: `src/ui/render.js`, UI smoke/accessibility tests  
Why it matters: The dashboard intentionally avoids action language.  
Recommended correction: Rename to "Traversal ended" or "Tree ended".  
Blocks action-contract design: No.

### Informational

#### I-001: Tests and lint pass

Area: Test quality  
Severity: Informational  
Evidence: `npm test` reported 140 passing tests. `npm run lint` exited 0.  
Affected files: Test suite  
Why it matters: The suite provides broad regression coverage, but passing tests do not prove untested behavior is correct.  
Recommended correction: Add targeted tests listed in this audit.  
Blocks action-contract design: No.

#### I-002: Runtime safety invariants are currently upheld

Area: Safety invariants  
Severity: Informational  
Evidence: `src/classifier/confidence.js:146-148` hardcodes action flags false. `src/server.js:17-45` exposes GET-only health, servers, diagnostics, export, and static assets. Runtime source search found no `taskkill`, `Stop-Process`, `process.kill`, `spawn`, or `execFile` action implementation.  
Affected files: `src/classifier/confidence.js`, `src/server.js`, UI files  
Why it matters: The current application is read-only at runtime.  
Recommended correction: Keep invariant tests as mandatory gates.  
Blocks action-contract design: No.

#### I-003: Git unavailable on PATH during audit

Area: Tooling  
Severity: Informational  
Evidence: `git status --short` failed because `git` is not recognized on PATH.  
Affected files: None  
Why it matters: The audit could not use Git to verify worktree cleanliness.  
Recommended correction: Run Git status from an environment where Git is available before committing or release tagging.  
Blocks action-contract design: No.

## 4. Safety-Invariant Verification Table

| Invariant | Status | Evidence |
| --- | --- | --- |
| `safeToStop` remains false | PASS | `src/classifier/confidence.js:146`; tests include action flag assertions. |
| `safeToRestart` remains false | PASS | `src/classifier/confidence.js:147`; tests include action flag assertions. |
| `bulkStoppable` remains false | PASS | `src/classifier/confidence.js:148`; tests include action flag assertions. |
| No stop endpoint exists at runtime | PASS | `src/server.js:17-45` only implements GET read-only routes. |
| No restart endpoint exists at runtime | PASS | Same as above. |
| No kill/cleanup endpoint exists at runtime | PASS | Runtime source search found no destructive endpoint or kill implementation. |
| No hidden destructive browser action exists | PASS | UI/export tests assert no stop/restart/kill/cleanup/bulk controls; source search found no such controls. |
| No automatic remediation exists | PASS | No process action, cleanup, upload, telemetry, or sharing code found in runtime source. |
| Documentation does not mention future destructive endpoints | FAIL | `docs/07-data-contracts.md:587-591` and `docs/03-architecture.md:208-209` mention future stop/restart routes. Runtime remains safe. |

## 5. Privacy Data-Flow Review

Collection: PowerShell `Get-NetTCPConnection` and `Get-CimInstance Win32_Process` are collected first; `netstat -ano` is fallback. Raw CIM is used in memory for normalization/enrichment. No raw CIM persistence was found.

Normalization: Command lines are redacted during normalization. Parent/process-tree command lines and configured paths are redacted. Finding H-002 shows top-level `executablePath` is not consistently redacted. Finding H-003 shows probe `finalUrl` can retain query strings.

Rendering: Dashboard rendering escapes HTML and labels hints/uncertainty. It renders command lines from normalized records and process-tree details from redacted fields. It also renders `httpProbe.finalUrl`, so URL query stripping must happen before rendering.

Persistence: History persists process instance ID, first/last seen, counts, most recent port, category, confidence level, privacy-safe project display identity, HTTP reachable state, lifecycle label/score, and scan ID. Tests verify command lines, paths, process trees, and secrets are not persisted.

Diagnostics: Diagnostics reports configuration and scanner health. It avoids known raw objects, but recoverable error messages are carried as strings and need stricter categorization/redaction before being considered fully privacy-safe.

Export: Export construction is allowlist-based and supports Markdown plus JSON. Tests verify command lines, paths, process trees, raw history, query strings, and secrets are excluded. Validation blocks common sensitive patterns without echoing the suspected value.

## 6. Audit Area Results

Scanner correctness: Mostly strong. Primary PowerShell/CIM path and netstat fallback exist. IPv4, IPv6, loopback, wildcard, protected process, and fallback parsing are covered by tests. Missing metadata degrades rather than crashes. Duplicate listener normalization needs explicit behavior and tests. Netstat fallback loses metadata and should be visibly degraded.

Process identity: History correctly uses PID plus creation time and refuses missing creation time as stable identity. Visible API/UI IDs still use PID plus port only, which is insufficient for future action targeting.

Classification and confidence: Categories are explicit and evidence-based. High confidence requires stronger evidence. Medium confidence can still be inflated by contextual weak signals; this is acceptable for read-only display but must not become action confidence.

Project ownership: Configured dev roots are used as search boundaries; invalid roots are reported; marker-confirmed versus inferred ownership is distinguishable through `confidence`, `source`, and evidence. Dev-root-only inference remains low confidence and does not grant action permission.

Launcher and process tree: Parent and ancestry enrichment are bounded, redacted, cycle-protected, and depth-limited. Protected boundaries and missing metadata are handled. UI wording should avoid overstating certainty.

HTTP probing: Probe behavior is bounded by timeout, redirect limit, localhost-only default, body cap, and no body persistence. External redirects are blocked. HTTPS localhost is supported by protocol selection but likely limited by local certificate behavior. `finalUrl` query stripping is the main privacy gap.

Network exposure: Wildcard binding is treated as a warning about binding, not proof of external reachability. Dashboard language is appropriately cautious.

Lifecycle and stale-candidate logic: Age alone does not mark stale. Databases, local AI servers, browser/editor helpers, and protected/system listeners are excluded or contextual. Process-tree truncation is treated as a limitation. Stale candidate requires multiple current-state signals and never grants action permission.

History: Retained fields match privacy goals. Missing, invalid, schema-mismatched, interrupted, disabled, and write-failure states are recoverable. Atomic replacement avoids partial writes; concurrent lost updates remain a risk.

Configuration and diagnostics: Defaults, local overrides, malformed files, invalid roots, history health, scanner fallback, and privacy status are covered. Settings affecting scanner, probe, tree, lifecycle, history, retention, and redaction are represented. Recoverable error messages need stricter sanitization.

Privacy and redaction: Strong overall, especially command-line, process-tree, history, and export surfaces. Gaps are top-level executable path, probe final URL query strings, and raw unexpected error messages.

Dashboard and accessibility: Strong smoke/accessibility coverage for states, filters, sorting, details, export UI, and destructive-control absence. Real browser layout/accessibility remains untested.

Export safety: Strong. Preview is explicit, format switching invalidates stale preview, copy/download use preview state only, validation blocks known sensitive patterns, and there is no automatic upload/share/telemetry.

API and data-contract consistency: Runtime API is read-only. Contracts contain stale/future action content and should be split/versioned before action design.

Test quality: Strong for unit, fixture, DOM-helper, and smoke behavior. Weak for real Windows integration, duplicate normalization, concurrent history writes, local redirect credential queries, top-level path redaction, and unexpected error privacy.

Documentation consistency: README, progress, scanner policy, privacy, diagnostics, and export docs are mostly aligned with current behavior. `docs/07-data-contracts.md` and `docs/03-architecture.md` need current-vs-future separation.

Future action-readiness: Not ready until high findings are fixed and future action gates are specified independently from current display confidence.

## 7. Test Coverage Assessment

Strong coverage:

- Category classification for Node, Python, local AI, database, browser/editor helpers, Java, unknown, protected/system.
- Redaction of command-line secrets and parent/process-tree command data.
- HTTP probe success, JSON, timeout, refused/closed, redirect-to-localhost, external redirect block, non-HTTP, all-interface warning, and error redaction.
- Project ownership markers, configured dev roots, invalid roots, nested roots, path redaction, and action flags.
- Launcher and multi-hop process-tree patterns, cycle detection, max depth, protected boundary, and redaction.
- Lifecycle labels, category exclusions, stale-candidate multi-signal behavior, and action flag invariants.
- History first/repeat/consecutive/reappeared, PID reuse, port changes, corruption, schema mismatch, pruning, disabled/write-failure, and privacy.
- Diagnostics, export builder, export UI state machine, dashboard smoke, sorting/filtering, and accessibility helper tests.

Weak coverage:

- Real Windows scanner integration with localized or unusual `netstat` output.
- Duplicate listener normalization across IPv4/IPv6/wildcard aliases.
- Unexpected error message privacy at server/diagnostics boundaries.
- Real browser rendering and keyboard traversal.
- Concurrent scan/history write contention.
- HTTPS localhost certificate failure modes.

Missing required pre-action coverage:

- Stable visible process identity using PID plus creation time.
- PID/creation-time/port/process-tree revalidation immediately before any dry-run or action.
- Protected boundary revalidation after scan-to-action delay.
- Race-condition tests for PID reuse, port reassignment, and parent process exit.
- Action API contract negative tests proving no action can proceed with missing creation time, fallback-only metadata, protected category, ambiguous ownership, or stale scan ID.

## 8. Documentation and Contract Drift Report

- `README.md` accurately describes current read-only behavior and endpoints.
- `docs/scanner-policy.md` and `docs/privacy.md` align with the intended privacy model, but current code has the H-002/H-003 gaps.
- `docs/progress.md` is consistent with the phased implementation history.
- `config/safety.example.json` and `config/projects.example.json` are useful. Some future-oriented fields such as bulk exclusions are harmless but should remain clearly informational until actions exist.
- `docs/07-data-contracts.md` mixes current read-only contracts with future action contracts and uses the unstable PID/port `id` shape.
- `docs/03-architecture.md` still lists future stop/restart endpoints. This is acceptable as architecture-roadmap material only if explicitly labeled non-implemented.

## 9. Action-Readiness Gate Checklist

Before action-contract design begins, the following must be true:

- Identity certainty: visible records expose a stable process-instance identity using PID plus creation time.
- Protected boundaries: protected process, protected port, system category, and protected ancestry are revalidated before any dry-run or action.
- Ownership requirements: action eligibility uses marker-confirmed or explicitly configured ownership, not dev-root-only inference.
- PID/creation-time revalidation: target PID and creation time are rechecked immediately before dry-run and action.
- Port revalidation: target port, bind address, protocol, and owning PID are rechecked immediately before dry-run and action.
- Process-tree revalidation: parent/process-tree context is refreshed and bounded before action decisions.
- Dry-run semantics: dry-run returns exactly what would be checked, what blocks, and what evidence is missing; it performs no mutation.
- Confirmation model: user confirmation must include process identity, port, project, protected checks, and race warnings.
- Audit logging: any future action attempt logs privacy-safe decision metadata, not raw command lines or paths.
- Race-condition handling: PID reuse, port reassignment, process exit, parent exit, and privilege changes produce safe failures.
- Privilege/elevation behavior: insufficient privileges produce explicit non-actionable errors; no auto-elevation.
- Failure and partial-success behavior: action contracts define no-op, already-exited, wrong-process, and post-action verification states.
- Restart ownership and command reconstruction risks: restart is not designed from raw command-line reconstruction without explicit ownership and safe command provenance.

## 10. Recommended Remediation Order

Audit blockers first:

- None.

Required read-only fixes:

1. Add stable visible process-instance identity and document display ID versus action identity.
2. Redact or compact top-level `executablePath` in normalized/API output.
3. Strip query/fragment from HTTP probe `finalUrl` before API/UI exposure.
4. Split current data contracts from future action contracts and version the current read-only API.
5. Define and test duplicate listener normalization.
6. Sanitize scanner/server/diagnostics error messages into safe categories.

Optional improvements:

1. Tighten export route matching to exact pathname.
2. Improve launcher wording to avoid overstating certainty.
3. Rename process-tree "Stop" UI label to "Traversal ended".
4. Add export validation cases for more unusual secret/path formats.
5. Add real browser accessibility smoke tests if the app grows more interactive.

Items deferred until action-contract design:

1. Stop/restart/kill/cleanup/tray/bulk behavior.
2. Action dry-run and confirmation flows.
3. Restart command provenance.
4. Action audit logging.
5. Elevation and privilege escalation policy.

## 11. Final Recommendation

Remain read-only and remediate the high findings first. After those are fixed, the project will be in a good position to begin a narrowly scoped action-contract design phase.

The current read-only runtime is safe enough to continue hardening and inspection work. It is not yet safe to use current visible records as action targets.
