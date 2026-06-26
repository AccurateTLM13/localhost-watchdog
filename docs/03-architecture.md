# 03 — Architecture

## Recommended Build Path

Start with a **Node backend + plain HTML/CSS/JS dashboard**. Wrap it in Tauri later when the scanner, safety model, and process actions are proven.

```txt
Phase 1: Node scanner CLI
Phase 2: Local dashboard on localhost:4545
Phase 3: Managed project config and restart
Phase 4: Windows tray/Tauri wrapper
Phase 5: Cross-platform cleanup
```

## High-Level Architecture

```txt
Tray / Dashboard UI
        ↓
HTTP API Layer
        ↓
Scanner Service
        ↓
Process Inspector
        ↓
Classifier + Safety Engine
        ↓
Action Engine
        ↓
Project Registry + History Store
```

## Core Modules

### 1. Scanner Service

Responsibilities:

- Find listening localhost ports.
- Map ports to owning PIDs.
- Refresh on interval.
- Emit normalized server records.

Windows commands to investigate first:

```powershell
Get-NetTCPConnection -State Listen
Get-CimInstance Win32_Process
```

Fallback command:

```cmd
netstat -ano
```

### 2. Process Inspector

Responsibilities:

- Resolve PID to process name.
- Resolve PID to command line.
- Resolve executable path.
- Resolve creation time.
- Resolve parent PID when possible.
- Estimate working directory if available.

Important fields:

```txt
pid
parentPid
processName
commandLine
executablePath
creationTime
user
```

### 3. HTTP Probe

Responsibilities:

- Probe `http://127.0.0.1:<port>`.
- Probe `http://localhost:<port>`.
- Optionally probe HTTPS.
- Read status code.
- Extract title.
- Detect common dev frameworks from headers, HTML, and known endpoints.

Initial endpoints:

```txt
/
/health
/api/health
/_next/static/
/vite.svg
/docs
/swagger
```

Do not make repeated aggressive requests. Keep probing light.

### 4. Classifier + Safety Engine

Responsibilities:

- Decide whether a process is likely a dev server.
- Assign category.
- Assign confidence score.
- Decide allowed actions.
- Hide protected processes.

Categories:

```txt
dev-server
database
local-ai
container
tunnel
test-runner
system
unknown
```

Actions:

```txt
open
inspect
adopt
stop
restart
forceStop
stopTree
```

### 5. Action Engine

Responsibilities:

- Open URL.
- Stop a safe process.
- Stop process tree only when explicitly allowed.
- Restart a managed project.
- Start a configured project.
- Find a free port.
- Wait until a port is free.

Rules:

- Default stop should target only the owning PID.
- Tree kill must be advanced and confirmed.
- Force kill must be advanced and confirmed.
- Bulk stop must only target high-confidence safe dev servers.

### 6. Project Registry

Stores known projects.

```json
{
  "projects": [
    {
      "id": "locailly",
      "name": "LocAIly",
      "path": "C:\\Users\\JP\\Desktop\\locailly",
      "startCommand": "npm run dev",
      "preferredPort": 31313,
      "runtime": "node",
      "safeToRestart": true
    }
  ]
}
```

### 7. History Store

Stores safe action history.

```txt
started
stopped
restarted
adopted
hidden
failed-stop
failed-restart
```

History matters because restart requires knowing what command and directory launched the server.

## UI Architecture

### MVP Dashboard

```txt
http://localhost:4545
```

Current read-only routes:

```txt
GET  /api/servers
GET  /api/diagnostics
GET  /api/diagnostics/export
```

Future action routes are intentionally not specified in the current implemented architecture. They require a separate action-contract design phase with identity and port revalidation, protected-boundary checks, dry-run semantics, explicit confirmation, and privacy-safe audit logging.

### UI Sections

1. Running Now
2. Stale Servers
3. Managed Projects
4. Hidden/Protected Summary
5. Recent Actions
6. Settings

## Later Tauri Wrapper

Use Tauri after the local dashboard is proven.

Tauri responsibilities:

- Taskbar/tray icon.
- Popup dashboard window.
- Autostart setting.
- Native notifications.
- Secure command execution bridge.

Keep the scanner/action engine reusable. The Tauri UI should call the same internal API or service layer.

## Folder Structure

```txt
localhost-watchdog/
  package.json
  README.md
  src/
    server.js
    scanner/
      windows.js
      normalize.js
      probes.js
    classifier/
      safety.js
      categories.js
      confidence.js
    actions/
      stop.js
      restart.js
      start-project.js
      free-port.js
    registry/
      projects.js
      history.js
    ui/
      index.html
      app.js
      styles.css
  config/
    projects.example.json
    safety.example.json
  test/
    fixtures/
    scanner.test.js
    safety.test.js
    actions.test.js
  docs/
```

## Future LocAIly Tool Pack Shape

```txt
scan_local_servers
inspect_local_server
stop_dev_server
restart_dev_server
start_project_server
find_free_port
clean_stale_dev_servers
```

Every tool action should return structured JSON and include whether the action was destructive.
