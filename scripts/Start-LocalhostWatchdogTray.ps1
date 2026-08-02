#requires -Version 5.1

[CmdletBinding()]
param(
  [string]$RepositoryRoot,
  [string]$NodePath,
  [string]$HostName = "127.0.0.1",
  [int]$Port = 4545,
  [ValidateRange(5, 3600)]
  [int]$RefreshSeconds = 15,
  [switch]$NoBrowser,
  [switch]$SmokeTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
  $RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
} else {
  $RepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
}

if ([Threading.Thread]::CurrentThread.ApartmentState -ne [Threading.ApartmentState]::STA) {
  throw "The tray companion must run in an STA PowerShell session. Use powershell.exe or pwsh -STA."
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:dashboardUrl = "http://$HostName`:$Port"
$script:healthUrl = "$($script:dashboardUrl)/api/health"
$script:serversUrl = "$($script:dashboardUrl)/api/servers"
$script:shutdownUrl = "$($script:dashboardUrl)/api/host/shutdown"
$script:hostControlToken = [Guid]::NewGuid().ToString("N")
$script:backendProcess = $null
$script:ownsBackend = $false
$script:backendShutdownRequested = $false
$script:quitRequested = $false
$script:lastStaleCount = 0
$script:trayIcon = $null
$script:trayMenu = $null
$script:refreshTimer = $null

function Invoke-WatchdogRequest {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Uri,
    [ValidateSet("GET", "POST")]
    [string]$Method = "GET",
    [string]$Token
  )

  $request = @{
    Uri = $Uri
    Method = $Method
    UseBasicParsing = $true
    TimeoutSec = 3
    ErrorAction = "Stop"
  }
  if ($Method -eq "POST") {
    $request.ContentType = "application/json"
    $request.Body = "{}"
  }
  if (-not [string]::IsNullOrWhiteSpace($Token)) {
    $request.Headers = @{ "X-Watchdog-Host-Token" = $Token }
  }

  $response = Invoke-WebRequest @request
  if ([string]::IsNullOrWhiteSpace($response.Content)) {
    return $null
  }
  return ($response.Content | ConvertFrom-Json)
}

function Test-WatchdogHealth {
  try {
    $health = Invoke-WatchdogRequest -Uri $script:healthUrl
    return ($health.ok -eq $true -and $health.destructiveActionsAvailable -eq $false)
  } catch {
    return $false
  }
}

function Resolve-NodeExecutable {
  if (-not [string]::IsNullOrWhiteSpace($NodePath)) {
    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
      throw "The requested Node executable was not found: $NodePath"
    }
    return (Resolve-Path -LiteralPath $NodePath).Path
  }

  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $command) {
    $command = Get-Command node -ErrorAction SilentlyContinue
  }
  if (-not $command) {
    throw "Node.js was not found on PATH. Install Node.js or pass -NodePath."
  }
  return $command.Source
}

function Start-WatchdogBackend {
  if (Test-WatchdogHealth) {
    return $false
  }

  $nodeExecutable = Resolve-NodeExecutable
  $logRoot = Join-Path $RepositoryRoot ".localhost-watchdog\tray"
  New-Item -ItemType Directory -Path $logRoot -Force | Out-Null

  $stdoutLog = Join-Path $logRoot "server.stdout.log"
  $stderrLog = Join-Path $logRoot "server.stderr.log"
  $environmentNames = @("HOST", "PORT", "WATCHDOG_HOST_TOKEN")
  $previousEnvironment = @{}
  foreach ($name in $environmentNames) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
  }

  try {
    $env:HOST = $HostName
    $env:PORT = [string]$Port
    $env:WATCHDOG_HOST_TOKEN = $script:hostControlToken
    $process = Start-Process -FilePath $nodeExecutable -ArgumentList @("watchdog.js", "serve") -WorkingDirectory $RepositoryRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
  } finally {
    foreach ($name in $environmentNames) {
      if ($null -eq $previousEnvironment[$name]) {
        Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
      } else {
        Set-Item -Path "Env:$name" -Value $previousEnvironment[$name]
      }
    }
  }

  if ($null -eq $process) {
    throw "The Watchdog Node backend could not be started."
  }
  $script:backendProcess = $process
  $script:ownsBackend = $true

  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-WatchdogHealth) {
      return $true
    }
    if ($process.HasExited) {
      throw "The Watchdog Node backend exited before its health endpoint became ready."
    }
    Start-Sleep -Milliseconds 250
  }

  throw "The Watchdog Node backend did not become ready at $($script:dashboardUrl)."
}

function Set-TrayText {
  param([string]$Text)
  if ($null -eq $script:trayIcon) {
    return
  }
  $safeText = if ([string]::IsNullOrWhiteSpace($Text)) { "Localhost Watchdog" } else { $Text }
  if ($safeText.Length -gt 63) {
    $safeText = $safeText.Substring(0, 63)
  }
  $script:trayIcon.Text = $safeText
}

function Show-TrayNotice {
  param(
    [string]$Title,
    [string]$Message,
    [System.Windows.Forms.ToolTipIcon]$Icon = [System.Windows.Forms.ToolTipIcon]::Info
  )
  if ($null -ne $script:trayIcon) {
    $script:trayIcon.ShowBalloonTip(5000, $Title, $Message, $Icon)
  }
}

