# Human Safety Review and Windows QA Guide

Use this guide for every change that affects scanning, classification, confirmation, process actions, managed-project launch, restart, or other safety-sensitive behavior.

The reviewer is approving a specific commit and a specific safety boundary. Approval does not automatically authorize later backends, UI controls, force-stop behavior, bulk actions, elevation, or broader process categories.

## The Three Decisions

Do not combine these decisions.

| Decision | Meaning | Minimum evidence |
|---|---|---|
| Ready for review | The change is coherent enough for human inspection. | Scope documented, local tests/lint pass, CI result available, known risks listed. |
| Ready to merge | The reviewed commit satisfies its stated safety boundary. | Human review complete, applicable Windows QA passes, no unresolved critical finding. |
| Ready to release | The merged artifact is safe for its intended users and environment. | Release checklist passes, actual packaged/runtime path is verified, required backend-specific QA passes. |

A draft pull request can pass automated checks and still be unapproved for merge or release.

## Five-Minute Reviewer Summary

Before reading implementation details, answer these questions:

1. What new action can the software take?
2. What can it still not do?
3. What exact evidence is required before the action is allowed?
4. What happens when evidence, audit logging, or revalidation is unavailable?
5. Does the default installed runtime perform the action, or only an explicitly injected backend?
6. Are protected, unknown, database, local-AI, browser, editor, service, and SYSTEM-owned processes still blocked?
7. Can a stale token, replayed request, changed PID, changed port owner, or changed process identity cause an action?
8. Could logs, diagnostics, errors, fixtures, or UI expose tokens, command lines, user paths, or raw system data?

If any answer is unclear, stop and request a narrower explanation before approving.

## Review Scope for PR #3

PR #3 introduces contracts and guarded seams for:

- a short-lived, single-use execution proof issued after accepted confirmation;
- `POST /api/actions/stop/execute`, protected by local session and CSRF validation;
- fresh process/listener/safety revalidation before dispatch;
- an audit write before dispatch;
- an injected graceful-stop dispatcher and post-action listener verification;
- managed-project start and restart managers using injected launcher/stopper seams.

PR #3 does **not** add:

- a production graceful-stop backend;
- a default command launcher;
- stop, restart, kill, cleanup, or bulk-action dashboard controls;
- force-stop or process-tree-kill behavior;
- automatic elevation;
- permission for scanner records to set `safeToStop`, `safeToRestart`, or `bulkStoppable` to `true`.

The built-in default dispatcher and launcher must fail closed. Real process signaling in the automated suite is limited to a test-injected dispatcher targeting a child fixture created by that test.

## What to Review in PR #3

### 1. Proof and replay boundary

Approve only if all are true:

- [ ] Confirmation itself does not execute an action.
- [ ] The execution token is opaque, short-lived, stored only as a hash, and returned only once.
- [ ] The token is bound to the accepted session, process instance, and listener.
- [ ] The token is consumed before execution revalidation and cannot be replayed.
- [ ] Real execution requires a separate idempotency key.

Primary files: `src/actions/confirmation.js`, `src/actions/execution.js`, `src/server.js`.

### 2. Fail-closed revalidation

- [ ] PID and creation-time identity still match.
- [ ] Listener ID, port ownership, host, process name, category, confidence, project ownership, and validation fingerprint still match.
- [ ] Protected-process, protected-port, process-tree, owner/session, elevation, and integrity checks still pass.
- [ ] Missing scanner, owner, session, integrity, audit, or other mandatory evidence blocks dispatch.
- [ ] Post-action verification distinguishes success, listener still active, replacement/respawn, and unavailable verification.

Primary files: `src/actions/dry-run.js`, `src/actions/security-policy.js`, `src/actions/execution.js`.

### 3. Backend boundary

- [ ] Production source contains no built-in process-kill or command-launch primitive for this milestone.
- [ ] No dispatcher or launcher means `STOP_BACKEND_UNAVAILABLE` or the equivalent fail-closed result.
- [ ] The injected backend receives only the already-validated target fields it needs.
- [ ] A backend exception becomes a safe error and does not expose raw exception text.
- [ ] No hard-kill fallback or automatic retry exists.

Primary files: `src/actions/execution.js`, `src/actions/start.js`, `src/actions/restart.js`, `src/server.js`.

### 4. Audit and privacy boundary

- [ ] The pre-dispatch audit write is mandatory and failure prevents dispatch.
- [ ] Audit records do not contain raw access tokens, command lines, process trees, environment variables, usernames/SIDs, or unredacted user paths.
- [ ] API errors and UI text do not expose raw OS exceptions or secrets.
- [ ] Tokens are not accepted in URLs and are not stored in browser persistence.

Primary files: `src/actions/audit.js`, `src/privacy/`, `test/action-source-safety.test.js`.

### 5. Managed-project boundary

- [ ] Only configured, validated projects are returned by the registry.
- [ ] Project paths are normalized for comparison and redacted for display.
- [ ] Missing launcher/stopper backends fail closed.
- [ ] Start and restart require protected local session/CSRF requests.
- [ ] The repository does not pass arbitrary unvalidated commands to a built-in shell launcher.

Primary files: `src/project/registry.js`, `src/actions/start.js`, `src/actions/restart.js`, `config/projects.example.json`.

## Manual Windows QA

### Safety rules for the reviewer

- Use a non-administrator PowerShell session unless the review explicitly targets elevation behavior.
- Do not test against an existing development server, database, local-AI server, editor, browser, service, or system process.
- Do not add a real dispatcher or launcher merely to complete this review.
- The fixture integration test may signal only the child process it starts itself.
- Stop immediately if an unrelated process exits, an elevation prompt appears, or a destructive dashboard control appears.

