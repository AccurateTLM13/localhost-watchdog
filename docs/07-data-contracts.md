# 07 — Data Contracts

## Server Record

Every scanner result should normalize into this shape.

Phase 3 note: the current app is still read-only. Current classifier categories are `node-dev-server`, `python-dev-server`, `local-ai-server`, `database`, `browser-helper`, `editor-helper`, `java-dev-server`, `system-or-protected`, and `unknown-listener`. Current scanner records include `confidenceLevel`, structured `evidence`, `networkExposure`, and read-only `httpProbe` metadata. Destructive flags remain `false` until a later safe-action phase.

Phase 4 dashboard note: the dashboard consumes this same API shape directly. It does not add permissions or infer destructive actions client-side. UI filters are presentation-only.

Phase 4.5 test note: dashboard smoke tests use a fake snapshot with the same `/api/servers` shape so UI states can be tested without relying on live local processes.

Phase 4.6 accessibility note: dashboard accessibility tests validate semantic rendering and keyboard-facing labels from the same API shape. They do not alter scanner data or introduce client-side action permissions.

Phase 5 ownership note: current records may include a read-only `project` field. Project ownership can add evidence and raise display confidence, but it does not grant action permissions.

Phase 6A dev-root note: scanner responses may include redacted configured dev-root search boundaries. These roots constrain project ownership detection and do not grant action permissions.

Launcher-context note: current records may include a read-only `launcher` field derived from parent process metadata. Launcher evidence can raise display confidence, but it does not grant action permissions.

Process-tree note: current records may include a read-only `processTree` field derived from bounded parent-process traversal. Process-tree evidence can raise display confidence, but it does not grant action permissions.

Lifecycle note: current records include read-only process timing fields and `lifecycleContext`. Lifecycle labels are cautious heuristics and never grant action permissions.

History note: scanner responses may include top-level read-only `history` status and per-record `historyContext`. History uses `PID + createdAt` identity and persists only privacy-safe normalized fields.

Dry-run eligibility note: current records may include read-only `actionEligibility`. This field can make a record eligible for a read-only safety check, but it does not grant stop/restart permission and does not change `safeToStop`, `safeToRestart`, or `bulkStoppable`.

Identity note: visible records expose `processInstanceId` when Windows creation time is reliable. `listenerId` and `id` add protocol, host, and port only as secondary listener identity. Records without reliable creation time use an explicit `session-unstable-*` identifier and must not be treated as durable process identity.

Duplicate-listener note: equivalent listener rows are merged when PID, protocol, normalized bind address, and port are identical. IPv4 loopback and IPv6 loopback are retained as distinct listeners. Wildcard binds and loopback binds are retained separately so network-exposure meaning is preserved.

```json
{
  "config": {
    "devRoots": [
      "%USERPROFILE%\\code",
      "D:\\projects"
    ]
  }
}
```

```json
{
  "history": {
    "enabled": true,
    "storageHealth": "available",
    "retainedSnapshotCount": 3,
    "oldestRetainedSnapshot": "2026-06-16T20:00:00.000Z",
    "lastSuccessfulHistoryWrite": "2026-06-16T21:00:00.000Z",
    "disappearedSincePrevious": 1,
    "redactionPrivacyStatus": "privacy-safe normalized fields only; no command lines, paths, response bodies, or process trees persisted",
    "warning": null
  }
}
```

