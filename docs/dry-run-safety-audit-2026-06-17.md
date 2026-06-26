# Dry-Run Safety Audit - 2026-06-17

Audit date: 2026-06-18  
Scope: focused safety audit of the read-only dry-run action phase  
Primary question: Is the dry-run eligibility and revalidation system sufficiently fail-closed, identity-safe, privacy-safe, and race-aware to begin designing the confirmation contract?

## 1. Executive Verdict

Verdict: NOT READY

Dry-run completion percentage: 78%

Rationale: The dry-run implementation remains read-only and contains no process-control primitive, destructive endpoint, or destructive UI control. Identity matching, protected category blocking, scanner revalidation, and action flags are directionally correct. However, the current system is not fail-closed enough to use as the immediate foundation for confirmation-contract design because request-status lookup can disclose the full dry-run result and raw token using only `requestId`, and omitted expected comparison fields can still produce `confirmation-eligible` with `unavailable` warnings. Those two issues weaken the token model and revalidation contract that a confirmation design would depend on.

Current recommendation: remain in dry-run hardening. Remediate blocker and high findings first, then re-audit before designing confirmation.

## Commands Run

| Command | Result |
| --- | --- |
| `Get-Content C:\Users\johnp\.codex\attachments\cee32aac-73ce-4f76-94c6-2c2410d14b89\pasted-text.txt` | Audit request read successfully. |
| `Select-String C:\Users\johnp\.codex\memories\MEMORY.md -Pattern "Localhost Watchdog|dry-run|action contract|D:\\localhost-watchdog"` | Used prior repo safety context; live repo files were still inspected as source of truth. |
| `Get-Content src\actions\dry-run.js`, `src\actions\eligibility.js`, `src\actions\audit.js`, `src\server.js` | Inspected dry-run implementation, eligibility, audit writer, and routes. |
| `Get-Content src\scanner\normalize.js`, `src\process\timing.js`, `src\ui\app.js`, `src\ui\render.js` | Inspected identity/timing normalization and UI behavior. |
| `Get-Content test\action-dry-run.test.js`, `test\action-api.test.js`, `test\action-ui.test.js`, `test\action-source-safety.test.js`, `test\docs-contract.test.js` | Inspected current dry-run and safety tests. |
| `npm test` | Pass: 168 tests, 168 pass, 0 fail. |
| `npm run lint` | Pass. |
| `rg -n -e "process\\.kill\\s*\\(" -e "\\btaskkill\\b" -e "\\bStop-Process\\b" -e "\\bTerminateProcess\\b" -e "\\bSuspend-Process\\b" -e "GenerateConsoleCtrlEvent" -e "Ctrl\\+C" -e "restart command" -e "/api/actions/(stop|restart|kill|cleanup)/(execute|confirm)" -e "/api/actions/(restart|kill|cleanup|bulk)" src test docs README.md` | Matches only future-design docs, prior audit text, and a negative route test for `/api/actions/stop/execute`; no runtime source process-control match found. |
| `rg -n -e "safeToStop\\s*:\\s*true" -e "safeToRestart\\s*:\\s*true" -e "bulkStoppable\\s*:\\s*true" -e "actionExecuted\\s*:\\s*true" src test docs README.md` | Matches only prose warning against `safeToStop:true`; no runtime source true action flags found. |
| Targeted Node probe: create dry-run, call `getDryRunStatus(requestId)` without token | Returned `ok:true`, full result, and `dryRunToken`; finding DRY-BLOCK-001. |
| Targeted Node probe: evaluate dry-run with empty `expected` object | Returned `passed:true`, `eligibilityState:"confirmation-eligible"`, warnings for unavailable comparisons; finding DRY-BLOCK-002. |
| `rg -n -e "C:\\\\Users\\\\johnp" -e "C:\\\\Users\\\\JP" -e "--(token|password|api-key|apikey|secret)[ =]" -e "Bearer [A-Za-z0-9._-]+" -e "api[_-]?key[ =:]" -e "\\?(token|password|api_key|apikey|secret)=" src .localhost-watchdog docs README.md test` | Matches in tests, fixtures, and docs examples; no matches in `src` or `.localhost-watchdog` from this command. |
| `npm run scan -- --compact | Select-String -Pattern '"actionEligibility"\|\"safeToStop\":true\|\"safeToStop\":false\|\"bulkStoppable\":true\|\"destructiveActionsAvailable\":false'` | Live scan succeeded. Output showed `destructiveActionsAvailable:false`, `safeToStop:false`, `actionEligibility`; no true action flags. This command updated `.localhost-watchdog/history.json`. |
| `if (Test-Path .localhost-watchdog\dry-run-audit.jsonl) ...` | No dry-run audit file present at audit time. |
| `git status --short` | Git unavailable on PATH: `git` command not recognized. Environment limitation, not a project failure. |

