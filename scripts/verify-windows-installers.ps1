[CmdletBinding()]
param(
  [string]$TargetTriple = "x86_64-pc-windows-msvc"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ReleaseRoot = Join-Path $ProjectRoot "src-tauri\target\$TargetTriple\release"
$BundleRoot = Join-Path $ReleaseRoot "bundle"
$AppExecutable = Join-Path $ReleaseRoot "subtitle-extractor.exe"
$NsisDirectory = Join-Path $BundleRoot "nsis"
$MsiDirectory = Join-Path $BundleRoot "msi"
$ModelSha256 = "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb"
$YtDlpSha256 = "52fe3c26dcf71fbdc85b528589020bb0b8e383155cfa81b64dd447bbe35e24b8"
$ExpectedFfmpegVersion = "8.1.2"
$ExpectedYtDlpVersion = "2026.07.04"

function Assert-Amd64Pe {
  param([Parameter(Mandatory = $true)][string]$FilePath)

  $Stream = [System.IO.File]::OpenRead($FilePath)
  $Reader = [System.IO.BinaryReader]::new($Stream)
  try {
    if ($Reader.ReadUInt16() -ne 0x5A4D) {
      throw "$FilePath is not a DOS/PE executable"
    }
    $Stream.Seek(0x3C, [System.IO.SeekOrigin]::Begin) | Out-Null
    $PeOffset = $Reader.ReadInt32()
    $Stream.Seek($PeOffset, [System.IO.SeekOrigin]::Begin) | Out-Null
    if ($Reader.ReadUInt32() -ne 0x00004550) {
      throw "$FilePath has an invalid PE signature"
    }
    if ($Reader.ReadUInt16() -ne 0x8664) {
      throw "$FilePath is not an AMD64 PE executable"
    }
  }
  finally {
    $Reader.Dispose()
    $Stream.Dispose()
  }
}

function Invoke-CheckedProcess {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [int[]]$AllowedExitCodes = @(0)
  )

  $Process = Start-Process `
    -FilePath $FilePath `
    -ArgumentList $Arguments `
    -Wait `
    -PassThru
  if ($AllowedExitCodes -notcontains $Process.ExitCode) {
    throw "$FilePath exited with code $($Process.ExitCode): $($Arguments -join ' ')"
  }
}

function Assert-RuntimeLayout {
  param([Parameter(Mandatory = $true)][string]$InstallDirectory)

  $MainExecutable = Join-Path $InstallDirectory "subtitle-extractor.exe"
  $FfmpegExecutable = Join-Path $InstallDirectory "ffmpeg.exe"
  $FfprobeExecutable = Join-Path $InstallDirectory "ffprobe.exe"
  $YtDlpExecutable = Join-Path $InstallDirectory "yt-dlp.exe"
  $ModelPath = Join-Path $InstallDirectory "models\ggml-small-q5_1.bin"

  foreach ($RequiredFile in @(
    $MainExecutable,
    $FfmpegExecutable,
    $FfprobeExecutable,
    $YtDlpExecutable,
    $ModelPath
  )) {
    if (-not (Test-Path -LiteralPath $RequiredFile -PathType Leaf)) {
      throw "Installed runtime is missing: $RequiredFile"
    }
  }

  foreach ($Executable in @(
    $MainExecutable,
    $FfmpegExecutable,
    $FfprobeExecutable,
    $YtDlpExecutable
  )) {
    Assert-Amd64Pe -FilePath $Executable
  }

  $ModelDigest = (
    Get-FileHash -LiteralPath $ModelPath -Algorithm SHA256
  ).Hash.ToLowerInvariant()
  if ($ModelDigest -ne $ModelSha256) {
    throw "Installed Whisper model checksum mismatch"
  }

  $YtDlpDigest = (
    Get-FileHash -LiteralPath $YtDlpExecutable -Algorithm SHA256
  ).Hash.ToLowerInvariant()
  if ($YtDlpDigest -ne $YtDlpSha256) {
    throw "Installed yt-dlp checksum mismatch"
  }

  $FfmpegOutput = @(
    & $FfmpegExecutable -hide_banner -version 2>&1
  )
  if ($LASTEXITCODE -ne 0 -or ($FfmpegOutput -join "`n") -notmatch "ffmpeg version $([regex]::Escape($ExpectedFfmpegVersion))") {
    throw "Installed FFmpeg failed its version smoke test"
  }

  $FfprobeOutput = @(
    & $FfprobeExecutable -hide_banner -version 2>&1
  )
  if ($LASTEXITCODE -ne 0 -or ($FfprobeOutput -join "`n") -notmatch "ffprobe version $([regex]::Escape($ExpectedFfmpegVersion))") {
    throw "Installed ffprobe failed its version smoke test"
  }

  $YtDlpOutput = @(& $YtDlpExecutable --version 2>&1)
  if ($LASTEXITCODE -ne 0 -or ($YtDlpOutput -join "").Trim() -ne $ExpectedYtDlpVersion) {
    throw "Installed yt-dlp failed its version smoke test"
  }
}

