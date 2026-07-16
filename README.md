# Localhost Watchdog

Localhost Watchdog is a Windows-first local development server scanner. The current dashboard and built-in scanner remain inspect-first: they scan local listeners, classify likely development servers, probe localhost HTTP metadata, detect project ownership, report launcher/process-tree context, add cautious lifecycle context, and compare privacy-safe local scan history.

The action path now includes dry-run, confirmation, simulation, and a guarded proof-gated stop execution route. The default graceful-stop backend fails closed unless a platform-safe dispatcher is explicitly supplied; no force stop, restart, tray, bulk cleanup, process-tree killing, `process.kill`, `taskkill`, or `Stop-Process` primitive exists in this phase.

## Commands

```powershell
npm test
npm run lint
npm run scan
npm start
```

`npm run scan` prints a JSON snapshot of visible likely local development listeners plus hidden counts. `npm start` runs the read-only dashboard at `http://127.0.0.1:4545`.

Read-only API endpoints:

- `GET /api/servers`
- `GET /api/diagnostics`
- `GET /api/diagnostics/export`
- `GET /api/health`
- `POST /api/session`
- `POST /api/actions/stop/dry-run`
- `POST /api/actions/dry-runs/status`
- `POST /api/actions/stop/confirmations`
- `POST /api/actions/stop/confirmations/submit`
- `POST /api/actions/stop/confirmations/status`
- `POST /api/actions/stop/confirmations/cancel`
- `POST /api/actions/stop/simulate-execution`
- `POST /api/actions/stop/execute`

The dry-run, confirmation, and simulation endpoints perform safety revalidation and intent recording only. `POST /api/actions/stop/execute` requires a short-lived execution proof issued by accepted confirmation, repeats final revalidation, requires audit availability, and uses an injected graceful-stop dispatcher. Without that dispatcher, the endpoint fails closed and does not stop, restart, signal, kill, clean up, or mutate any process.

## Scanner Strategy

Windows scanning uses:

1. `Get-NetTCPConnection -State Listen`
2. `Get-CimInstance Win32_Process`
3. `netstat -ano` as a fallback if the primary TCP scan fails or returns no parseable listeners

Command lines and top-level executable paths are redacted during normalization before scanner output is returned.

Visible records expose stable `processInstanceId` values only when PID plus Windows process creation time are available. Per-listener `id`/`listenerId` values may add host and port as secondary listener context. Records without reliable creation time use explicit `session-unstable-*` identifiers.

Equivalent duplicate listener rows are merged before classification. IPv4 and IPv6 listeners remain distinct where meaningful, and wildcard binds remain separate from loopback binds so network-exposure warnings stay accurate.

When available, scanner output also resolves a listener's parent process and bounded ancestry from `Get-CimInstance Win32_Process`. Parent and ancestry command lines are redacted before output and exposed only as read-only context.

Visible loopback listeners also receive read-only HTTP probe enrichment. Probes use short timeouts, do not store response bodies, do not follow redirects to non-localhost destinations, and strip query strings, fragments, and embedded credentials from emitted final URLs.

Scanner, probe, config, history, and API failures are reported with safe error codes/categories and user-safe messages. Raw exception text is not exposed through API, diagnostics, UI, history, export, or logs.

## Safety Boundaries

- Protected processes are hidden or read-only and never actionable.
- Unknown low-confidence listeners are hidden by default and counted.
- Dashboard-visible records remain inspect/open only unless an explicit proof-gated backend execution flow is invoked through the protected API.
- `safeToStop`, `safeToRestart`, and `bulkStoppable` are always `false` on scanner records.
- Classification output includes structured `evidence` entries and a `confidenceLevel`.
- HTTP probe evidence has score `0`; probe results cannot make a process manageable.
- Dry-run eligibility is separate from action flags. A passed dry run can report `confirmation-eligible`, but still grants no permission to execute an action.
- Confirmation records explicit user intent and may issue a short-lived single-use execution proof for the exact confirmed target. Confirmation itself still returns `actionExecuted:false`.

## Dry-Run Eligibility

Visible records include read-only `actionEligibility` metadata:

- `state`: `ineligible`, `inspect-only`, `dry-run-eligible`, `confirmation-eligible`, or `blocked`
- `canDryRun`
- `safeMessage`
- `validationFingerprint`
- `checks`

