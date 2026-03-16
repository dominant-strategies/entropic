param(
    [ValidateSet("dev", "prod")]
    [string]$Mode = "dev",

    [switch]$ReleaseBinary
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir ".."))
$RuntimeTar = Join-Path $ProjectRoot "src-tauri\resources\openclaw-runtime.tar.gz"
$RuntimeResourcesDir = Join-Path $ProjectRoot "src-tauri\resources\runtime"
$LocalAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { (Join-Path $HOME "AppData\Local") }
$ManagedWslRoot = Join-Path $LocalAppData "Entropic\runtime\wsl"
$ManagedWslArtifact = Join-Path $RuntimeResourcesDir "entropic-runtime.tar"
$ManagedWslArtifactHash = Join-Path $RuntimeResourcesDir "entropic-runtime.sha256"
$DebugBinaryPath = Join-Path $ProjectRoot "src-tauri\target\debug\entropic.exe"
$ReleaseBinaryPath = Join-Path $ProjectRoot "src-tauri\target\release\entropic.exe"

function Test-FileNonEmpty([string]$Path) {
    if (-not (Test-Path -Path $Path -PathType Leaf)) {
        return $false
    }
    return (Get-Item -Path $Path).Length -gt 0
}

function Get-DevRuntimeInputPaths {
    return @(
        (Join-Path $ProjectRoot "openclaw-runtime\entrypoint.sh"),
        (Join-Path $ProjectRoot "openclaw-runtime\Dockerfile"),
        (Join-Path $ProjectRoot "scripts\build-openclaw-runtime.sh"),
        (Join-Path $ProjectRoot "scripts\bundle-runtime-image.sh")
    )
}

function Test-DevRuntimeTarFresh {
    if (-not (Test-FileNonEmpty $RuntimeTar)) {
        return $false
    }

    $tarWriteTime = (Get-Item -Path $RuntimeTar).LastWriteTimeUtc
    foreach ($path in Get-DevRuntimeInputPaths) {
        if ((Test-Path -Path $path -PathType Leaf) -and ((Get-Item -Path $path).LastWriteTimeUtc -gt $tarWriteTime)) {
            return $false
        }
    }

    return $true
}