## 2. Findings

### Blocker

#### DRY-BLOCK-001 - Dry-run status lookup does not require proof of possession

Area: Request authorization and lookup  
Severity: Blocker  
Evidence:

- `src/actions/dry-run.js:59-101` returns a stored public result from `getDryRunStatus(requestId, options)`; token validation only happens when `options.token` is provided.
- `src/server.js:60-67` wires `GET /api/actions/dry-runs/:requestId` to optional `token` and optional `processInstanceId` query parameters.
- Targeted probe returned the full result, including `dryRunToken`, with `getDryRunStatus(result.requestId)` and no token.

Affected files:

- `src/actions/dry-run.js`
- `src/server.js`
- `test/action-api.test.js`
- `docs/07-data-contracts.md`

Why it matters: A request ID alone currently acts as a bearer lookup key and returns the actual token. That collapses the intended proof-of-possession model, exposes more process identity detail than needed, and creates a weak foundation for confirmation-token design even though no execution path exists yet.

Recommended correction:

- Require token or another opaque session-bound proof for status retrieval.
- Never return `dryRunToken` from status retrieval.
- Consider returning only a redacted status envelope from GET, with detailed checks available only when token and identity match.
- Add tests for missing token, wrong token, wrong identity, expired token, and token not echoed in status responses.

Blocks confirmation-contract design: Yes.

#### DRY-BLOCK-002 - Missing expected comparison fields can still produce `confirmation-eligible`

Area: Fresh revalidation  
Severity: Blocker  
Evidence:

- `src/actions/dry-run.js:271-274` turns omitted expected values into `status:"unavailable"`.
- `src/actions/dry-run.js:311-315` treats only `blocked` checks as failure; `warning` and `unavailable` still allow `passed:true` and `eligibilityState:"confirmation-eligible"`.
- Targeted probe with `expected:{}` returned `passed:true`, `eligibilityState:"confirmation-eligible"`, and unavailable warning codes for process name, listener port, host, project name, and project source.

Affected files:

- `src/actions/dry-run.js`
- `test/action-dry-run.test.js`
- `docs/07-data-contracts.md`
- `docs/scanner-policy.md`

Why it matters: Revalidation is supposed to compare the current process/listener/project state against the original visible record. If the caller can omit expected values and still receive `confirmation-eligible`, drift in process name, port, bind host, and project identity may not invalidate the dry run.

Recommended correction:

- Make required expected fields explicit in request validation.
- Treat unavailable comparisons for required fields as `blocked`, not warning.
- Require `expected.validationFingerprint`.
- Add tests where each required expected field is missing and must block.

Blocks confirmation-contract design: Yes.

### High

#### DRY-HIGH-001 - Process-tree truncation is warning-only in dry-run pass logic

Area: Protected boundaries  
Severity: High  
Evidence:

- `docs/action-contract-design.md:85-87` says dry-run eligibility requires a bounded process tree without protected ancestor and that failed gates move to `blocked`.
- `docs/action-contract-design.md:151-153` says max-depth truncation should prevent real execution in the first stop version.
- `src/actions/eligibility.js:67-71` allows `dry-run-eligible` with `PROCESS_TREE_TRUNCATED` warning.
- `src/actions/dry-run.js:264-266` adds `PROCESS_TREE_TRUNCATED` as warning only; `src/actions/dry-run.js:311-315` still passes with warnings.

Affected files:

