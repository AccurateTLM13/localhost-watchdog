#requires -Version 5.1

[CmdletBinding()]
param(
  [string]$RepositoryRoot,
  [string]$OutputRoot,
  [string]$NodeRuntimePath,
  [switch]$Force,
  [switch]$PortableZip,
  [switch]$BuildInstaller,
  [string]$InnoCompilerPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
  $RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
} else {
  $RepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
}

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
  $OutputRoot = Join-Path $RepositoryRoot "dist"
}
$OutputRoot = [System.IO.Path]::GetFullPath($OutputRoot)
New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null

$package = Get-Content (Join-Path $RepositoryRoot "package.json") -Raw | ConvertFrom-Json
$version = [string]$package.version
if ([string]::IsNullOrWhiteSpace($version)) {
  throw "package.json must contain a version before a release can be staged."
}

$architecture = "win-x64"
$stageName = "LocalhostWatchdog-$version-$architecture"
$stageRoot = Join-Path $OutputRoot $stageName
$stageFullPath = [System.IO.Path]::GetFullPath($stageRoot)
$outputPrefix = $OutputRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $stageFullPath.StartsWith($outputPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Release staging path escaped the output directory."
}

if (Test-Path -LiteralPath $stageRoot) {
  if (-not $Force) {
    throw "Release staging directory already exists. Use -Force only after verifying it is disposable: $stageRoot"
  }
  Remove-Item -LiteralPath $stageRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null

function Copy-ReleaseFile {
  param([Parameter(Mandatory = $true)][string]$RelativePath)
  $source = Join-Path $RepositoryRoot $RelativePath
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "Required release file is missing: $RelativePath"
  }
  $destination = Join-Path $stageRoot $RelativePath
  $destinationDirectory = Split-Path -Parent $destination
  New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination -Force
}

function Copy-ReleaseDirectory {
  param([Parameter(Mandatory = $true)][string]$RelativePath)
  $source = Join-Path $RepositoryRoot $RelativePath
  if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    throw "Required release directory is missing: $RelativePath"
  }
  Copy-Item -LiteralPath $source -Destination (Join-Path $stageRoot $RelativePath) -Recurse -Force
}

@(
  "watchdog.js",
  "package.json",
  "LICENSE",
  "README.md"
) | ForEach-Object { Copy-ReleaseFile $_ }

Copy-ReleaseDirectory "src"

New-Item -ItemType Directory -Path (Join-Path $stageRoot "config") -Force | Out-Null
@(
  "config\safety.example.json",
  "config\projects.example.json",
  "config\dev-roots.example.json"
) | ForEach-Object { Copy-ReleaseFile $_ }
Copy-ReleaseFile "scripts\Start-LocalhostWatchdogTray.ps1"

if ([string]::IsNullOrWhiteSpace($NodeRuntimePath)) {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction SilentlyContinue }
  if (-not $nodeCommand) {
    throw "Node.js was not found. Pass -NodeRuntimePath with a tested node.exe."
  }
  $NodeRuntimePath = $nodeCommand.Source
} else {
  $NodeRuntimePath = (Resolve-Path -LiteralPath $NodeRuntimePath).Path
}

if (-not (Test-Path -LiteralPath $NodeRuntimePath -PathType Leaf)) {
  throw "The requested Node runtime does not exist: $NodeRuntimePath"
}

$nodeVersion = (& $NodeRuntimePath --version 2>$null | Select-Object -First 1).Trim()
$nodeMajorMatch = [regex]::Match($nodeVersion, "^v(?<major>\d+)")
if (-not $nodeMajorMatch.Success -or [int]$nodeMajorMatch.Groups["major"].Value -lt 22) {
  throw "The bundled Node runtime must be version 22 or newer. Detected: $nodeVersion"
}

$runtimeRoot = Join-Path $stageRoot "runtime\node"
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
Copy-Item -LiteralPath $NodeRuntimePath -Destination (Join-Path $runtimeRoot "node.exe") -Force
$runtimeMetadata = [ordered]@{
  schemaVersion = "localhost-watchdog.node-runtime.v1"
  version = $nodeVersion
  architecture = $architecture
  sourcePath = [System.IO.Path]::GetFileName($NodeRuntimePath)
  bundledExecutable = "runtime/node/node.exe"
}
[System.IO.File]::WriteAllText(
  (Join-Path $runtimeRoot "NODE-RUNTIME.json"),
  ($runtimeMetadata | ConvertTo-Json -Depth 4) + "`n",
  [System.Text.UTF8Encoding]::new($false)
)

