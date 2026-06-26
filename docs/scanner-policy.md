# Scanner Policy

## Read-Only Rule

The Phase 1 scanner may inspect local TCP listeners and process metadata only. It must not stop, restart, suspend, signal, mutate, or reprioritize any process.

## Command-Line Redaction Rules

Command lines may contain secrets. Redaction happens during normalization before records are emitted to CLI output, API responses, fixtures, or UI inspection.

Redact:

- Environment variable assignments whose keys include `token`, `secret`, `password`, `passwd`, `api_key`, `apikey`, `key`, `auth`, `session`, `credential`, or `client_secret`.
- CLI flags containing those same fragments, both `--flag=value` and `--flag value` forms.
- `Bearer ...` and `Basic ...` authorization values.
- URL password components are removed from emitted output.

Do not store an unredacted command line in normalized scanner output.

Top-level executable paths are also normalized before output. Paths under Windows user profiles are compacted to `%USERPROFILE%`, and sensitive environment placeholders such as `%SECRET_TOKEN%` are redacted before API, UI, fixture, history, diagnostics, export, error, or log output.

HTTP probe final URLs are sanitized at the probe boundary. The scanner strips query strings, fragments, and embedded credentials before `finalUrl` leaves the probe module.

Recoverable scanner, probe, config, history, and API errors use stable safe codes/categories plus user-safe messages. Raw exception text, shell output, command fragments, paths, tokens, and environment values are not exposed through API, diagnostics, UI, history, export, or logs.

## Process Identity and Listener Normalization

Visible records use explicit identity fields:

- `processInstanceId` is stable only when PID and `Win32_Process.CreationDate` are available.
- `listenerId` and `id` include protocol, normalized bind address, and port as secondary listener identity.
- Records without reliable creation time use `session-unstable-*` identifiers and must not be treated as durable process identity.

Duplicate listener rows are normalized before classification:

- Identical PID, protocol, normalized bind address, and port rows are merged.
- `localhost` and `127.0.0.1` are equivalent.
- `[::1]` and `::1` are equivalent.
- `*` and `0.0.0.0` are equivalent.
- IPv4 loopback and IPv6 loopback remain distinct.
- Wildcard binds and loopback binds remain distinct so network-exposure meaning is preserved.

## Fixture Capture Policy

Fixtures are allowed only when they are sanitized.

Before committing captured output:

- Replace usernames if needed.
- Replace project names if they reveal private work.
- Replace tokens, API keys, session IDs, passwords, signed URLs, database URLs, and auth headers.
- Prefer minimal fixtures that include only fields needed by parser tests.
- Do not commit full machine-wide process dumps.

## Protected Process Rules

Protected process names are hidden or inspect-only and must never receive destructive actions.

Initial protected list:

- Windows core: `System`, `Idle`, `Registry`, `svchost.exe`, `csrss.exe`, `wininit.exe`, `winlogon.exe`, `services.exe`, `lsass.exe`, `explorer.exe`, `dwm.exe`
- Search/security/sync: `SearchIndexer.exe`, `MsMpEng.exe`, `SecurityHealthService.exe`, `OneDrive.exe`, `Dropbox.exe`
- Browsers and collaboration apps: `chrome.exe`, `msedge.exe`, `firefox.exe`, `Teams.exe`, `Discord.exe`
- Driver/vendor prefixes: `NVIDIA*`, `AMD*`, `Intel*`, `Audio*`
- Docker Desktop core processes are protected in this phase.

## Phase 2 Classification Categories

Explicit scanner categories:

- `node-dev-server`
- `python-dev-server`
- `local-ai-server`
- `database`
- `browser-helper`
- `editor-helper`
- `java-dev-server`
- `system-or-protected`
- `unknown-listener`

Every classification returns an `evidence` array. Each evidence entry includes:

- `type`
- `score`
- `message`

The legacy `reasons` field remains as a message-only projection of evidence.

## Phase 3 HTTP Probe Policy

HTTP probing is read-only enrichment for visible loopback listeners.

Rules:

