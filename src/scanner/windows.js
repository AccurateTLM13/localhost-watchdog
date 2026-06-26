"use strict";

const { execFile } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { promisify } = require("node:util");
const { attachActionEligibilityToSnapshot } = require("../actions/eligibility");
const { loadWatchdogConfig } = require("../config/load");
const { applyHistoryToSnapshot } = require("../history/store");
const { safeError, safeErrorMessage } = require("../privacy/errors");
const { attachLifecycleContext } = require("../process/lifecycle");
const { enrichWithHttpProbes } = require("./probe");
const {
  normalizeConnections,
  parseJsonArray,
  parseNetstatOutput,
  parsePowerShellTcpConnections,
  parseWindowsProcesses
} = require("./normalize");

const execFileAsync = promisify(execFile);
const POWERSHELL = process.env.LOCALHOST_WATCHDOG_POWERSHELL || resolveWindowsCommand("WindowsPowerShell\\v1.0\\powershell.exe", "powershell.exe");
const NETSTAT = resolveWindowsCommand("netstat.exe", "netstat.exe");
const SEC_CMD_TEMPLATE = `
$ErrorActionPreference = 'Stop';
$code = @'
using System;
using System.Runtime.InteropServices;

public class WinSecurity {
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint processAccess, bool bInheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr TokenHandle, int TokenInformationClass, IntPtr TokenInformation, int TokenInformationLength, out int ReturnLength);

    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint TOKEN_QUERY = 0x0008;
    private const int TokenElevation = 20;
    private const int TokenIntegrityLevel = 25;

    [StructLayout(LayoutKind.Sequential)]
    private struct TOKEN_ELEVATION {
        public int TokenIsElevated;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SID_AND_ATTRIBUTES {
        public IntPtr Sid;
        public int Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TOKEN_MANDATORY_LABEL {
        public SID_AND_ATTRIBUTES Label;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetSidSubAuthority(IntPtr pSid, int nSubAuthority);

    [DllImport("advapi32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetSidSubAuthorityCount(IntPtr pSid);

    public struct ProcessSecurityInfo {
        public bool ElevationAvailable;
        public bool IntegrityAvailable;
        public int Elevated;
        public int IntegrityLevel;
        public string Error;
    }

    public static ProcessSecurityInfo GetProcessSecurity(int pid) {
        ProcessSecurityInfo info = new ProcessSecurityInfo();
        info.ElevationAvailable = false;
        info.IntegrityAvailable = false;
        info.Elevated = 0;
        info.IntegrityLevel = 0;
        info.Error = "";

        IntPtr hProcess = IntPtr.Zero;
        IntPtr hToken = IntPtr.Zero;

        try {
            hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (hProcess == IntPtr.Zero) {
                info.Error = "OpenProcessFailed: " + Marshal.GetLastWin32Error();
                return info;
            }

            if (!OpenProcessToken(hProcess, TOKEN_QUERY, out hToken)) {
                info.Error = "OpenProcessTokenFailed: " + Marshal.GetLastWin32Error();
                return info;
            }

            // Elevation
            int elevationSize = Marshal.SizeOf(typeof(TOKEN_ELEVATION));
            IntPtr pElevation = Marshal.AllocHGlobal(elevationSize);
            try {
                int returnLength;
                if (GetTokenInformation(hToken, TokenElevation, pElevation, elevationSize, out returnLength)) {
                    TOKEN_ELEVATION elevationStruct = (TOKEN_ELEVATION)Marshal.PtrToStructure(pElevation, typeof(TOKEN_ELEVATION));
                    info.Elevated = elevationStruct.TokenIsElevated;
                    info.ElevationAvailable = true;
                } else {
                    info.Error = "GetTokenInformationElevationFailed: " + Marshal.GetLastWin32Error();
                }
            } finally {
                Marshal.FreeHGlobal(pElevation);
            }

            // Integrity Level
            int returnLengthIL;
            GetTokenInformation(hToken, TokenIntegrityLevel, IntPtr.Zero, 0, out returnLengthIL);
            if (returnLengthIL > 0) {
                IntPtr pIntegrity = Marshal.AllocHGlobal(returnLengthIL);
                try {
                    if (GetTokenInformation(hToken, TokenIntegrityLevel, pIntegrity, returnLengthIL, out returnLengthIL)) {
                        TOKEN_MANDATORY_LABEL label = (TOKEN_MANDATORY_LABEL)Marshal.PtrToStructure(pIntegrity, typeof(TOKEN_MANDATORY_LABEL));
                        IntPtr pSid = label.Label.Sid;
                        IntPtr pSubAuthorityCount = GetSidSubAuthorityCount(pSid);
                        if (pSubAuthorityCount != IntPtr.Zero) {
                            int subAuthorityCount = Marshal.ReadByte(pSubAuthorityCount);
                            if (subAuthorityCount > 0) {
                                IntPtr pSubAuthority = GetSidSubAuthority(pSid, subAuthorityCount - 1);
                                if (pSubAuthority != IntPtr.Zero) {
                                    info.IntegrityLevel = Marshal.ReadInt32(pSubAuthority);
                                    info.IntegrityAvailable = true;
                                }
                            }
                        }
                    }
                } finally {
                    Marshal.FreeHGlobal(pIntegrity);
                }
            }
        } finally {
            if (hToken != IntPtr.Zero) {
                CloseHandle(hToken);
            }
            if (hProcess != IntPtr.Zero) {
                CloseHandle(hProcess);
            }
        }
        return info;
    }
}
'@

Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue

$pids = @(PIDS_PLACEHOLDER)
$results = @()

foreach ($pid in $pids) {
    $sec = [WinSecurity]::GetProcessSecurity($pid)
    $ownerSid = $null
    $ownerUser = $null
    $ownerDomain = $null
    $secErr = $sec.Error

    try {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $pid"
        if ($proc) {
            $owner = Invoke-CimMethod -InputObject $proc -MethodName GetOwner
            $ownerSidObj = Invoke-CimMethod -InputObject $proc -MethodName GetOwnerSid
            $ownerSid = $ownerSidObj.Sid
            $ownerUser = $owner.User
            $ownerDomain = $owner.Domain
        } else {
            if (-not $secErr) { $secErr = "ProcessNotFound" }
        }
    } catch {
        if (-not $secErr) { $secErr = $_.Exception.Message }
    }

    $results += [PSCustomObject]@{
        ProcessId = $pid
        OwnerSid = $ownerSid
        OwnerUser = $ownerUser
        OwnerDomain = $ownerDomain
        Elevated = if ($sec.ElevationAvailable) { $sec.Elevated -eq 1 } else { $null }
        IntegrityLevel = if ($sec.IntegrityAvailable) { $sec.IntegrityLevel } else { $null }
        SecurityError = if ($secErr) { $secErr } else { $null }
    }
}

$results | ConvertTo-Json
`;