$sourceCommit = $null
try {
  $sourceCommit = (& git -c safe.directory=$RepositoryRoot -C $RepositoryRoot rev-parse HEAD 2>$null | Select-Object -First 1).Trim()
} catch {
  $sourceCommit = $null
}
$releaseMetadata = [ordered]@{
  schemaVersion = "localhost-watchdog.release.v1"
  product = "Localhost Watchdog"
  version = $version
  architecture = $architecture
  nodeVersion = $nodeVersion
  sourceCommit = if ($sourceCommit) { $sourceCommit } else { $null }
  entrypoint = "watchdog.js"
  trayEntrypoint = "scripts/Start-LocalhostWatchdogTray.ps1"
  dataDirectory = "%LOCALAPPDATA%/Localhost Watchdog"
  builtAt = (Get-Date).ToUniversalTime().ToString("o")
}
[System.IO.File]::WriteAllText(
  (Join-Path $stageRoot "RELEASE-METADATA.json"),
  ($releaseMetadata | ConvertTo-Json -Depth 5) + "`n",
  [System.Text.UTF8Encoding]::new($false)
)

$hashLines = New-Object System.Collections.Generic.List[string]
Get-ChildItem -LiteralPath $stageRoot -File -Recurse | Where-Object { $_.Name -ne "SHA256SUMS.txt" } | Sort-Object FullName | ForEach-Object {
  $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  $relative = $_.FullName.Substring($stageRoot.Length + 1).Replace("\", "/")
  $hashLines.Add("$hash  $relative")
}
[System.IO.File]::WriteAllLines((Join-Path $stageRoot "SHA256SUMS.txt"), $hashLines, [System.Text.UTF8Encoding]::new($false))

$zipPath = $null
if ($PortableZip) {
  $zipPath = Join-Path $OutputRoot "$stageName.zip"
  if (Test-Path -LiteralPath $zipPath) {
    if (-not $Force) { throw "Portable ZIP already exists. Use -Force after verifying it is disposable: $zipPath" }
    Remove-Item -LiteralPath $zipPath -Force
  }
  Compress-Archive -Path (Join-Path $stageRoot "*") -DestinationPath $zipPath -CompressionLevel Optimal
}

$installerPath = $null
if ($BuildInstaller) {
  if ([string]::IsNullOrWhiteSpace($InnoCompilerPath)) {
    $compiler = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($compiler) { $InnoCompilerPath = $compiler.Source }
  }
  if ([string]::IsNullOrWhiteSpace($InnoCompilerPath) -or -not (Test-Path -LiteralPath $InnoCompilerPath -PathType Leaf)) {
    throw "Inno Setup compiler was not found. Install it on the build machine or pass -InnoCompilerPath."
  }
  $installerOutput = Join-Path $OutputRoot "installer"
  New-Item -ItemType Directory -Path $installerOutput -Force | Out-Null
  $installerPath = Join-Path $installerOutput "Localhost-Watchdog-$version-Setup.exe"
  if (Test-Path -LiteralPath $installerPath) {
    if (-not $Force) { throw "Installer already exists. Use -Force after verifying it is disposable: $installerPath" }
    Remove-Item -LiteralPath $installerPath -Force
  }
  $issPath = Join-Path $RepositoryRoot "packaging\windows\LocalhostWatchdog.iss"
  & $InnoCompilerPath "/DAppVersion=$version" "/DSourceDir=$stageRoot" "/DOutputDir=$installerOutput" "/DOutputBaseFilename=Localhost-Watchdog-$version-Setup" $issPath
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
    throw "Inno Setup did not produce the expected installer."
  }
}

[ordered]@{
  ok = $true
  version = $version
  stageRoot = $stageRoot
  nodeRuntime = $nodeVersion
  portableZip = $zipPath
  installer = $installerPath
} | ConvertTo-Json -Depth 4