- Probe only localhost or loopback URLs by default.
- Use strict timeouts so a slow service cannot block scans.
- Do not store full response bodies.
- Read only a small bounded response prefix for title and framework hints.
- Follow redirects only when the next URL is still localhost or loopback.
- Block redirects to external destinations.
- Redact probe error messages before output.
- Add probe evidence with score `0`.
- Never let HTTP probe results grant `safeToStop`, `safeToRestart`, or bulk action permissions.

## Phase 4 Dashboard Policy

The dashboard is a read-only rendering surface.

Rules:

- Render only data returned by `/api/servers`.
- Treat framework, title, and server detections as hints, not guaranteed facts.
- Show network exposure warnings when listeners bind to all interfaces.
- Show evidence so category and confidence decisions are explainable.
- Display command lines only after scanner redaction.
- Do not render or store full HTTP response bodies.
- Do not add stop, restart, tray, destructive, or bulk-action controls.

## Phase 4.5 Dashboard Smoke Test Policy

Dashboard smoke tests should use fake API data for UI states that are difficult or unsafe to reproduce from live processes.

Coverage expectations:

- Reachable and unreachable probe states.
- Network exposure warnings.
- Unknown, helper, local AI, database, dev-server, and protected/read-only categories.
- Empty list, loading, and API error states.
- Filter and sort behavior.
- Redacted command-line rendering.
- Absence of destructive controls.

Use lightweight test helpers before adding browser automation dependencies. A browser test tool should only be added when real layout, interaction, or accessibility behavior cannot be validated through shared render helpers.

## Phase 4.6 Accessibility and Keyboard Policy

Dashboard accessibility checks should remain read-only and should validate:

- Interactive controls have clear accessible names.
- Filter buttons expose selected state with `aria-pressed`.
- Status and loading messages are readable text with appropriate live-region semantics.
- Error messages use alert semantics.
- Open links include server context, not only a generic label.
- Evidence sections use native `details` and `summary` so they remain keyboard-operable.
- Focus states are visible for keyboard users.
- Reachability, warning, unknown, protected, and read-only states are not communicated by color alone.
- Destructive controls remain absent.

## Phase 5 Project Ownership Policy

Project ownership detection is read-only enrichment.

Rules:

- Use configured project paths first when available.
- Use configured dev roots to limit marker-based inference.
- Search upward from safe local path candidates inferred from redacted command lines, executable paths, or known working directories.
- Recognize `package.json`, `.git`, `vite.config.*`, `next.config.*`, `astro.config.*`, `pyproject.toml`, `requirements.txt`, `manage.py`, `pom.xml`, and `build.gradle`.
- Prefer `package.json` `name` as the display name when available.
- Fall back to the nearest folder name when no explicit name exists.
- Redact paths under the user profile as `%USERPROFILE%`.
- Add ownership evidence with bounded confidence.
- Never let ownership evidence grant stop, restart, process killing, tray, destructive, or bulk-action permissions.

## Phase 6A User Dev Roots Policy

Optional user-configured dev roots live in `config/dev-roots.json`.

Rules:

- Accept only existing absolute directories as dev-root search boundaries.
- Ignore missing, empty, relative, malformed, or inaccessible dev-root entries.
- Merge accepted user roots with built-in safety roots and explicit project paths.
- Redact user-profile paths in API and dashboard output as `%USERPROFILE%`.
- Ownership inference may search upward only while it remains inside configured dev roots.
- Roots outside configured dev roots remain ignored unless explicitly configured in `config/projects.json`.
- Configured dev roots are trust boundaries for detection only, not permission grants.
- Dev-root and ownership evidence cannot enable stop, restart, process killing, tray, destructive, or bulk actions.

## Parent-Process and Launcher Context Policy

Launcher context is read-only enrichment for visible server records.

Rules:

- Resolve parent PID, parent process name, command line, and executable path from Windows CIM process metadata when available.
- Redact parent command lines before normalized scanner output, API responses, fixtures, logs, or UI rendering.
- Redact user-profile paths in parent process path fields.
- Identify common launch contexts such as VS Code, Cursor, Windows Terminal, PowerShell, Command Prompt, Git Bash, npm/npx/pnpm/yarn, node, python, java, Docker Desktop, and `docker compose`.
- Add launcher evidence with bounded confidence impact.
- Treat missing or inaccessible parent metadata as `Parent process unknown`.
- Never let launcher evidence grant stop, restart, process killing, tray, destructive, or bulk-action permissions.

## Multi-Hop Process-Tree Policy

Process-tree context is read-only ancestry enrichment for visible server records.

Rules:

- Walk parent processes only from already collected Windows CIM process metadata.
- Default to a strict maximum traversal depth of `5`.
- Stop traversal when parent PID is missing, parent process metadata is unavailable, parent PID repeats, a cycle is detected, a protected/system process is reached, or max depth is reached.
- Include only safe chain fields: PID, process name, category, launcher name, redacted command line, and redacted executable path.
- Detect common ancestry patterns such as VS Code -> shell -> package manager -> node, Cursor -> shell -> package manager -> node, Windows Terminal -> PowerShell -> python, cmd -> npm -> node, Git Bash -> package manager -> node, Gradle/Maven -> java, Python launcher -> python server, and Docker Desktop or `docker compose`.
- Add process-tree evidence with bounded confidence impact.
- Keep detailed process-tree data inside scanner/API output and dashboard evidence/details sections.
- Never let process-tree evidence grant stop, restart, process killing, tray, destructive, or bulk-action permissions.

## Process Age and Lifecycle Context Policy

Lifecycle context is read-only heuristic enrichment for visible server records.

Rules:

- Derive `createdAt`, `ageMs`, age label, timing source, timing status, and timing error from Windows process creation metadata.
- Treat missing, invalid, and future/skewed creation times as explicit timing states.
- Use only cautious labels: `active`, `long-running`, `possibly-detached`, `stale-candidate`, and `unknown`.
- Do not use definitive labels such as orphaned, abandoned, safe to kill, or unused.
- Never classify a process as stale based on age alone.
- Require multiple explainable signals before using `stale-candidate`.
- Consider signals such as long-running age, missing immediate parent metadata, unavailable original editor/terminal ancestry, unexpected process-tree stop, unreachable/non-HTTP probe for HTTP dev servers, missing project path, weak or missing ownership, and temporary dev-server shape.
- Exclude databases, local AI servers, browser/editor helpers, protected/system processes, and unknown listeners from stale-candidate scoring by default.
- Treat max-depth process-tree truncation as a limitation, not a stale signal by itself.
- Show stale/detached context as informational only and never as a cleanup recommendation.
- Never let lifecycle context grant stop, restart, process killing, tray, destructive, automatic cleanup, or bulk-action permissions.

## Privacy-Safe Historical Snapshot Policy

Historical scan comparison is read-only context for visible server records.

Rules:

- Store history in a simple local JSON file.
- Use `PID + process creation time` as the process-instance identity.
- Do not treat PID reuse with a different creation time as the same process.
- Do not persist records without a stable creation time as process instances.
- Persist only privacy-safe normalized fields: process instance ID, first seen time, last seen time, seen count, consecutive seen count, most recent port, category, confidence level, safe project display identity, HTTP reachable state, lifecycle label, previous lifecycle score, and scan identifier.
- Do not persist raw CIM records, full response bodies, unredacted command lines, secrets, unredacted user paths, complete process trees, or protected-process details beyond safe aggregate counts.
- Use atomic file writes.
- Recover safely from missing history files, invalid JSON, interrupted temp writes, schema mismatches, and unwritable history locations.
- History failures must not block live scanner output.
- Add history warnings to scanner output when storage is corrupt, unavailable, disabled, or write failed.
- Apply retention pruning by maximum snapshot count, maximum history age, and maximum tracked process records.
- Treat repeated or continuous observation as informational only.
- Historical persistence may add bounded context evidence, but it must not by itself mark a process stale.
- Never let history context grant stop, restart, cleanup, process killing, tray, destructive, automatic cleanup, or bulk-action permissions.

## Configuration and Diagnostics Policy