const CURRENT_INFO_CMD_TEMPLATE = `
$ErrorActionPreference = 'Stop';
$code = @'
using System;
using System.Runtime.InteropServices;

public class WinSecurity {
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint processAccess, bool bInheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr TokenHandle, int TokenInformationClass, IntPtr TokenInformation, int TokenInformationLength, out int ReturnLength);

    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint TOKEN_QUERY = 0x0008;
    private const int TokenElevation = 20;
    private const int TokenIntegrityLevel = 25;

    [StructLayout(LayoutKind.Sequential)]
    private struct TOKEN_ELEVATION {
        public int TokenIsElevated;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SID_AND_ATTRIBUTES {
        public IntPtr Sid;
        public int Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TOKEN_MANDATORY_LABEL {
        public SID_AND_ATTRIBUTES Label;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetSidSubAuthority(IntPtr pSid, int nSubAuthority);

    [DllImport("advapi32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetSidSubAuthorityCount(IntPtr pSid);

    public struct ProcessSecurityInfo {
        public bool ElevationAvailable;
        public bool IntegrityAvailable;
        public int Elevated;
        public int IntegrityLevel;
        public string Error;
    }

    public static ProcessSecurityInfo GetProcessSecurity(int pid) {
        ProcessSecurityInfo info = new ProcessSecurityInfo();
        info.ElevationAvailable = false;
        info.IntegrityAvailable = false;
        info.Elevated = 0;
        info.IntegrityLevel = 0;
        info.Error = "";

        IntPtr hProcess = IntPtr.Zero;
        IntPtr hToken = IntPtr.Zero;

        try {
            hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (hProcess == IntPtr.Zero) {
                info.Error = "OpenProcessFailed: " + Marshal.GetLastWin32Error();
                return info;
            }

            if (!OpenProcessToken(hProcess, TOKEN_QUERY, out hToken)) {
                info.Error = "OpenProcessTokenFailed: " + Marshal.GetLastWin32Error();
                return info;
            }

            // Elevation
            int elevationSize = Marshal.SizeOf(typeof(TOKEN_ELEVATION));
            IntPtr pElevation = Marshal.AllocHGlobal(elevationSize);
            try {
                int returnLength;
                if (GetTokenInformation(hToken, TokenElevation, pElevation, elevationSize, out returnLength)) {
                    TOKEN_ELEVATION elevationStruct = (TOKEN_ELEVATION)Marshal.PtrToStructure(pElevation, typeof(TOKEN_ELEVATION));
                    info.Elevated = elevationStruct.TokenIsElevated;
                    info.ElevationAvailable = true;
                } else {
                    info.Error = "GetTokenInformationElevationFailed: " + Marshal.GetLastWin32Error();
                }
            } finally {
                Marshal.FreeHGlobal(pElevation);
            }

            // Integrity Level
            int returnLengthIL;
            GetTokenInformation(hToken, TokenIntegrityLevel, IntPtr.Zero, 0, out returnLengthIL);
            if (returnLengthIL > 0) {
                IntPtr pIntegrity = Marshal.AllocHGlobal(returnLengthIL);
                try {
                    if (GetTokenInformation(hToken, TokenIntegrityLevel, pIntegrity, returnLengthIL, out returnLengthIL)) {
                        TOKEN_MANDATORY_LABEL label = (TOKEN_MANDATORY_LABEL)Marshal.PtrToStructure(pIntegrity, typeof(TOKEN_MANDATORY_LABEL));
                        IntPtr pSid = label.Label.Sid;
                        IntPtr pSubAuthorityCount = GetSidSubAuthorityCount(pSid);
                        if (pSubAuthorityCount != IntPtr.Zero) {
                            int subAuthorityCount = Marshal.ReadByte(pSubAuthorityCount);
                            if (subAuthorityCount > 0) {
                                IntPtr pSubAuthority = GetSidSubAuthority(pSid, subAuthorityCount - 1);
                                if (pSubAuthority != IntPtr.Zero) {
                                    info.IntegrityLevel = Marshal.ReadInt32(pSubAuthority);
                                    info.IntegrityAvailable = true;
                                }
                            }
                        }
                    }
                } finally {
                    Marshal.FreeHGlobal(pIntegrity);
                }
            }
        } finally {
            if (hToken != IntPtr.Zero) {
                CloseHandle(hToken);
            }
            if (hProcess != IntPtr.Zero) {
                CloseHandle(hProcess);
            }
        }
        return info;
    }
}
'@

Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue

$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$currentSid = $currentIdentity.User.Value
$currentPrincipal = New-Object System.Security.Principal.WindowsPrincipal($currentIdentity)
$currentElevated = $currentPrincipal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
$currentSessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId

$sec = [WinSecurity]::GetProcessSecurity($PID)
$currentIntegrityLevel = if ($sec.IntegrityAvailable) { $sec.IntegrityLevel } else { $null }
$currentIntegrityAvailable = $sec.IntegrityAvailable

$processes = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath,CreationDate,SessionId

[PSCustomObject]@{
    CurrentSid = $currentSid
    CurrentElevated = $currentElevated
    CurrentSessionId = $currentSessionId
    CurrentIntegrityLevel = $currentIntegrityLevel
    CurrentIntegrityAvailable = $currentIntegrityAvailable
    Processes = $processes
} | ConvertTo-Json -Depth 4
`;