- `src/actions/eligibility.js`
- `src/actions/dry-run.js`
- `test/action-dry-run.test.js`
- `docs/action-contract-design.md`

Why it matters: Truncation means the evaluator did not fully inspect ancestry. A protected boundary can exist above the max-depth cutoff. Passing dry-run with truncation may be acceptable as "inspect-only", but should not become `confirmation-eligible`.

Recommended correction:

- Keep truncated trees visible but `inspect-only`, or allow dry-run but force a non-confirmation state.
- Add explicit tests for truncated process tree blocking `confirmation-eligible`.

Blocks confirmation-contract design: Yes.

#### DRY-HIGH-002 - Lifecycle stale-candidate state is not part of dry-run blocking

Area: Eligibility state machine  
Severity: High  
Evidence:

- `docs/action-contract-design.md:85` lists "no current lifecycle stale-candidate block" as part of `dry-run-eligible`.
- `src/actions/eligibility.js:16-71` checks identity, metadata, category, confidence, project ownership, protected port/ancestor, and truncation, but not `lifecycleContext.label === "stale-candidate"`.
- `src/actions/dry-run.js` does not check lifecycle label in revalidation.
- Live scan on 2026-06-18 showed multiple visible records with `lifecycleContext.label:"stale-candidate"` and `actionEligibility.state:"inspect-only"` due to medium confidence, not due to lifecycle gating.

Affected files:

- `src/actions/eligibility.js`
- `src/actions/dry-run.js`
- `src/process/lifecycle.js`
- `test/action-dry-run.test.js`

Why it matters: A high-confidence owned dev server with stale-candidate lifecycle could pass dry-run because stale lifecycle is not a gate. That conflicts with the action-contract design's cautious lifecycle requirement.

Recommended correction:

- Add lifecycle gating to eligibility and dry-run revalidation.
- Treat `stale-candidate` as blocked for confirmation eligibility.
- Treat `possibly-detached` according to a clear policy with tests.

Blocks confirmation-contract design: Yes.

#### DRY-HIGH-003 - Token is returned in API result and can be rendered or persisted by clients

Area: Privacy and token handling  
Severity: High  
Evidence:

- `src/actions/dry-run.js:281-300` returns both `dryRunToken` and a token metadata object in public dry-run results.
- `src/ui/app.js:158-162` stores the full response object in `state.dryRuns`.
- `src/ui/render.js:305-314` renders all `dryRun.checks`, but not `dryRunToken`; current UI does not display the token.
- Status retrieval without token returns the stored `dryRunToken` as shown in targeted probe.

Affected files:

- `src/actions/dry-run.js`
- `src/server.js`
- `src/ui/app.js`
- `docs/07-data-contracts.md`

Why it matters: The token is not an execution credential today, but future confirmation design will likely build on token possession. Returning and storing the raw token broadly increases accidental leak risk and makes replay-hardening harder.

Recommended correction:

- Return raw token only in the initial dry-run response if truly needed.
- Do not return raw token from status retrieval.
- Avoid storing raw token in UI state unless required; if stored, isolate it from generic render state.
- Do not document token examples as ordinary output fields without proof-of-possession rules.

Blocks confirmation-contract design: Yes.

### Medium

#### DRY-MED-001 - Dry-run request lacks CSRF/session nonce and idempotency is optional

Area: API safety  
Severity: Medium  
Evidence:

- `docs/action-contract-design.md:574-580` calls for same-origin requests, CSRF token or same-origin nonce, and idempotency key.
- `src/server.js:121-130` checks Host and Origin where present.
- `src/actions/dry-run.js:33-40` uses idempotency only when supplied.
- `src/ui/app.js:175-181` generates an idempotency key, but API validation does not require one and has no CSRF/session nonce.

Affected files:

- `src/server.js`
- `src/actions/dry-run.js`
- `src/ui/app.js`
- `test/action-api.test.js`

Why it matters: Dry-run is read-only, but it does run scanner work and writes audit records. Optional idempotency and absent CSRF/session nonce leave more room for request flooding, browser resubmission ambiguity, and cross-origin edge cases before confirmation work begins.

Recommended correction:

- Require idempotency keys for dry-run POST.
- Add a local UI-issued nonce or CSRF token before confirmation design.
- Add tests for missing idempotency, duplicate idempotency, and cross-origin POST with absent Origin but suspicious headers.

Blocks confirmation-contract design: No, if remediated before confirmation routes are introduced.

#### DRY-MED-002 - Host/Origin validation is useful but not complete request authorization

Area: API safety  
Severity: Medium  
Evidence:

- `src/server.js:121-130` accepts requests with no Origin when Host is `localhost`, `127.0.0.1`, or `::1`.
- `src/server.js:13` defaults bind host to `127.0.0.1`, but allows `HOST` environment override.
- Tests cover external Origin rejection, but not missing Origin from non-browser clients, malformed Host variants, or HOST override behavior.

Affected files:

- `src/server.js`
- `test/action-api.test.js`
- `README.md`

Why it matters: Host and Origin checks are not a session authorization model. If future confirmation endpoints reuse this API pattern, a local process or tool could interact with action endpoints without a UI session nonce.

Recommended correction:

- Keep server binding default to loopback and document that non-loopback `HOST` is unsupported for action phases.
- Add a per-page nonce for dry-run POST before confirmation work.
- Add tests for Host variants, missing Origin, IPv6 bracket behavior, and HOST override warnings.

Blocks confirmation-contract design: No, but should be addressed first.

#### DRY-MED-003 - Audit append is privacy-safe but lacks atomic/concurrency and retention policy

Area: Audit logging  
Severity: Medium  
Evidence:

- `src/actions/audit.js:9-14` builds an allowlisted record and writes one JSON line.
- `src/actions/audit.js:41-43` uses `appendFileSync`.
- Audit record omits `dryRunToken`, command lines, paths, process trees, and raw scanner payloads.
- No tests cover concurrent dry-run audit writes, partial writes, rotation, or retention.

Affected files:

- `src/actions/audit.js`
- `test/action-dry-run.test.js`
- `docs/privacy.md`

Why it matters: JSONL append is usually adequate for a single Node process, but overlapping dry-runs could interleave or grow the audit file indefinitely. Before confirmation design, audit behavior needs clearer guarantees because confirmation/execution will depend on audit integrity.

Recommended correction:

- Define audit retention and maximum size.
- Add write serialization or an atomic append strategy appropriate for Node single-process server behavior.
- Add tests for concurrent writes and validation that tokens are never persisted.

Blocks confirmation-contract design: No, but should be remediated before execution design.

#### DRY-MED-004 - Validation fingerprint omits some material context

Area: Validation fingerprint  
Severity: Medium  
Evidence:

- `src/actions/eligibility.js:128-149` hashes process/listener IDs, PID, createdAt, processName, host, port, category, confidence level, project display/source/confidence, tree stop reason, truncation, protected boundary, and protected port.
- It does not include lifecycle label, project root/working directory, launcher/rootLauncher, process-tree chain categories, network exposure level, timing status, or HTTP reachability.
- `src/actions/dry-run.js:258-266` treats fingerprint mismatch as blocked only when expected fingerprint is supplied.

Affected files:

- `src/actions/eligibility.js`
- `src/actions/dry-run.js`
- `docs/action-contract-design.md`

Why it matters: The fingerprint is the main compact stale-state check. Omitting lifecycle, project root, and ancestry summary means some state changes that should invalidate confirmation can be missed unless another explicit comparison catches them.

Recommended correction:

- Include all action-relevant state in the fingerprint, especially lifecycle label, project root/source identity, tree root launcher or chain digest, network exposure, timing status, and protected evidence summary.
- Require fingerprint in dry-run requests.
- Keep canonical object key order fixed.

Blocks confirmation-contract design: No, if fixed before confirmation tokens rely on the fingerprint.

#### DRY-MED-005 - Project ownership drift checks do not verify root/path existence

Area: Project ownership drift  
Severity: Medium  
Evidence:

- `src/actions/dry-run.js:239-256` verifies strong ownership and compares project display name/source when supplied.
- It does not compare project root, working directory, marker path, or root existence.
- `docs/action-contract-design.md:178-179` says project root should still exist and remain inside allowed boundary when marker-derived.

