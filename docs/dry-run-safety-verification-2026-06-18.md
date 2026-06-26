# Dry-Run Safety Verification Addendum - 2026-06-18

Audit date: 2026-06-18  
Scope: targeted verification audit of remediated dry-run safety blockers  
Mode: audit-only; no runtime code changes  

## 1. Executive Verdict

Verdict: PASS WITH CONDITIONS

Updated dry-run completion percentage: 92%

Primary conclusion: DRY-BLOCK-001 and DRY-BLOCK-002 are fixed. The dry-run phase is still read-only, status lookup now requires proof of possession, and mandatory missing or unavailable revalidation evidence no longer reaches `confirmation-eligible`.

Recommendation: begin confirmation-contract design, but do not implement confirmation or execution yet. Carry the remaining medium/low findings below into the design gate, especially CSRF/session nonce, audit retention/concurrency policy, and explicit owner/session/elevation requirements.

## 2. Blocker Verification

| Finding | Verification | Result |
| --- | --- | --- |
| DRY-BLOCK-001 - request-ID-only status lookup disclosed detailed status and token | Source now requires `safeRequestId` and `safeStatusAccessToken`; stored entries keep `statusAccessTokenHash`; status route is `POST /api/actions/dry-runs/status`; retired GET route returns 404; probes confirmed requestId-only, malformed, wrong, cross-request, unknown, and expired lookup return generic unavailable. | Fixed |
| DRY-BLOCK-002 - missing expected fields could still produce `confirmation-eligible` | `src/actions/required-fields.js` defines 13 required fields and 41 mandatory check codes; probes confirmed each missing required expected field blocks; missing current values and mandatory warning/unavailable combinations downgrade to `blocked`. | Fixed |

## 3. Status-Token Security Table

| Requirement | Evidence | Result |
| --- | --- | --- |
| requestId alone cannot retrieve detailed status | Manager probe returned `DRY_RUN_STATUS_UNAVAILABLE`; API probe returned 404 with same code. | Pass |
| Detailed lookup requires `statusAccessToken` | `getDryRunStatus` rejects missing/malformed token before map lookup; valid token returns status. | Pass |
| POST-only status retrieval | `src/server.js` only serves `/api/actions/dry-runs/status` for POST; GET returns 405. | Pass |
| Retired GET routes do not expose status | `/api/actions/dry-runs/:requestId?token=...` returned 404 `NOT_FOUND`. | Pass |
| Token not accepted through URL path/query | Source-safety test rejects URL token patterns; server reads token only from header/body. | Pass |
| Token not stored in browser storage | UI source has in-memory `dryRunStatusAccess`; search found no `localStorage` or `sessionStorage`. | Pass |
| Token hash comparison timing-safe | `timingSafeTokenEqual` hashes supplied token and uses `crypto.timingSafeEqual`. | Pass |
| Missing/wrong/malformed/expired/cross-request/unknown tokens indistinguishable | Manager probe returned `DRY_RUN_STATUS_UNAVAILABLE` for all listed token failures. | Pass |
| Failure response does not reveal request existence | Unknown request ID and wrong token both return generic unavailable response. | Pass |
| Success response excludes token material | Manager/API probes showed no `statusAccessToken`, no token hash, and no `dryRunToken` in status response. | Pass |
| Token authorizes status read only | Response metadata has `authorizesStatusRead:true`, `authorizesConfirmation:false`, `authorizesExecution:false`; no confirmation/execution route exists. | Pass |
| Token expires with dry-run result | Lookup at exact expiry boundary and after expiry returned generic unavailable. | Pass |

Caveat: With a valid status token, a mismatched `processInstanceId` returns distinct `DRY_RUN_IDENTITY_MISMATCH`. This does not reopen DRY-BLOCK-001 because the token is already required, but confirmation design should decide whether identity mismatch should also be generic.

## 4. Mandatory-Field Verification Table

