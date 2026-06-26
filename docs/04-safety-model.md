# 04 — Safety Model

## Core Safety Rule

Localhost Watchdog must never behave like a blind process killer. It should only manage processes it can confidently classify as development-related.

If unsure, show read-only or hide.

## Safety Levels

| Level | Meaning | Actions |
|---|---|---|
| Protected | System/daily-use process | Hidden or read-only |
| Unknown | Not enough evidence | Inspect only |
| Likely Dev | Some dev evidence | Open, adopt |
| Safe Dev | Strong dev evidence | Open, stop |
| Managed | Started/adopted by app | Open, stop, restart |

## Protected Process Examples

Never stop by default:

```txt
System
Idle
Registry
svchost.exe
csrss.exe
wininit.exe
winlogon.exe
services.exe
lsass.exe
explorer.exe
dwm.exe
SearchIndexer.exe
MsMpEng.exe
SecurityHealthService.exe
OneDrive.exe
Dropbox.exe
chrome.exe
msedge.exe
firefox.exe
Teams.exe
Discord.exe
NVIDIA*
AMD*
Intel*
Audio*
```

Notes:

- Browser processes may be related to dev, but killing them is not the purpose.
- Docker Desktop core services should be protected. Docker containers can be shown separately later.

## Dev Runtime Allowlist

Potentially manageable when combined with other evidence:

```txt
node.exe
npm.cmd
pnpm.cmd
yarn.cmd
bun.exe
deno.exe
python.exe
python3.exe
py.exe
uvicorn.exe
flask.exe
django-admin.exe
dotnet.exe
java.exe
ruby.exe
php.exe
ollama.exe
```

Runtime alone is not enough. `node.exe` could be many things. The command line, project path, port, and parent process matter.

## Development Folder Allowlist

Default user-configurable roots:

```txt
C:\Users\<user>\Desktop
C:\Users\<user>\Documents\GitHub
C:\Users\<user>\Projects
C:\Users\<user>\dev
C:\Users\<user>\code
```

A process launched from one of these paths is more likely to be safe to manage.

## Confidence Score

Start with a simple additive score.

```txt
+30 listening on localhost / 127.0.0.1
+25 command line includes dev runtime
+20 path is inside known dev folder
+15 port is common dev port
+15 command includes dev keywords
+15 HTTP probe responds
+10 page title / framework detected
+10 parent process is terminal/editor/agent
+30 process is managed/adopted
-50 binds to 0.0.0.0 without user opt-in
-80 executable path is outside user space and not allowlisted
-100 protected process name
```

Common dev ports:

```txt
3000-3010
4000-4010
5000-5010
5173
5174
8000
8080
8888
9000
1313
31313
```

Dev command keywords:

```txt
npm run dev
pnpm dev
yarn dev
bun dev
next dev
vite
astro dev
remix dev
nuxt dev
svelte-kit
python -m http.server
uvicorn
flask run
manage.py runserver
dotnet watch
ollama serve
```

## Confidence Thresholds

```txt
0-39   Hidden/Unknown
40-59  Read-only inspect
60-79  Likely dev, allow adopt/open only
80-100 Safe dev, allow stop with confirmation
100+   Managed, allow restart/stop
```

## Action Permissions

### Open URL

Allowed when a port is listening and URL can be formed.

### Stop

Allowed only when:

- confidence >= 80, or
- server is managed/adopted, and
- not protected, and
- dry-run result matches current PID.

### Restart

Allowed only when:

- server is managed/adopted, and
- start command exists, and
- working directory exists, and
- stop succeeded, and
- port is free or alternate port was selected.

### Force Stop

Allowed only when:

- user expands advanced actions, and
- process is not protected, and
- user confirms exact process name, PID, and port.

### Stop Tree

Allowed only when:

- process tree is displayed, and
- every child process is shown, and
- no protected child is included, and
- user confirms.

## Dry-Run Requirement

Every destructive action must support dry-run internally.

Dry-run returns:

```json
{
  "action": "stop",
  "allowed": true,
  "wouldKill": [
    {
      "pid": 12345,
      "name": "node.exe",
      "port": 3000,
      "command": "npm run dev"
    }
  ],
  "blocked": [],
  "warnings": []
}
```

## Bulk Stop Rules

“Stop All Safe Dev Servers” may only include:

- `safeToStop === true`
- `confidence >= 85`
- not protected
- not database unless explicitly included
- not local AI model server unless explicitly included
- not manually pinned as “keep running”

Bulk stop must show a preview list first.

## Database Safety

Databases should be categorized, but default action should be inspect/open only.

Examples:

```txt
postgres
mysql
mongod
redis-server
supabase
```

Reason: stopping a database can break active development work or data migrations. Treat databases as “managed only” until user opts in.

## Local AI Safety

Local AI servers like Ollama, LM Studio, or LocAIly companion should be visible but not bulk-stopped by default. They can be long-running intentionally.

Initial behavior:

```txt
Show: yes
Open/inspect: yes
Stop: only if managed or confirmed
Bulk stop: no by default
```

## Hidden Summary

The UI should show a trust-building summary:

```txt
Dev processes shown: 3
Protected/system processes hidden: 142
Unknown listeners hidden: 5
```

This tells the user the tool is not pretending the system is empty; it is filtering intentionally.