Affected files:

- `src/actions/dry-run.js`
- `src/project/ownership.js`
- `test/action-dry-run.test.js`

Why it matters: A project display name/source can remain stable while the root disappears, moves, or changes casing/boundary. Confirmation should not be designed on top of a weaker project identity check.

Recommended correction:

- Include safe project root identity and marker evidence in dry-run expected fields and fingerprint.
- Revalidate root existence and configured boundary.
- Add tests for project path disappearance and root change with same display name.

Blocks confirmation-contract design: No, but should be addressed before confirmation implementation.

### Low

#### DRY-LOW-001 - Malformed JSON and oversized body handling is coarse

Area: API safety  
Severity: Low  
Evidence:

- `src/server.js:95-119` parses JSON; malformed JSON resolves to `{ invalidJson:true }`, then dry-run validation returns missing identity errors.
- Oversized request rejects and destroys the request; top-level catch maps to generic 500 via `safeError("server", error)`.
- No tests cover malformed JSON or oversized body behavior for dry-run routes.

Affected files:

- `src/server.js`
- `test/action-api.test.js`

Why it matters: Safe errors are still returned, but request validation would be clearer and easier to monitor if malformed JSON and oversized bodies had stable codes/statuses such as `INVALID_JSON` and `REQUEST_BODY_TOO_LARGE`.

Recommended correction:

- Return 400 for malformed JSON and 413 for oversized bodies with stable safe codes.
- Add tests for both.

Blocks confirmation-contract design: No.

#### DRY-LOW-002 - UI wording still uses "Passed" and "Dry-run passed"

Area: UI safety  
Severity: Low  
Evidence:

- `src/ui/render.js:322-328` labels dry-run success as `Passed`, `Passed with warnings`, or `Dry-run passed`.
- `src/ui/render.js:301` also displays `Permission not granted`, which partially mitigates the issue.
- Tests accept these labels.

Affected files:

- `src/ui/render.js`
- `test/action-ui.test.js`

Why it matters: "Passed" can be interpreted as readiness to act. The UI is currently read-only, but confirmation design should use wording like "Safety check complete" and keep "not permission to stop" prominent.

Recommended correction:

- Change labels to "Safety check complete" and "Safety check complete with warnings."
- Keep "No action was executed" and "Permission not granted" adjacent to the status.

Blocks confirmation-contract design: No.

#### DRY-LOW-003 - Status endpoint returns 404 for expired stored results

Area: Expiration and replay  
Severity: Low  
Evidence:

- `src/server.js:67` returns 404 whenever `result.ok === false`.
- `src/actions/dry-run.js:87-95` returns an expired result with `ok:false`, `status:"expired"`.
- Tests assert manager-level expired status, not API HTTP status semantics.

Affected files:

- `src/server.js`
- `test/action-api.test.js`

Why it matters: Expired is not the same as missing. A future UI or audit viewer may need to distinguish missing/not found from expired using HTTP status or stable code.

Recommended correction:

- Add a code such as `DRY_RUN_EXPIRED` and return 410 Gone, or return 200 with `status:"expired"` for read-only status.
- Add API tests.

Blocks confirmation-contract design: No.

### Informational

#### DRY-INFO-001 - Runtime source remains read-only

Area: Source safety  
Severity: Informational  
Evidence:

- `test/action-source-safety.test.js` checks no `process.kill`, `Stop-Process`, `taskkill`, `TerminateProcess`, `Suspend-Process`, or execution/confirmation route patterns in `src`.
- Source search found no runtime matches for process-control primitives.
- `src/classifier/confidence.js:146-148` returns `safeToStop:false`, `safeToRestart:false`, and `bulkStoppable:false`.
- Live scan output included `destructiveActionsAvailable:false` and `safeToStop:false`.

Affected files:

- `src/classifier/confidence.js`
- `src/actions/*`
- `src/server.js`
- `src/ui/*`

Why it matters: This supports continued dry-run hardening without immediate process safety risk.

Recommended correction: Keep source-safety tests as required gates.

Blocks confirmation-contract design: No.

