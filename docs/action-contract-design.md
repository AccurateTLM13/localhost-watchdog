# Future Action Contract Design

Status: dry-run eligibility implemented; execution sections remain future design only  
Current implementation impact: read-only dry-run eligibility and revalidation only  
Scope: future single-process stop action contract, dry-run first  

This document designs a safety-critical action contract for Localhost Watchdog. The current implementation covers only the first read-only dry-run eligibility phase: action eligibility metadata, fresh revalidation, short-lived dry-run status, privacy-safe dry-run audit records, and non-destructive dashboard states. It does not implement stop, restart, kill, cleanup, tray behavior, bulk actions, elevation, process signaling, confirmation issuance, execution endpoints, or destructive controls. Current runtime action flags remain false.

## 1. Executive Recommendation

Recommendation: design the first future action phase as dry-run-only.

The first future action phase should not stop any process. It should add only action eligibility computation, pre-action revalidation, dry-run result generation, confirmation-token issuance simulation, audit-log shape validation, and UI rendering of blocked/dry-run states. Execution should remain impossible until the dry-run contract, confirmation contract, audit logging, and race-condition tests pass on Windows-realistic fixtures and live local scanner checks.

The first real stop implementation, if later approved, should support only a narrow single-process stop candidate:

- Stable process identity is available from PID plus creation time.
- Listener identity is known and revalidated.
- Category is a high-confidence development-server category.
- Project ownership is marker-confirmed or explicitly configured.
- Process and ancestry do not cross protected boundaries.
- The process is not database, local AI, browser/editor helper, unknown, system/protected, service-managed, elevated beyond Watchdog, or missing metadata.
- The user completes an explicit typed confirmation after a successful, unexpired dry run.

Restart should be deferred beyond the first stop implementation. Restart is not simply "stop then rerun command"; command provenance, environment, working directory, shell, package manager, terminal ownership, secrets, and elevation all need independent verification.

## 2. Threat Model

Primary harm scenarios:

- Wrong process is stopped because PID was reused.
- Wrong listener is targeted because the port was reassigned.
- A protected process is misclassified as a development server.
- A process becomes service-managed, elevated, or protected after the scan.
- A child process replaces its parent between dry run and execution.
- A stale browser request or resubmission repeats an action.
- A status-access token or future confirmation token is reused after process state changes.
- A listener binds to all interfaces and the UI overstates certainty.
- Command lines or paths leak secrets through action logs, diagnostics, errors, or exports.
- Restart reconstructs an unsafe or secret-bearing command.

Attacker or accident model:

- Local malicious page attempting to call localhost endpoints.
- User double-clicking, refreshing, or resubmitting an old action page.
- Concurrent browser tabs issuing duplicate requests.
- Concurrent scans or action attempts racing with each other.
- Windows process metadata unavailable due to privileges.
- System services respawning processes after termination.

Design posture: fail closed. Missing evidence, stale evidence, mismatch, unsafe category, privacy risk, or concurrent ambiguity blocks the action.

## 3. Eligibility State Machine

Future action eligibility is separate from current display confidence. Do not introduce `safeToStop: true`. Current `safeToStop`, `safeToRestart`, and `bulkStoppable` remain false.

States:

- `ineligible`: Record cannot enter any action flow.
- `inspect-only`: Record is useful for display but cannot dry-run.
- `dry-run-eligible`: Record has enough evidence to run validation without mutation.
- `confirmation-eligible`: A fresh dry run passed and issued a short-lived confirmation challenge.
- `blocked`: A candidate entered action evaluation but failed one or more required gates.

State transitions:

```txt
visible record
  -> ineligible
  -> inspect-only
  -> dry-run-eligible
  -> dry-run passed
  -> confirmation-eligible
  -> execution request accepted by future implementation
```

Any failed gate transitions to `blocked`. Any state change in process identity, listener identity, project ownership, protected classification, process tree, privilege state, or scan recency cancels the current dry run and confirmation.

Minimum evidence for each state:

| State | Required evidence |
| --- | --- |
| `ineligible` | Any absolute block, including protected/system, database, local AI by default, unknown listener, missing creation time, unstable identity, missing process metadata, protected port, non-localhost target, elevated mismatch, or protected ancestor. |
| `inspect-only` | Visible record with useful context, but missing one or more action-grade requirements. Examples: browser/editor helpers, medium-confidence dev server, weak project ownership, lifecycle uncertainty, fallback-only metadata. |
| `dry-run-eligible` | Stable PID+creation-time identity, listener ID, high-confidence dev-server category, marker-confirmed or configured project ownership, local loopback or explicitly accepted wildcard listener, no protected process/port/category, process metadata available, bounded process tree without protected ancestor, no current lifecycle stale-candidate block, current scan not stale. |
| `confirmation-eligible` | All dry-run revalidation checks pass, status-access proof is fresh for status reads, result contains no warnings requiring block, and any future typed confirmation challenge is issued for this exact process instance and listener. |
| `blocked` | Any mismatch, missing required evidence, stale token, conflicting newer scan, protected boundary, privilege mismatch, duplicate request conflict, or scanner unavailable during required revalidation. |

Assumption: `dry-run-eligible` means "eligible to validate," not "safe to stop."

Unresolved decision: whether wildcard-bound development servers can ever be dry-run eligible. Initial recommendation is inspect-only unless a future setting explicitly allows wildcard-bound local dev servers and the confirmation wording highlights network exposure.

## 4. Evidence Requirements

Required identity evidence:

- `processInstanceId` from PID plus `Win32_Process.CreationDate`.
- `identity.status` is `stable`.
- `id` and `listenerId` include secondary listener identity.
- `createdAt` is available and not invalid, missing, or future-skewed.
- PID is an integer greater than zero and is not a system pseudo-PID.

Required listener evidence:

- Protocol is TCP.
- Listener port is numeric and in valid range.
- Host/bind address is normalized.
- Listener belongs to the same PID during scan.
- Duplicate-listener normalization has completed.
- Wildcard versus loopback meaning is preserved.

Required project evidence:

- Project ownership source is one of:
  - explicit configured project path
  - marker-confirmed project root
- Accepted markers include `package.json`, `.git`, `vite.config.*`, `next.config.*`, `astro.config.*`, `pyproject.toml`, `requirements.txt`, `manage.py`, `pom.xml`, and `build.gradle`.
- Dev-root-only inference is insufficient for action eligibility.
- Project root and working directory are redacted in output.
- Project path still exists during revalidation.

Required classification evidence:

- Category must be one of:
  - `node-dev-server`
  - `python-dev-server`
  - `java-dev-server`
- Confidence level must be `high`.
- Evidence must include strong command/process/project evidence, not only weak stacked signals.
- HTTP probe hints may support context but cannot grant eligibility.

Required protected evidence:

- Protected process check passed.
- Protected port check passed.
- Protected port range check passed.
- Category is not `system-or-protected`.
- Process tree contains no protected ancestor.
- Process is not a Windows service or security process unless a future service-aware design explicitly supports it.

Required lifecycle evidence:

- Lifecycle label is not `stale-candidate`.
- `possibly-detached` is allowed only for dry-run if project and identity evidence are strong and no other risk signal is present.
- Age alone never blocks or grants eligibility.
- History may explain context but cannot grant eligibility.

Required launcher/process-tree evidence:

- Parent lookup attempted.
- Process tree built from fresh process metadata.
- Traversal stopped safely for a non-risk reason, such as missing parent PID at root.
- `max-depth` truncation is a warning and should prevent real execution in the first stop version.
- Missing parent metadata is inspect-only unless a future policy explicitly allows it with stronger project evidence.

Required user/session ownership evidence where available:

- Process owner/session matches current user where Windows exposes reliable metadata.
- If owner/session metadata is unavailable, dry-run may report `ownerStatus: unavailable`, but execution should block in the first real stop version.
- Elevated process with non-elevated Watchdog blocks.
- Cross-user process blocks.

## 5. Revalidation Sequence

Every future dry run and execution request must perform a fresh revalidation immediately before returning a result. Execution must repeat the same revalidation after confirmation and before any process signal.

Sequence:

1. Resolve target by `processInstanceId` and `listenerId`.
2. Confirm there is no newer conflicting scan or active action lock for the same process instance.
3. Query current TCP listeners using the primary scanner path where available.
4. Query current process metadata using CIM.
5. Verify PID still exists.
6. Verify creation time still matches exactly.
7. Verify process name still matches the scanned record.
8. Verify listener port still exists.
9. Verify listener port still belongs to the same PID.
10. Verify host/bind state still matches or is an allowed equivalent.
11. Verify listener protocol still matches.
12. Rebuild classification from current data.
13. Verify protected process classification has not changed.
14. Verify protected port classification has not changed.
15. Rebuild project ownership and verify project identity has not changed.
16. Verify project root still exists and remains inside allowed configured boundary when marker-derived.
17. Rebuild launcher and process tree.
18. Verify process tree has not crossed a protected boundary.
19. Verify privilege/session owner status where available.
20. Re-evaluate lifecycle context.
21. Check dry-run status-access token or future confirmation token freshness.
22. Produce a structured pass/warn/block result.

Any mismatch cancels the action. Cancellation should return a safe error category, not raw scanner output.

## 6. Dry-Run Contract

Dry run is a validation action that changes nothing. It must perform every future execution validation step except the final process signal.

Properties:

- Mutates no process.
- Writes no execution result except optional privacy-safe audit entry for the dry-run attempt.
- Produces a structured result with `passes`, `warnings`, and `blocks`.
- Expires quickly. Recommended default: 60 seconds.
- Is bound to exact `processInstanceId`, `listenerId`, scan ID, validation fingerprint, and browser session nonce.
- Cannot be reused after any process state change.
- Cannot be upgraded to execution if warnings require manual redesign.

Dry-run result states:

- `passed`: all required checks passed and confirmation may be issued.
- `warning`: checks passed but execution is not allowed in first version due to non-blocking uncertainty, such as wildcard bind.
- `blocked`: at least one block exists.
- `expired`: token or validation window expired.
- `changed`: identity/listener/project/protected/tree state changed.
- `unavailable`: scanner or metadata source needed for revalidation was unavailable.

Proposed dry-run response:

```json
{
  "ok": true,
  "schemaVersion": "localhost-watchdog.action-dry-run.v1",
  "actionRequestId": "actreq_20260617_120000_01",
  "action": "stop",
  "mode": "single-process",
  "status": "passed",
  "expiresAt": "2026-06-17T12:01:00.000Z",
  "target": {
    "processInstanceId": "pid-12345-created-2026-06-17t11-00-00-000z",
    "listenerId": "pid-12345-created-2026-06-17t11-00-00-000z-listener-tcp-127-0-0-1-3000",
    "pid": 12345,
    "processName": "node.exe",
    "port": 3000,
    "host": "127.0.0.1",
    "category": "node-dev-server",
    "projectDisplayName": "my-app"
  },
  "validation": {
    "passes": [
      { "code": "PID_EXISTS", "message": "PID still exists." },
      { "code": "CREATION_TIME_MATCH", "message": "Process creation time matches." }
    ],
    "warnings": [],
    "blocks": []
  },
  "confirmation": {
    "required": true,
    "tokenPreview": "STOP 3000 my-app",
    "challengeId": "confirm_20260617_120000_01"
  }
}
```

Dry-run blocked response:

```json
{
  "ok": false,
  "schemaVersion": "localhost-watchdog.action-dry-run.v1",
  "actionRequestId": "actreq_20260617_120000_02",
  "action": "stop",
  "status": "blocked",
  "validation": {
    "passes": [],
    "warnings": [],
    "blocks": [
      {
        "code": "CREATION_TIME_MISMATCH",
        "category": "identity",
        "message": "The process identity changed since it was scanned."
      }
    ]
  }
}
```

## 7. Confirmation Contract

Confirmation must be explicit, typed, scoped, short-lived, and impossible to trigger accidentally.

Required UI details shown:

- Action: stop single process.
- Project display name.
- Process name.
- PID.
- Process creation time.
- Listener host and port.
- Category and confidence level.
- Network exposure warning, if any.
- Project ownership source.
- Launcher/process-tree summary.
- Lifecycle label.
- Dry-run expiration time.
- Privacy-safe warning that command lines are redacted and not used as restart instructions.

Required wording:

```txt
Stop this single local development process?

Project: <project display name>
Process: <processName> PID <pid>
Port: <host>:<port>
Identity: PID plus creation time verified

This will affect only the verified process instance shown here.
Localhost Watchdog will revalidate PID, creation time, port ownership,
protected status, project identity, and process ancestry immediately before acting.

Type exactly: STOP <port> <project display name>
```

Rules:

- Confirmation token must be typed by the user.
- Confirmation token must include the port and project display name.
- Confirmation challenge expires quickly. Recommended default: 60 seconds.
- Confirmation is bound to dry-run result fingerprint.
- Confirmation cannot be reused after page refresh, browser resubmission, state mismatch, or newer conflicting scan.
- No bulk confirmation.
- No hidden keyboard shortcut.
- No default-focused destructive button.
- Primary focus should remain on a neutral or cancel control, not on the destructive control.
- The destructive execution button remains disabled until typed confirmation matches exactly.

Unresolved decision: whether confirmation should require typing the process name as well as project and port. Recommendation: include process name if tests show project names are often ambiguous.

## 8. Protected Boundaries

Absolute blocks:

- Windows system processes.
- Security and antivirus processes.
- Processes matching configured protected process names or driver/vendor prefixes.
- Protected ports and protected port ranges.
- Service-managed processes unless a future service-aware design exists.
- Database categories by default.
- Local AI categories by default.
- Browser helper and editor helper categories by default.
- Unknown listeners.
- Missing creation time.
- Unstable or session-only identity.
- Missing process metadata.
- Missing listener metadata.
- Missing project ownership.
- Dev-root-only project ownership.
- Process tree containing protected ancestor.
- Process-tree max-depth truncation in first real stop version.
- Elevated process when Watchdog lacks matching privilege.
- Cross-user or cross-session process when owner/session evidence is available.
- Non-loopback listener by default.
- Wildcard listener unless future explicit policy allows it.
- Scanner unavailable during revalidation.
- Conflicting newer scan or active action lock.

Protected boundary decisions must be computed from fresh metadata during dry run and execution, not from stale UI state.

## 9. Proposed Stop Semantics

This section compares future options only. Nothing here is implemented.

Graceful application shutdown:

- Description: App-specific endpoint or protocol asks the dev server to exit.
- Benefits: Lowest data-loss risk.
- Risks: Not standardized; may require app integration; can be spoofed if not authenticated.
- Initial version: Prohibited unless the app explicitly registers a local, authenticated, read-only-to-action transition in a future managed-project model.

Console control signal:

- Description: Send console event to process group.
- Benefits: Closer to Ctrl+C in terminal.
- Risks: Windows console ownership is complex; can affect other processes in the console group; may require attaching to console; ambiguous parent/child impact.
- Initial version: Not acceptable until terminal ownership and process group boundaries are testable.

Process termination:

- Description: Terminate the exact process instance after revalidation.
- Benefits: Narrowest mechanically if constrained to one PID.
- Risks: Not graceful; may lose in-memory work; may fail under permissions; service managers may respawn.
- Initial future real-stop candidate: Acceptable only as explicitly confirmed single-process termination, not tree termination, after all gates pass.

Process-tree termination:

- Description: Stop PID and descendants.
- Benefits: Can clean up child server processes.
- Risks: High false-positive blast radius; tree may include package managers, terminals, shells, editors, or shared child processes.
- Initial version: Prohibited.

Package-manager-aware shutdown:

- Description: Use npm/pnpm/yarn/bun lifecycle or terminal process relationship.
- Benefits: Closer to how dev server was launched.
- Risks: Requires shell/package-manager context, command provenance, working directory, and terminal ownership.
- Initial version: Prohibited for execution; may be modeled in dry-run evidence.

Container-aware shutdown:

- Description: Use Docker or compose primitives.
- Benefits: Correct abstraction for containerized servers.
- Risks: Project/compose identity, container ownership, and service boundaries are separate from PID/listener identity.
- Initial version: Prohibited. Requires separate container action contract.

Initial future real-stop recommendation: single-process termination only, with a clear label such as "Stop verified process instance," not "clean up," "kill tree," or "restart."

## 10. Restart Deferral Recommendation

Restart should be deferred beyond the first stop implementation.