let lastScanDiagnostics = null;

async function scanWindows(options = {}) {
  const now = options.now || new Date();
  const startedAt = now;
  const runner = options.runner || runCommand;
  const config = options.config || loadWatchdogConfig();
  const errors = [];

  let connections = [];
  let rawSource = "powershell";

  try {
    const tcpOutput = await runner(POWERSHELL, [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "$ErrorActionPreference='Stop'; Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess,State | ConvertTo-Json -Depth 4"
    ]);
    connections = parsePowerShellTcpConnections(tcpOutput);
  } catch (error) {
    errors.push(safeError("Get-NetTCPConnection", error));
  }

  if (connections.length === 0) {
    try {
      const netstatOutput = await runner(NETSTAT, ["-ano"]);
      connections = parseNetstatOutput(netstatOutput);
      rawSource = "netstat";
  } catch (error) {
      errors.push(safeError("netstat -ano", error));
    }
  }

  let processes = new Map();
  let watchdogContext = {
    CurrentSid: null,
    CurrentElevated: false,
    CurrentSessionId: null,
    CurrentIntegrityLevel: null,
    CurrentIntegrityAvailable: false
  };

  try {
    const processOutput = await runner(POWERSHELL, [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      CURRENT_INFO_CMD_TEMPLATE
    ]);
    const parsed = JSON.parse(processOutput);
    if (parsed && typeof parsed === "object") {
      watchdogContext = {
        CurrentSid: parsed.CurrentSid || null,
        CurrentElevated: parsed.CurrentElevated === true,
        CurrentSessionId: parsed.CurrentSessionId != null ? Number(parsed.CurrentSessionId) : null,
        CurrentIntegrityLevel: parsed.CurrentIntegrityLevel != null ? Number(parsed.CurrentIntegrityLevel) : null,
        CurrentIntegrityAvailable: parsed.CurrentIntegrityAvailable === true
      };
      processes = parseWindowsProcesses(JSON.stringify(parsed.Processes || []));
    } else {
      processes = parseWindowsProcesses(processOutput);
    }
  } catch (error) {
    errors.push(safeError("Get-CimInstance Win32_Process", error));
  }

  const targetPids = new Set();
  for (const conn of connections) {
    const pid = conn.pid;
    if (pid && Number.isInteger(pid) && pid > 0) {
      let currentPid = pid;
      let depth = 0;
      while (currentPid && depth < 10) {
        targetPids.add(currentPid);
        const proc = processes.get(currentPid);
        if (!proc || !proc.parentPid || targetPids.has(proc.parentPid)) {
          break;
        }
        currentPid = proc.parentPid;
        depth++;
      }
    }
  }
  const targetPidsArr = [...targetPids];

  if (targetPidsArr.length > 0) {
    try {
      const pidsStr = targetPidsArr.join(", ");
      const secCmd = SEC_CMD_TEMPLATE.replace("PIDS_PLACEHOLDER", pidsStr);
      const secOutput = await runner(POWERSHELL, [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        secCmd
      ]);
      if (secOutput && secOutput.trim()) {
        const secParsed = parseJsonArray(secOutput);
        for (const item of secParsed) {
          const pid = Number(item.ProcessId);
          const proc = processes.get(pid);
          if (proc) {
            proc.ownerSid = item.OwnerSid || null;
            proc.ownerUser = item.OwnerUser || null;
            proc.ownerDomain = item.OwnerDomain || null;
            proc.elevated = item.Elevated != null ? Boolean(item.Elevated) : null;
            proc.integrityLevel = item.IntegrityLevel != null ? Number(item.IntegrityLevel) : null;
            proc.securityError = item.SecurityError || null;
          }
        }
      }
    } catch (error) {
      errors.push(safeError("GetProcessSecurity", error));
    }
  }

  const normalized = normalizeConnections(connections, processes, {
    now,
    config,
    rawSource,
    watchdog: watchdogContext,
    processTreeMaxDepth: config.safety.processTree ? config.safety.processTree.maxDepth : 5
  });
  const probedServers = options.skipHttpProbe
    ? normalized.visible
    : await enrichWithHttpProbes(normalized.visible, {
      timeoutMs: config.safety.httpProbeTimeoutMs,
      maxRedirects: config.safety.httpProbeMaxRedirects
    });
  const servers = probedServers.map((record) => attachLifecycleContext(record, { config }));

  const snapshot = {
    ok: true,
    generatedAt: now.toISOString(),
    platform: "win32",
    scanner: {
      primary: "Get-NetTCPConnection",
      processMetadata: "Get-CimInstance Win32_Process",
      fallback: "netstat -ano",
      destructiveActionsAvailable: false
    },
    config: {
      devRoots: config.safety.devRootsDisplay || []
    },
    servers,
    hidden: normalized.hidden,
    totals: {
      scanned: normalized.total,
      visible: servers.length,
      hidden: normalized.total - normalized.visible.length
    },
    errors
  };
  const scanEndedAt = new Date();

  if (options.skipHistory) {
    const result = attachActionEligibilityToSnapshot(applyHistoryToSnapshot(snapshot, {
      now,
      config: {
        safety: {
          history: {
            enabled: false
          }
        }
      }
    }));
    recordLastScanDiagnostics(result, { startedAt, endedAt: scanEndedAt, rawSource, errors, options });
    return result;
  }

  try {
    const result = attachActionEligibilityToSnapshot(applyHistoryToSnapshot(snapshot, {
      now,
      config
    }));
    recordLastScanDiagnostics(result, { startedAt, endedAt: scanEndedAt, rawSource, errors, options });
    return result;
  } catch (error) {
    const result = attachActionEligibilityToSnapshot({
      ...snapshot,
      servers: snapshot.servers.map((record) => ({
        ...record,
        historyContext: {
          firstSeenAt: null,
          lastSeenAt: null,
          seenCount: 0,
          consecutiveSeenCount: 0,
          persistedAcrossScans: false,
          previouslySeen: false,
          reappeared: false,
          historyStatus: "unavailable",
          evidence: [
            {
              type: "history",
              score: 0,
              message: safeErrorMessage("history", error)
            }
          ]
        }
      })),
      history: {
        enabled: true,
        storageHealth: "unavailable",
        retainedSnapshotCount: 0,
        oldestRetainedSnapshot: null,
        lastSuccessfulHistoryWrite: null,
        disappearedSincePrevious: 0,
        redactionPrivacyStatus: "privacy-safe normalized fields only; no command lines, paths, response bodies, or process trees persisted",
        warning: safeErrorMessage("history", error)
      }
    });
    recordLastScanDiagnostics(result, { startedAt, endedAt: scanEndedAt, rawSource, errors: [...errors, safeError("history", error)], options });
    return result;
  }
}