#### DRY-INFO-002 - Git unavailable on PATH during audit

Area: Environment  
Severity: Informational  
Evidence:

- `git status --short` failed with `git : The term 'git' is not recognized...`.

Affected files: None.

Why it matters: The audit could not use Git to enumerate changed files or confirm worktree state.

Recommended correction: None for project runtime. Use Git from a shell where it is on PATH when needed.

Blocks confirmation-contract design: No.

## 3. Eligibility-State Verification Table

| State | Intended meaning | Implementation evidence | Audit result |
| --- | --- | --- | --- |
| `ineligible` | Absolute blocks or missing action-grade identity/metadata | `evaluateRecordEligibility` returns ineligible on blocked checks; absolute categories are `system-or-protected`, `database`, `local-ai-server`, `unknown-listener` | Mostly pass; lifecycle stale and truncation policy gaps remain |
| `inspect-only` | Visible but not sufficient for dry-run | Medium confidence and weak ownership produce inspect-only | Pass |
| `dry-run-eligible` | Enough evidence to run validation only | High dev category plus strong project ownership plus stable identity can produce `canDryRun:true` | Conditional; tree truncation and stale lifecycle not enforced strongly enough |
| `confirmation-eligible` | Fresh dry-run passed, but no execution exists in this phase | `finalizeResult` sets this when no blocked checks exist | Fail-closed gap: unavailable required comparisons can still reach this state |
| `blocked` | Candidate failed dry-run gates | Blockers created for PID/creation mismatch, category, protected, confidence, ownership, metadata, scanner/audit failure | Pass for tested blockers; needs more missing-field tests |

## 4. Revalidation Coverage Table

| Required check | Current coverage | Evidence | Result |
| --- | --- | --- | --- |
| Fresh scanner snapshot | Yes | `createDryRunManager` default `scanProvider` calls `scanWindows({ skipHistory:true })` | Pass |
| PID exists | Yes | `findCurrentRecord`; `PID_EXISTS` block when no record | Pass |
| PID + creation time | Yes, via `processInstanceId` | `CREATION_TIME_MATCH` compares current and requested processInstanceId | Pass |
| Unstable/session ID | Yes at request validation | `validateDryRunRequest` blocks `session-unstable-*` | Pass |
| Listener ID | Yes | `LISTENER_ID_MATCH` | Pass |
| Port ownership | Partial | Port compared when expected port supplied | Blocker: missing expected port becomes warning |
| Bind host | Partial | Host compared when expected host supplied | Blocker: missing expected host becomes warning |
| Process name | Partial | Name compared when expected name supplied | Blocker: missing expected name becomes warning |
| Category | Yes | Blocks non-dev and absolute categories | Pass |
| Confidence | Yes | Requires `confidenceLevel === "high"` | Pass |
| Project ownership | Partial | Strong ownership required; name/source compared if supplied | Medium gap: root/path existence not checked |
| Protected process/port | Yes | Category/protected evidence checks | Pass |
| Protected ancestor | Yes for detected chain | `hasProtectedAncestor` checks protected-boundary stop and chain category | Pass, with truncation caveat |
| Process-tree truncation | Weak | Warning only | High finding |
| Lifecycle stale-candidate | Missing | No dry-run or eligibility gate | High finding |
| Scanner unavailable | Yes | `SCANNER_UNAVAILABLE` blocker | Pass |
| Audit unavailable | Yes | `AUDIT_LOG_UNAVAILABLE` blocker | Pass |
| Fingerprint drift | Partial | Blocks only when fingerprint supplied | Medium gap: fingerprint should be required and broader |

## 5. Protected-Boundary Verification Table

| Boundary | Current behavior | Audit result |
| --- | --- | --- |
| Protected process | Classifier marks `system-or-protected`; dry-run blocks absolute category | Pass |
| Protected port | Classifier evidence and dry-run protected-port check | Pass |
| Protected ancestor | `hasProtectedAncestor` checks tree stop reason and chain category | Pass when ancestry is available |
| Tree truncation | Warning only | High risk |
| Database | Absolute block category | Pass |
| Local AI | Absolute block category | Pass |
| Unknown listener | Absolute block category | Pass |
| Browser/editor helper | Non-dev category blocks dry-run | Pass |
| Missing metadata | Missing creation/process metadata blocks | Pass |
| Invalid/future/skewed creation time | Timing status not available blocks eligibility; dry-run checks timing status | Pass |
| Unverifiable privilege | Blocks only if `current.privilege.elevated === true && verified !== true`; no owner/session/elevation source currently populates this | Partial |

