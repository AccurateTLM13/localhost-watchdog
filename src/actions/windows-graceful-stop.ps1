param(
  [Parameter(Mandatory = $true)]
  [int] $TargetPid,
  [Parameter(Mandatory = $true)]
  [string] $ProcessName,
  [Parameter(Mandatory = $true)]
  [string] $CreatedAt,
  [Parameter(Mandatory = $true)]
  [int] $Port
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class LocalhostWatchdogConsole {
    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    public delegate bool HandlerRoutine(uint controlType);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AttachConsole(uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GenerateConsoleCtrlEvent(uint controlEvent, uint processGroupId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetConsoleCtrlHandler(HandlerRoutine handlerRoutine, bool add);
}
"@

$target = $null
try {
  $target = [System.Diagnostics.Process]::GetProcessById($TargetPid)
} catch {
  exit 10
}

$actualName = ($target.ProcessName + ".exe").ToLowerInvariant()
if ($actualName -ne $ProcessName.ToLowerInvariant()) {
  exit 11
}

try {
  $expectedStart = [DateTimeOffset]::Parse($CreatedAt, [Globalization.CultureInfo]::InvariantCulture).UtcDateTime
  $actualStart = $target.StartTime.ToUniversalTime()
  if ([Math]::Abs(($actualStart - $expectedStart).TotalMilliseconds) -gt 2000) {
    exit 11
  }
} catch {
  exit 11
}

try {
  $listeners = @(Get-NetTCPConnection -State Listen -OwningProcess $TargetPid -ErrorAction Stop | Where-Object { [int]$_.LocalPort -eq $Port })
  if ($listeners.Count -eq 0) {
    exit 12
  }
} catch {
  exit 12
}

try {
  if ($target.MainWindowHandle -ne [IntPtr]::Zero -and $target.CloseMainWindow()) {
    exit 0
  }
} catch {
  # A console process commonly has no main window. Continue to the console path.
}

# A CTRL+BREAK event can be addressed to the target PID when the target was
# launched as its own console process group. If it was not, Windows rejects
# the group ID and this helper fails closed without touching another process.
try {
  [LocalhostWatchdogConsole]::FreeConsole() | Out-Null
  if (-not [LocalhostWatchdogConsole]::AttachConsole([uint32]$TargetPid)) {
    exit 13
  }

  $handler = [LocalhostWatchdogConsole+HandlerRoutine]{ param($controlType) return $true }
  if (-not [LocalhostWatchdogConsole]::SetConsoleCtrlHandler($handler, $true)) {
    exit 14
  }

  if (-not [LocalhostWatchdogConsole]::GenerateConsoleCtrlEvent(1, [uint32]$TargetPid)) {
    exit 15
  }

  exit 0
} catch {
  exit 16
} finally {
  [LocalhostWatchdogConsole]::FreeConsole() | Out-Null
}
