$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "../../windows/safe-target.ps1")

$tempRoot = Join-Path $env:TEMP ("blue-tanuki-safe-target-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot | Out-Null
try {
  $safeTarget = Resolve-SafeDirectoryTarget (Join-Path $tempRoot "not-created\app") "fixture"
  if ($safeTarget -ne [System.IO.Path]::GetFullPath((Join-Path $tempRoot "not-created\app"))) {
    throw "nonexistent target parent was not normalized consistently"
  }

  $rejected = $false
  try {
    Assert-SafeInstallTargets -InstallRoot $env:USERPROFILE -DataRoot (Join-Path $tempRoot "data") -SourceRoot $tempRoot | Out-Null
  } catch {
    $rejected = $true
  }
  if (-not $rejected) { throw "user-profile install target was accepted" }

  $rejected = $false
  try {
    Assert-SafeInstallTargets -InstallRoot (Join-Path $tempRoot "shared") -DataRoot (Join-Path $tempRoot "shared\data") -SourceRoot (Join-Path $tempRoot "source") | Out-Null
  } catch {
    $rejected = $true
  }
  if (-not $rejected) { throw "overlapping install/data targets were accepted" }

  $actual = Join-Path $tempRoot "actual"
  New-Item -ItemType Directory -Path $actual | Out-Null
  $junction = Join-Path $tempRoot "alias"
  New-Item -ItemType Junction -Path $junction -Target $actual | Out-Null
  $rejected = $false
  try {
    Resolve-SafeDirectoryTarget (Join-Path $junction "install") "reparse fixture" | Out-Null
  } catch {
    $rejected = $true
  }
  if (-not $rejected) { throw "reparse-point target was accepted" }

  Write-Output "windows_target_guard=pass"
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force
}