## 6. API and Token-Security Review

Strengths:

- Server defaults to `127.0.0.1`.
- Host and Origin checks reject non-localhost values where present.
- Dry-run mutation is only via POST.
- Status endpoint is GET but read-only.
- `Cache-Control: no-store` is set on JSON responses.
- Request IDs use `crypto.randomBytes(16)`, and tokens use `crypto.randomBytes(24)`.
- Tokens do not authorize execution and no execution endpoint exists.

Gaps:

- Status retrieval does not require token and returns the token.
- CSRF/session nonce is not implemented.
- Idempotency key is optional.
- Malformed JSON and oversized body responses need stable status codes.
- Request flooding limits are not present.
- `HOST` override could bind the server outside loopback unless operationally constrained.

## 7. Privacy Data-Flow Review

Collection: Scanner collects TCP listeners and CIM metadata. Command lines and executable paths are redacted during normalization.  
Normalization: Process identity uses PID plus creation time; user-profile paths are compacted.  
Dry-run API: Returns safe check messages, but currently includes raw `dryRunToken` and can return it from status lookup without token proof.  
Audit: `buildDryRunAuditRecord` is allowlisted and omits tokens, command lines, process trees, and raw scanner payloads.  
UI: Renders eligibility checks and safe messages; current renderer does not display token directly, but full dry-run result is stored in UI state.  
Persistence: Live history search found no source/history matches for raw user paths or secret patterns. No dry-run audit file existed during this audit.  
Fixtures/tests/docs: Secret-like strings exist intentionally in tests and docs examples to validate redaction.

## 8. Race-Condition Review

| Race | Current mitigation | Residual risk |
| --- | --- | --- |
| Process exits during scan | Missing current record blocks | Needs integration test with controlled process exit |
| PID reused immediately | PID plus creation time mismatch blocks | Covered by unit test |
| Port reassigned after revalidation | Current dry-run checks port at dry-run time only | Future confirmation/execution must repeat revalidation immediately |
| Parent process exits | Missing parent metadata currently can still allow if other evidence strong | Needs clearer policy before confirmation |
| Project metadata changes | Name/source compared if expected supplied; root not checked | Medium finding |
| Overlapping scanner runs | No lock; scanner is read-only | Acceptable for dry-run but confirmation must lock per process instance |
| Simultaneous dry-run requests | In-memory idempotency only when key supplied | Medium finding |
| Audit-log write collision | Synchronous append in one Node process; no concurrency tests | Medium finding |
| Browser resubmission | UI idempotency key changes each click; API idempotency optional | Needs stricter idempotency |
| Expired result replay | Manager returns expired after TTL if retained; request path prunes expired on new requests | Mostly pass; API status semantics need improvement |

Future execution phase must revalidate PID, creation time, listener ownership, host, category, confidence, project identity, protected state, process tree, privilege/session, and audit availability again immediately before any process signal.

## 9. Test-Quality Assessment

Strong coverage:

- PID reuse with different creation time.
- Multiple ports for same process.
- Missing/unstable identity.
- Absolute category blocks.
- Protected tree boundary.
- Process name/host/project/category/fingerprint changes when expected fields exist.
- Scanner unavailable.
- Audit write failure.
- Expiration, wrong token, wrong identity at manager level.
- API route basics and unsupported Origin.
- UI safety labels and absence of destructive controls.
- Source-level absence of destructive primitives.

Weak coverage:

- Status retrieval without token.
- Missing required expected fields.
- Required validation fingerprint.
- API-level expired status semantics.
- Malformed JSON, oversized request, content-type validation.
- Idempotency required versus optional.
- Tree truncation and lifecycle stale-candidate gating.
- Project root disappearance.
- Host header variants and HOST override behavior.
- Token not returned from status endpoint.