Restart is riskier because accurate restart requires:

- Working directory.
- Environment variables.
- Shell type.
- Package manager.
- Command arguments.
- Secret handling.
- Elevation state.
- Parent launcher.
- Terminal ownership.
- Process group behavior.
- File watcher expectations.
- Service/container manager behavior.

Observed command lines are not safe restart recipes. They may be redacted, truncated, inherited from wrapper processes, contain secrets, depend on shell aliases, depend on environment, or be launched from an editor terminal with implicit state.

Future restart design must require explicit managed-project command provenance, not reconstruction from process metadata.

## 11. Race-Condition Handling

PID reuse:

- Mitigation: PID plus creation time is mandatory.
- If creation time differs, cancel with `CREATION_TIME_MISMATCH`.

Port reassignment:

- Mitigation: requery listener table immediately before action.
- If port belongs to a different PID, cancel with `PORT_OWNER_CHANGED`.

Process exit during confirmation:

- Mitigation: execution revalidation checks PID exists.
- If gone, return `ALREADY_EXITED` and do not treat as success unless policy later defines no-op success.

Child process replacing parent:

- Mitigation: revalidate exact PID and process tree.
- If target process role changed, cancel with `PROCESS_TREE_CHANGED`.

Project path changes:

- Mitigation: re-evaluate project ownership and marker.
- If root missing or ownership source changes, cancel with `PROJECT_IDENTITY_CHANGED`.

Overlapping scans:

- Mitigation: include scan ID and validation fingerprint.
- If newer scan has conflicting identity/listener data, cancel with `CONFLICTING_NEWER_SCAN`.

Concurrent action requests:

- Mitigation: per-process-instance action lock.
- Duplicate request returns existing status if idempotency key matches; otherwise `ACTION_ALREADY_IN_PROGRESS`.

Browser refresh/resubmission:

- Mitigation: idempotency key plus one-use confirmation token.
- Reused execution request returns current action status, not a second execution.

Stale status-access or future confirmation tokens:

- Mitigation: short expiration and fingerprint comparison.
- Expired or mismatched tokens return `DRY_RUN_EXPIRED` or `DRY_RUN_STALE`.

## 12. Audit-Log Contract

Action logs are local, privacy-safe, append-only records. Audit-log write failure must not allow execution to proceed in the first real stop version. Fail closed unless a future policy explicitly defines emergency behavior.

Allowed fields:

- `actionRequestId`
- `timestamp`
- `action`
- `phase`
- `status`
- `processInstanceId`
- `listenerId`
- `pid`
- `processName`
- `port`
- `host`
- `category`
- `confidenceLevel`
- `projectDisplayName`
- `projectSource`
- `validationResult`
- `confirmationResult`
- `executionResult`
- `errorCode`
- `errorCategory`
- `scanId`
- `dryRunId`
- `confirmationId`
- `idempotencyKeyHash`

Prohibited fields:

- Raw command lines.
- Parent command lines.
- Raw process trees.
- Raw CIM records.
- Secrets or tokens.
- Unredacted user paths.
- Full HTTP response bodies.
- Query strings.
- Cookies or headers.
- Protected-process details beyond safe category/code.
- Machine identifiers.
- External IP addresses.

Example:

```json
{
  "schemaVersion": "localhost-watchdog.action-log.v1",
  "actionRequestId": "actreq_20260617_120000_01",
  "timestamp": "2026-06-17T12:00:00.000Z",
  "action": "stop",
  "phase": "dry-run",
  "status": "blocked",
  "processInstanceId": "pid-12345-created-2026-06-17t11-00-00-000z",
  "listenerId": "pid-12345-created-2026-06-17t11-00-00-000z-listener-tcp-127-0-0-1-3000",
  "pid": 12345,
  "processName": "node.exe",
  "port": 3000,
  "host": "127.0.0.1",
  "category": "node-dev-server",
  "confidenceLevel": "high",
  "projectDisplayName": "my-app",
  "projectSource": "marker:package.json",
  "validationResult": "blocked",
  "confirmationResult": "not-issued",
  "executionResult": "not-attempted",
  "errorCode": "PROCESS_TREE_PROTECTED_ANCESTOR",
  "errorCategory": "protected-boundary"
}
```