### Record the environment

```powershell
git rev-parse HEAD
node --version
npm --version
[System.Environment]::OSVersion.VersionString
```

Record the outputs in the signoff template below. Approval applies only to the tested commit.

### Automated gate on Windows

```powershell
npm ci
npm run lint
npm test
```

Expected result:

- dependency installation succeeds;
- lint exits with code `0`;
- every test passes;
- the fixture integration test starts and stops only its own child fixture;
- no orphan fixture listener or process remains.

If the full suite fails, preserve the exact failing test names and error text. Do not approve based on a smaller passing subset.

### Production-source primitive check

```powershell
rg -n -e "process\.kill" -e "\btaskkill\b" -e "\bStop-Process\b" -e "\bTerminateProcess\b" -e "GenerateConsoleCtrlEvent" src
```

For PR #3, expected result is no built-in action primitive in production source. Scanner subprocess code may exist for read-only PowerShell/CIM inspection, but action modules must not contain a production stop or arbitrary command-launch implementation.

### Dashboard inspection

```powershell
npm start
```

Open `http://127.0.0.1:4545` and verify:

- [ ] The dashboard loads without an administrator prompt.
- [ ] No Stop, Restart, Kill, Cleanup, Execute, or Bulk Stop button is visible.
- [ ] Protected and unknown records remain hidden or inspect-only.
- [ ] Dry-run and confirmation wording clearly distinguish intent from execution.
- [ ] No raw token, unredacted user path, or raw command-line secret is visible.

Stop the watchdog server with `Ctrl+C` when inspection is complete. Starting the dashboard performs a live local scan and may update ignored local state under `.localhost-watchdog/`; it does not authorize a process action.

### Default-backend check

Review the default server construction and confirm that no `gracefulStop` or project launcher is supplied by `npm start`. Automated tests must demonstrate that an otherwise valid execution or project-action request fails closed when its backend is unavailable.

Do not create a real execution proof and target a live process solely to test the unavailable backend. The automated fail-closed test is the safe acceptance path for this milestone.

## Stop Conditions

Reject or pause the review if any of these occur:

- CI, lint, or the full test suite fails.
- The reviewed commit differs from the tested commit.
- Production source gains a process-control or arbitrary command-launch primitive without a separately approved backend design.
- Confirmation directly executes or silently authorizes an action.
- An execution proof can be replayed, persisted, logged, placed in a URL, or used for another target.
- Audit failure does not block dispatch.
- Missing or changed identity, ownership, listener, protection, or privilege evidence does not fail closed.
- A protected, unknown, database, local-AI, browser, editor, service, or SYSTEM-owned process becomes actionable by default.
- Raw exceptions, tokens, secrets, command lines, SIDs/usernames, or unredacted paths appear in output.
- Manual QA affects any process the test did not create.

## Evidence to Keep

For each safety-sensitive review, preserve:

- pull request URL and commit SHA;
- reviewer name and date;
- Windows version, Node version, and npm version;
- exact commands run;
- lint, test, and CI results;
- manual dashboard observations;
- source-primitive search result;
- any failures, including exact test names/error codes;
- explicit deferred work and untested runtime paths;
- final decision: reject, keep draft, ready for review, ready to merge, or ready to release.

Do not include access tokens, raw command lines, user paths, process dumps, or other sensitive local data in review evidence.

## Reviewer Signoff Template

```text
Pull request:
Reviewed commit SHA:
Reviewer name:
Reviewer initials:
Review date:
Windows version:
Node/npm versions:

Automated evidence:
- npm ci:
- npm run lint:
- npm test:
- Windows CI:
- production-source primitive check:

Manual evidence:
- dashboard loaded without elevation:
- no destructive controls visible:
- protected/unknown records remained non-actionable:
- no token/secret/path exposure observed:
- only test-created fixture process was signaled:

Known limitations or deferred work:

Decision:
[ ] Reject
[ ] Keep as draft
[ ] Ready for review
[ ] Ready to merge
[ ] Ready to release

Typed attestation:
I reviewed the commit identified above against the Localhost Watchdog safety guide. I understand the approved scope and confirm that any production stop backend, command launcher, force-stop behavior, elevation, bulk action, or broader target category requires a separate review unless explicitly included and evidenced here.

Typed signature:
```

## Future Review Routing

Use the highest applicable row; higher-risk reviews include all lower-risk gates.

| Change type | Required review |
|---|---|
| Scanner, classifier, diagnostics, or privacy only | Automated gate, scanner/safety checklist, privacy inspection. |
| Dry-run or confirmation | Above plus session/CSRF, identity, token, audit, replay, and fail-closed review. |
| Execution proof or action API | Above plus proof consumption, final revalidation, idempotency, backend boundary, and manual Windows QA. |
| Real production stop backend | Above plus backend-specific threat review, disposable-process integration QA, timeout/respawn verification, and explicit human approval. |
| Managed-project launcher or restart backend | Above plus command allowlisting, working-directory validation, environment handling, port strategy, and failure-lineage review. |
| Force stop, elevation, process-tree action, or bulk action | New design approval required before implementation; do not inherit approval from an earlier milestone. |
| Packaged release | Verify the exact packaged artifact and runtime wiring, complete `docs/09-release-checklist.md`, then sign release approval. |

## Current PR #3 Approval Recommendation

PR #3 may be marked ready for human review when its local and Windows CI gates pass on the same commit. Mark it ready to merge only after a reviewer completes the applicable checklist and Windows dashboard inspection above.

Approval of PR #3 accepts the proof-gated and injected-backend architecture. It does not approve or release a production process-stop backend or arbitrary project launcher.
