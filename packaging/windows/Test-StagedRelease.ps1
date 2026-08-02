#requires -Version 5.1

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$StageRoot,
  [Parameter(Mandatory = $true)]
  [string]$DataRoot,
  [ValidateRange(1024, 65535)]
  [int]$Port = 4546
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$StageRoot = (Resolve-Path -LiteralPath $StageRoot).Path
$DataRoot = [System.IO.Path]::GetFullPath($DataRoot)
$nodePath = Join-Path $StageRoot "runtime\node\node.exe"
$entrypoint = Join-Path $StageRoot "watchdog.js"
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw "Staged Node runtime is missing: $nodePath" }
if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) { throw "Staged entrypoint is missing: $entrypoint" }

$hostName = "127.0.0.1"
$token = [Guid]::NewGuid().ToString("N")
$dashboardUrl = "http://$hostName`:$Port"
$logRoot = Join-Path $DataRoot "staged-smoke"
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$process = $null
$environmentNames = @(
  "HOST",
  "PORT",
  "WATCHDOG_HOST_TOKEN",
  "LOCALHOST_WATCHDOG_APP_ROOT",
  "LOCALHOST_WATCHDOG_DATA_DIR"
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

function Request-Shutdown {
  if ($null -eq $process -or $process.HasExited) { return }
  try {
    Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$dashboardUrl/api/host/shutdown" -Headers @{ "X-Watchdog-Host-Token" = $token } -ContentType "application/json" -Body "{}" -TimeoutSec 3 | Out-Null
  } catch {
    # The acceptance script never force-terminates the staged backend.
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  while (-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 100
  }
}

try {
  $env:HOST = $hostName
  $env:PORT = [string]$Port
  $env:WATCHDOG_HOST_TOKEN = $token
  $env:LOCALHOST_WATCHDOG_APP_ROOT = $StageRoot
  $env:LOCALHOST_WATCHDOG_DATA_DIR = $DataRoot
  $process = Start-Process -FilePath $nodePath -ArgumentList @($entrypoint, "serve") -WorkingDirectory $StageRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logRoot "stdout.log") -RedirectStandardError (Join-Path $logRoot "stderr.log")

  $health = $null
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $health = Invoke-WebRequest -UseBasicParsing -Uri "$dashboardUrl/api/health" -TimeoutSec 2
      if ($health.StatusCode -eq 200) { break }
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  if ($null -eq $health -or $health.StatusCode -ne 200) {
    throw "The staged backend did not become healthy. See $logRoot"
  }

  $snapshot = (Invoke-WebRequest -UseBasicParsing -Uri "$dashboardUrl/api/servers" -TimeoutSec 10).Content | ConvertFrom-Json
  if ($snapshot.hidden.watchdog -ne 1) {
    throw "The staged scanner did not hide its own backend by exact identity."
  }
  if (Test-Path -LiteralPath (Join-Path $StageRoot ".localhost-watchdog\history.json")) {
    throw "The staged backend wrote history into the installed app directory."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $DataRoot "history.json"))) {
    throw "The staged backend did not write history into the user data directory."
  }

  Request-Shutdown
  if (-not $process.HasExited) { throw "The staged backend did not exit after host-only shutdown." }
  [ordered]@{
    ok = $true
    stageRoot = $StageRoot
    dataRoot = $DataRoot
    port = $Port
    visible = @($snapshot.servers).Count
    hiddenWatchdog = $snapshot.hidden.watchdog
  } | ConvertTo-Json -Depth 4
} finally {
  Request-Shutdown
  foreach ($name in $environmentNames) {
    if ($null -eq $previousEnvironment[$name]) {
      Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
    } else {
      Set-Item -Path "Env:$name" -Value $previousEnvironment[$name]
    }
  }
}