| Required evidence | Policy/check | Verification | Result |
| --- | --- | --- | --- |
| PID | `EXPECTED_PID_REQUIRED`, `PID_MATCH` | Missing, null, empty, malformed, zero, negative, and current missing block. | Pass |
| Creation time | `EXPECTED_CREATION_TIME_REQUIRED`, `CREATION_TIME_VALUE_MATCH`, `CREATION_TIME_AVAILABLE` | Missing or malformed expected and missing current creation time block. | Pass |
| Process-instance ID | `PROCESS_INSTANCE_ID_REQUIRED`, `STABLE_IDENTITY`, `CREATION_TIME_MATCH` | Missing or session-unstable identity blocks. | Pass |
| Listener ID | `LISTENER_ID_REQUIRED`, `LISTENER_ID_MATCH` | Missing expected listener ID blocks. | Pass |
| Port | `EXPECTED_PORT_REQUIRED`, `LISTENER_PORT_OWNERSHIP` | Missing/malformed expected port and current mismatch block. | Pass |
| Normalized bind host | `EXPECTED_HOST_REQUIRED`, `HOST_BIND_MATCH` | Missing expected host and missing/mismatched current host block. | Pass |
| Process name | `EXPECTED_PROCESS_NAME_REQUIRED`, `PROCESS_NAME_MATCH`, `PROCESS_METADATA_AVAILABLE` | Missing expected or current process name blocks. | Pass |
| Category | `EXPECTED_CATEGORY_REQUIRED`, `DEV_CATEGORY`, `CATEGORY_MATCH` | Missing category and category drift block. | Pass |
| Confidence level | `EXPECTED_CONFIDENCE_LEVEL_REQUIRED`, `HIGH_CONFIDENCE`, `CONFIDENCE_LEVEL_MATCH` | Missing confidence or non-high confidence blocks. | Pass |
| Validation fingerprint | `EXPECTED_VALIDATION_FINGERPRINT_REQUIRED`, `CONFLICTING_NEWER_SCAN` | Missing fingerprint blocks; drift blocks. | Pass |
| Project ownership fields | `EXPECTED_PROJECT_NAME_REQUIRED`, `EXPECTED_PROJECT_ROOT_REQUIRED`, `EXPECTED_PROJECT_SOURCE_REQUIRED`, `PROJECT_*_MATCH`, `PROJECT_OWNERSHIP` | Missing expected project fields and root drift block. | Pass |
| Protected process | `PROTECTED_PROCESS`, `CATEGORY_BLOCKED` | Protected/system category blocks. | Pass |
| Protected port | `PROTECTED_PORT` | Protected port evidence blocks. | Pass |
| Protected tree/boundary | `PROCESS_TREE_BOUNDARY_AVAILABLE`, `PROTECTED_TREE_BOUNDARY`, `PROCESS_TREE_NOT_TRUNCATED` | Missing tree, protected ancestor, and truncation block. | Pass |
| Scanner/revalidation availability | `SCANNER_UNAVAILABLE` | Scanner exception returns blocked safe result. | Pass |
| Process metadata availability | `PROCESS_METADATA_AVAILABLE` | Missing process name blocks. | Pass |
| Lifecycle blocking policy | `LIFECYCLE_NOT_STALE` | `stale-candidate` blocks. | Pass |
| Optional warnings | `mandatory:false` only | No current dry-run pass path relies on optional warnings. Source supports optional only when explicitly marked `mandatory:false`. | Pass |

## 5. Eligibility-Invariant Table

| Invariant or impossible state | Verification | Result |
| --- | --- | --- |
| `confirmation-eligible` requires `passed:true` | `finalizeResult` sets `passed` false when blockers or mandatory problems exist. | Pass |
| Zero blockers required | VM harness with `confirmation-eligible` plus blocker added `DRY_RUN_INTERNAL_INVARIANT_VIOLATION` and downgraded to `blocked`. | Pass |
| Zero unavailable mandatory checks required | VM harness with mandatory unavailable downgraded to `blocked`. | Pass |
| Zero warning mandatory checks required | VM harness with mandatory warning downgraded to `blocked`. | Pass |
| Stable identity required | Missing/unstable identity tests and probes block. | Pass |
| Matching validation fingerprint required | Missing fingerprint blocks; changed fingerprint blocks. | Pass |
| Unexpired result required | Status lookup at exact expiry boundary returns generic unavailable. | Pass |
| Successful audit write required | Audit writer exception adds `AUDIT_LOG_UNAVAILABLE` and blocks. | Pass |
| `actionExecuted:false` always | Tests, probes, and source search confirmed false-only action result. | Pass |
| Scanner unavailable cannot remain confirmation-eligible | Probe returned `SCANNER_UNAVAILABLE` blocker. | Pass |
| Identity changed cannot remain confirmation-eligible | Valid-token wrong-identity status returned safe mismatch with `actionExecuted:false`. | Pass |

## 6. Token Privacy Search Results

