# Localhost Watchdog Confirmation Contract Design

Status: confirmation-only contract.  
Runtime implementation status: confirmation-only intent recording implemented on 2026-06-18; execution remains not implemented.  
Scope: confirmation-only design for a previously passed dry run.  
Execution status: out of scope. Confirmation must not execute, authorize, schedule, or imply a stop, restart, kill, cleanup, signal, elevation, tray action, or bulk action.

This document answers the confirmation-phase question:

> What exact contract allows a user to explicitly confirm a previously passed dry run without that confirmation itself authorizing or executing a stop?

The answer is a narrow, fail-closed confirmation contract. It records explicit user intent after a dry run has already passed, but every confirmation response still carries `actionExecuted: false` and `executionAuthorized: false`. A later execution phase would require a separate design, a separate API contract, a separate token class, fresh revalidation, and separate audit rules.

## 1. Executive Recommendation

Recommendation: implement a future confirmation-only phase only after the current dry-run phase remains verified and the remaining confirmation prerequisites are implemented as read-only or non-executing safety gates.

The confirmation phase should:

- Accept confirmation only for an unexpired, passed, confirmation-eligible dry-run result.
- Require a session-bound confirmation access token that is distinct from the dry-run status access token.
- Require same-origin POST requests with CSRF protection.
- Require exact typed confirmation wording generated for the confirmation challenge.
- Revalidate process identity, listener identity, protected boundaries, owner/session, elevation, and scanner freshness immediately before accepting confirmation.
- Write a privacy-safe audit record before returning an accepted confirmation state.
- Return a confirmation record that cannot be used to execute any action.

The confirmation phase should not:

- Set `safeToStop`, `safeToRestart`, or `bulkStoppable` to true.
- Add an execution endpoint.
- Add stop, restart, kill, cleanup, tray, elevation, or bulk behavior.
- Treat confirmation as permission to signal a process.
- Persist raw tokens, command lines, unredacted paths, process trees, request bodies, or scanner records.

Go-forward posture: PASS WITH CONDITIONS for designing a confirmation-only implementation phase.

Blocking conditions before implementation:

- Session and CSRF protections must be implemented and tested.
- Windows owner/session/elevation metadata must be available or fail closed.
- Confirmation audit retention and concurrency behavior must be explicit and tested.
- The confirmation token must be separate from dry-run status retrieval and future execution authorization.

Assumptions:

- Localhost Watchdog is still a local browser application served from a loopback origin.
- Dry-run status retrieval remains protected by `statusAccessToken`.
- The future confirmation phase runs in the same Node process as the dry-run API unless a later design says otherwise.
- Windows owner/session/elevation checks may need new metadata collection before confirmation can become available.

Unresolved decisions:

- Exact storage location for the confirmation audit log should be finalized with implementation details.
- Whether the dashboard uses a session cookie plus CSRF token, or a server-issued page nonce plus CSRF token, should be chosen during implementation. This contract allows both, but requires equivalent protections.
- Whether accepted confirmation records are retained in memory only or also exposed through a token-protected status endpoint should be decided before implementation.

## 2. Confirmation Threat Model

Confirmation adds risk even without execution because it records user intent that a later phase might consume incorrectly. The threat model treats confirmation as sensitive, but not destructive.

Threats:

- A malicious page causes the browser to submit a confirmation request through CSRF.
- A copied URL, browser history entry, referrer, or log exposes a confirmation token.
- Request ID alone retrieves or mutates confirmation state.
- A token for one dry run is replayed against another dry run.
- A token for status retrieval is reused as a confirmation token.
- A confirmation token is later accepted by an execution endpoint.
- A stale dry run is confirmed after PID reuse or listener changes.
- A process moves across protected, owner, session, or elevation boundaries between dry run and confirmation.
- A missing mandatory value is treated as a warning instead of a blocker.
- A failed audit write is ignored and confirmation is accepted without durable evidence.
- Concurrent submissions produce ambiguous accepted/rejected states.
- UI wording makes the user believe a process was stopped or will be stopped automatically.

Defenses:

- POST-only APIs with JSON content-type.
- Same-origin host and origin checks.
- CSRF token and session/page nonce checks.
- Confirmation access token separate from dry-run status token.
- Token hash storage and timing-safe comparison.
- Short token lifetime.
- Single-use accepted state.
- Server-side typed phrase verification.
- Mandatory fail-closed revalidation.
- Audit write success required before acceptance.
- Response fields that explicitly state `actionExecuted: false` and `executionAuthorized: false`.

Out of scope for this phase:

- Process signaling.
- Stop or restart execution.
- UAC elevation.
- Remote access.
- Bulk action semantics.
- Automatic cleanup or recommendations.

## 3. Eligibility Requirements

A dry-run result may become confirmation-eligible only if all requirements below are true. Missing, null, empty, malformed, unavailable, warning, or contradictory mandatory evidence must block confirmation.

Required dry-run state:

- `passed: true`.
- `confirmationEligible: true` or equivalent future field.
- Zero blockers.
- Zero unavailable mandatory checks.
- Zero warning mandatory checks.
- `actionExecuted: false`.
- Result is not expired at confirmation creation time.
- Result remains unexpired at confirmation submit time.
- Original dry-run audit write succeeded.

Required identity state:

- Stable process-instance identity exists.
- PID is present and valid.
- Process creation time is present, valid, non-future beyond allowed clock skew, and matches current scan metadata.
- Process-instance ID matches the expected PID plus creation-time identity.
- Listener ID is present and matches current listener state.
- Port matches the expected listener port.
- Normalized bind host matches or remains within an explicitly allowed equivalent normalization set.
- Validation fingerprint matches current revalidation output.

Required classification and safety state:

- Process name is present and matches expected normalized value.
- Category is present and matches expected normalized value.
- Confidence level is present and matches expected normalized value.
- Protected-process check is available and passed.
- Protected-port check is available and passed.
- Protected-tree or protected-boundary check is available and passed.
- Scanner and revalidation availability checks are available and passed.
- Process metadata availability checks are available and passed.
- Process-tree truncation policy is evaluated and not blocking.
- Lifecycle blocking policy is evaluated and not blocking.
- Conflicting newer-scan evidence is absent.

Required ownership state:

- Project ownership fields required by the dry-run policy are present.
- Project ownership source and confidence are present when ownership is part of the eligibility decision.
- If project ownership is unavailable, the dry run must explicitly mark that state as blocking or optional. It must not be skipped.
- Dev-root evidence alone must not make the target confirmable.

Required Windows owner/session/elevation state:

- Target owner identity is available as a safe comparison result, not a raw username.
- Target session ID is available.
- Watchdog process owner/session state is available.
- Target process and Watchdog process are in the same user boundary and same interactive session for the first action design.
- Elevation/integrity state is available.
- Unknown owner, unknown session, unknown elevation, service-owned, SYSTEM-owned, cross-user, cross-session, and protected targets block confirmation.

Required request state:

- Request method is POST.
- Request content type is JSON.
- Request body is within size limits.
- Host is an allowed local origin.
- Origin is same-origin and allowed.
- CSRF validation passes.
- Session or page nonce validation passes.
- Confirmation token validation passes for submit/status/cancel operations.
- Idempotency key is present and valid for mutating confirmation operations.

Confirmation must not be available when:

- Dry-run status is only retrievable by request ID.
- The status token has expired.
- The dry run has expired.
- A newer scan contradicts any mandatory expected value.
- Any mandatory comparison is skipped.
- Audit logging is unavailable.
- The process has an unstable or session-scoped identity.
- The process lacks reliable creation time.

## 4. Confirmation Token Contract

The confirmation token is a future token class. It is not the existing `statusAccessToken`, and it is not an execution token.

Token purposes:

- Dry-run status token: authorizes read-only dry-run status retrieval only.
- Confirmation token: authorizes read-only confirmation status retrieval and confirmation submission for one confirmation challenge only.
- Execution token: not defined in this document and must not exist in a confirmation-only phase.

Recommended token fields:

```json
{
  "tokenType": "confirmation-access",
  "authorizesStatusRead": false,
  "authorizesConfirmation": true,
  "authorizesExecution": false,
  "dryRunRequestId": "dry-run-request-id",
  "confirmationRequestId": "confirmation-request-id",
  "processInstanceId": "pid-createdAt-identity",
  "listenerId": "listener-identity",
  "validationFingerprint": "dry-run-validation-fingerprint",
  "sessionId": "server-session-id",
  "pageNonceHash": "hash-only",
  "createdAt": "2026-06-18T00:00:00.000Z",
  "expiresAt": "2026-06-18T00:01:00.000Z",
  "consumedAt": null
}
```

The raw token:

- Must be generated with at least 256 bits of cryptographic randomness.
- Must be opaque and unguessable.
- Must be returned only once to the client during confirmation-challenge creation.
- Must be held by the browser only in temporary JavaScript memory.
- Must not be rendered as visible text.
- Must not be placed in URLs, path parameters, query strings, fragments, referrers, local storage, session storage, cookies unless specifically using an HttpOnly cookie design, logs, audit records, diagnostics, history, exports, fixtures, or documentation examples.
- Must be sent back only in a POST body field or a request header, never in the URL.

The server:

- Stores only a token hash.
- Uses timing-safe hash comparison.
- Stores token metadata separately from the raw token.
- Expires the token no later than the dry-run result expiration.
- Should default to a maximum lifetime of 60 seconds.
- Consumes the token on accepted confirmation.
- May consume the token on cancellation.
- Should not consume the token on one invalid typed phrase unless a configurable attempt limit is exceeded.
- Must treat missing, wrong, malformed, expired, consumed, cross-request, and unknown tokens as indistinguishable safe failures.

A confirmation token must never:

- Retrieve dry-run status unless explicitly scoped for confirmation-status readback.
- Modify dry-run state.
- Authorize execution.
- Survive server restart unless token persistence is separately designed and audited.
- Be accepted by any future execution endpoint.

If token hashes are retained:

- Store them only in the in-memory confirmation store by default.
- Retain them only until expiration plus a short cleanup grace period.
- Delete them during periodic pruning and on server shutdown.
- Do not write token hashes to audit logs, history, diagnostics, exports, or fixtures.

## 5. Session and CSRF Design

Confirmation requires both a valid same-origin session and CSRF protection. Token secrecy alone is not sufficient.

Allowed request posture:

- Host must be loopback or an explicitly configured local host.
- Origin must match the served dashboard origin.
- Method must be POST.
- Content type must be `application/json`.
- Request body size must be bounded.
- Fetch metadata headers should be enforced where available.

Recommended browser session model:

- Server issues a short-lived local session on dashboard load or through a read-only session bootstrap endpoint.
- Session state is stored server-side.
- A session cookie uses `HttpOnly`, `SameSite=Strict`, `Path=/`, no `Domain`, and a short lifetime.
- If HTTPS is available, add `Secure`. If the local app is HTTP-only, document why `Secure` cannot be used and rely on loopback-only binding plus origin and CSRF checks.
- A page nonce is generated per dashboard load and held in memory.
- A CSRF token is generated per session or page nonce and sent in a request header.

The confirmation challenge must bind to:

- Session ID.
- Page nonce hash.
- CSRF token family or validation context.
- Dry-run request ID.
- Process-instance ID.
- Listener ID.
- Validation fingerprint.

Multiple-tab behavior:

- Confirmation challenges are bound to the page nonce that created them.
- A token created in one tab must not be accepted from another tab unless the implementation explicitly supports shared page nonce state.
- Creating a new confirmation challenge for the same dry run should either return the same active challenge for the same session and idempotency key, or cancel the older challenge. This behavior must be documented and tested.

Rejected request classes:

- Missing session.
- Missing page nonce.
- Missing CSRF token.
- Invalid Origin.
- Null Origin.
- Invalid Host.
- Non-local Host.
- GET, PUT, PATCH, DELETE, or form POST.
- Unsupported content type.
- Malformed JSON.
- Oversized body.

Safe failure behavior:

- Return stable categorized errors.
- Do not reveal whether a dry-run request ID or confirmation request ID exists when token/session validation fails.
- Do not include internal stack traces, raw request bodies, raw tokens, paths, command lines, shell output, or environment values.

## 6. Process Owner and Session Policy

The first confirmation-only implementation should only allow confirmation for same-user, same-session, non-protected, non-elevated interactive processes when all metadata is available.

Policy table:

| Target state | Confirmation policy | Reason |
| --- | --- | --- |
| Same user, same interactive session, non-elevated, metadata available | May be eligible | Narrow first action boundary. |
| Same user, different session | Block | User intent may not apply across sessions. |
| Different user | Block | Cross-user process control requires a separate security model. |
| SYSTEM, LocalService, NetworkService, service-owned, or protected account | Block | Protected/system boundary. |
| Owner unavailable | Block | Unknown identity cannot be confirmed safely. |
| Session ID unavailable | Block | Unknown session cannot be confirmed safely. |
| Session comparison unavailable | Block | Mandatory comparison cannot be skipped. |
| Target exited before confirmation | Block | Identity no longer matches. |
| PID reused with different creation time | Block | Different process instance. |
| Process tree reaches protected boundary | Block | Protected ancestry cannot be treated as user-owned. |
| Process tree metadata unavailable | Block if required by dry-run policy | Missing mandatory context cannot be skipped. |

Owner data privacy:

- Do not render raw usernames.
- Do not persist raw SIDs unless a later privacy review approves a redacted or hashed representation.
- Use safe labels such as `same-user`, `different-user`, `system-owned`, or `owner-unavailable`.
- Audit records may store the comparison result, not the raw account value.

## 7. Elevation Policy

The first confirmation-only implementation should fail closed on elevation uncertainty.

Policy:

- Do not self-elevate.
- Do not display UAC prompts.
- Do not confirm elevated targets from a non-elevated Watchdog process.
- Do not confirm non-elevated targets from an elevated Watchdog process until an elevated-mode policy exists.
- Do not confirm when target integrity level is unavailable.
- Do not confirm when Watchdog integrity level is unavailable.
- Do not confirm when target and Watchdog elevation states differ.
- Do not confirm protected or system targets even if elevation metadata appears favorable.

Required metadata:

- Watchdog elevation state.
- Target elevation state.
- Target integrity level or equivalent safe comparison.
- Whether metadata collection required elevated privileges.
- Whether metadata was partial or unavailable.

Safe labels:

- `same-non-elevated-session`
- `elevation-mismatch`
- `target-elevated`
- `watchdog-elevated`
- `elevation-unavailable`
- `protected-boundary`

Any label other than the narrow same non-elevated user/session case blocks confirmation in the first implementation.

## 8. Confirmation Presentation and Wording

The UI must make clear that confirmation records intent only.

Required confirmation review content:

- Server title.
- Port.
- Bind host and network-exposure warning, if any.
- Process name.
- Category and confidence level.
- Project display name and safe root label, if available.
- Process-instance identity summary.
- Creation time and age label, if available.
- Launcher/process-tree summary.
- Lifecycle label and limitations.
- Dry-run result status.
- Dry-run expiration time.
- Owner/session result.
- Elevation result.
- Protected-process, protected-port, and protected-boundary result.
- Revalidation fingerprint summary.
- Statement that no process action will occur in the confirmation phase.

Prohibited presentation content:

- Raw command lines.
- Parent command lines.
- Full unredacted paths.
- Raw process trees.
- Raw scanner records.
- Raw request bodies.
- Tokens.
- Token hashes.
- Environment values.
- Secret-like values.
- A button labeled `Stop`, `Kill`, `Restart`, or `Cleanup`.

Recommended confirmation statement:

> Record confirmation for this dry-run result. This will not stop, restart, kill, clean up, or signal any process.

Recommended accepted statement:

> Confirmation recorded. No process action was executed.

Typed phrase:

- The server generates a non-secret display challenge.
- The phrase should include the listener port and a short random display code.
- The phrase should not include project names or paths because those may be sensitive or ambiguous.
- Example display phrase: `CONFIRM PORT 3000 R7K2`.
- The random display code is not a security token.
- The display code may be stored in audit as a challenge ID, but the full user-entered phrase should not be stored.
- The server verifies the exact phrase after trimming leading and trailing whitespace.
- Case must be exact.
- Internal whitespace must be exact.
- Browser-side validation may disable the submit button until the phrase matches, but server-side validation is authoritative.

The UI must not:

- Autofill the phrase.
- Submit on page load.
- Submit from a hidden keyboard shortcut.
- Put the destructive verb in a primary button.
- Suggest that accepted confirmation is an execution approval.

Recommended button labels:

- `Generate confirmation review`
- `Record confirmation`
- `Cancel confirmation`

Avoid:

- `Stop`
- `Kill`
- `Restart`
- `Cleanup`
- `Proceed`
- `Execute`

## 9. Confirmation State Machine

States:

| State | Meaning | Terminal |
| --- | --- | --- |
| `not-available` | Dry run is not eligible for confirmation. | No |
| `challenge-created` | Confirmation challenge exists and awaits typed phrase. | No |
| `challenge-expired` | Confirmation challenge expired. | Yes |
| `dry-run-expired` | Underlying dry run expired before confirmation completed. | Yes |
| `session-invalid` | Session, page nonce, or CSRF validation failed. | Yes |
| `token-invalid` | Token validation failed with a generic safe failure. | Yes |
| `phrase-invalid` | Typed phrase did not match. | No, until attempt limit reached |
| `identity-changed` | PID, creation time, process instance, listener, or fingerprint changed. | Yes |
| `listener-changed` | Port or bind host changed outside allowed normalization. | Yes |
| `protected-boundary-changed` | Protected process, port, or tree boundary changed. | Yes |
| `owner-blocked` | Owner/session policy blocks confirmation. | Yes |
| `elevation-blocked` | Elevation policy blocks confirmation. | Yes |
| `audit-unavailable` | Audit write cannot be completed. | Yes |
| `accepted` | Confirmation was recorded. No action was executed or authorized. | Yes |
| `cancelled` | User cancelled the challenge. | Yes |

Allowed transitions:

- `not-available` to `challenge-created` only after eligibility creation checks pass.
- `challenge-created` to `phrase-invalid` after an incorrect phrase while attempts remain.
- `phrase-invalid` to `accepted` after a later correct phrase and successful revalidation.
- `challenge-created` to any terminal blocked state if revalidation fails.
- `challenge-created` to `accepted` only after token, session, CSRF, phrase, revalidation, and audit write all pass.
- `challenge-created` to `cancelled` by explicit user cancel.
- Any non-terminal state to `challenge-expired` after expiration.

Impossible states:

- `accepted` with `actionExecuted: true`.
- `accepted` with `executionAuthorized: true`.
- `accepted` with blockers.
- `accepted` with unavailable mandatory checks.
- `accepted` with warning mandatory checks.
- `accepted` with expired dry run.
- `accepted` with mismatched validation fingerprint.
- `accepted` with audit failure.
- `accepted` with scanner unavailable.
- `accepted` with unstable identity.

Every impossible state must be downgraded to a terminal blocked state and audited if audit is available.

## 10. Revalidation Sequence

Confirmation acceptance requires a fresh revalidation sequence immediately before returning `accepted`.

Recommended sequence:

1. Parse request with a bounded JSON parser.
2. Validate method, content type, Host, Origin, session, page nonce, and CSRF token.
3. Validate confirmation token hash with timing-safe comparison.
4. Load confirmation challenge metadata.
5. Confirm token is unexpired, unconsumed, and bound to the same challenge.
6. Confirm dry-run result exists, is unexpired, and remains confirmation-eligible.
7. Verify typed phrase exactly matches the challenge.
8. Run a fresh compact scan or revalidation scan.
9. Recompute process-instance identity from PID and creation time.
10. Verify process-instance ID matches expected identity.
11. Verify listener ID, port, and normalized bind host.
12. Verify validation fingerprint.
13. Verify category, confidence, process name, and mandatory project ownership fields.
14. Verify protected-process, protected-port, protected-tree, owner/session, and elevation results.
15. Verify process metadata availability.
16. Verify process-tree truncation and lifecycle blocking policies.
17. Verify no conflicting newer-scan evidence exists.
18. Build privacy-safe audit record.
19. Write audit record successfully.
20. Mark challenge accepted and token consumed.
21. Return accepted response with `actionExecuted: false` and `executionAuthorized: false`.

Ordering rule:

- Do not mark a challenge accepted before the audit write succeeds.
- Do not consume the token as accepted before the accepted audit record is durable.
- If audit write fails, return `audit-unavailable` and do not return accepted.

Freshness rule:

- Revalidation output must be generated after confirmation submission begins.
- Revalidation must not rely only on the original dry-run snapshot.
- Revalidation failures must use safe error categories.

## 11. Audit-Log Contract

Confirmation audit records are privacy-safe records of user intent and safety checks. They are not execution logs.

Recommended audit schema:

```json
{
  "schemaVersion": "localhost-watchdog.confirmation-audit.v1",
  "recordType": "confirmation",
  "event": "accepted",
  "timestamp": "2026-06-18T00:00:00.000Z",
  "confirmationRequestId": "confirmation-request-id",
  "dryRunRequestId": "dry-run-request-id",
  "idempotencyKeyHash": "hash-only",
  "redactedIdentity": {
    "processInstanceId": "stable-process-instance-id",
    "listenerId": "listener-id",
    "port": 3000,
    "bindHostClass": "loopback",
    "processName": "node.exe",
    "category": "node-dev-server",
    "confidenceLevel": "high",
    "projectDisplayName": "app"
  },
  "checks": [
    { "code": "PID_MATCH", "status": "passed" },
    { "code": "CREATION_TIME_MATCH", "status": "passed" },
    { "code": "OWNER_SESSION_MATCH", "status": "passed" },
    { "code": "ELEVATION_POLICY", "status": "passed" },
    { "code": "AUDIT_WRITE", "status": "passed" }
  ],
  "sessionValidation": {
    "host": "passed",
    "origin": "passed",
    "csrf": "passed",
    "pageNonce": "passed"
  },
  "typedPhrase": {
    "challengeId": "display-challenge-id",
    "matched": true
  },
  "expiresAt": "2026-06-18T00:01:00.000Z",
  "actionExecuted": false,
  "executionAuthorized": false
}
```

Allowed audit fields:

- Schema version.
- Record type.
- Event type.
- Timestamp.
- Confirmation request ID.
- Dry-run request ID.
- Idempotency key hash.
- Safe process-instance ID.
- Listener ID.
- Port.
- Bind host class, not raw external address unless already safe under scanner policy.
- Process name.
- Category.
- Confidence level.
- Privacy-safe project display identity.
- Check codes and statuses.
- Session validation outcomes.
- Owner/session/elevation outcome labels.
- Typed phrase match result and challenge ID.
- Expiration time.
- `actionExecuted: false`.
- `executionAuthorized: false`.

Prohibited audit fields:

- Raw confirmation token.
- Confirmation token hash.
- Dry-run status token.
- Status token hash.
- CSRF token.
- Page nonce raw value.
- Session cookie.
- Raw request body.
- Typed phrase raw input.
- Raw command line.
- Parent command line.
- Unredacted executable path.
- Unredacted project path.
- Raw process tree.
- Raw scanner record.
- Raw CIM data.
- Environment values.
- Headers, cookies, query strings, or credentials.
- Secrets or suspected secrets.

Audit write failure:

- Blocks confirmation acceptance.
- Returns a safe categorized error.
- Must not leak internal path, stack, or filesystem details.
- May produce an in-memory diagnostic warning without raw data.

## 12. Retention and Concurrency Policy

Recommended storage:

- Use a simple append-only JSONL audit file for confirmation records.
- Keep it separate from history snapshots.
- Do not store tokens or raw process data.
- Suggested path: `.localhost-watchdog/confirmation-audit.jsonl`.
- The path itself should be reported only through safe display labels in diagnostics.

Retention defaults:

- Maximum record age: 30 days.
- Maximum record count: 5,000.
- Maximum file size: 10 MB.
- Prune on startup and after successful writes when limits are exceeded.
- Use schema version checks during pruning.

Write behavior:

- Serialize writes through an in-process queue.
- Use append-only writes for new records.
- Use temp file plus atomic rename when compacting or pruning.
- Treat disk-full, permission-denied, invalid path, lock contention, and serialization failure as audit-unavailable.
- Confirmation acceptance must fail closed when the accepted audit record cannot be written.

Concurrent requests:

- The same confirmation challenge can have one accepted terminal state.
- Simultaneous submissions for the same challenge must resolve to one accepted or blocked result.
- A second successful submit must return the already accepted state only if it uses the same idempotency key and does not reprocess the confirmation.
- A different idempotency key after acceptance should return a safe terminal state without changing the original audit record.

Corruption behavior:

- A trailing partial JSONL line from an interrupted write may be ignored during read with a warning.
- Existing malformed records should not block live scanning.
- Malformed audit storage must block confirmation acceptance until storage health is restored.
- Diagnostics should report safe aggregate audit health only.

Retention unresolved decisions:

- Whether dry-run and confirmation audit records should be unified in a single action-audit log remains a future implementation decision.
- If unified, schema versioning must preserve the distinction between dry-run and confirmation records.

## 13. Replay and Idempotency Handling

Replay prevention:

- Confirmation tokens are short-lived.
- Tokens are bound to one dry-run request ID.
- Tokens are bound to one process-instance ID.
- Tokens are bound to one listener ID.
- Tokens are bound to one validation fingerprint.
- Tokens are bound to one session and page nonce.
- Tokens are consumed on accepted confirmation.

Idempotency:

- Mutating confirmation endpoints require an idempotency key.
- Idempotency keys are random client-generated values or server-issued challenge values.
- Store only a hash of the idempotency key.
- Repeating the same submit with the same idempotency key returns the same terminal result.
- Repeating with a different idempotency key after terminal acceptance must not create a second acceptance.

Dry-run expiration races:

- If the dry run expires before submit revalidation completes, confirmation fails as `DRY_RUN_EXPIRED`.
- If the confirmation token expires before audit write, confirmation fails as `CONFIRMATION_EXPIRED`.
- Accepted responses must include the accepted timestamp and the fact that no action was executed.

Process races:

- If PID no longer exists, block.
- If PID exists but creation time differs, block.
- If listener moved ports, block unless the dry-run contract explicitly expected and validated that listener change. The first implementation should block.
- If process category or protected result changes, block.
- If owner/session/elevation becomes unavailable, block.

Server restart:

- In-memory confirmation tokens are invalid after restart.
- Status lookup after restart returns a safe unavailable or expired state.
- Confirmation acceptance after restart is not allowed unless token persistence is separately designed.

## 14. Proposed API Schemas

These schemas are the confirmation-only API contract. They remain non-executing and do not define any stop, restart, kill, cleanup, signal, tray, elevation, or bulk endpoint.

### Create Confirmation Challenge

`POST /api/actions/stop/confirmations`

Purpose: create a non-executing confirmation challenge for a passed dry run.

Request headers:

```http
Content-Type: application/json
Origin: http://localhost:<port>
X-CSRF-Token: <csrf-token>
X-Dry-Run-Status-Token: <status-access-token>
```

Request body:

```json
{
  "schemaVersion": "localhost-watchdog.confirmation-request.v1",
  "dryRunRequestId": "dry-run-request-id",
  "processInstanceId": "process-instance-id",
  "listenerId": "listener-id",
  "validationFingerprint": "validation-fingerprint",
  "pageNonce": "page-nonce",
  "idempotencyKey": "idempotency-key"
}
```

Success response:

```json
{
  "schemaVersion": "localhost-watchdog.confirmation-response.v1",
  "confirmationRequestId": "confirmation-request-id",
  "state": "challenge-created",
  "expiresAt": "2026-06-18T00:01:00.000Z",
  "confirmationAccessToken": "returned-once-opaque-token",
  "displayChallenge": {
    "challengeId": "display-challenge-id",
    "requiredPhrase": "CONFIRM PORT 3000 R7K2",
    "normalization": "trim-only-case-sensitive"
  },
  "review": {
    "serverTitle": "Vite dev server",
    "port": 3000,
    "bindHostClass": "loopback",
    "processName": "node.exe",
    "category": "node-dev-server",
    "confidenceLevel": "high",
    "projectDisplayName": "app",
    "ownerSessionPolicy": "same-non-elevated-session",
    "elevationPolicy": "same-non-elevated-session",
    "networkExposure": "loopback-only",
    "statement": "Recording confirmation will not stop, restart, kill, clean up, or signal any process."
  },
  "authorization": {
    "authorizesStatusRead": false,
    "authorizesConfirmation": true,
    "authorizesExecution": false
  },
  "actionExecuted": false,
  "executionAuthorized": false
}
```

The raw `confirmationAccessToken` is returned once for in-memory client use. It must not be rendered as visible text, persisted, logged, audited, exported, or placed in browser storage.

### Submit Confirmation

`POST /api/actions/stop/confirmations/submit`

Request headers:

```http
Content-Type: application/json
Origin: http://localhost:<port>
X-CSRF-Token: <csrf-token>
X-Confirmation-Access-Token: <confirmation-access-token>
```

Request body:

```json
{
  "schemaVersion": "localhost-watchdog.confirmation-submit.v1",
  "confirmationRequestId": "confirmation-request-id",
  "typedPhrase": "CONFIRM PORT 3000 R7K2",
  "pageNonce": "page-nonce",
  "idempotencyKey": "idempotency-key"
}
```

Accepted response:

```json
{
  "schemaVersion": "localhost-watchdog.confirmation-result.v1",
  "confirmationRequestId": "confirmation-request-id",
  "dryRunRequestId": "dry-run-request-id",
  "state": "accepted",
  "acceptedAt": "2026-06-18T00:00:30.000Z",
  "audit": {
    "written": true,
    "recordType": "confirmation"
  },
  "checks": [
    { "code": "PID_MATCH", "status": "passed" },
    { "code": "CREATION_TIME_MATCH", "status": "passed" },
    { "code": "OWNER_SESSION_MATCH", "status": "passed" },
    { "code": "ELEVATION_POLICY", "status": "passed" }
  ],
  "authorization": {
    "authorizesStatusRead": false,
    "authorizesConfirmation": false,
    "authorizesExecution": false
  },
  "actionExecuted": false,
  "executionAuthorized": false,
  "message": "Confirmation recorded. No process action was executed."
}
```

Blocked response:

```json
{
  "schemaVersion": "localhost-watchdog.confirmation-result.v1",
  "state": "blocked",
  "error": {
    "code": "IDENTITY_CHANGED",
    "category": "confirmation-revalidation",
    "message": "Confirmation could not be recorded because the target changed during revalidation."
  },
  "actionExecuted": false,
  "executionAuthorized": false
}
```

### Confirmation Status

`POST /api/actions/stop/confirmations/status`

Status retrieval remains POST-only. Request ID alone is not sufficient.

Request headers:

```http
Content-Type: application/json
Origin: http://localhost:<port>
X-CSRF-Token: <csrf-token>
X-Confirmation-Access-Token: <confirmation-access-token>
```

Request body:

```json
{
  "schemaVersion": "localhost-watchdog.confirmation-status.v1",
  "confirmationRequestId": "confirmation-request-id",
  "pageNonce": "page-nonce"
}
```

Response must not include:

- Confirmation access token.
- Confirmation token hash.
- Dry-run status token.
- Status token hash.
- Raw request body.
- Raw typed phrase.

### Cancel Confirmation

`POST /api/actions/stop/confirmations/cancel`

