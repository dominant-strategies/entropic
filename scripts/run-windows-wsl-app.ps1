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

    $bashCommand = "set -euo pipefail; ENTROPIC_BUILD_ALLOW_DOCKER_DESKTOP=1 ./scripts/build-openclaw-runtime.sh; ENTROPIC_BUILD_ALLOW_DOCKER_DESKTOP=1 ./scripts/bundle-runtime-image.sh"

    Invoke-WslProjectBash -Command $bashCommand
    if ($LASTEXITCODE -ne 0 -or -not (Test-FileNonEmpty $RuntimeTar)) {
        throw "Failed generating runtime tar for Windows dev mode."
    }
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

$RuntimeHelper = Join-Path $ScriptDir "dev-wsl-runtime.ps1"
& powershell -ExecutionPolicy Bypass -File $RuntimeHelper start $Mode
if ($LASTEXITCODE -ne 0) {
    throw "Failed to start WSL runtime for mode '$Mode'."
}

$env:ENTROPIC_WINDOWS_MANAGED_WSL = "1"
$env:ENTROPIC_RUNTIME_ALLOW_SHARED_DOCKER = "0"
$env:ENTROPIC_RUNTIME_MODE = $Mode

if ($ReleaseBinary) {
    $binaryPath = Resolve-ReleaseBinaryPath
    Stop-StaleReleaseEntropicProcess
    & $binaryPath
} else {
    if ($Mode -eq "dev") {
        Ensure-DevRuntimeTar
    }
    Stop-StaleDebugEntropicProcess
    & pnpm.cmd tauri:dev
}

exit $LASTEXITCODE
