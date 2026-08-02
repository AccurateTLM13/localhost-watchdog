#define MyAppName "Localhost Watchdog"
#define MyAppPublisher "Localhost Watchdog"
#define MyAppExeName "LocalhostWatchdogTray.ps1"

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\..\dist\LocalhostWatchdog-0.1.0-win-x64"
#endif
#ifndef OutputDir
  #define OutputDir "..\..\dist\installer"
#endif
#ifndef OutputBaseFilename
  #define OutputBaseFilename "Localhost-Watchdog-Setup"
#endif

[Setup]
AppId={{A7E89046-7DB2-4B9F-9B91-2C1AAFD0E2C4}
AppName={#MyAppName}
AppVersion={#AppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\Localhost Watchdog
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBaseFilename}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#MyAppName}
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#MyAppName}
VersionInfoDescription=Local Windows development server inventory and lifecycle inspector

[Tasks]
Name: "startup"; Description: "Start Localhost Watchdog when I sign in to Windows"; GroupDescription: "Startup options:"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -STA -ExecutionPolicy Bypass -File ""{app}\scripts\Start-LocalhostWatchdogTray.ps1"" -RepositoryRoot ""{app}"" -DataRoot ""{localappdata}\Localhost Watchdog"""; WorkingDir: "{app}"
Name: "{userstartup}\{#MyAppName}"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -STA -ExecutionPolicy Bypass -File ""{app}\scripts\Start-LocalhostWatchdogTray.ps1"" -RepositoryRoot ""{app}"" -DataRoot ""{localappdata}\Localhost Watchdog"""; WorkingDir: "{app}"; Tasks: startup

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -STA -ExecutionPolicy Bypass -File ""{app}\scripts\Start-LocalhostWatchdogTray.ps1"" -RepositoryRoot ""{app}"" -DataRoot ""{localappdata}\Localhost Watchdog"""; WorkingDir: "{app}"; Description: "Launch {#MyAppName}"; Flags: postinstall nowait skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}"