function recordLastScanDiagnostics(snapshot, context) {
  const servers = snapshot.servers || [];
  const probes = servers.map((record) => record.httpProbe || {});
  lastScanDiagnostics = {
    scanId: snapshot.history && snapshot.history.lastSuccessfulHistoryWrite ? `scan-${snapshot.generatedAt}` : `scan-${snapshot.generatedAt}`,
    startedAt: context.startedAt.toISOString(),
    endedAt: context.endedAt.toISOString(),
    durationMs: Math.max(0, context.endedAt.getTime() - context.startedAt.getTime()),
    activeScannerSource: context.rawSource,
    visible: snapshot.totals.visible,
    hidden: snapshot.totals.hidden,
    errors: context.errors || [],
    warnings: [
      ...(snapshot.history && snapshot.history.warning ? [snapshot.history.warning] : [])
    ],
    probeSummary: {
      enabled: !context.options.skipHttpProbe,
      attempted: probes.filter((probe) => probe.attempted).length,
      reachable: probes.filter((probe) => probe.reachable).length,
      timeout: probes.filter((probe) => String(probe.error || "").toLowerCase().includes("timeout")).length,
      refused: probes.filter((probe) => String(probe.error || "").toLowerCase().includes("refused")).length,
      nonHttp: probes.filter((probe) => String(probe.error || "").toLowerCase().includes("non-http")).length
    },
    enrichment: {
      truncatedTreeCount: servers.filter((record) => record.processTree && record.processTree.truncated).length,
      missingParentMetadataCount: servers.filter((record) => record.processTree && record.processTree.stopReason === "missing-parent-metadata").length,
      missingCreationTimeCount: servers.filter((record) => record.timingStatus !== "available").length
    },
    history: snapshot.history || null
  };
}

function getLastScanDiagnostics() {
  return lastScanDiagnostics;
}

async function runCommand(command, args) {
  const { stdout } = await execFileAsync(command, args, {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  return stdout;
}

function resolveWindowsCommand(system32RelativePath, fallback) {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const candidate = join(systemRoot, "System32", system32RelativePath);
  return existsSync(candidate) ? candidate : fallback;
}

module.exports = {
  parseJsonArray,
  parseNetstatOutput,
  parsePowerShellTcpConnections,
  parseWindowsProcesses,
  resolveWindowsCommand,
  runCommand,
  scanWindows,
  getLastScanDiagnostics
};