```json
{
  "id": "pid-12345-created-2026-06-16t14-22-00-000z-listener-tcp-127-0-0-1-3000",
  "processInstanceId": "pid-12345-created-2026-06-16t14-22-00-000z",
  "listenerId": "pid-12345-created-2026-06-16t14-22-00-000z-listener-tcp-127-0-0-1-3000",
  "identity": {
    "status": "stable",
    "scope": "process-instance",
    "processInstanceId": "pid-12345-created-2026-06-16t14-22-00-000z",
    "listenerId": "pid-12345-created-2026-06-16t14-22-00-000z-listener-tcp-127-0-0-1-3000",
    "listenerKey": "listener-tcp-127-0-0-1-3000",
    "pid": 12345,
    "createdAt": "2026-06-16T14:22:00.000Z",
    "source": "pid-and-creation-time",
    "evidence": [
      "process identity uses PID plus Win32_Process.CreationDate",
      "listener host and port are secondary listener identity only"
    ]
  },
  "pid": 12345,
  "parentPid": 12000,
  "port": 3000,
  "host": "127.0.0.1",
  "protocol": "tcp",
  "url": "http://localhost:3000",
  "processName": "node.exe",
  "commandLine": "npm run dev",
  "executablePath": "C:\\Program Files\\nodejs\\node.exe",
  "workingDirectory": "%USERPROFILE%\\Desktop\\my-app",
  "creationTime": "2026-06-16T14:22:00.000Z",
  "uptimeMs": 18000000,
  "createdAt": "2026-06-16T14:22:00.000Z",
  "ageMs": 18000000,
  "ageLabel": "5 hours",
  "timingSource": "Win32_Process.CreationDate",
  "timingStatus": "available",
  "timingError": null,
  "user": "JP",
  "category": "node-dev-server",
  "runtime": "node",
  "projectId": null,
  "projectName": null,
  "project": {
    "name": "my-app",
    "root": "%USERPROFILE%\\code\\my-app",
    "confidence": 85,
    "source": "marker:package.json",
    "evidence": [
      "found package.json with name 'my-app'"
    ],
    "workingDirectory": "%USERPROFILE%\\code\\my-app"
  },
  "launcher": {
    "parentPid": 12000,
    "parentProcessName": "Code.exe",
    "parentCategory": "editor",
    "launcherName": "VS Code",
    "confidenceImpact": 8,
    "parentCommandLine": "Code.exe --folder-uri %USERPROFILE%\\code\\my-app --token [REDACTED]",
    "parentExecutablePath": "%USERPROFILE%\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
    "evidence": [
      {
        "type": "launcher",
        "score": 8,
        "message": "parent process suggests launch context: VS Code"
      }
    ]
  },
  "processTree": {
    "depth": 4,
    "truncated": false,
    "stopReason": "missing-parent-pid",
    "rootLauncher": "VS Code",
    "chain": [
      {
        "pid": 11800,
        "processName": "Code.exe",
        "category": "editor",
        "launcherName": "VS Code",
        "commandLine": "Code.exe --folder-uri %USERPROFILE%\\code\\my-app",
        "executablePath": "%USERPROFILE%\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe"
      },
      {
        "pid": 11900,
        "processName": "powershell.exe",
        "category": "terminal",
        "launcherName": "PowerShell",
        "commandLine": "powershell.exe npm run dev --password [REDACTED]",
        "executablePath": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
      },
      {
        "pid": 12000,
        "processName": "npm.cmd",
        "category": "package-manager",
        "launcherName": "npm",
        "commandLine": "npm run dev --token [REDACTED]",
        "executablePath": "C:\\Program Files\\nodejs\\npm.cmd"
      },
      {
        "pid": 12345,
        "processName": "node.exe",
        "category": "runtime",
        "launcherName": "node",
        "commandLine": "npm run dev",
        "executablePath": "C:\\Program Files\\nodejs\\node.exe"
      }
    ],
    "evidence": [
      {
        "type": "process-tree",
        "score": 8,
        "message": "process-tree pattern detected: VS Code -> shell -> package manager -> node"
      }
    ]
  },
  "lifecycleContext": {
    "label": "long-running",
    "processAge": {
      "createdAt": "2026-06-16T14:22:00.000Z",
      "ageMs": 18000000,
      "label": "5 hours",
      "source": "Win32_Process.CreationDate",
      "status": "available",
      "error": null
    },
    "parentAvailable": true,
    "rootLauncherAvailable": true,
    "treeStopReason": "missing-parent-pid",
    "detachedCandidate": false,
    "staleCandidate": false,
    "staleScore": 20,
    "signals": [
      {
        "type": "age-threshold",
        "score": 20,
        "message": "process exceeds long-running threshold: 5 hours"
      }
    ],
    "limitations": [
      "informational heuristic only; not permission to stop, restart, kill, or clean up this process"
    ]
  },
  "historyContext": {
    "firstSeenAt": "2026-06-16T20:00:00.000Z",
    "lastSeenAt": "2026-06-16T21:00:00.000Z",
    "seenCount": 3,
    "consecutiveSeenCount": 3,
    "persistedAcrossScans": true,
    "previouslySeen": true,
    "reappeared": false,
    "historyStatus": "available",
    "evidence": [
      {
        "type": "history",
        "score": 0,
        "message": "process instance observed in 3 scans"
      }
    ]
  },
  "managed": false,
  "confidence": 92,
  "confidenceLevel": "high",
  "safeToShow": true,
  "safeToStop": false,
  "safeToRestart": false,
  "bulkStoppable": false,
  "actionEligibility": {
    "state": "dry-run-eligible",
    "canDryRun": true,
    "safeMessage": "This listener can run a read-only safety check.",
    "validationFingerprint": "7ee054c66ef0...",
    "checks": [
      {
        "code": "STABLE_IDENTITY",
        "status": "pass",
        "message": "Stable PID plus creation-time identity is available."
      }
    ]
  },
  "actions": ["open", "inspect"],
  "reasons": [
    "listening on localhost",
    "command includes npm run dev",
    "path is inside known dev folder",
    "common development port"
  ],
  "warnings": [],
  "networkExposure": {
    "level": "loopback",
    "warning": false,
    "message": "Listener is bound to loopback."
  },
  "httpProbe": {
    "attempted": true,
    "reachable": true,
    "statusCode": 200,
    "responseTimeMs": 42,
    "finalUrl": "http://localhost:3000/",
    "contentType": "text/html; charset=utf-8",
    "title": "Vite App",
    "hints": ["vite"],
    "redirectBlocked": false
  },
  "raw": {
    "source": "powershell"
  }
}
```

