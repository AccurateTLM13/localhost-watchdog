# 02 — Research Reuse Map

## Purpose

This document tells the agent what existing project patterns to learn from before building Localhost Watchdog. The goal is not to copy blindly. The goal is to reuse proven ideas, avoid obvious mistakes, and fit the best parts into this project's safety-first vision.

## Reuse Rule

Before copying code, verify the license. Prefer learning patterns over copy-paste. MIT-style projects are easier to reuse. GPL-style projects may infect the project license if code is copied directly, so treat them as design references unless the project intentionally adopts GPL.

## Reference Projects and What to Borrow

### Sonar

Useful patterns:

- Rich `list` output with port, process, PID, URL, CPU, memory, uptime, Docker/container details.
- Hides desktop apps and system services by default.
- Has an explicit include-all mode.
- Provides `info`, `kill`, `watch`, `next`, `open`, `profile`, and `tray` style commands.

Borrow for Localhost Watchdog:

- Default-hide model for non-dev processes.
- Detailed process inspection command.
- JSON output contract.
- Project/profile concept.
- Watch mode and notification concept.

Do not copy blindly:

- macOS-specific assumptions.
- Docker-heavy flow before Windows dev server flow is stable.

### PortKiller

Useful patterns:

- Native desktop/tray UX.
- Auto-refresh.
- Search/filter by port and process name.
- Categorization: web server, database, development, system.
- Watched ports and notifications.
- Graceful + force kill distinction.

Borrow for Localhost Watchdog:

- Tray dashboard layout.
- Category badges.
- Watched/favorite ports.
- Configurable refresh interval.
- Split stop actions into normal stop and advanced force stop.

Do not copy blindly:

- Kubernetes and Cloudflare tunnel scope for MVP.

### Port Kill

Useful patterns:

- CLI and GUI/status bar split.
- Restart with saved command.
- Service detection from `package.json`, Docker Compose, Procfile, Python files.
- YAML service orchestration.
- Guard mode with auto-restart.

Borrow for Localhost Watchdog:

- Managed service config.
- Restart history.
- Service discovery.
- Start/stop all managed services.
- Guard mode later, not MVP.

Do not copy blindly:

- Cache cleaning.
- SSH features.
- Over-wide orchestration before safe detection works.

### Node Killer

Useful patterns:

- Simple menubar count of active dev servers.
- Runtime toggles for Node, Vite, Bun.
- One-click kill and kill-all with confirmation.
- Auto-refresh preferences.

Borrow for Localhost Watchdog:

- Runtime filters.
- Live count badge.
- Simple first tray UX.
- Confirmation for bulk actions.

Do not copy blindly:

- macOS-only limitation.
- Node-only scope.

### PortKilla

Useful patterns:

- Process tree view.
- Docker container label detection.
- Kill port vs kill tree vs force kill.
- Kill all dev Node.js with safe list.
- Test runner detection.
- History export.

Borrow for Localhost Watchdog:

- Process tree as advanced view.
- Separate stop modes.
- Safe-list approach for bulk kill.
- Kill history log.
- Test runner detection later.

Do not copy blindly:

- Force kill shortcuts in MVP UI.

### portzap

Useful patterns:

- Cross-platform Rust CLI.
- List, kill, watch, wait, free-port commands.
- Graceful shutdown first.
- JSON output for agents.
- Interactive TUI.

Borrow for Localhost Watchdog:

- `wait until port free` logic.
- `find free port` logic.
- Agent-friendly JSON output.
- Graceful shutdown escalation model.

Do not copy blindly:

- Terminal UI as the main product; Localhost Watchdog is dashboard/tray first.

### PortPilot

Useful patterns:

- Real-time terminal dashboard.
- Filter by port, process name, or PID.
- Highlight common development ports.
- One-key kill with confirmation.
- JSON mode.

Borrow for Localhost Watchdog:

- Common port highlighting.
- Filter/search UX.
- CLI fallback commands for testing.

### killall / WinPortKill

Useful patterns:

- Windows-first process termination.
- Port-based kill.
- Dry-run.
- Three-tier safety model.
- Process tree awareness.
- Restart subcommand.

Borrow for Localhost Watchdog:

- Windows process inspection strategy.
- Dry-run before destructive actions.
- Safety tiers.
- Restart command pattern.

Important warning:

- Verify license before direct reuse.

### GhostlyShare

Useful patterns:

- Automatic local app discovery.
- Detects app types by probing HTTP endpoints, titles, docs, OpenAPI, health routes.
- Compact action strip: open, copy, stop.
- Session expiration and safe lifecycle behavior.

Borrow for Localhost Watchdog:

- HTTP probing for friendly names.
- Page title detection.
- Health status.
- Auto-expire/warn for stale servers.

Do not copy blindly:

- Public tunnel sharing. This is not MVP.

## Reuse Decision Matrix

| Need | Best reference |
|---|---|
| Safe hidden defaults | Sonar |
| Tray UI | PortKiller, Node Killer |
| Restart/orchestration | Port Kill |
| Windows kill behavior | killall, WinPortKill |
| Free port detection | portzap, Sonar |
| JSON agent output | portzap, Sonar, PortPilot |
| Project profiles | Sonar, Port Kill |
| Process tree view | PortKilla, killall |
| Zombie cleanup | Portless prune concept |
| App discovery | GhostlyShare |

## Agent Research Checklist

Before implementing a feature, the agent should:

1. Find the closest reference project.
2. Inspect its license.
3. Identify the concept to reuse.
4. Decide whether to adapt, reimplement, or ignore.
5. Document the decision in `docs/reuse-decisions.md` or the progress log.
6. Add tests that prove the adapted behavior works in this project.

## Anti-Pattern Warning

Do not merge every cool feature into MVP. That is how a watchdog becomes a three-headed raccoon wearing a Kubernetes helmet.
