# Execution Contract

> [!IMPORTANT]
> **Status: Future Design Specification**
> This document defines the architectural and safety requirements for any future process-stop execution phase in Localhost Watchdog. The current implementation remains completely non-destructive: it performs only read-only dry-run safety checks, confirmation intent recording, and execution simulations. No process signaling, killing, or termination capability is present in the source code.

---

## 1. Single-Use Execution Proof

To prevent unauthorized, repeated, or accidental process stop actions, any future execution phase must require a short-lived, single-use **Execution Proof**.

1. **Token Issuance**: 
   - Upon successful user confirmation (where the typed phrase matches the challenge exactly and all validation policies pass), the server generates a one-time `executionAccessToken`.
   - The token must be an opaque, cryptographically secure random string (e.g., 32 bytes of entropy encoded as hex).
   - The token is never stored in plaintext on the server; the server stores only a SHA-256 hash.
2. **Short Time-to-Live (TTL)**:
   - The token must expire quickly. The default TTL is **30 seconds** from issuance.
3. **Strict Binding**:
   - The token is tightly bound to:
     - The active user session (`sessionNonce`).
     - The validation fingerprint (`validationFingerprint`) computed from the scan.
     - The specific `processInstanceId` and `listenerId` of the target.
4. **Single-Use Enforcement**:
   - The token can be consumed exactly once.
   - When a POST request to `/api/actions/stop/execute` is received, the server immediately marks the corresponding token hash as consumed/invalid.
   - Subsequent or duplicate requests presenting the same token must fail closed with a generic `EXECUTION_PROOF_INVALID` or `DRY_RUN_EXPIRED` response.

---

## 2. Final Revalidation

Immediately upon receiving a valid execution request (before any process action or signal is dispatched), the server must execute a **Final Revalidation** pass.

- **Fresh Scanner Pass**: The server triggers a fresh, live scan of the local system's TCP listener table and process metadata.
- **Race-Condition Checks**: The server checks that:
  - The target PID still exists.
  - The process creation time still matches the expected time exactly (`CREATION_TIME_MATCH`).
  - The process executable name still matches (`PROCESS_NAME_MATCH`).
  - The target listener port is still bound and belongs to the correct PID (`LISTENER_PORT_OWNERSHIP`).
  - The bind address/host class matches (`HOST_BIND_MATCH`).
  - No new, conflicting scan results exist.
- **Fail Closed**: If any check fails, or if WMI/CIM/PowerShell query sources are temporarily unavailable, the execution must abort immediately, log a blocked attempt, and return a safe error code.

---

## 3. Graceful-Stop Semantics

If stop execution is later enabled, it must adhere to strict safety boundaries to prevent data loss, system instability, or unintended process disruption.

- **Single-Process Constraint**: The stop action applies strictly to a single, verified process instance. Bulk stopping of non-dev servers, databases, or local AI servers is prohibited by default.
- **No Destructive Primitives by Default**:
  - The tool must not use force-killing (`taskkill /F`, `Stop-Process -Force`, or `kill -9`) in the default flow.
  - The action must target only processes classified as development runtimes (`node.exe`, `python.exe`, `java.exe`) with a confidence level of `high` (80+).
- **Graceful Shutdown Escalation**:
  1. **Console Control Signal**: The initial attempt should send a graceful console control signal (such as `Ctrl+C` or `SIGINT` equivalent) to the target process group, allowing the dev server to run its cleanup hooks (saving files, closing database connections).
  2. **Graceful Single-Process Exit**: If console signals are unsafe or unsupported on the platform, the tool uses standard process exit requests (`System.Diagnostics.Process.CloseMainWindow` or equivalent) targeting the specific PID.
  3. **No Auto-Escalation**: The tool must never automatically escalate to a hard kill without a separate, explicit user request and secondary confirmation.

---

## 4. Timeout and Post-Action Verification

To guarantee that the target process has exited and that the system has returned to a safe state, the execution flow must incorporate timeout and verification loops.

1. **Execution Timeout**:
   - The execution command has a strict time limit (default: **5 seconds**).
2. **Post-Action Verification Loop**:
   - Once the stop signal is dispatched, the watchdog enters a brief polling loop (e.g., checks every 500ms).
   - During each check, it queries the local system for the presence of the PID and the listener port.
3. **Verification Outcomes**:
   - **Successful Stop**: Both the process (PID) and the listener (port) disappear within the timeout window. The server returns `actionExecuted: true` and `state: "success"`.
   - **Listener Still Active**: If the listener remains active after the timeout, the action is marked as failed. The server returns `LISTENER_STILL_ACTIVE` and marks the status as degraded.
   - **Process Respawned**: If the process exits but a service manager (e.g., Windows Service Control Manager, PM2, or a wrapper shell loop) immediately restarts it under a new PID, the server returns `PROCESS_RESPAWNED`. The tool must not auto-retry.

---

## 5. Audit-Log Contract

Every execution attempt, success, or failure must be audited.

- **Mandatory Writing**: An append-only audit record must be written to `.localhost-watchdog/execution-audit.jsonl`. If writing fails (e.g., disk full, permission denied), the execution must fail closed and abort before signaling the process.
- **Privacy-Safe Content**:
  - **Allowed Fields**: Timestamp, request ID, dry-run request ID, confirmation ID, target PID, host/port, category, confidence level, final outcome state, and error code.
  - **Prohibited Fields**: Command lines (unredacted or redacted), process trees, environment variables, user paths, HTTP response bodies, secrets, or username/SID details.

---

## 6. Replay and Race-Condition Protection

To defend against replay attacks, network glitches, or user double-clicks, the watchdog implements:

- **Idempotency Keys**: All execution requests must include a unique `idempotencyKey`. If a request with an identical key is received, the server returns the cached outcome of the first execution rather than executing a new action.
- **Cross-Origin Protections**: All execution routes enforce localhost-only origin and referrers, rejecting cross-site request forgery (CSRF) attempts.
- **Server Restart Invalidation**: In-memory tokens and active confirmations are cleared if the Localhost Watchdog server is restarted.

---

## 7. Error Behavior and Privacy

All error states must prevent exposure of sensitive system details.

- **Privacy-Safe Error Codes**: All errors must return standardized, safe codes from the allowed schema, including:
  - `ALREADY_EXITED`: The target process exited before the action could be dispatched.
  - `IDENTITY_MISMATCH` / `CREATION_TIME_MISMATCH`: The process identity changed (e.g., PID recycled).
  - `PORT_OWNER_CHANGED`: The port was taken by a different process.
  - `EXECUTION_TIMEOUT`: The process did not exit within the timeout window.
  - `REVALIDATION_UNAVAILABLE`: The scanner could not query the process/port table.
- **Redaction of Raw Exceptions**: Under no circumstances should raw OS exception messages, folder paths, command fragments, or stack traces be returned in API responses or written to audit logs.