## Hidden Record Summary

Do not show full system details by default. Show counts and reasons.

```json
{
  "hidden": {
    "protected": 142,
    "unknown": 5,
    "nonLocalhost": 3,
    "lowConfidence": 7
  }
}
```

## Diagnostics

Path:

```txt
GET /api/diagnostics
```

Shape:

```json
{
  "ok": true,
  "generatedAt": "2026-06-17T15:00:00.000Z",
  "destructiveActionsAvailable": false,
  "status": "healthy",
  "configuration": {
    "sources": {
      "safety": {
        "sourceFile": "D:\\localhost-watchdog\\config\\safety.example.json",
        "status": "healthy",
        "configured": false,
        "error": null
      }
    },
    "devRoots": {
      "loadedRoots": [],
      "validRoots": [],
      "ignoredRoots": [],
      "effectiveValue": []
    },
    "httpProbeSettings": {
      "timeoutMs": 750,
      "maxRedirects": 2
    },
    "processTreeDepth": {
      "configuredValue": 5,
      "effectiveValue": 5,
      "defaultedValue": null,
      "status": "healthy"
    }
  },
  "scanner": {
    "status": "healthy",
    "activeScannerSource": "powershell",
    "lastScanId": "scan-2026-06-17T15:00:00.000Z",
    "scanDurationMs": 120
  },
  "probing": {
    "enabled": true,
    "timeoutMs": 750,
    "redirectLimit": 2,
    "responseBodyMetadataCapBytes": 65536,
    "localhostOnlyRedirectPolicy": "redirects to non-localhost destinations are blocked"
  },
  "processContext": {
    "projectOwnership": { "enabled": true, "status": "healthy" },
    "launcherContext": { "enabled": true, "status": "healthy" },
    "maxProcessTreeDepth": 5
  },
  "lifecycle": {
    "status": "healthy"
  },
  "history": {
    "enabled": true,
    "storageHealth": "healthy",
    "safeDisplayLocation": "D:\\localhost-watchdog\\.localhost-watchdog\\history.json"
  },
  "privacy": {
    "commandLineRedactionActive": true,
    "pathRedactionActive": true,
    "httpBodyPersistenceDisabled": true,
    "rawCimPersistenceDisabled": true,
    "processTreePersistenceDisabled": true,
    "protectedDetailsAggregationActive": true,
    "historyFileIgnoredByGit": true
  }
}
```

## Diagnostics Export

Path:

```txt
GET /api/diagnostics/export
GET /api/diagnostics/export?format=json
```

Markdown is the default format. JSON returns the same allowlisted content as a JSON diagnostic bundle.

Response envelope:

```json
{
  "ok": true,
  "schemaVersion": "localhost-watchdog.diagnostics-export.v1",
  "format": "markdown",
  "filename": "localhost-watchdog-diagnostics-20260617.md",
  "content": "# Localhost Watchdog Diagnostics Summary\n...",
  "validation": {
    "status": "passed",
    "checkedAt": "2026-06-17T15:00:00.000Z"
  }
}
```

Validation failure response:

```json
{
  "ok": false,
  "schemaVersion": "localhost-watchdog.diagnostics-export.v1",
  "format": "markdown",
  "filename": "localhost-watchdog-diagnostics-20260617.md",
  "content": "",
  "validation": {
    "status": "blocked",
    "code": "BEARER_TOKEN",
    "message": "Export validation blocked output because it matched a prohibited sensitive pattern."
  }
}
```