Diagnostics is a read-only inspection surface.

Rules:

- Report effective runtime configuration without exposing secrets, raw command lines, raw CIM data, complete process trees, full HTTP response bodies, or unredacted user paths.
- Report source and status for safety config, project config, dev-root config, protected process rules, protected port rules, common development ports, HTTP probing, process-tree depth, lifecycle thresholds, history settings, retention settings, and privacy settings.
- Distinguish configured, effective, defaulted, invalid/ignored, and unavailable values where practical.
- Do not silently hide invalid dev roots in diagnostics. Scanner behavior may ignore them safely, but diagnostics must show each rejected root with a safe display path and reason.
- Use status labels such as `healthy`, `degraded`, `disabled`, `warning`, and `unavailable`.
- Report scanner fallback health and recoverable errors without turning them into hard failures for the diagnostics endpoint.
- Report history corruption, schema mismatch, disabled history, unavailable storage, and write failures as diagnostics context.
- Do not expose raw environment values. Environment-variable expansion may be reported as a boolean and paths must use safe display forms.
- Never add stop, restart, cleanup, process killing, tray, destructive, recommendation-to-kill, automatic cleanup, or bulk-action controls to diagnostics.

## Privacy-Safe Diagnostics Export Policy

Diagnostics export is a read-only troubleshooting surface.

Rules:

- Build exports from an explicit allowlist of approved fields.
- Do not serialize full diagnostics, scanner snapshots, process records, history files, runtime objects, or DOM content and then redact afterward.
- Support Markdown and JSON output. Markdown is the default.
- Include an export schema/version identifier and creation timestamp.
- Include only aggregate or capability-level information such as application version, operating system family, safe runtime version, diagnostics status, scanner source/capability status, visible/hidden counts, warning categories, probe settings and aggregate outcomes, process-context status, lifecycle status, history health/retention, dev-root counts and rejection reasons, configuration-source states, and privacy/redaction status.
- Export dev roots only as counts plus generalized labels such as `Dev Root 1`; never export the underlying absolute path.
- Prefer aggregate listener counts. Do not include complete process lists.
- Do not include raw command lines, parent command lines, process trees, raw CIM data, raw environment values, secrets, tokens, full absolute user paths, raw history records, response bodies, query strings, cookies, headers, protected-process details, local usernames, machine identifiers, or external IP addresses.
- Validate generated export content before enabling copy or download.
- Block copy/download when validation detects likely bearer tokens, API keys, passwords, sensitive command arguments, Windows user-profile paths, raw command fragments, credential-like query strings, cookies, authorization headers, or raw environment-variable references.
- Validation errors must not display the suspected secret value.
- The dashboard must generate a preview only after explicit user action.
- Copy must copy only the generated preview string.
- Download must use generic timestamped filenames.
- Do not automatically copy, download, upload, share, transmit, stop, restart, cleanup, kill, recommend cleanup, or perform bulk actions.

## Dry-Run Eligibility Policy

Dry-run eligibility is the first read-only action-system phase. It validates whether a visible record would pass safety gates, but it does not execute anything.

Rules:

- Keep `safeToStop`, `safeToRestart`, and `bulkStoppable` false for every record and result.
- Treat `dry-run-eligible` as permission to run a read-only safety check only.
- Treat `confirmation-eligible` as permission to request a non-executing confirmation review only; no execution endpoint exists in this phase.
- Require stable PID plus creation-time identity. Missing creation time or `session-unstable-*` identity blocks dry-run.
- Require listener identity and fresh port/PID/bind-address revalidation.
- Require high-confidence `node-dev-server`, `python-dev-server`, or `java-dev-server` category plus configured or marker-confirmed project ownership.
- Block protected/system records, protected ports, protected ancestors, databases, local AI servers, unknown listeners, missing metadata, listener reassignment, identity mismatch, scanner unavailability, and audit-log write failure.
- Use a short-lived opaque `statusAccessToken` tied to process and listener identity. It authorizes dry-run status read only, does not authorize confirmation or execution, is never accepted in a URL path/query string, and is never returned by status lookup.
- Store only a hash of the status-access token where practical, and compare supplied tokens in a timing-safe way.
- Request ID alone must never retrieve a detailed dry-run result. Missing, wrong, malformed, expired, cross-request, or unknown status tokens return a generic unavailable response with no existence disclosure.
- Treat mandatory revalidation checks as fail-closed. Missing, null, empty, malformed, warning, unavailable, or blocked mandatory fields prevent `confirmation-eligible`.
- Mandatory dry-run evidence includes PID, creation time, stable process-instance identity, listener identity, port, host, process name, category, confidence level, protected process/port/tree boundary result, process metadata, scanner validation fingerprint, project name/root/source, lifecycle non-stale status, and audit-log success.
- Write only privacy-safe dry-run audit records containing request ID, timestamps, redacted identity, check outcomes, eligibility state, expiration, and `actionExecuted:false`.
- Do not include command lines, parent command lines, process trees, raw CIM records, secrets, raw paths, response bodies, headers, cookies, or query strings in dry-run audit output.
- Reject non-localhost host/origin attempts where detectable.
- Do not add stop, restart, kill, cleanup, tray, execution, or bulk controls.

## Confirmation-Only Policy

Confirmation records explicit user intent only. It cannot stop, restart, signal, suspend, terminate, clean up, or otherwise modify any process.

Rules:

- Require strict localhost Host and Origin validation for confirmation endpoints.
- Require a server-generated session nonce and CSRF token.
- Require JSON content type and bounded request bodies.
- Require an unexpired dry-run status proof.
- Create a separate short-lived `confirmationAccessToken` that authorizes confirmation submission only.
- Store confirmation token material as a hash where practical and compare with timing-safe equality.
- Never accept confirmation tokens in URL paths or query strings.
- Never render, log, audit, export, persist, or store confirmation tokens in browser local/session storage.
- Require exact typed confirmation phrase matching with trim-only, case-sensitive normalization.
- Revalidate PID, creation time, process-instance identity, listener ID, port, host, process name, category, project identity, protected boundaries, owner/session, elevation/integrity, scanner availability, and validation fingerprint before acceptance.
- Block confirmation on missing owner, missing session, different user, different login session, SYSTEM/service ownership, unverifiable elevation, elevated mismatch, audit write failure, expired dry run, token mismatch, or any mandatory revalidation failure.
- Accepted confirmation must return `actionExecuted:false` and `executionAuthorized:false`.
- Accepted confirmation must state `Confirmation recorded. No process action was executed.`
- Confirmation audit records must be privacy-safe and must not contain tokens, typed phrases, cookies, CSRF tokens, raw request bodies, command lines, raw paths, process trees, owner names, SIDs, or secrets.

Safe probe metadata:

- reachable true/false
- HTTP status code
- response time
- final URL after allowed redirects
- content type
- HTML page title
- framework/server hints
- redacted error message

## Initial Classification Confidence Model

The Phase 1 model is informational and read-only. It can decide visibility and category, but it cannot grant stop or restart permissions.

Current score inputs:

- `+30` listening on localhost.
- `+25` process name is a known development runtime.
- `+20` path or command line appears inside a common development folder.
- `+15` port is a common development port.
- `+15` command includes a development server keyword.
- `-50` binds to all interfaces.
- `-100` protected process name.

Phase 2 confidence levels:

- `high`: strong runtime/command/project evidence and score at least `75`.
- `medium`: partial runtime/category evidence and score at least `45`.
- `low`: weak or helper-only evidence. Visible only when useful for inspection, never manageable.

Visibility:

- Protected processes are hidden and counted as protected.
- Non-localhost listeners are hidden and counted as non-localhost.
- Unknown records below medium confidence are hidden as low-confidence.
- Browser helpers, editor helpers, databases, local AI servers, and Java helper/development listeners may remain visible when useful, but are inspect-only.
- Visible records are read-only and expose only `open` and `inspect` actions.

Destructive flags:

- `safeToStop`: always `false`
- `safeToRestart`: always `false`
- `bulkStoppable`: always `false`
