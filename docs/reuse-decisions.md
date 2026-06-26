# Reuse Decisions

## 2026-06-16 - Phase 0/1 scanner foundation

Decision: reimplement scanner and parser code locally.

Reason:

- Phase 1 only needs Windows listening-port discovery, process metadata enrichment, JSON normalization, and tests.
- Existing tools in the research map are useful design references, but direct code reuse would require license-by-license review and is unnecessary for this narrow foundation.
- The implementation uses standard Windows commands and Node standard library APIs only.

References used as patterns:

- Sonar: JSON-oriented process list and default hiding of non-dev/system processes.
- portzap and PortPilot: agent-friendly structured scanner output.
- killall / WinPortKill: Windows-first process/port inspection and dry-run safety concepts for later phases.
- PortKiller and Node Killer: later dashboard/tray concepts, not implemented in this phase.

License decision:

- Project license is MIT.
- No third-party source code was copied into this repository during Phase 0/1.

Deferred:

- Stop, restart, force stop, process tree management, tray UI, and bulk actions.
- HTTP probing and framework detection.
- Full project registry and managed restart behavior.