JSON bundle shape:

```json
{
  "schemaVersion": "localhost-watchdog.diagnostics-export.v1",
  "createdAt": "2026-06-17T15:00:00.000Z",
  "application": {
    "name": "localhost-watchdog",
    "version": "0.1.0"
  },
  "runtime": {
    "osFamily": "windows",
    "nodeVersion": "22.16.0"
  },
  "diagnostics": {
    "status": "healthy",
    "destructiveActionsAvailable": false
  },
  "configurationSources": {
    "safety": { "status": "healthy", "configured": true },
    "projects": { "status": "healthy", "configured": false },
    "devRoots": { "status": "healthy", "configured": false }
  },
  "scanner": {
    "status": "healthy",
    "activeScannerSource": "Get-NetTCPConnection",
    "totals": {
      "visible": 3,
      "hidden": 2,
      "scanned": 5
    },
    "warningCategories": []
  },
  "devRoots": {
    "totalConfigured": 2,
    "totalValid": 1,
    "totalIgnored": 1,
    "ignored": [
      {
        "label": "Dev Root 1",
        "reasonIgnored": "path does not exist"
      }
    ]
  },
  "privacy": {
    "commandLineRedactionActive": true,
    "pathRedactionActive": true,
    "httpBodyPersistenceDisabled": true
  },
  "actionFlags": {
    "safeToStopEnabled": false,
    "safeToRestartEnabled": false,
    "bulkActionsEnabled": false,
    "destructiveActionsAvailable": false,
    "automaticSharingEnabled": false
  }
}
```

Export content is built from an explicit allowlist. It must not include raw command lines, parent command lines, process trees, raw CIM data, raw environment values, secrets, tokens, absolute user paths, raw history records, response bodies, query strings, cookies, headers, protected-process details, complete process lists, local usernames, machine identifiers, or external IP addresses.

## Project Config

Path:

```txt
config/projects.json
```

Shape:

```json
{
  "version": 1,
  "projects": [
    {
      "id": "lighthouse-handoff",
      "name": "Lighthouse Handoff",
    "path": "%USERPROFILE%\\Desktop\\lighthouse-handoff",
    "preferredPort": 3000,
    "runtime": "node",
    "tags": ["chrome-extension", "local-ai"]
    }
  ]
}
```

Project configuration is read-only in the current implementation. It identifies known project roots and display metadata for ownership detection; it does not define start, stop, restart, cleanup, or remediation behavior.

## Safety Config

Path:

```txt
config/safety.json
```

Shape:

```json
{
  "version": 1,
  "devRoots": [
    "C:\\Users\\JP\\Desktop",
    "C:\\Users\\JP\\Documents\\GitHub",
    "C:\\Users\\JP\\Projects"
  ],
  "protectedProcesses": [
    "System",
    "svchost.exe",
    "explorer.exe",
    "MsMpEng.exe",
    "chrome.exe",
    "msedge.exe"
  ],
  "devRuntimes": [
    "node.exe",
    "npm.cmd",
    "pnpm.cmd",
    "bun.exe",
    "python.exe",
    "dotnet.exe"
  ],
  "commonDevPorts": [3000, 3001, 5173, 8000, 8080, 1313, 31313],
  "lifecycle": {
    "longRunningDevServerMs": 14400000,
    "staleCandidateMinimumScore": 60,
    "categoryExclusions": [
      "database",
      "local-ai-server",
      "browser-helper",
      "editor-helper",
      "system-or-protected",
      "unknown-listener"
    ]
  },
  "history": {
    "enabled": true,
    "storagePath": ".localhost-watchdog/history.json",
    "maxSnapshots": 25,
    "maxHistoryAgeMs": 1209600000,
    "maxProcessRecords": 500
  },
  "bulkStopExcludedCategories": ["database", "local-ai", "system", "unknown"]
}
```

## Current Read-Only API Endpoints

```txt
GET    /api/health
GET    /api/servers
GET    /api/diagnostics
GET    /api/diagnostics/export
GET    /api/diagnostics/export?format=json
POST   /api/session
POST   /api/actions/stop/dry-run
POST   /api/actions/dry-runs/status
POST   /api/actions/stop/confirmations
POST   /api/actions/stop/confirmations/submit
POST   /api/actions/stop/confirmations/status
POST   /api/actions/stop/confirmations/cancel
```