Purpose: cancel a non-executing confirmation challenge.

Cancel response:

```json
{
  "schemaVersion": "localhost-watchdog.confirmation-result.v1",
  "confirmationRequestId": "confirmation-request-id",
  "state": "cancelled",
  "actionExecuted": false,
  "executionAuthorized": false
}
```

### Safe Error Codes

Required error codes:

- `CONFIRMATION_NOT_AVAILABLE`
- `DRY_RUN_EXPIRED`
- `DRY_RUN_NOT_CONFIRMATION_ELIGIBLE`
- `CONFIRMATION_TOKEN_INVALID`
- `CONFIRMATION_EXPIRED`
- `CONFIRMATION_ALREADY_USED`
- `SESSION_INVALID`
- `CSRF_BLOCKED`
- `ORIGIN_BLOCKED`
- `HOST_BLOCKED`
- `OWNER_BLOCKED`
- `ELEVATION_BLOCKED`
- `AUDIT_UNAVAILABLE`
- `IDENTITY_CHANGED`
- `LISTENER_CHANGED`
- `PROTECTED_BOUNDARY_CHANGED`
- `CONFLICTING_NEWER_SCAN`
- `UNSUPPORTED_CONTENT_TYPE`
- `INVALID_JSON`
- `REQUEST_TOO_LARGE`

Token, session, and unknown-request failures should use generic safe messages that do not reveal whether a request ID exists.

## 15. Proposed UI States

These UI states are future design only.

Required states:

- `No confirmation available`
- `Generate confirmation review`
- `Loading confirmation review`
- `Confirmation review ready`
- `Typed phrase incomplete`
- `Typed phrase mismatch`
- `Recording confirmation`
- `Confirmation recorded`
- `Confirmation expired`
- `Dry run expired`
- `Target changed`
- `Owner/session blocked`
- `Elevation blocked`
- `Audit unavailable`
- `Network or API error`
- `Cancelled`

Required labels:

- `This records confirmation only. It will not stop, restart, kill, clean up, or signal any process.`
- `Confirmation recorded. No process action was executed.`
- `The target changed during revalidation. Generate a new dry run before continuing.`
- `Owner, session, or elevation metadata is unavailable, so confirmation is blocked.`

Accessibility requirements:

- Confirmation review is reachable by keyboard.
- Typed phrase input has a clear accessible name.
- Status changes use readable status text.
- Error text is not color-only.
- Disabled controls use semantic disabled state.
- The required phrase is visible as text but is not a token.
- The raw confirmation token is never visible in the DOM.

Prohibited UI states:

- Stop button.
- Kill button.
- Restart button.
- Cleanup button.
- Bulk controls.
- Hidden destructive shortcut.
- Disabled placeholder suggesting execution is present.
- Success state that implies a process was stopped.

## 16. Execution Boundary

Confirmation is not execution.

The confirmation-only phase must always return:

```json
{
  "actionExecuted": false,
  "executionAuthorized": false
}
```

Boundary rules:

- Confirmation does not set `safeToStop`.
- Confirmation does not set `safeToRestart`.
- Confirmation does not set `bulkStoppable`.
- Confirmation does not create an execution token.
- Confirmation does not enqueue work.
- Confirmation does not send process signals.
- Confirmation does not reserve a PID.
- Confirmation does not make a later execution safe by itself.
- Confirmation does not bypass future revalidation.

A future execution phase must have:

- Separate design document.
- Separate threat model.
- Separate token class.
- Separate endpoint contract.
- Separate UI wording.
- Separate audit schema.
- Separate dry-run plus confirmation plus execution revalidation.
- Explicit Windows signal semantics.
- Race-condition handling.
- Partial-failure behavior.
- Privilege/elevation behavior.
- PID and creation-time revalidation immediately before signaling.
- Listener and port revalidation immediately before signaling.
- Owner/session/elevation revalidation immediately before signaling.

Any future execution endpoint must reject:

- Dry-run status tokens.
- Confirmation access tokens.
- Expired confirmation records.
- Confirmation records without fresh execution-phase revalidation.

## 17. Required Implementation Tests

Confirmation eligibility tests:

- Passed dry run can create a confirmation challenge only when all mandatory checks pass.
- Dry run with blocker cannot create confirmation challenge.
- Dry run with mandatory warning cannot create confirmation challenge.
- Dry run with unavailable mandatory check cannot create confirmation challenge.
- Expired dry run cannot create confirmation challenge.
- Unstable process identity cannot create confirmation challenge.
- Missing creation time cannot create confirmation challenge.
- Missing process-instance ID cannot create confirmation challenge.
- Missing listener ID cannot create confirmation challenge.
- Missing validation fingerprint cannot create confirmation challenge.

Token tests:

- Confirmation token is distinct from dry-run status token.
- Request ID alone cannot retrieve confirmation details.
- Token is POST-only.
- Token is not accepted in path or query string.
- Token is not stored in local storage or session storage.
- Token hash comparison is timing-safe.
- Missing, malformed, wrong, expired, consumed, unknown, and cross-request tokens return indistinguishable safe failures.
- Token expires no later than dry run.
- Accepted confirmation consumes token.
- Confirmation token cannot authorize execution.

Session and CSRF tests:

- Missing CSRF blocks.
- Wrong CSRF blocks.
- Missing page nonce blocks.
- Wrong page nonce blocks.
- Invalid Origin blocks.
- Null Origin blocks.
- Invalid Host blocks.
- Unsupported content type blocks.
- Malformed JSON blocks.
- Oversized body blocks.

Owner/session/elevation tests:

- Same user, same session, non-elevated target may be eligible.
- Different user blocks.
- Different session blocks.
- SYSTEM-owned target blocks.
- Service-owned target blocks.
- Owner unavailable blocks.
- Session unavailable blocks.
- Target elevation unavailable blocks.
- Target elevated blocks.
- Watchdog elevated state mismatch blocks.

Typed phrase tests:

- Exact phrase accepts when all other checks pass.
- Wrong phrase blocks acceptance.
- Case mismatch blocks.
- Internal whitespace mismatch blocks.
- Leading and trailing whitespace are trimmed only if contract keeps that normalization.
- Phrase is not audited raw.
- Phrase is not autofilled.

Revalidation tests:

- PID reuse with different creation time blocks.
- Same PID and creation time but listener changed blocks.
- Port changed blocks.
- Bind host changed blocks unless explicitly equivalent.
- Validation fingerprint changed blocks.
- Category changed blocks.
- Protected process result changed blocks.
- Protected port result changed blocks.
- Protected tree boundary changed blocks.
- Scanner unavailable blocks.
- Conflicting newer-scan evidence blocks.

Audit tests:

- Accepted confirmation requires successful audit write.
- Audit write failure blocks acceptance.
- Audit records include only approved fields.
- Audit records exclude tokens, token hashes, request bodies, command lines, unredacted paths, process trees, raw scanner records, and secrets.
- Concurrent append preserves valid JSONL records.
- Retention pruning preserves schema-valid records.
- Corrupt audit storage blocks acceptance but does not block live scanner.

State invariant tests:

- Accepted plus blocker downgrades.
- Accepted plus unavailable mandatory check downgrades.
- Accepted plus warning mandatory check downgrades.
- Accepted plus expired dry run downgrades.
- Accepted plus identity changed downgrades.
- Accepted plus audit failure downgrades.
- Accepted plus scanner unavailable downgrades.
- Accepted always returns `actionExecuted: false`.
- Accepted always returns `executionAuthorized: false`.

UI tests:

- No stop controls exist.
- No restart controls exist.
- No kill controls exist.
- No cleanup controls exist.
- No bulk controls exist.
- Confirmation token is not rendered in DOM.
- Copy/export flows do not include confirmation token.
- Status text says no action was executed.
- Keyboard and accessibility states are valid.

Source-safety tests:

- No `process.kill`.
- No `taskkill`.
- No `Stop-Process`.
- No `TerminateProcess`.
- No `Suspend-Process`.
- No console control signaling.
- No execution endpoint.
- No restart endpoint.
- No cleanup endpoint.
- No destructive UI control.
- No true stop, restart, or bulk flags.

## 18. Explicit Non-Goals

This design does not define or implement:

- Stop execution.
- Restart execution.
- Kill execution.
- Cleanup behavior.
- Process signaling.
- UAC elevation.
- Tray behavior.
- Bulk actions.
- Automatic remediation.
- Recommendations to stop or kill a process.
- Background cleanup.
- Remote access.
- Telemetry.
- Uploading or sharing confirmation data.
- Execution tokens.
- Execution endpoints.
- Restart command reconstruction.
- Service control.
- Docker container stopping.
- Browser tab closing.
- Editor task termination.

This design also does not change current read-only or dry-run runtime behavior.

## 19. Go/No-Go Checklist for a Confirmation-Only Implementation Phase

Go only when every item is true:

- Dry-run safety verification remains PASS or PASS WITH CONDITIONS with no open blocker.
- DRY-BLOCK-001 remains fixed.
- DRY-BLOCK-002 remains fixed.
- Request ID alone cannot retrieve dry-run status.
- Dry-run status token remains read-only.
- No execution endpoints exist.
- No destructive source calls exist.
- Confirmation implementation plan includes session and CSRF protection.
- Confirmation implementation plan includes owner/session metadata.
- Confirmation implementation plan includes elevation metadata.
- Confirmation implementation plan includes audit retention and concurrency behavior.
- Confirmation implementation plan includes token storage and expiry.
- Confirmation implementation plan includes exact typed phrase behavior.
- Confirmation implementation plan includes fail-closed mandatory-field checks.
- Confirmation implementation plan includes fresh revalidation before acceptance.
- Confirmation implementation plan includes no action execution and no execution authorization.
- Tests are specified for token privacy, CSRF, owner/session, elevation, audit failure, race conditions, and source safety.
- Documentation clearly labels confirmation as non-executing.

No-go if any item is true:

- Confirmation token can authorize execution.
- Confirmation token appears in URL, DOM text, logs, audit, diagnostics, history, exports, or fixtures.
- Missing mandatory evidence can still produce accepted confirmation.
- Owner/session metadata is unavailable and not blocking.
- Elevation metadata is unavailable and not blocking.
- Audit write failure can still produce accepted confirmation.
- UI wording implies that a process was stopped.
- Any stop, restart, kill, cleanup, tray, bulk, remediation, or execution behavior is added in the confirmation-only phase.

Final recommendation: begin a confirmation-contract implementation phase only after accepting this contract and explicitly scoping that phase to non-executing confirmation records. Remain dry-run-only until that implementation phase is requested.
