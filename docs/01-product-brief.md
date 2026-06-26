# 01 — Product Brief

## Working Name

**Localhost Watchdog**

Alternative names:

- Dev Server Watchdog
- Port Pit Crew
- Local Server Guard
- Zombie Server Cleaner

## One-Line Product Definition

A safe tray/taskbar utility that shows forgotten local development servers and lets the user open, stop, restart, or launch them without touching Windows Task Manager.

## Core Problem

During AI-assisted development, local servers are often started by a user, an editor terminal, an AI agent, or a script. The terminal may close, the project may be forgotten, and days later the machine feels slow because old Node, Vite, Next, Python, Docker, Ollama, or companion servers are still running.

## Target User

Primary user:

- Developer using AI coding agents
- Windows-first workflow
- Multiple local projects
- Frequently runs `npm run dev`, Vite, Next.js, Python servers, companion servers, Docker, or local AI tools

Secondary user:

- Any developer who wants a friendlier port/process dashboard
- Teams that need a safer local dev cleanup flow

## Must-Have Capabilities

1. Detect active localhost development servers.
2. Map ports to owning process IDs.
3. Display process metadata clearly.
4. Hide system-critical and daily-use processes by default.
5. Stop only high-confidence dev processes.
6. Restart a managed process from its saved command and working directory.
7. Allow known projects to be started from a configured project list.

## Would-Be-Cool Capabilities

1. Tray/taskbar popup.
2. One-click open URL.
3. Zombie server warnings based on uptime.
4. Port conflict resolution.
5. Safe “stop all dev servers” action.
6. Project profiles.
7. Log preview.
8. Optional integration as a LocAIly tool pack.

## Non-Goals for MVP

Do not build these in the first milestone:

- Public tunnel sharing
- Cloudflare/ngrok integration
- Kubernetes port-forward management
- Full Task Manager replacement
- Killing random system processes
- AI analysis layer
- Complex installer
- Auto-start on boot

## Product Rule

If the tool cannot explain why a process is safe to manage, it should not offer a stop button.

## User Experience Promise

The user should be able to answer three questions in under five seconds:

1. What dev servers are still running?
2. Which project started them?
3. Can I safely stop or restart them?

## MVP Output

The first useful version can be a local dashboard, not a polished desktop app:

```txt
node watchdog.js
open http://localhost:4545
```

The tray app comes after scanner safety is proven.