function Update-TrayStatus {
  try {
    $snapshot = Invoke-WatchdogRequest -Uri $script:serversUrl
    if ($null -eq $snapshot -or $snapshot.ok -eq $false -or $null -eq $snapshot.servers) {
      throw "The Watchdog scanner returned an invalid snapshot."
    }

    $records = @($snapshot.servers)
    $visibleRecords = @($records | Where-Object { $_.visible -ne $false })
    $staleRecords = @($visibleRecords | Where-Object {
      $_.lifecycle -and $_.lifecycle.state -eq "stale-candidate"
    })
    $visibleCount = $visibleRecords.Count
    $staleCount = $staleRecords.Count
    Set-TrayText "Watchdog: $visibleCount server(s)"

    if ($staleCount -gt 0 -and $staleCount -ne $script:lastStaleCount) {
      Show-TrayNotice "Localhost Watchdog" "$staleCount stale local dev server(s) detected." ([System.Windows.Forms.ToolTipIcon]::Warning)
    }
    $script:lastStaleCount = $staleCount
  } catch {
    Set-TrayText "Watchdog: refresh unavailable"
    if ($script:lastStaleCount -ne -1) {
      Show-TrayNotice "Localhost Watchdog" "The local server snapshot could not be refreshed." ([System.Windows.Forms.ToolTipIcon]::Warning)
      $script:lastStaleCount = -1
    }
  }
}

function Open-WatchdogDashboard {
  Start-Process -FilePath $script:dashboardUrl | Out-Null
}

function Request-BackendShutdown {
  if (-not $script:ownsBackend -or $script:backendShutdownRequested) {
    return $true
  }
  if ($null -eq $script:backendProcess -or $script:backendProcess.HasExited) {
    $script:backendShutdownRequested = $true
    return $true
  }

  try {
    $result = Invoke-WatchdogRequest -Uri $script:shutdownUrl -Method POST -Token $script:hostControlToken
    if ($null -eq $result -or $result.ok -ne $true -or $result.serversTerminated -ne $false) {
      throw "The backend did not confirm a host-only shutdown."
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while (-not $script:backendProcess.HasExited -and [DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 100
    }
    if (-not $script:backendProcess.HasExited) {
      throw "The backend did not exit after the host-only shutdown request."
    }
    $script:backendShutdownRequested = $true
    return $true
  } catch {
    Show-TrayNotice "Localhost Watchdog" "Watchdog could not close its own backend safely; it was left running." ([System.Windows.Forms.ToolTipIcon]::Error)
    return $false
  }
}

function Close-TrayHost {
  param([switch]$RequestBackend)
  if ($RequestBackend) {
    [void](Request-BackendShutdown)
  }
  if ($null -ne $script:refreshTimer) {
    $script:refreshTimer.Stop()
    $script:refreshTimer.Dispose()
    $script:refreshTimer = $null
  }
  if ($null -ne $script:trayIcon) {
    $script:trayIcon.Visible = $false
    $script:trayIcon.Dispose()
    $script:trayIcon = $null
  }
  if ($null -ne $script:trayMenu) {
    $script:trayMenu.Dispose()
    $script:trayMenu = $null
  }
}

function Quit-Watchdog {
  if ($script:quitRequested) {
    return
  }
  if (-not (Request-BackendShutdown)) {
    return
  }
  $script:quitRequested = $true
  Close-TrayHost
  [System.Windows.Forms.Application]::ExitThread()
}

try {
  [void](Start-WatchdogBackend)

  if ($SmokeTest) {
    if (-not $script:ownsBackend) {
      throw "Smoke test requires an unused Watchdog port so the companion can prove backend ownership."
    }
    if (-not (Request-BackendShutdown)) {
      throw "The Watchdog backend smoke test could not close its own backend."
    }
    Write-Output "Watchdog tray companion backend smoke test passed."
    return
  }

  $script:trayMenu = New-Object System.Windows.Forms.ContextMenuStrip
  $openItem = $script:trayMenu.Items.Add("Open Watchdog")
  $refreshItem = $script:trayMenu.Items.Add("Refresh")
  [void]$script:trayMenu.Items.Add("-")
  $quitItem = $script:trayMenu.Items.Add("Quit")

  $script:trayIcon = New-Object System.Windows.Forms.NotifyIcon
  $script:trayIcon.Icon = [System.Drawing.SystemIcons]::Application
  $script:trayIcon.Text = "Localhost Watchdog"
  $script:trayIcon.ContextMenuStrip = $script:trayMenu
  $script:trayIcon.Visible = $true
  $script:trayIcon.add_DoubleClick({ Open-WatchdogDashboard })
  $openItem.add_Click({ Open-WatchdogDashboard })
  $refreshItem.add_Click({ Update-TrayStatus })
  $quitItem.add_Click({ Quit-Watchdog })

  $script:refreshTimer = New-Object System.Windows.Forms.Timer
  $script:refreshTimer.Interval = $RefreshSeconds * 1000
  $script:refreshTimer.add_Tick({ Update-TrayStatus })
  $script:refreshTimer.Start()

  Update-TrayStatus
  if (-not $NoBrowser) {
    Open-WatchdogDashboard
  }
  [System.Windows.Forms.Application]::Run()
} catch {
  Write-Error $_
  exit 1
} finally {
  Close-TrayHost -RequestBackend
}