Searches inspected source, tests, docs, fixtures, and `.localhost-watchdog`.

Findings:

- Runtime source contains `statusAccessTokenHash` only inside `src/actions/dry-run.js` in the in-memory `results` map.
- Token hashes are retained only until TTL expiry or pruning. `prune(now)` deletes expired result entries on dry-run requests.
- Raw `statusAccessToken` is returned only in the initial dry-run creation response and stored temporarily in UI memory at `state.dryRunStatusAccess`.
- UI rendering strips `statusAccessToken` before writing `state.dryRuns`.
- No `localStorage` or `sessionStorage` calls were found.
- `.localhost-watchdog` contained only `history.json`; no dry-run audit file existed at audit time.
- Searches found token-like strings in tests and docs examples, including the old audit document as historical evidence. No runtime persistence file under `.localhost-watchdog` contained status tokens or token hashes.

## 7. API Edge-Case Results

| Case | Result |
| --- | --- |
| Unsupported method | `GET /api/actions/dry-runs/status` returned 405 `METHOD_NOT_ALLOWED`. |
| Unsupported content type | POST text/plain returned 415 `UNSUPPORTED_CONTENT_TYPE`. |
| Malformed JSON | Returned 400 `INVALID_JSON`; raw body not echoed. |
| Oversized body | Returned 413 `REQUEST_BODY_TOO_LARGE`. |
| Malformed request ID | Manager returned generic `DRY_RUN_STATUS_UNAVAILABLE`. |
| Malformed token | Manager returned generic `DRY_RUN_STATUS_UNAVAILABLE`. |
| Invalid Host | Returned 403 `UNSUPPORTED_ORIGIN`. |
| Invalid Origin | Returned 403 `UNSUPPORTED_ORIGIN`. |
| Duplicate status request | Multiple valid lookups returned the same read-only available status and no token material. |
| Exact expiration boundary | Returned generic `DRY_RUN_STATUS_UNAVAILABLE`. |
| Immediately after expiration | Returned generic `DRY_RUN_STATUS_UNAVAILABLE`. |
| Retry after safe failure | Subsequent valid lookup after no-token failure succeeded. |
| Simultaneous lookups | Five parallel valid lookups returned available status, no token material, no mutation. |

## 8. Audit-Log Safety Assessment

Audit source is allowlisted. `buildDryRunAuditRecord` writes:

- schema version and type
- request ID
- evaluated/expiration timestamps
- process instance ID and listener ID
- category and confidence level
- eligibility state and pass status
- `actionExecuted:false`
- check codes/statuses/messages
- warning and blocker codes/messages

Audit excludes:

- raw status tokens
- token hashes
- request bodies
- command lines
- unredacted paths
- process trees
- full scanner records
- secrets

Write-failure behavior: verified blocked with `AUDIT_LOG_UNAVAILABLE`; no action is executed.

Remaining audit findings, separate from DRY-BLOCK-001 and DRY-BLOCK-002:

- Medium: audit append uses synchronous JSONL append and has no explicit retention/rotation policy.
- Low: no dedicated concurrent append stress test was added beyond dry-run manager and source tests.

## 9. Source-Safety Verification

Runtime source remains read-only:

- No `process.kill`
- No `taskkill`
- No `Stop-Process`
- No `TerminateProcess`
- No `Suspend-Process`
- No `GenerateConsoleCtrlEvent`
- No runtime confirmation endpoint
- No runtime execution endpoint
- No restart/cleanup/bulk endpoint
- No destructive UI control
- No true `safeToStop`, `safeToRestart`, `bulkStoppable`, or `actionExecuted`

Search matches were limited to future-design docs, old audit text, and negative tests.

## 10. Remaining Findings

### Blocker

None for the two remediated dry-run blockers.

### High

None found in the remediated dry-run blocker scope.

### Medium

DRY-VERIFY-MED-001 - No CSRF/session nonce yet  
Area: API safety  
Evidence: `src/server.js` validates local Host/Origin, but no UI-issued nonce exists.  
Why it matters: Dry-run is read-only today, but confirmation-contract design should include a stronger browser/session authorization model.  
Blocks confirmation-contract design: No, but it must be part of the design before implementation.

DRY-VERIFY-MED-002 - Audit retention/concurrency policy remains undefined  
Area: Audit logging  
Evidence: `appendFileSync` JSONL write is privacy-safe, but no retention, rotation, or inter-process append lock exists.  
Why it matters: Confirmation and execution design will depend on stronger audit guarantees.  
Blocks confirmation-contract design: No; blocks future execution implementation if left unresolved.

