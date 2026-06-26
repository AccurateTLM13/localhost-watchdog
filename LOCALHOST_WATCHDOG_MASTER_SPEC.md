# Localhost Watchdog — Master Agent Spec

## Build Intent

Create a Windows-first desktop/tray utility that detects local development servers, hides system-critical processes, and lets the user safely open, stop, restart, or launch project servers.

This is designed for AI-assisted development workflows where servers are often started in terminals, editors, or by agents and then forgotten.

## Core Build Order

```txt
1. Scanner
2. Classifier
3. Dashboard
4. Safe stop
5. Managed projects
6. Restart
7. Adopt
8. Tray wrapper
9. Advanced cleanup
10. LocAIly tool pack
```

## Borrowed Patterns

Use these existing tool patterns as references:

- Sonar: safe hidden defaults, rich process metadata, profiles, watch mode.
- PortKiller: tray UX, categories, favorites, watched ports, one-click termination.
- Port Kill: restart history, service detection, orchestration config.
- Node Killer: simple active dev server count and runtime toggles.
- PortKilla: process tree view, kill modes, Docker labels, history.
- portzap / PortPilot: JSON output, free-port search, wait commands, TUI testing ideas.
- killall / WinPortKill: Windows process termination, dry-run, safety tiers.
- GhostlyShare: local app discovery and compact action strips.

## Safety Non-Negotiables

- Never stop protected processes.
- Never bulk-stop databases or local AI servers by default.
- Never force kill in the default flow.
- Never kill a process if PID or port changed between scan and action.
- Always provide dry-run internally for destructive actions.
- Always include reasons for classification.
- Hide or read-only unknown processes.

## MVP Definition

MVP is not the tray app. MVP is the safe local dashboard:

```txt
node watchdog.js
open http://localhost:4545
```

MVP must show:

- active likely dev servers
- port
- URL
- process name
- PID
- command
- confidence score
- category
- reasons
- hidden/protected summary

MVP may include stop only after classifier tests pass.

## Recommended Tech

Initial:

- Node.js backend
- Plain HTML/CSS/JS dashboard
- JSON config files
- Node test runner or Vitest

Later:

- Tauri tray wrapper
- Native notifications
- Autostart option

## Agent Development Rule

Each phase must finish with:

```txt
Summary
Files changed
Safety impact
Tests run
Manual QA
Risks
Next step
```

No agent should jump phases without passing the current phase exit criteria.