function Convert-ToWslPath([string]$WindowsPath) {
    $full = [System.IO.Path]::GetFullPath($WindowsPath)
    if ($full -match "^[A-Za-z]:\\") {
        $drive = $full.Substring(0, 1).ToLowerInvariant()
        $rest = $full.Substring(2).Replace("\", "/")
        return "/mnt/$drive$rest"
    }
    throw "Cannot convert path to WSL form: $WindowsPath"
}

function Invoke-WslProjectBash([string]$Command) {
    $projectRootWsl = Convert-ToWslPath $ProjectRoot
    & wsl -d entropic-dev --cd $projectRootWsl -- bash -lc $Command
}

function Get-ManagedDistroInstallPath([string]$DistroName) {
    return (Join-Path $ManagedWslRoot $DistroName)
}

function Test-WslRuntimeArtifactFresh {
    if (-not (Test-FileNonEmpty $ManagedWslArtifact) -or -not (Test-FileNonEmpty $ManagedWslArtifactHash)) {
        return $false
    }

    $artifactWriteTime = (Get-Item -Path $ManagedWslArtifact).LastWriteTimeUtc
    $freshnessInputs = @(
        (Join-Path $ProjectRoot "scripts\dev-wsl-runtime.ps1"),
        (Join-Path $ProjectRoot "src-tauri\src\runtime.rs"),
        (Join-Path $ProjectRoot "src-tauri\src\commands.rs")
    )

    foreach ($path in $freshnessInputs) {
        if ((Test-Path -Path $path -PathType Leaf) -and ((Get-Item -Path $path).LastWriteTimeUtc -gt $artifactWriteTime)) {
            return $false
        }
    }

    $ext4Path = Join-Path (Get-ManagedDistroInstallPath "entropic-dev") "ext4.vhdx"
    if ((Test-Path -Path $ext4Path -PathType Leaf) -and ((Get-Item -Path $ext4Path).LastWriteTimeUtc -gt $artifactWriteTime)) {
        return $false
    }

    return $true
}

function Write-WslArtifactHashes([string]$ArtifactPath) {
    $hash = (Get-FileHash -Path $ArtifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -Path "$ArtifactPath.sha256" -Value $hash -NoNewline
    Set-Content -Path $ManagedWslArtifactHash -Value $hash -NoNewline
}

function Ensure-WslRuntimeArtifacts {
    if (Test-WslRuntimeArtifactFresh) {
        return
    }

    Write-Host "[wsl] Managed WSL rootfs artifact is stale; exporting current entropic-dev distro."
    New-Item -ItemType Directory -Force -Path $RuntimeResourcesDir | Out-Null

    Remove-Item -Path $ManagedWslArtifact -Force -ErrorAction SilentlyContinue
    Remove-Item -Path "$ManagedWslArtifact.sha256" -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $ManagedWslArtifactHash -Force -ErrorAction SilentlyContinue

    & wsl --export entropic-dev $ManagedWslArtifact
    if ($LASTEXITCODE -ne 0 -or -not (Test-FileNonEmpty $ManagedWslArtifact)) {
        throw "Failed exporting Docker-ready entropic-dev WSL distro to $ManagedWslArtifact"
    }

    Write-WslArtifactHashes -ArtifactPath $ManagedWslArtifact
}

function Resolve-ReleaseBinaryPath {
    $candidates = @(
        (Join-Path $ProjectRoot "src-tauri\target\release\entropic.exe"),
        (Join-Path $ProjectRoot "src-tauri\target\release\Entropic.exe")
    )

    foreach ($candidate in $candidates) {
        if (Test-Path -Path $candidate -PathType Leaf) {
            return $candidate
        }
    }

    throw "Release binary not found under src-tauri\target\release. Run pnpm.cmd user-test:build:win first."
}

function Ensure-DevRuntimeTar {
    if (Test-DevRuntimeTarFresh) {
        return
    }

    if (Test-FileNonEmpty $RuntimeTar) {
        Write-Host "[wsl] Runtime tar is stale; rebuilding because runtime source files changed."
    }

    $openClawDist = Join-Path $ProjectRoot "..\openclaw\dist"
    if (-not (Test-Path $openClawDist)) {
        throw "OpenClaw dist missing at $openClawDist. Build openclaw first."
    }

    $bashCommand = "set -euo pipefail; ./scripts/build-openclaw-runtime.sh; ./scripts/bundle-runtime-image.sh"

    Invoke-WslProjectBash -Command $bashCommand
    if ($LASTEXITCODE -ne 0 -or -not (Test-FileNonEmpty $RuntimeTar)) {
        throw "Failed generating runtime tar for Windows dev mode."
    }
}

function Assert-FreshSandboxArtifactsForReleaseRun {
    if (Test-DevRuntimeTarFresh) {
        return
    }

    if ($env:ENTROPIC_ALLOW_STALE_RUNTIME_TAR -eq "1") {
        Write-Warning "Release user-test run is using a stale openclaw-runtime.tar.gz because ENTROPIC_ALLOW_STALE_RUNTIME_TAR=1 was set."
        return
    }

    throw @"
Release user-test run is blocked because src-tauri\resources\openclaw-runtime.tar.gz is stale relative to openclaw-runtime sources.

This can produce misleading sandbox startup failures or hangs during 'Provisioning isolated container' / 'Verifying sandbox health'.

Rebuild the Windows user-test binary without -SkipRuntimeTarBuild:
  pnpm.cmd user-test:build:win:bin

If you intentionally want to run with a stale sandbox image, set ENTROPIC_ALLOW_STALE_RUNTIME_TAR=1 and retry.
"@
}

function Stop-StaleDebugEntropicProcess {
    Stop-StaleEntropicProcessByPath -BinaryPath $DebugBinaryPath

}

function Stop-StaleReleaseEntropicProcess {
    Stop-StaleEntropicProcessByPath -BinaryPath $ReleaseBinaryPath
}

function Stop-StaleEntropicProcessByPath([string]$BinaryPath) {
    $staleProcesses = Get-Process entropic -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -eq $BinaryPath
    }

    foreach ($process in $staleProcesses) {
        Stop-Process -Id $process.Id -Force
    }

    if ($staleProcesses) {
        Start-Sleep -Milliseconds 500
    }
}

Set-Location $ProjectRoot

$env:ENTROPIC_WINDOWS_MANAGED_WSL = "1"
$env:ENTROPIC_RUNTIME_ALLOW_SHARED_DOCKER = "0"
$env:ENTROPIC_RUNTIME_MODE = $Mode
$scriptExitCode = 0

if ($ReleaseBinary) {
    Assert-FreshSandboxArtifactsForReleaseRun
    $env:ENTROPIC_AUTH_USE_LOCALHOST = "1"
    $binaryPath = Resolve-ReleaseBinaryPath
    Stop-StaleReleaseEntropicProcess
    & $binaryPath
} else {
    $RuntimeHelper = Join-Path $ScriptDir "dev-wsl-runtime.ps1"
    & powershell -ExecutionPolicy Bypass -File $RuntimeHelper start $Mode
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to start WSL runtime for mode '$Mode'."
    }

    if ($Mode -eq "dev") {
        Ensure-DevRuntimeTar
        Ensure-WslRuntimeArtifacts
    }
    Stop-StaleDebugEntropicProcess
    & pnpm.cmd tauri:dev
}

if (Get-Variable -Name LASTEXITCODE -ErrorAction SilentlyContinue) {
    $scriptExitCode = [int]$LASTEXITCODE
}

exit $scriptExitCode
