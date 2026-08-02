# Windows release packaging

The release package is intended to run on a Windows x64 machine without a repository checkout, Git, npm, Rust, Tauri, or a separately installed Node.js runtime.

## Stage a release

Run from the repository root in Windows PowerShell:

```powershell
.\packaging\windows\build-release.ps1 -PortableZip
```

The script copies only runtime files, bundles the tested `node.exe`, writes release metadata, and produces `SHA256SUMS.txt`. The staged directory is created under `dist\LocalhostWatchdog-<version>-win-x64`.

If the build machine has a specific Node runtime that must be used:

```powershell
.\packaging\windows\build-release.ps1 -NodeRuntimePath "C:\Program Files\nodejs\node.exe" -PortableZip
```

The runtime must satisfy the application engine requirement of Node 22 or newer. The runtime is selected at build time; the installer does not download software on the destination computer.

To verify the staged package with its bundled runtime:

```powershell
.\packaging\windows\Test-StagedRelease.ps1 `
  -StageRoot "$env:TEMP\localhost-watchdog-release\LocalhostWatchdog-0.1.0-win-x64" `
  -DataRoot "$env:TEMP\localhost-watchdog-release\data"
```

This smoke test uses port 4546 by default, checks the health endpoint, confirms that the package hides its own backend by exact identity, verifies that history is written outside the installed files, and closes only the staged backend through the protected host-control route.

## Build the installer

Install Inno Setup on the build machine, then run:

```powershell
.\packaging\windows\build-release.ps1 -BuildInstaller -PortableZip
```

The installer is per-user by default and installs immutable program files under `%LOCALAPPDATA%\Programs\Localhost Watchdog`. Mutable configuration, history, audits, and tray logs live under `%LOCALAPPDATA%\Localhost Watchdog` and are preserved by uninstall.

## Acceptance boundary

The PowerShell/.NET tray companion remains the current Windows shell. The installer must be tested on a clean Windows x64 machine with no Node.js, Git, repository checkout, Rust, Tauri, or PowerShell 7. Windows PowerShell 5.1 and a browser are the only host assumptions.

Before calling an installer a release, verify that the Watchdog backend is not presented as an unmanaged development listener, that an existing backend is not claimed by a second tray host, and that uninstall does not stop unrelated development servers.
