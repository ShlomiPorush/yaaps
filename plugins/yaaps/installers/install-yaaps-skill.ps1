#Requires -Version 5.1

[CmdletBinding()]
param(
  [switch]$Codex,
  [switch]$Claude,
  [switch]$All,
  [switch]$DryRun,
  [Uri]$Source,
  [string]$LocalPackage,
  [string]$HomeDirectory,
  [string[]]$TargetDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Resolve-Targets {
  param([string]$UserHome)

  if ($All -or ($Codex -and $Claude)) { return @("codex", "claude") }
  if ($Codex) { return @("codex") }
  if ($Claude) { return @("claude") }

  $detected = @()
  if ((Get-Command codex -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath (Join-Path $UserHome ".codex") -PathType Container)) {
    $detected += "codex"
  }
  if ((Get-Command claude -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath (Join-Path $UserHome ".claude") -PathType Container)) {
    $detected += "claude"
  }
  if ($detected.Count -gt 0) { return $detected }
  Write-Host "No Codex or Claude installation was detected; installing to both standard user skill paths."
  return @("codex", "claude")
}

function Expand-SkillPackage {
  param(
    [string]$PackagePath,
    [string]$Destination
  )

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $root = [IO.Path]::GetFullPath($Destination).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  [IO.Directory]::CreateDirectory($root) | Out-Null
  $archive = [IO.Compression.ZipFile]::OpenRead($PackagePath)
  try {
    foreach ($entry in $archive.Entries) {
      $relative = $entry.FullName.Replace("\", "/")
      if (-not $relative.StartsWith("yaaps/", [StringComparison]::Ordinal) -or $relative.Contains(":")) {
        throw "The package contains a path outside the yaaps skill directory."
      }
      $segments = $relative.Split("/", [StringSplitOptions]::RemoveEmptyEntries)
      if ($segments -contains "..") { throw "The package contains a path traversal entry." }
      $target = [IO.Path]::GetFullPath((Join-Path $root ($segments -join [IO.Path]::DirectorySeparatorChar)))
      if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        throw "The package escapes its extraction directory."
      }
      if (-not $entry.Name) {
        [IO.Directory]::CreateDirectory($target) | Out-Null
        continue
      }
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
      $inputStream = $entry.Open()
      try {
        $outputStream = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }
      } finally { $inputStream.Dispose() }
    }
  } finally { $archive.Dispose() }

  $skill = Join-Path $root "yaaps"
  if (-not (Test-Path -LiteralPath (Join-Path $skill "SKILL.md") -PathType Leaf)) {
    throw "The package does not contain yaaps/SKILL.md."
  }
  return $skill
}

function Install-SkillDirectory {
  param(
    [string]$SourceDirectory,
    [string]$Destination
  )

  $parent = Split-Path -Parent $Destination
  [IO.Directory]::CreateDirectory($parent) | Out-Null
  $staged = Join-Path $parent ".yaaps-install-$([Guid]::NewGuid().ToString('N'))"
  Copy-Item -LiteralPath $SourceDirectory -Destination $staged -Recurse -Force
  $backup = $null
  if (Test-Path -LiteralPath $Destination) {
    $backup = "$Destination.backup-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff'))"
    Move-Item -LiteralPath $Destination -Destination $backup
  }
  try {
    Move-Item -LiteralPath $staged -Destination $Destination
  } catch {
    Remove-Item -LiteralPath $staged -Recurse -Force -ErrorAction SilentlyContinue
    if ($backup) { Move-Item -LiteralPath $backup -Destination $Destination }
    throw
  }
}

if ($Source -and $LocalPackage) {
  throw "Use either -Source or -LocalPackage, not both."
}
if (-not $HomeDirectory) {
  $HomeDirectory = [Environment]::GetFolderPath("UserProfile")
}
$HomeDirectory = [IO.Path]::GetFullPath($HomeDirectory)
$destinations = if ($TargetDirectory) {
  foreach ($target in $TargetDirectory) { [IO.Path]::GetFullPath($target) }
} else {
  $targets = @(Resolve-Targets $HomeDirectory)
  foreach ($target in $targets) {
    if ($target -eq "claude") {
      Join-Path $HomeDirectory ".claude\skills\yaaps"
    } else {
      Join-Path $HomeDirectory ".agents\skills\yaaps"
    }
  }
}

if ($DryRun) {
  Write-Output "YAAPS skill installation dry run."
  foreach ($destination in $destinations) { Write-Output "Would install: $destination" }
  if ($LocalPackage) { Write-Output "Package: $([IO.Path]::GetFullPath($LocalPackage))" }
  elseif ($Source) { Write-Output "Source: $Source" }
  else { Write-Output "Source must be provided with -Source or -LocalPackage for installation." }
  return
}

# The server substitutes this placeholder when serving the installer; a copy
# taken straight from the repository still carries the literal placeholder,
# which must fail with guidance rather than an invalid-URI cast error.
if (-not $Source -and -not $LocalPackage) {
  try { $Source = [Uri]"__YAAPS_SKILL_PACKAGE_URL__" }
  catch { throw "Source must be provided with -Source or -LocalPackage for installation." }
  if (-not $Source.IsAbsoluteUri) {
    throw "Source must be provided with -Source or -LocalPackage for installation."
  }
}

if ($Source -and $Source.Scheme -ne "https" -and -not ($Source.Scheme -eq "http" -and $Source.DnsSafeHost -in @("localhost", "127.0.0.1", "::1"))) {
  throw "Source must use HTTPS except for localhost testing."
}

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "yaaps-skill-install-$([Guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory($temporaryRoot) | Out-Null
try {
  $packagePath = Join-Path $temporaryRoot "yaaps-skill.zip"
  if ($LocalPackage) {
    Copy-Item -LiteralPath ([IO.Path]::GetFullPath($LocalPackage)) -Destination $packagePath
  } else {
    Invoke-WebRequest -UseBasicParsing -Uri $Source -OutFile $packagePath
    $checksumPath = Join-Path $temporaryRoot "yaaps-skill.zip.sha256"
    Invoke-WebRequest -UseBasicParsing -Uri ([Uri]::new("$($Source.AbsoluteUri).sha256")) -OutFile $checksumPath
    $checksumDocument = Get-Content -LiteralPath $checksumPath -Raw
    if ($checksumDocument -notmatch "^([a-fA-F0-9]{64})  yaaps-skill\.zip\s*$") {
      throw "The skill package checksum document is invalid."
    }
    $actualChecksum = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash
    if ($actualChecksum -ine $Matches[1]) { throw "The skill package failed SHA-256 verification." }
  }
  $expandedSkill = Expand-SkillPackage $packagePath (Join-Path $temporaryRoot "expanded")
  foreach ($destination in $destinations) {
    Install-SkillDirectory $expandedSkill $destination
    Write-Output "Installed YAAPS skill: $destination"
  }
} finally {
  Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}
