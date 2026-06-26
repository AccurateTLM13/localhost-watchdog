# Privacy Notes

Localhost Watchdog is local-first and read-only in the current implementation.

## Normalized Scanner Output

Normalized scanner output redacts command lines and top-level executable paths before records leave the scanner boundary. User-profile paths are compacted to `%USERPROFILE%`, and sensitive environment placeholders are redacted.

HTTP probe `finalUrl` values are sanitized before output. Query strings, fragments, and embedded credentials are removed; only safe localhost origin/path information is retained.

Recoverable scanner, probe, config, history, and API errors use stable safe codes/categories plus user-safe messages. Raw exception text, command fragments, shell output, paths, tokens, and environment values must not be exposed through API responses, diagnostics, UI, history, export, or logs.

## Scan History

History is stored locally as JSON at `.localhost-watchdog/history.json` by default. The directory is ignored by Git.

Persisted history records may include:

- process instance ID built from PID and process creation time
- first seen and last seen timestamps
- seen count and consecutive seen count
- most recent port
- category and confidence level
- safe project display name
- HTTP reachable true/false/null
- lifecycle label and previous lifecycle score
- scan identifier

Persisted history records must not include:

- raw CIM records
- command lines
- secrets
- unredacted user paths
- full HTTP response bodies
- process trees
- parent command lines
- protected-process details beyond aggregate counts

History failures do not block live scan results. Missing, corrupt, schema-mismatched, disabled, or unwritable history is reported as scanner context only.

History context is informational. It is not permission to stop, restart, kill, clean up, or bulk-manage any process.

## Dry-Run Audit Records

Dry-run safety checks are read-only. They may write a local audit record at `.localhost-watchdog/dry-run-audit.jsonl` so the tool can explain why a safety check passed or blocked.

Dry-run audit records may include:

- schema version and record type
- request ID
- evaluated and expiration timestamps
- process instance ID and listener ID
- category and confidence level
- eligibility state
- pass/block status
- check codes, statuses, and safe messages
- `actionExecuted:false`

Dry-run audit records must not include:

- raw command lines or parent command lines
- process trees
- raw CIM records
- secrets or tokens
- unredacted paths
- full HTTP response bodies
- query strings
- headers or cookies
- protected-process details

Dry-run creation returns a one-time `statusAccessToken` for status reads only. The raw status token is not written to audit records, diagnostics, exports, history, logs, rendered UI details, or status responses. Stored dry-run status keeps only a hash where practical; status lookup with a missing, malformed, wrong, expired, or cross-request token returns a generic unavailable response without disclosing whether the request ID exists.

Audit write failure blocks dry-run eligibility in this phase, but it does not affect or mutate the target process.

## Confirmation Audit Records

Confirmation records explicit user intent only. They do not authorize or execute process actions.

Confirmation audit records are written locally at `.localhost-watchdog/confirmation-audit.jsonl` and may include:

- schema version and record type
- confirmation request ID
- related dry-run request ID
- timestamp and expiration
- redacted process/listener identity
- session, Origin/Host, and CSRF validation outcomes
- owner/session and elevation outcome labels
- phrase accepted/rejected result by challenge ID
- final confirmation state
- `actionExecuted:false`
- `executionAuthorized:false`

Confirmation audit records must not include:

- confirmation tokens or token hashes
- dry-run status tokens or token hashes
- typed phrases
- cookies or CSRF tokens
- raw request bodies
- owner names or SIDs
- command lines or parent command lines
- raw paths
- process trees
- raw scanner records
- secrets

Confirmation audit write failure blocks confirmation acceptance, but it does not affect or mutate the target process.

## Diagnostics

Diagnostics reports effective configuration and runtime health using safe display values.

Diagnostics may include:

- config source file names
- safe display paths
- whether environment variables were expanded
- invalid dev-root rejection reasons
- aggregate scanner/probe/history counts
- redaction and persistence status

Diagnostics must not include:

- secrets
- unredacted command lines
- raw environment values
- raw CIM snapshots
- full HTTP response bodies
- complete process trees
- protected-process details
- cleanup recommendations

## Diagnostics Export

Diagnostics export is stricter than the diagnostics API. Export content is built from an explicit allowlist of approved summary fields. The implementation must not serialize full diagnostics, scanner snapshots, process records, or runtime objects and then redact them afterward.

Export formats:

- Markdown troubleshooting summary, the default.
- JSON diagnostic bundle with the same allowlisted content.

Export may include:

- application version
- operating system family and safe Node.js version
- diagnostics status
- scanner source and capability status
- visible, hidden, and scanned aggregate counts
- recoverable scanner warning categories
- HTTP probe configuration and aggregate outcomes
- process-context, lifecycle, and history status
- history retention limits
- dev-root counts and generalized rejection reasons
- privacy/redaction status
- configuration-source configured/defaulted state
- export creation timestamp

Export must not include:

- raw command lines or parent command lines
- process trees
- raw CIM data
- raw environment values
- secrets or tokens
- full absolute user paths
- raw history records
- response bodies
- query strings
- cookies or headers
- protected-process details
- complete process lists
- local usernames
- machine identifiers
- external IP addresses

Dev-root export is limited to total configured, total valid, total ignored, generalized labels such as `Dev Root 1`, and rejection reasons. The underlying absolute path is not exported.

Export validation runs before preview content can be copied or downloaded. It blocks output that resembles bearer tokens, API keys, passwords, sensitive command arguments, Windows user-profile paths, raw command fragments, credential-like query strings, cookies, authorization headers, or raw environment-variable references. Validation errors do not display the suspected secret value.

The dashboard export UI is explicit-action only. It does not automatically copy, download, upload, share, or transmit diagnostics. Copy uses only the generated preview content.