No current implemented endpoint performs stop, restart, kill, cleanup, upload, sharing, remediation, project mutation, settings mutation, or bulk action behavior.

The dry-run endpoints perform revalidation only. The confirmation endpoints record explicit user intent only. They do not execute process signals, terminate processes, restart processes, mutate projects, or enable bulk actions.

## Dry-Run Eligibility API

Path:

```txt
POST /api/actions/stop/dry-run
```

Request:

```json
{
  "processInstanceId": "pid-12345-created-2026-06-17t11-00-00-000z",
  "listenerId": "pid-12345-created-2026-06-17t11-00-00-000z-listener-tcp-127-0-0-1-3000",
  "idempotencyKey": "opaque-click-id",
  "expected": {
    "pid": 12345,
    "processName": "node.exe",
    "host": "127.0.0.1",
    "port": 3000,
    "createdAt": "2026-06-17T11:00:00.000Z",
    "projectName": "my-app",
    "projectRoot": "%USERPROFILE%\\code\\my-app",
    "projectSource": "marker:package.json",
    "category": "node-dev-server",
    "confidenceLevel": "high",
    "validationFingerprint": "7ee054c66ef0..."
  }
}
```

Response:

```json
{
  "ok": true,
  "requestId": "dryrun-0c0ffee",
  "statusAccessToken": "dryrun-status-opaque",
  "evaluatedAt": "2026-06-17T12:00:00.000Z",
  "expiresAt": "2026-06-17T12:01:00.000Z",
  "processInstanceId": "pid-12345-created-2026-06-17t11-00-00-000z",
  "listenerId": "pid-12345-created-2026-06-17t11-00-00-000z-listener-tcp-127-0-0-1-3000",
  "eligibilityState": "confirmation-eligible",
  "passed": true,
  "checks": [
    {
      "code": "PID_EXISTS",
      "status": "pass",
      "message": "Requested process identity is present in the latest scan."
    }
  ],
  "warnings": [],
  "blockers": [],
  "safeMessage": "Dry-run safety check completed. No action was executed.",
  "actionExecuted": false,
  "statusAccess": {
    "expiresAt": "2026-06-17T12:01:00.000Z",
    "tiedToProcessInstanceId": "pid-12345-created-2026-06-17t11-00-00-000z",
    "tiedToListenerId": "pid-12345-created-2026-06-17t11-00-00-000z-listener-tcp-127-0-0-1-3000",
    "authorizesStatusRead": true,
    "authorizesConfirmation": false,
    "authorizesExecution": false
  }
}
```

Status path:

```txt
POST /api/actions/dry-runs/status
```

Status request:

```json
{
  "requestId": "dryrun-0c0ffee",
  "processInstanceId": "pid-12345-created-2026-06-17t11-00-00-000z",
  "statusAccessToken": "dryrun-status-opaque"
}
```

The `statusAccessToken` may also be sent as the `x-dry-run-status-token` header. It must not be placed in a URL path or query string. Request ID alone never retrieves a detailed dry-run result. Missing, malformed, wrong, expired, cross-request, or unknown status tokens return the same generic unavailable shape:

```json
{
  "ok": false,
  "code": "DRY_RUN_STATUS_UNAVAILABLE",
  "category": "dry-run-status",
  "message": "Dry-run status is unavailable, expired, or the access token is invalid.",
  "actionExecuted": false
}
```

Status responses do not include `statusAccessToken`, `dryRunToken`, confirmation tokens, execution tokens, command lines, process trees, raw scanner payloads, or raw paths.

Dry-run check statuses are `pass`, `warning`, `blocked`, or `unavailable`. `confirmation-eligible` requires all mandatory checks to pass, no blockers, stable process identity, an unexpired result, and successful audit write. Missing, null, empty, malformed, warning, unavailable, or blocked mandatory evidence fails closed.

Mandatory dry-run fields and checks include PID, creation time, stable process-instance identity, listener identity, listener ID, port, host, process name, category, confidence level, protected process status, protected port status, protected process-tree boundary result, process metadata availability, scanner validation fingerprint, project name/root/source, non-stale lifecycle status, and audit-log availability. The status-access token authorizes status read only; it never authorizes confirmation or execution.

## Confirmation-Only API

Confirmation endpoints are implemented as non-executing intent recording. They require a local session, CSRF proof, strict localhost Host and Origin validation, JSON content type, bounded request bodies, an unexpired dry-run status proof, and a separate confirmation access token where applicable.