function Assert-ApplicationLaunch {
  param([Parameter(Mandatory = $true)][string]$ApplicationPath)

  $ApplicationProcess = Start-Process `
    -FilePath $ApplicationPath `
    -WorkingDirectory (Split-Path -Parent $ApplicationPath) `
    -PassThru
  try {
    $Deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $Deadline) {
      Start-Sleep -Milliseconds 500
      $ApplicationProcess.Refresh()
      if ($ApplicationProcess.HasExited) {
        throw "Installed application exited during launch with code $($ApplicationProcess.ExitCode)"
      }
      if ($ApplicationProcess.MainWindowHandle -ne 0) {
        Write-Host "Verified application window: $($ApplicationProcess.MainWindowTitle)"
        return
      }
    }
    throw "Installed application did not create a window within 30 seconds"
  }
  finally {
    $ApplicationProcess.Refresh()
    if (-not $ApplicationProcess.HasExited) {
      $TaskKill = Start-Process `
        -FilePath "taskkill.exe" `
        -ArgumentList @("/PID", "$($ApplicationProcess.Id)", "/T", "/F") `
        -Wait `
        -PassThru `
        -NoNewWindow
      if ($TaskKill.ExitCode -ne 0) {
        throw "Failed to terminate the application process tree"
      }
    }
  }
}

function Wait-PathRemoval {
  param([Parameter(Mandatory = $true)][string]$Path)

  $Deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ((Test-Path -LiteralPath $Path) -and [DateTime]::UtcNow -lt $Deadline) {
    Start-Sleep -Milliseconds 500
  }
  if (Test-Path -LiteralPath $Path) {
    throw "Installer did not remove its installation directory: $Path"
  }
}

function Get-ProductUninstallEntries {
  $RegistryRoots = @(
    "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
  )
  $Entries = @()
  foreach ($RegistryRoot in $RegistryRoots) {
    if (-not (Test-Path -LiteralPath $RegistryRoot)) {
      continue
    }
    foreach ($RegistryKey in (Get-ChildItem -LiteralPath $RegistryRoot)) {
      $Entry = Get-ItemProperty `
        -LiteralPath $RegistryKey.PSPath `
        -ErrorAction SilentlyContinue
      if ($null -eq $Entry) {
        continue
      }
      $DisplayName = $Entry.PSObject.Properties["DisplayName"]
      $Publisher = $Entry.PSObject.Properties["Publisher"]
      if (
        $null -ne $DisplayName -and
        $null -ne $Publisher -and
        $DisplayName.Value -eq "文案提取" -and
        $Publisher.Value -eq "SCF"
      ) {
        $Entries += $Entry
      }
    }
  }
  return @($Entries)
}

