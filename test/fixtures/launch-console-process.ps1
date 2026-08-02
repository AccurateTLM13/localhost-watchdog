param(
  [Parameter(Mandatory = $true)] [string] $NodePath,
  [Parameter(Mandatory = $true)] [string] $FixturePath,
  [Parameter(Mandatory = $true)] [string] $Token,
  [Parameter(Mandatory = $true)] [int] $Port
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class LocalhostWatchdogProcessLauncher {
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

function Quote-Argument([string] $Value) {
  return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

$commandLine = [string]::Join(" ", @(
  (Quote-Argument $NodePath),
  (Quote-Argument $FixturePath),
  (Quote-Argument $Token),
  (Quote-Argument ([string]$Port))
))
$startup = New-Object LocalhostWatchdogProcessLauncher+StartupInfo
$startup.cb = [Runtime.InteropServices.Marshal]::SizeOf($startup)
$startup.flags = 0x00000001
$startup.showWindow = 0
$info = New-Object LocalhostWatchdogProcessLauncher+ProcessInformation
$newConsole = 0x00000010
$newProcessGroup = 0x00000200

if (-not [LocalhostWatchdogProcessLauncher]::CreateProcess(
    $NodePath,
    [Text.StringBuilder]::new($commandLine),
    [IntPtr]::Zero,
    [IntPtr]::Zero,
    $false,
    ($newConsole -bor $newProcessGroup),
    [IntPtr]::Zero,
    (Get-Location).Path,
    [ref]$startup,
    [ref]$info)) {
  throw "CreateProcess failed with Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}

[LocalhostWatchdogProcessLauncher]::CloseHandle($info.thread) | Out-Null
[LocalhostWatchdogProcessLauncher]::CloseHandle($info.process) | Out-Null
$started = Get-Process -Id $info.processId
[Console]::WriteLine("$($info.processId)|$($started.StartTime.ToUniversalTime().ToString('o'))")