Session bootstrap:

```txt
POST /api/session
```

Response:

```json
{
  "ok": true,
  "sessionNonce": "lw-session-opaque",
  "csrfToken": "lw-csrf-opaque",
  "expiresAt": "2026-06-18T12:10:00.000Z",
  "actionExecuted": false,
  "executionAuthorized": false
}
```

Create confirmation review:

```txt
POST /api/actions/stop/confirmations
```

Headers:

```txt
Content-Type: application/json
Origin: http://127.0.0.1:4545
X-CSRF-Token: lw-csrf-opaque
X-Dry-Run-Status-Token: dryrun-status-opaque
```

Request:

```json
{
  "sessionNonce": "lw-session-opaque",
  "dryRunRequestId": "dryrun-opaque",
  "processInstanceId": "pid-12345-created-2026-06-17t11-00-00-000z",
  "listenerId": "pid-12345-created-2026-06-17t11-00-00-000z-listener-tcp-127-0-0-1-3000",
  "validationFingerprint": "7ee054c66ef0...",
  "idempotencyKey": "opaque-click-id"
}
```

Response:

```json
{
  "ok": true,
  "confirmationRequestId": "confirm-opaque",
  "dryRunRequestId": "dryrun-opaque",
  "state": "awaiting-confirmation",
  "expiresAt": "2026-06-18T12:01:00.000Z",
  "confirmationAccessToken": "confirm-access-opaque",
  "displayChallenge": {
    "challengeId": "challenge-abcd",
    "requiredPhrase": "CONFIRM PORT 3000 ABCD",
    "normalization": "trim-only-case-sensitive"
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

The raw `confirmationAccessToken` is returned once for in-memory browser state only. It must not be rendered, logged, audited, exported, persisted, or placed in URLs.

Submit confirmation:

```txt
POST /api/actions/stop/confirmations/submit
```

Submit requires `X-Confirmation-Access-Token`, `X-CSRF-Token`, session nonce, dry-run status proof, and the exact typed phrase. A successful response is still non-executing:

```json
{
  "ok": true,
  "confirmationRequestId": "confirm-opaque",
  "dryRunRequestId": "dryrun-opaque",
  "state": "confirmation-accepted",
  "message": "Confirmation recorded. No process action was executed.",
  "authorization": {
    "authorizesStatusRead": false,
    "authorizesConfirmation": false,
    "authorizesExecution": false
  },
  "actionExecuted": false,
  "executionAuthorized": false
}
```

Status and cancel:

```txt
POST /api/actions/stop/confirmations/status
POST /api/actions/stop/confirmations/cancel
```

Both require session/CSRF proof and the confirmation access token. Request ID alone is never enough. Missing, malformed, wrong, expired, consumed, cross-request, or unknown confirmation tokens return a generic unavailable result without existence disclosure.

Confirmation states include `not-available`, `awaiting-confirmation`, `confirmation-input-invalid`, `confirmation-accepted`, `confirmation-expired`, `identity-changed`, `dry-run-expired`, `session-invalid`, `csrf-blocked`, `owner-blocked`, `elevation-blocked`, `audit-unavailable`, and `cancelled`.

All confirmation results include `actionExecuted:false` and `executionAuthorized:false`.

## Error Shape

```json
{
  "ok": false,
  "code": "REQUEST_FAILED",
  "category": "api",
  "message": "The request could not be completed safely."
}
```

Common error codes:

```txt
REQUEST_FAILED
SCANNER_TCP_UNAVAILABLE
SCANNER_PROCESS_METADATA_UNAVAILABLE
SCANNER_NETSTAT_UNAVAILABLE
HISTORY_UNAVAILABLE
HISTORY_WRITE_FAILED
UNKNOWN_RECOVERABLE_ERROR
```

## Future Action Contract Design Notes

This section is not an implemented contract. The current app remains read-only.

Any future action-contract design must start from a separate versioned document and must require process-instance identity, PID and creation-time revalidation, listener port revalidation, protected-boundary revalidation, process-tree revalidation, dry-run semantics, explicit confirmation, privacy-safe audit logging, race-condition handling, privilege/elevation behavior, and failure/partial-success behavior.

Restart-style concepts are especially risky because command reconstruction from observed command lines is not reliable or privacy-safe by itself. Future design work must establish explicit ownership and safe command provenance before proposing any restart behavior.