Missing required pre-confirmation coverage:

- Concurrency/audit write collision.
- Controlled live Windows integration test for process exit/reuse/reassignment.
- Owner/session/elevation metadata unavailable versus mismatch.
- Non-loopback/wildcard dry-run policy.
- Duplicate listener conflicting ownership.
- Request flooding and same-origin nonce behavior.

## 10. Source-Safety Verification

Runtime source search found no process-control primitives in `src`:

- no `process.kill`
- no `taskkill`
- no `Stop-Process`
- no `TerminateProcess`
- no `Suspend-Process`
- no `GenerateConsoleCtrlEvent`
- no execution/confirmation/restart/kill/cleanup/bulk route in runtime source

Matches from broader search were future-design documentation or negative tests. `src/classifier/confidence.js` hardcodes all process action flags false. Live compact scan showed `destructiveActionsAvailable:false` and `safeToStop:false`.

## 11. Required Remediation Order

### Audit Blockers First

1. Require proof-of-possession for dry-run status retrieval and stop returning raw tokens from status.
2. Make missing required expected fields block dry-run instead of warning.

### Required Read-Only Fixes

3. Make process-tree truncation block `confirmation-eligible`.
4. Add lifecycle stale-candidate gating to eligibility and dry-run.
5. Require validation fingerprint in dry-run requests and broaden fingerprint inputs.
6. Add project root/path existence and boundary drift checks.
7. Add CSRF/session nonce and require idempotency keys.

### Optional Improvements Before Confirmation Design

8. Add stable malformed JSON and oversized body response codes.
9. Add audit retention and concurrency tests.
10. Improve UI language from "Passed" to "Safety check complete."
11. Clarify expired status HTTP semantics.

### Deferred Until Confirmation-Contract Design

12. Typed confirmation challenge wording.
13. Execution lock design.
14. Privilege/elevation execution behavior.
15. Any stop, restart, kill, cleanup, tray, signaling, or bulk behavior.

## 12. Go/No-Go Recommendation

Recommendation: No-go for confirmation-contract design.

The dry-run phase is safe to continue running as read-only inspection because no execution path exists and action flags remain false. It is not yet strong enough as the base for confirmation design. Confirmation work should wait until status-token proof-of-possession and missing-field fail-closed behavior are remediated and re-audited.

Conditional go criteria:

- Dry-run status retrieval requires token or equivalent session-bound proof.
- Raw dry-run tokens are not returned from status and are not generally rendered.
- Missing expected comparison fields, missing fingerprint, truncated tree, stale-candidate lifecycle, and project root drift block confirmation eligibility.
- API tests cover malformed input, idempotency, token absence, token mismatch, expiry, and local-origin/session-nonce behavior.
- Audit write concurrency and privacy tests are in place.

## 2026-06-18 Remediation Addendum

Implemented focused remediation for the blocker and high-priority dry-run safety findings while keeping the app read-only.

- Replaced request-ID-only status lookup with `POST /api/actions/dry-runs/status`.
- Added a separate opaque `statusAccessToken` for status reads only. Stored dry-run results keep a hash, and valid status retrieval does not return the raw token.
- Retired token-in-query status lookup. Missing, malformed, wrong, expired, cross-request, or unknown tokens return a generic unavailable response without request-existence disclosure.
- Added a machine-readable mandatory required-field policy for expected PID, creation time, process identity, listener identity, port, host, process name, category, confidence level, validation fingerprint, and project fields.
- Made unavailable, malformed, warning, or blocked mandatory evidence fail closed for `confirmation-eligible`.
- Added fail-closed checks for category/confidence drift, project root drift, process-tree boundary availability, process-tree truncation, stale-candidate lifecycle, PID value, creation-time value, scanner availability, and audit-log availability.
- Updated API, UI wording, data-contract docs, scanner policy, privacy notes, and tests to use `statusAccessToken` and keep action flags disabled.

Remaining condition after this remediation: run a targeted re-audit of the dry-run status-token model, mandatory-field matrix, API edge cases, and audit/log privacy before beginning confirmation-contract implementation.