function Assert-UninstallRegistration {
  param(
    [Parameter(Mandatory = $true)][bool]$Expected,
    [string]$InstallDirectory = ""
  )

  $Entries = @(Get-ProductUninstallEntries)
  if (-not $Expected) {
    if ($Entries.Count -ne 0) {
      throw "Uninstall registration still exists after package removal"
    }
    return
  }

  if ($Entries.Count -ne 1) {
    throw "Expected one uninstall registration, found $($Entries.Count)"
  }
  $DirectorySeparators = [char[]]@('\', '/')
  $RegisteredLocation = (
    [string]$Entries[0].InstallLocation
  ).Trim('"').TrimEnd($DirectorySeparators)
  $ExpectedLocation = $InstallDirectory.TrimEnd($DirectorySeparators)
  if (
    -not [StringComparer]::OrdinalIgnoreCase.Equals(
      $RegisteredLocation,
      $ExpectedLocation
    )
  ) {
    throw "Unexpected registered install location: $RegisteredLocation"
  }
}

if (-not (Test-Path -LiteralPath $AppExecutable -PathType Leaf)) {
  throw "Missing release application executable: $AppExecutable"
}
Assert-Amd64Pe -FilePath $AppExecutable

$NsisInstallers = @(
  Get-ChildItem -LiteralPath $NsisDirectory -Filter "*.exe" -File
)
$MsiInstallers = @(
  Get-ChildItem -LiteralPath $MsiDirectory -Filter "*.msi" -File
)
if ($NsisInstallers.Count -eq 0) {
  throw "No NSIS installer was produced"
}
if ($MsiInstallers.Count -eq 0) {
  throw "No MSI installer was produced"
}

foreach ($InstallerFile in @($NsisInstallers + $MsiInstallers)) {
  if ($InstallerFile.Length -lt 1MB) {
    throw "Installer is unexpectedly small: $($InstallerFile.FullName)"
  }
}

$WindowsInstaller = $null
$Database = $null
$Summary = $null
try {
  $WindowsInstaller = New-Object -ComObject WindowsInstaller.Installer
  foreach ($MsiFile in $MsiInstallers) {
    $Database = $WindowsInstaller.GetType().InvokeMember(
      "OpenDatabase",
      [System.Reflection.BindingFlags]::InvokeMethod,
      $null,
      $WindowsInstaller,
      @($MsiFile.FullName, 0)
    )
    $Summary = $Database.GetType().InvokeMember(
      "SummaryInformation",
      [System.Reflection.BindingFlags]::InvokeMethod,
      $null,
      $Database,
      @(0)
    )
    $Template = [string]$Summary.GetType().InvokeMember(
      "Property",
      [System.Reflection.BindingFlags]::GetProperty,
      $null,
      $Summary,
      @(7)
    )
    if ($Template -notmatch "(^|;)x64(;|$)") {
      throw "MSI template is not x64: $Template"
    }
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($Summary)
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($Database)
    $Summary = $null
    $Database = $null
  }
}
finally {
  if ($null -ne $Summary) {
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($Summary)
  }
  if ($null -ne $Database) {
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($Database)
  }
  if ($null -ne $WindowsInstaller) {
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($WindowsInstaller)
  }
}

$HashLines = foreach ($InstallerFile in @($NsisInstallers + $MsiInstallers)) {
  $Digest = (Get-FileHash -LiteralPath $InstallerFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  "$Digest  $($InstallerFile.Name)"
}
$HashManifest = Join-Path $BundleRoot "SHA256SUMS.txt"
$HashLines | Sort-Object | Set-Content -LiteralPath $HashManifest -Encoding ascii

$SmokeRoot = "$($env:SystemDrive)\subtitle-extractor-installer-smoke-$PID"
if ($SmokeRoot -notmatch "^[A-Za-z]:\\subtitle-extractor-installer-smoke-\d+$") {
  throw "Refusing unsafe installer smoke-test root: $SmokeRoot"
}
$NsisInstallDirectory = Join-Path $SmokeRoot "nsis"
$MsiInstallDirectory = Join-Path $SmokeRoot "msi"
$MsiLog = Join-Path $SmokeRoot "msi-install.log"
$MsiInstallAttempted = $false

try {
  if (Test-Path -LiteralPath $SmokeRoot) {
    Remove-Item -LiteralPath $SmokeRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Path $SmokeRoot | Out-Null
  Assert-UninstallRegistration -Expected $false

  $NsisInstaller = $NsisInstallers[0]
  Invoke-CheckedProcess `
    -FilePath $NsisInstaller.FullName `
    -Arguments @("/S", "/NS", "/D=$NsisInstallDirectory")
  Assert-RuntimeLayout -InstallDirectory $NsisInstallDirectory
  Assert-UninstallRegistration `
    -Expected $true `
    -InstallDirectory $NsisInstallDirectory
  Assert-ApplicationLaunch `
    -ApplicationPath (Join-Path $NsisInstallDirectory "subtitle-extractor.exe")

  $NsisUninstaller = Join-Path $NsisInstallDirectory "uninstall.exe"
  if (-not (Test-Path -LiteralPath $NsisUninstaller -PathType Leaf)) {
    throw "NSIS installation is missing uninstall.exe"
  }
  Invoke-CheckedProcess -FilePath $NsisUninstaller -Arguments @("/S")
  Wait-PathRemoval -Path $NsisInstallDirectory
  Assert-UninstallRegistration -Expected $false

  $MsiInstaller = $MsiInstallers[0]
  $MsiInstallAttempted = $true
  Invoke-CheckedProcess `
    -FilePath "msiexec.exe" `
    -Arguments @(
      "/i",
      $MsiInstaller.FullName,
      "/qn",
      "/norestart",
      "INSTALLDIR=$MsiInstallDirectory",
      "/L*v",
      $MsiLog
    ) `
    -AllowedExitCodes @(0, 3010)
  Assert-RuntimeLayout -InstallDirectory $MsiInstallDirectory
  Assert-UninstallRegistration `
    -Expected $true `
    -InstallDirectory $MsiInstallDirectory
  Assert-ApplicationLaunch `
    -ApplicationPath (Join-Path $MsiInstallDirectory "subtitle-extractor.exe")

  Invoke-CheckedProcess `
    -FilePath "msiexec.exe" `
    -Arguments @(
      "/x",
      $MsiInstaller.FullName,
      "/qn",
      "/norestart",
      "/L*v",
      (Join-Path $SmokeRoot "msi-uninstall.log")
    ) `
    -AllowedExitCodes @(0, 3010)
  $MsiInstallAttempted = $false
  Wait-PathRemoval -Path $MsiInstallDirectory
  Assert-UninstallRegistration -Expected $false
}
finally {
  $NsisUninstaller = Join-Path $NsisInstallDirectory "uninstall.exe"
  if (Test-Path -LiteralPath $NsisUninstaller -PathType Leaf) {
    try {
      Invoke-CheckedProcess -FilePath $NsisUninstaller -Arguments @("/S")
    }
    catch {
      Write-Warning "NSIS cleanup failed: $_"
    }
  }
  if ($MsiInstallAttempted -and $MsiInstallers.Count -gt 0) {
    try {
      Invoke-CheckedProcess `
        -FilePath "msiexec.exe" `
        -Arguments @("/x", $MsiInstallers[0].FullName, "/qn", "/norestart") `
        -AllowedExitCodes @(0, 1605, 3010)
    }
    catch {
      Write-Warning "MSI cleanup failed: $_"
    }
  }
  if (Test-Path -LiteralPath $SmokeRoot) {
    Remove-Item -LiteralPath $SmokeRoot -Recurse -Force
  }
  $ProductRegistryPath = "HKCU:\Software\SCF\文案提取"
  if (Test-Path -LiteralPath $ProductRegistryPath) {
    Remove-Item -LiteralPath $ProductRegistryPath -Recurse -Force
  }
  foreach ($AppDataPath in @(
    (Join-Path $env:APPDATA "com.scf.subtitleextractor"),
    (Join-Path $env:LOCALAPPDATA "com.scf.subtitleextractor")
  )) {
    if (Test-Path -LiteralPath $AppDataPath) {
      Remove-Item -LiteralPath $AppDataPath -Recurse -Force
    }
  }
}

Write-Host "Verified AMD64 application, NSIS installer, and x64 MSI"
Write-Host "Installed, launched, and removed NSIS and MSI package payloads"
Write-Host "Wrote installer hashes to $HashManifest"