## 13. Failure Model

All failures should return safe codes and user-safe messages.

| Scenario | Outcome |
| --- | --- |
| Already exited | Cancel. Return `ALREADY_EXITED`. No process action. |
| Identity mismatch | Cancel. Return `IDENTITY_MISMATCH` or more specific `CREATION_TIME_MISMATCH`. |
| Permission denied | Cancel. Return `PERMISSION_DENIED`. Do not auto-elevate. |
| Partial process-tree shutdown | Prohibited in first version because tree shutdown is not allowed. If later supported, return `PARTIAL_TREE_FAILURE` and require audit entry. |
| Listener remains active | Return `LISTENER_STILL_ACTIVE` after post-action verification. Treat as failed or unknown, not success. |
| Process immediately respawns | Return `PROCESS_RESPAWNED` with service-manager suspicion. Do not retry automatically. |
| Action timeout | Return `ACTION_TIMEOUT`. Do not escalate method. |
| Scanner unavailable during revalidation | Block before action. Return `REVALIDATION_UNAVAILABLE`. |
| Audit-log write failure | Block before action in first real stop version. Return `AUDIT_LOG_UNAVAILABLE`. |
| Duplicate request | If idempotency key matches, return existing status. If not, return `ACTION_ALREADY_IN_PROGRESS`. |
| Confirmation expired | Return `CONFIRMATION_EXPIRED`. Require new dry run. |
| Dry run expired | Return `DRY_RUN_EXPIRED`. Require fresh dry run. |

## 14. Proposed API Schemas

The dry-run request/status endpoints are implemented as read-only revalidation. Confirmation, execution, action-status-for-execution, and audit-log view endpoints are future proposals only and must not be implemented in the current read-only phase.

Security requirements for all future action endpoints:

- Bind server to localhost only.
- Reject non-localhost `Host` and `Origin` where detectable.
- Require same-origin requests.
- Require CSRF token or same-origin nonce issued by the local UI.
- Require idempotency key for dry-run and execution requests.
- Return `Cache-Control: no-store`.
- Do not accept GET for action mutation or token issuance.
- Do not support bulk targets.

### Dry-Run Request

```txt
POST /api/actions/stop/dry-run
```

Request:

```json
{
  "schemaVersion": "localhost-watchdog.action-request.v1",
  "processInstanceId": "pid-12345-created-2026-06-17t11-00-00-000z",
  "listenerId": "pid-12345-created-2026-06-17t11-00-00-000z-listener-tcp-127-0-0-1-3000",
  "scanId": "scan-2026-06-17T12:00:00.000Z",
  "idempotencyKey": "idem_opaque_random",
  "csrfToken": "csrf_opaque_random"
}
```

Response: dry-run contract from section 6.

### Confirmation Issuance

Future proposal only; not implemented.

```txt
POST /api/actions/stop/confirmations
```

Request:

```json
{
  "schemaVersion": "localhost-watchdog.confirmation-request.v1",
  "dryRunId": "dryrun_20260617_120000_01",
  "processInstanceId": "pid-12345-created-2026-06-17t11-00-00-000z",
  "listenerId": "pid-12345-created-2026-06-17t11-00-00-000z-listener-tcp-127-0-0-1-3000",
  "idempotencyKey": "idem_opaque_random",
  "csrfToken": "csrf_opaque_random"
}
```

Response:

```json
{
  "ok": true,
  "schemaVersion": "localhost-watchdog.confirmation.v1",
  "confirmationId": "confirm_20260617_120000_01",
  "dryRunId": "dryrun_20260617_120000_01",
  "expiresAt": "2026-06-17T12:01:00.000Z",
  "typedToken": "STOP 3000 my-app",
  "display": {
    "action": "stop",
    "processName": "node.exe",
    "pid": 12345,
    "port": 3000,
    "host": "127.0.0.1",
    "projectDisplayName": "my-app",
    "riskText": "This stops one verified local development process. It will be revalidated immediately before execution."
  }
}
```

### Execution Request

Future proposal only; not implemented.

```txt
POST /api/actions/stop/simulate-execution
```

Request:

```json
{
  "schemaVersion": "localhost-watchdog.execution-request.v1",
  "confirmationId": "confirm_20260617_120000_01",
  "typedToken": "STOP 3000 my-app",
  "processInstanceId": "pid-12345-created-2026-06-17t11-00-00-000z",
  "listenerId": "pid-12345-created-2026-06-17t11-00-00-000z-listener-tcp-127-0-0-1-3000",
  "idempotencyKey": "idem_opaque_random",
  "csrfToken": "csrf_opaque_random"
}
```

Response:

```json
{
  "ok": false,
  "schemaVersion": "localhost-watchdog.execution-result.v1",
  "actionRequestId": "actreq_20260617_120000_01",
  "status": "not-implemented",
  "message": "Execution is not implemented in the current read-only phase."
}
```

The response above is the only acceptable behavior if these routes are accidentally sketched before real implementation is approved.

### Action Status

Future proposal only for execution flows; the current implementation has only read-only dry-run status.

```txt
GET /api/actions/:actionRequestId/status
```

Response:

```json
{
  "ok": true,
  "schemaVersion": "localhost-watchdog.action-status.v1",
  "actionRequestId": "actreq_20260617_120000_01",
  "action": "stop",
  "phase": "dry-run",
  "status": "blocked",
  "updatedAt": "2026-06-17T12:00:00.000Z",
  "result": {
    "code": "CREATION_TIME_MISMATCH",
    "category": "identity",
    "message": "The process identity changed since it was scanned."
  }
}
```

### Audit-Log View

Future proposal only; the current implementation writes local dry-run audit records but does not expose an audit-log view endpoint.

```txt
GET /api/actions/audit-log
```

Response:

```json
{
  "ok": true,
  "schemaVersion": "localhost-watchdog.action-audit-view.v1",
  "entries": [
    {
      "actionRequestId": "actreq_20260617_120000_01",
      "timestamp": "2026-06-17T12:00:00.000Z",
      "action": "stop",
      "phase": "dry-run",
      "status": "blocked",
      "processName": "node.exe",
      "port": 3000,
      "category": "node-dev-server",
      "projectDisplayName": "my-app",
      "errorCode": "CREATION_TIME_MISMATCH",
      "errorCategory": "identity"
    }
  ]
}
```

Common future error codes:

```txt
ACTION_NOT_IMPLEMENTED
ACTION_ALREADY_IN_PROGRESS
ALREADY_EXITED
AUDIT_LOG_UNAVAILABLE
CONFIRMATION_EXPIRED
CONFIRMATION_MISMATCH
CONFLICTING_NEWER_SCAN
CREATION_TIME_MISMATCH
DRY_RUN_EXPIRED
DRY_RUN_STALE
IDENTITY_MISMATCH
INSUFFICIENT_PRIVILEGE
LISTENER_STILL_ACTIVE
MISSING_CREATION_TIME
MISSING_PROCESS_METADATA
PERMISSION_DENIED
PORT_OWNER_CHANGED
PROCESS_NAME_CHANGED
PROCESS_RESPAWNED
PROCESS_TREE_CHANGED
PROCESS_TREE_PROTECTED_ANCESTOR
PROJECT_IDENTITY_CHANGED
PROTECTED_CATEGORY
PROTECTED_PORT
PROTECTED_PROCESS
REVALIDATION_UNAVAILABLE
UNSTABLE_IDENTITY
UNKNOWN_LISTENER
WILDCARD_BIND_BLOCKED
```

## 15. Proposed UI States

Future UI states:

- `inspect-only`: Show context and explain why action is unavailable.
- `blocked`: Show block reasons with safe error codes and plain-language explanations.
- `dry-run available`: Show a neutral "Validate stop..." action, not "Stop."
- `dry-run passed`: Show validation result and expiration timer.
- `dry-run warning`: Show warnings and disable execution if policy requires.
- `confirmation required`: Show exact typed token field and risk details.
- `executing`: Disable controls; show that revalidation is happening first.
- `succeeded`: Show post-action verification result and audit-log reference.
- `failed`: Show safe error code/category and next manual inspection guidance.
- `identity changed/cancelled`: Explain that the process changed and no action was taken.

UI constraints:

- No destructive UI in current phase.
- No disabled placeholder that implies stop is already available.
- No bulk action controls.
- No restart controls.
- No default-focused destructive button.
- No keyboard shortcut for execution.
- Confirmation input must be blank by default.
- Status text must not rely on color alone.
- Evidence and validation details should be accessible via native disclosure controls.

## 16. Required Pre-Implementation Tests

Required before any real stop implementation:

- PID reuse with different creation time blocks.
- Creation-time mismatch blocks.
- Port reassignment blocks.
- Process name mismatch blocks.
- Host/bind mismatch blocks.
- Project identity changed blocks.
- Protected process blocks.
- Protected port blocks.
- Protected ancestor blocks.
- Unknown listener blocks.
- Database category blocks.
- Local AI category blocks.
- Browser/editor helper category blocks.
- Missing metadata blocks.
- Missing creation time blocks.
- Unstable/session-only ID blocks.
- Stale dry run blocks.
- Expired confirmation blocks.
- Typed confirmation mismatch blocks.
- Duplicate request with same idempotency key returns same status.
- Duplicate request with different idempotency key blocks.
- Permission denied fails closed.
- Process respawn is reported without retry.
- Partial tree failure cannot happen in first version because tree actions are prohibited.
- Audit-log write failure blocks execution.
- Scanner unavailable during revalidation blocks.
- Privacy/redaction in all dry-run, confirmation, execution, status, audit-log, diagnostics, fixture, and UI outputs.
- No restart command reconstruction.
- No bulk actions.
- No hidden destructive controls.
- No execution, confirmation, restart, kill, cleanup, or bulk endpoints in read-only builds.
- CSRF/local-origin protections reject cross-origin attempts.
- Browser refresh/resubmission cannot repeat execution.
- Confirmation cannot be reused after state change.

Recommended test layers:

- Unit tests for eligibility and block code mapping.
- Fixture tests for Windows scanner/revalidation edge cases.
- API contract tests using fake scanner providers.
- UI render tests for every future state.
- Privacy snapshot tests over action logs and errors.
- Integration tests using controlled local dummy processes before real stop is enabled.

## 17. Explicit Non-Goals

Non-goals for this design phase:

- Implement stop.
- Implement restart.
- Implement kill.
- Implement cleanup.
- Implement tray behavior.
- Implement bulk actions.
- Implement elevation.
- Implement process signaling.
- Implement destructive endpoints.
- Change `safeToStop`, `safeToRestart`, or `bulkStoppable`.
- Add destructive UI controls.
- Add cleanup recommendations.
- Reconstruct restart commands from observed command lines.
- Manage databases, local AI servers, browsers, editors, services, containers, or unknown listeners.
- Upload, share, or transmit action logs.

## 18. Go/No-Go Checklist for First Dry-Run-Only Action Phase

Go only if all are true:

- Runtime remains read-only.
- No execution endpoint exists.
- No process signaling code exists.
- No destructive UI control exists.
- Eligibility states are implemented without `safeToStop: true`.
- Dry-run endpoint, if added, mutates no process.
- Dry-run uses fresh scanner data, not stale UI state.
- Dry-run blocks missing creation time and unstable identity.
- Dry-run blocks protected process, protected port, protected ancestor, unknown listener, database, and local AI categories.
- Dry-run requires high-confidence dev-server category.
- Dry-run requires marker-confirmed or configured project ownership.
- Dry-run reports pass/warn/block evidence with safe messages.
- Dry-run tokens expire and are bound to validation fingerprints.
- Confirmation issuance, if added, does not enable execution.
- Audit-log schema is privacy-safe and validated.
- All action outputs exclude raw command lines, secrets, unredacted user paths, raw process trees, raw CIM data, headers, cookies, and query credentials.
- Tests cover PID reuse, port reassignment, protected boundaries, stale tokens, duplicate requests, permission denial, scanner failure, and privacy.

No-go if any are true:

- Any code path can signal, terminate, stop, restart, or clean up a process.
- Any action flag becomes true.
- Any endpoint accepts bulk targets.
- Any endpoint can execute after a stale dry run.
- Any confirmation can be reused.
- Any raw command line or unredacted path reaches API, UI, logs, fixtures, diagnostics, or export.
- Restart design depends on command reconstruction from process metadata.