`POST /api/actions/stop/dry-run` accepts a stable `processInstanceId`, `listenerId`, and expected safe fields from the visible record. The server performs a fresh scanner pass and revalidates PID plus creation time, listener identity, port ownership, bind address, process name, category, confidence, project ownership, protected process/port/tree boundaries, metadata availability, and conflicting newer evidence.

Dry-run creation responses include `requestId`, one-time `statusAccessToken`, `statusAccess`, `evaluatedAt`, `expiresAt`, `processInstanceId`, `listenerId`, `eligibilityState`, `passed`, `checks`, `warnings`, `blockers`, `safeMessage`, and `actionExecuted:false`. Status lookup uses `POST /api/actions/dry-runs/status` with `requestId` plus `statusAccessToken` in the JSON body or `x-dry-run-status-token` header. Stored status results and UI rendering never return or display the raw status token. The token authorizes status read only, expires with the result, and does not authorize confirmation or execution.

Dry-run confirmation eligibility fails closed when mandatory revalidation fields are unavailable, malformed, warning, or blocked. Mandatory fields include stable process identity, creation time, listener identity, PID, port, host, process name, category, confidence level, protected boundary checks, project ownership fields, process metadata, scanner fingerprint, and audit-log availability.

Absolute dry-run blocks include protected/system records, protected ports or ancestors, databases, local AI servers, unknown listeners, missing creation time, unstable/session-scoped identity, missing process metadata, identity mismatch, listener reassignment, elevated privilege mismatch, scanner unavailability, and audit-log write failure.

Dry-run attempts write a privacy-safe local audit record to `.localhost-watchdog/dry-run-audit.jsonl`. Audit write failure blocks dry-run eligibility but cannot affect the target process.

## Confirmation-Only Intent Recording

Confirmation is separate from dry-run status and separate from execution dispatch. It records explicit intent and can issue a short-lived execution proof, but confirmation submission itself cannot stop, restart, signal, suspend, terminate, clean up, or otherwise modify a process.

The dashboard first requests a short-lived local session from `POST /api/session`. Confirmation endpoints require strict localhost Host and Origin checks, a server-generated session nonce, CSRF validation, JSON content type, bounded request bodies, and an unexpired dry-run status proof. Missing, null, malformed, or foreign origins fail closed.

`POST /api/actions/stop/confirmations` creates a short-lived confirmation review for a passed dry run. It returns a one-time `confirmationAccessToken` for in-memory client use only. The token authorizes confirmation submission only, never execution, and is not rendered, logged, audited, exported, persisted, or accepted in URLs.

`POST /api/actions/stop/confirmations/submit` requires the confirmation token, session/CSRF proof, dry-run status proof, and an exact typed phrase such as `CONFIRM PORT 5173 ABCD`. The server trims leading/trailing whitespace only; case and internal spacing must match. A successful result says `Confirmation recorded. No process action was executed.`

Confirmation fails closed when owner/session/elevation metadata is unavailable or unsafe. The first implementation blocks different users, different login sessions, SYSTEM/service ownership, missing owner/session data, elevated targets without matching verified privilege, and unverifiable integrity state. Current scanner records expose unavailable owner/session/elevation metadata explicitly, so live confirmation remains blocked unless safe metadata is present.

Confirmation attempts write privacy-safe audit records to `.localhost-watchdog/confirmation-audit.jsonl`. Audit write failure blocks confirmation acceptance.

## Categories

Current read-only categories:

- `node-dev-server`
- `python-dev-server`
- `local-ai-server`
- `database`
- `browser-helper`
- `editor-helper`
- `java-dev-server`
- `system-or-protected`
- `unknown-listener`

## HTTP Probe Fields

Each visible eligible record includes `httpProbe`:

- `attempted`
- `reachable`
- `statusCode`
- `responseTimeMs`
- `finalUrl`
- `contentType`
- `title`
- `hints`
- `redirectBlocked`
- `error`

Records also include `networkExposure`, which warns when a listener binds to all interfaces. Probes still use localhost URLs only.

## Lifecycle Context

Visible server records include process timing fields derived from Windows process metadata:

- `createdAt`
- `ageMs`
- `ageLabel`
- `timingSource`
- `timingStatus`
- `timingError`

Records also include read-only `lifecycleContext` with cautious labels:

- `active`
- `long-running`
- `possibly-detached`
- `stale-candidate`
- `unknown`