DRY-VERIFY-MED-003 - Valid-token identity mismatch is distinguishable  
Area: Status privacy  
Evidence: wrong identity with valid token returns `DRY_RUN_IDENTITY_MISMATCH`, while bad/missing tokens return generic unavailable.  
Why it matters: This leaks only after proof of token possession, but confirmation design should decide whether all status read failures should be generic.  
Blocks confirmation-contract design: No.

### Low

DRY-VERIFY-LOW-001 - Git unavailable on PATH  
Area: Environment  
Evidence: `git status --short` failed because `git` was not recognized.  
Why it matters: Could not verify worktree state with Git in this shell.  
Blocks confirmation-contract design: No.

DRY-VERIFY-LOW-002 - Historical audit document still contains old `dryRunToken` evidence  
Area: Documentation search noise  
Evidence: privacy search finds old blocker evidence in `docs/dry-run-safety-audit-2026-06-17.md`.  
Why it matters: This is intentional historical evidence, but raw search output needs interpretation.  
Blocks confirmation-contract design: No.

## 11. Exact Commands And Results

| Command | Result |
| --- | --- |
| `Select-String C:\Users\johnp\.codex\memories\MEMORY.md -Pattern "Localhost Watchdog|dry-run|action contract|D:\\localhost-watchdog" -Context 2,2` | Prior repo safety context found; live repo files inspected as source of truth. |
| `Get-Content docs/dry-run-safety-audit-2026-06-17.md` | Inspected original blockers and remediation addendum. |
| `Get-Content docs/action-contract-design.md` | Inspected confirmation-design preconditions and non-goals. |
| `Get-Content src/actions/dry-run.js` | Inspected status-token storage, lookup, expiry, invariant, and result construction. |
| `Get-Content src/actions/required-fields.js` | Inspected machine-readable required-field and mandatory-check policy. |
| `Get-Content src/server.js` | Inspected POST-only status API, JSON parsing, Host/Origin checks, and safe errors. |
| `Get-Content src/ui/app.js`, `src/ui/render.js` | Inspected temporary UI token state and stripped render state. |
| `Get-Content src/actions/audit.js` | Inspected audit allowlist. |
| Targeted manager/API status probe | Confirmed requestId-only, malformed, wrong, cross-request, unknown, expired failures; valid status excludes token material; retired GET route returns 404. |
| Targeted required-field/invariant VM probe | Confirmed 13 required fields and 41 mandatory checks; mandatory warning/unavailable/blocker impossible states downgrade to blocked. |
| `node --test test/action-dry-run.test.js` | Pass: 11 tests. |
| `node --test test/action-api.test.js` | Pass: 3 tests. |
| `node --test test/action-ui.test.js` | Pass: 3 tests. |
| `node --test test/action-source-safety.test.js` | Pass: 4 tests. |
| `node --test test/docs-contract.test.js` | Pass: 1 test. |
| `npm test` | Pass: 172 tests. |
| `npm run lint` | Pass. |
| `npm run scan -- --compact` | Pass. Live scan returned `destructiveActionsAvailable:false`, `visible:9`, `hidden:31`; this updated `.localhost-watchdog/history.json`. |
| `git status --short` | Failed: `git` not recognized on PATH. Environment limitation, not project failure. |
| `rg` source-safety search for kill/stop/confirmation/execution patterns | Runtime source clean; matches only future docs, old audits, and negative tests. |
| `rg` true action flag search | Runtime source clean; matches only prose warnings in docs. |
| `rg` token/privacy search | Runtime persistence clean; matches expected source token handling, tests, docs examples, and old audit evidence. |
| `if (Test-Path .localhost-watchdog\dry-run-audit.jsonl) ...` | No dry-run audit file present at audit time. |

## 12. Final Recommendation

Begin confirmation-contract design.

Do not implement confirmation, execution, stop, restart, kill, cleanup, process signaling, tray behavior, elevation, bulk actions, or destructive UI controls yet.

The next design phase should specify:

- session/CSRF nonce requirements
- one-use confirmation challenge model
- repeated PID plus creation-time revalidation
- repeated listener/port ownership revalidation
- project root existence and configured-boundary revalidation
- process-tree/protected-boundary revalidation
- audit retention and concurrency guarantees
- privilege/session/elevation policy
- exact failure semantics and generic versus specific status privacy rules
