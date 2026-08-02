param(
  [Parameter(Mandatory = $true)] [string] $ExecutablePath,
  [Parameter(Mandatory = $true)] [string] $WorkingDirectory,
  [Parameter(Mandatory = $true)] [string] $ArgumentListJson
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class LocalhostWatchdogProjectLauncher {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct StartupInfo {
        public int cb;
        public string reserved;
        public string desktop;
        public string title;
        public int x;
        public int y;
        public int xSize;
        public int ySize;
        public int xCountChars;
        public int yCountChars;
        public int fillAttribute;
        public uint flags;
        public short showWindow;
        public short reserved2;
        public IntPtr reserved2Ptr;
        public IntPtr standardInput;
        public IntPtr standardOutput;
        public IntPtr standardError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct ProcessInformation {
        public IntPtr process;
        public IntPtr thread;
        public uint processId;
        public uint threadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfo startupInfo,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);
}
"@

function Quote-WindowsArgument([string] $Value) {
  if ($null -eq $Value -or $Value.Length -eq 0) { return '""' }
  return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

$arguments = @()
if ($ArgumentListJson) {
  $parsedArguments = ConvertFrom-Json -InputObject $ArgumentListJson
  if ($null -ne $parsedArguments) {
    $arguments = @($parsedArguments | ForEach-Object { [string]$_ })
  }
}

$commandLine = [string]::Join(" ", @(
  (Quote-WindowsArgument $ExecutablePath)
  $arguments | ForEach-Object { Quote-WindowsArgument $_ }
))

$startup = New-Object LocalhostWatchdogProjectLauncher+StartupInfo
$startup.cb = [Runtime.InteropServices.Marshal]::SizeOf($startup)
$startup.flags = 0x00000001
$startup.showWindow = 0
$info = New-Object LocalhostWatchdogProjectLauncher+ProcessInformation
$creationFlags = 0x00000010 -bor 0x00000200 -bor 0x00000400

if (-not [LocalhostWatchdogProjectLauncher]::CreateProcess(
    $ExecutablePath,
    [Text.StringBuilder]::new($commandLine),
    [IntPtr]::Zero,
    [IntPtr]::Zero,
    $false,
    $creationFlags,
    [IntPtr]::Zero,
    $WorkingDirectory,
    [ref]$startup,
    [ref]$info)) {
  throw "CreateProcess failed with Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}

try {
  $started = [System.Diagnostics.Process]::GetProcessById($info.processId)
  [Console]::WriteLine("$($info.processId)|$($started.StartTime.ToUniversalTime().ToString('o'))")
} finally {
  [LocalhostWatchdogProjectLauncher]::CloseHandle($info.thread) | Out-Null
  [LocalhostWatchdogProjectLauncher]::CloseHandle($info.process) | Out-Null
}