Detached and stale labels are heuristics, not facts. A process is never marked stale from age alone. Stale-candidate scoring requires multiple explainable signals, category eligibility, and a configurable minimum score. Databases, local AI servers, browser/editor helpers, protected/system processes, and unknown listeners are excluded from stale-candidate scoring by default.

## Dashboard

The dashboard is plain HTML, CSS, and JavaScript served by the existing Node server. It renders:

- Summary counts for scanned, visible, hidden, reachable HTTP, network-exposed, and unknown listeners.
- Cards for visible listeners with port, host, URL, process name, category, confidence, probe metadata, hints, safety state, and evidence.
- Read-only action readiness with safety-check states, dry-run results, block reasons, and explicit "permission not granted" text.
- Project ownership when a server can be tied to a configured project root or marker files.
- Launcher context such as "Launched from VS Code", "Launched from PowerShell", or "Parent process unknown" when parent metadata is available.
- Compact process chains such as `VS Code -> PowerShell -> npm -> node` when bounded ancestry is available.
- Process start time, running duration, lifecycle label, lifecycle signals, and an explicit informational-only warning.
- Filters for all visible, dev servers, local AI, databases, browser/editor helpers, unknown, network-exposed, and protected/read-only records.
- Sorting by port, confidence, category, or process.

All command lines shown in the dashboard are the redacted scanner output. Full HTTP response bodies are not rendered or stored.

Dashboard smoke tests use fake `/api/servers` data with Node's built-in test runner. No browser test dependency is required for the current read-only rendering checks.

Accessibility and keyboard smoke checks cover filter button state, refresh and sort labels, contextual open links, native details disclosures, loading/error states, network warnings, HTTP probe status text, visible focus styles, and absence of destructive controls.

## Project Ownership

Visible server records may include a read-only `project` field. Ownership detection uses configured project paths, configured dev roots, and nearby marker files such as `package.json`, `.git`, `vite.config.*`, `next.config.*`, `astro.config.*`, `pyproject.toml`, `requirements.txt`, `manage.py`, `pom.xml`, and `build.gradle`.

Project ownership can add confidence evidence, but it never enables stop, restart, or bulk actions.

## Launcher Context

Visible server records may include a read-only `launcher` field derived from parent process metadata:

- `parentPid`
- `parentProcessName`
- `parentCategory`
- `launcherName`
- `confidenceImpact`
- `parentCommandLine`
- `parentExecutablePath`
- `evidence`

Known launch contexts include VS Code, Cursor, Windows Terminal, PowerShell, Command Prompt, Git Bash, npm/npx/pnpm/yarn, node, python, java, Docker Desktop, and `docker compose`. Launcher evidence may raise display confidence, but it never enables stop, restart, or bulk actions.

Visible server records may also include a read-only `processTree` field:

- `depth`
- `truncated`
- `stopReason`
- `rootLauncher`
- `chain`
- `evidence`

Process-tree traversal defaults to a maximum depth of `5` and stops on missing parent PID, missing parent metadata, cycles, protected/system boundaries, or max depth. Process-tree evidence is bounded and informational only; it never enables stop, restart, process killing, or bulk actions.

Lifecycle thresholds can be configured in `config/safety.json`:

```json
{
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
  }
}
```

Lifecycle scoring is informational only and never enables stop, restart, cleanup, process killing, or bulk actions.

## History

Scan history is a lightweight local JSON file, enabled by default at:

```txt
.localhost-watchdog/history.json
```

The default directory is ignored by Git. History uses `PID + createdAt` as the process-instance identity, so PID reuse with a different creation time is treated as a different process. Records without creation time are not persisted as stable process instances.

Persisted fields are intentionally minimal:

- process instance ID
- first and last seen time
- seen and consecutive-seen counts
- most recent port
- category
- confidence level
- safe project display identity
- HTTP reachable state
- lifecycle label and previous lifecycle score
- scan identifier

History does not persist command lines, raw CIM records, response bodies, unredacted paths, process trees, secrets, or protected-process details beyond aggregate counts. Missing, corrupt, schema-mismatched, or unwritable history never blocks the live scanner; the current scan still returns with a history warning.

History retention is configured in `config/safety.json`:

```json
{
  "history": {
    "enabled": true,
    "storagePath": ".localhost-watchdog/history.json",
    "maxSnapshots": 25,
    "maxHistoryAgeMs": 1209600000,
    "maxProcessRecords": 500
  }
}
```

Historical persistence is informational. Repeated observation can explain lifecycle context, but it is not proof of abandonment and cannot mark a process stale by itself.

## Diagnostics

`GET /api/diagnostics` returns a privacy-safe effective configuration and runtime health report. It includes:

- configuration source/status for safety config, projects config, and dev roots
- valid and ignored dev roots with safe display paths and rejection reasons
- protected process/port and common dev-port settings
- HTTP probe settings and probe summary
- process-tree depth and process-enrichment status
- lifecycle thresholds
- history storage health and retention limits
- scanner source/fallback status and last scan summary
- privacy and safety flags

Diagnostics uses status labels such as `healthy`, `degraded`, `disabled`, `warning`, and `unavailable`. It does not expose secrets, raw command lines, raw CIM snapshots, full response bodies, complete process trees, or unredacted user paths.

`GET /api/diagnostics/export` builds a privacy-safe troubleshooting summary from an explicit allowlist of approved fields. Markdown is the default format; JSON is available with `?format=json`. The export includes only aggregate scanner and diagnostics information such as app/runtime version, status labels, scanner capability status, visible/hidden counts, probe settings/outcomes, process-context status, lifecycle status, history health/retention, dev-root counts/rejection reasons, configuration-source states, privacy flags, and an export timestamp.

The export intentionally excludes raw command lines, parent command lines, process trees, raw CIM data, raw environment values, secrets/tokens, full user paths, raw history records, response bodies, query strings, cookies/headers, protected-process details, complete process lists, usernames, machine identifiers, and external IP addresses. Dev roots are exported only as counts plus generalized labels such as `Dev Root 1` with a rejection reason.

The dashboard export panel is explicit-action only: Generate Preview, then Copy Summary or Download Summary. It does not automatically copy, download, upload, share, or transmit anything. Copy uses only the generated preview text. Download filenames are generic and timestamped.

Export UI smoke tests use fake export API responses plus injected clipboard, Blob, URL, and document helpers. They verify initial disabled states, explicit Markdown/JSON preview generation, format-switch invalidation, validation failures, copy/download behavior, accessibility labels, and absence of automatic upload/sharing or destructive controls without using a real browser clipboard or writing files.

Optional user dev roots can be configured in `config/dev-roots.json`:

```json
{
  "version": 1,
  "devRoots": [
    "%USERPROFILE%\\code",
    "D:\\projects"
  ]
}
```

Only existing absolute directories are accepted as ownership search boundaries. Project paths explicitly listed in `config/projects.json` are still trusted as configured projects even when they sit outside dev roots. API and dashboard output redact user-profile roots as `%USERPROFILE%`.

Managed project entries may also include `startCommand`, `preferredPort`, `portStrategy`, `runtime`, and `tags`. Start and restart requests are fail-closed unless the server is created with an injected project launcher; the repository does not spawn arbitrary commands by default. `GET /api/projects` lists validated configured projects, while protected `POST /api/projects/start` and `POST /api/projects/restart` require the same local session and CSRF checks used by action execution endpoints.

See [docs/scanner-policy.md](docs/scanner-policy.md) for redaction, fixture, protected-process, and confidence rules.

## Document Map

| File | Purpose |
|---|---|
| `docs/01-product-brief.md` | Product vision, users, scope, non-goals |
| `docs/02-research-reuse-map.md` | What to borrow from similar GitHub projects |
| `docs/03-architecture.md` | Proposed system architecture and modules |
| `docs/04-safety-model.md` | Process protection, confidence scoring, kill rules |
| `docs/05-phased-roadmap.md` | Milestones that build on each other |
| `docs/06-testing-strategy.md` | Proactive testing patterns and validation matrix |
| `docs/07-data-contracts.md` | JSON schemas and config shapes |
| `docs/08-agent-prompts.md` | Ready-to-use implementation prompts |
| `docs/09-release-checklist.md` | Quality gates before each release |
| `docs/10-human-safety-review-guide.md` | Human approval, Windows QA, evidence, and signoff guide |
| `docs/privacy.md` | Privacy notes for local scan history |
| `docs/progress.md` | Implementation progress log |
| `docs/reuse-decisions.md` | Reuse and license decisions |
