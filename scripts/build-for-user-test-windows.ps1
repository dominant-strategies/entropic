param(
    [switch]$SkipRuntimeTarBuild,
    [switch]$SkipFrontendBuild
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message"
}

function Ensure-File([string]$Path, [string]$Content) {
    if (-not (Test-Path $Path)) {
        $parent = Split-Path -Parent $Path
        if ($parent) {
            New-Item -ItemType Directory -Force -Path $parent | Out-Null
        }
        Set-Content -Path $Path -Value $Content -NoNewline
    }
}

function Test-FileNonEmpty([string]$Path) {
    if (-not (Test-Path -Path $Path -PathType Leaf)) {
        return $false
    }
    return (Get-Item -Path $Path).Length -gt 0
}

function Get-WslBaseDistroName {
    if ($env:ENTROPIC_WSL_BASE_DISTRO) {
        return $env:ENTROPIC_WSL_BASE_DISTRO
    }
    return "Ubuntu"
}

function Get-WslRegisteredDistros {
    $distros = @()
    try {
        $lines = & wsl -l -q 2>$null
    } catch {
        throw "WSL is not available. Install it first with: wsl --install -d $(Get-WslBaseDistroName)"
    }

    foreach ($line in $lines) {
        $name = "$line".Trim()
        if (-not [string]::IsNullOrWhiteSpace($name)) {
            $distros += $name
        }
    }

    return $distros
}

function Assert-WslBaseDistroPresent {
    $baseDistro = Get-WslBaseDistroName
    $registered = Get-WslRegisteredDistros
    if ($registered -notcontains $baseDistro) {
        throw "Base WSL distro '$baseDistro' is not installed. Install it first with: wsl --install -d $baseDistro"
    }
}

function Invoke-DevWslHelper([string]$Command, [string]$Mode) {
    $helper = Join-Path $ScriptDir "dev-wsl-runtime.ps1"
    & powershell -ExecutionPolicy Bypass -File $helper $Command $Mode
    if ($LASTEXITCODE -ne 0) {
        throw "WSL helper failed: $Command $Mode"
    }
}

function Remove-StaleWslModeArtifacts {
    foreach ($path in @(
        (Join-Path $RuntimeDir "entropic-runtime-dev.tar"),
        (Join-Path $RuntimeDir "entropic-runtime-dev.tar.sha256"),
        (Join-Path $RuntimeDir "entropic-runtime-dev.sha256"),
        (Join-Path $RuntimeDir "entropic-runtime-prod.tar"),
        (Join-Path $RuntimeDir "entropic-runtime-prod.tar.sha256"),
        (Join-Path $RuntimeDir "entropic-runtime-prod.sha256")
    )) {
        Remove-Item -Path $path -Force -ErrorAction SilentlyContinue
    }
}

function Write-WslArtifactHashes([string]$ArtifactPath) {
    $hash = (Get-FileHash -Path $ArtifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -Path "$ArtifactPath.sha256" -Value $hash -NoNewline
    Set-Content -Path (Join-Path $RuntimeDir "entropic-runtime.sha256") -Value $hash -NoNewline
}

function Ensure-WslRuntimeArtifacts {
    $artifact = Join-Path $RuntimeDir "entropic-runtime.tar"
    $hashPath = Join-Path $RuntimeDir "entropic-runtime.sha256"
    Remove-StaleWslModeArtifacts

    if ((Test-FileNonEmpty $artifact) -and (Test-FileNonEmpty $hashPath)) {
        return
    }

    Write-Step "Preparing managed WSL distro artifacts"
    Assert-WslBaseDistroPresent

    $baseDistro = Get-WslBaseDistroName
    Remove-Item -Path $artifact -Force -ErrorAction SilentlyContinue
    Remove-Item -Path "$artifact.sha256" -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $hashPath -Force -ErrorAction SilentlyContinue

    & wsl --export $baseDistro $artifact
    if ($LASTEXITCODE -ne 0 -or -not (Test-FileNonEmpty $artifact)) {
        throw "Failed exporting base WSL distro '$baseDistro' to $artifact"
    }

    Write-WslArtifactHashes -ArtifactPath $artifact
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

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir ".."))
Set-Location $ProjectRoot

$RuntimeTar = Join-Path $ProjectRoot "src-tauri/resources/openclaw-runtime.tar.gz"
$RuntimeDir = Join-Path $ProjectRoot "src-tauri/resources/runtime"
$ResourcesBinDir = Join-Path $ProjectRoot "src-tauri/resources/bin"
$ResourcesShareLimaDir = Join-Path $ProjectRoot "src-tauri/resources/share/lima"
$RuntimeRootfsArtifact = Join-Path $RuntimeDir "entropic-runtime.tar"

Write-Host "Building Entropic Windows user-test bundle..."
Write-Host "Project root: $ProjectRoot"

Write-Step "Preparing required resource paths"
New-Item -ItemType Directory -Force -Path $ResourcesBinDir | Out-Null
New-Item -ItemType Directory -Force -Path $ResourcesShareLimaDir | Out-Null
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null

# tauri.conf.json references these globs in all builds. Keep deterministic markers
# so local Windows builds do not fail when macOS/Linux bundle assets are absent.
Ensure-File -Path (Join-Path $ResourcesBinDir "windows-user-test-placeholder.txt") -Content "windows placeholder`n"
Ensure-File -Path (Join-Path $ResourcesShareLimaDir "windows-user-test-placeholder.txt") -Content "windows placeholder`n"
Ensure-File -Path (Join-Path $RuntimeDir "windows-user-test-placeholder.txt") -Content "windows placeholder`n"

if (-not (Test-Path "node_modules")) {
    Write-Step "Installing JS dependencies"
    & pnpm.cmd install
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm install failed"
    }
}

Ensure-WslRuntimeArtifacts

if (-not (Test-FileNonEmpty $RuntimeTar)) {
    if ($SkipRuntimeTarBuild) {
        throw "Missing or empty runtime tar: $RuntimeTar. Re-run without -SkipRuntimeTarBuild to generate a valid runtime image tar."
    } else {
        Write-Step "Building runtime image tar via WSL (this can take a while)"

        $OpenClawDist = Join-Path $ProjectRoot "..\openclaw\dist"
        if (-not (Test-Path $OpenClawDist)) {
            throw "OpenClaw dist missing at $OpenClawDist. Build openclaw first."
        }

        Invoke-DevWslHelper -Command "start" -Mode "dev"
        $ProjectRootWsl = Convert-ToWslPath $ProjectRoot
        $BashCommand = @(
            "set -euo pipefail"
            "cd '$ProjectRootWsl'"
            "ENTROPIC_BUILD_ALLOW_DOCKER_DESKTOP=1 ./scripts/build-openclaw-runtime.sh"
            "ENTROPIC_BUILD_ALLOW_DOCKER_DESKTOP=1 ./scripts/bundle-runtime-image.sh"
        ) -join "; "

        & wsl -d entropic-dev -- bash -lc $BashCommand
        if ($LASTEXITCODE -ne 0) {
            throw "Failed generating runtime tar in WSL (entropic-dev)."
        }
    }
}

if (-not (Test-FileNonEmpty $RuntimeTar)) {
    throw "Missing or empty required runtime tar: $RuntimeTar"
}

if (-not $SkipFrontendBuild) {
    Write-Step "Building frontend dist"
    $frontendBuilt = $false

    & pnpm.cmd build
    if ($LASTEXITCODE -eq 0) {
        $frontendBuilt = $true
    }

    if (-not $frontendBuilt) {
        Write-Host "Windows frontend build failed. Falling back to WSL build..."
        Invoke-DevWslHelper -Command "start" -Mode "dev"
        $ProjectRootWsl = Convert-ToWslPath $ProjectRoot
        & wsl -d entropic-dev -- bash -lc "cd '$ProjectRootWsl' && pnpm build"
        if ($LASTEXITCODE -ne 0) {
            throw "Frontend build failed on both Windows and WSL."
        }
    }
}

Write-Step "Preparing Windows user-test Tauri config"
$UserTestConfigPath = Join-Path $ProjectRoot "src-tauri/tauri.conf.windows-user-test.json"
$BaseConfigPath = Join-Path $ProjectRoot "src-tauri/tauri.conf.json"
$config = Get-Content -Path $BaseConfigPath -Raw | ConvertFrom-Json
if (-not $config.build) {
    throw "Invalid tauri config: missing build block in $BaseConfigPath"
}
$config.build.beforeBuildCommand = "cmd /c exit 0"
$config.build.frontendDist = "../dist"

# User-test local installers should not require release updater signing keys.
if ($config.bundle) {
    $config.bundle.createUpdaterArtifacts = $false
    $config.bundle.resources = @(
        "resources/openclaw-runtime.tar.gz",
        "resources/runtime/*"
    )
}
if ($config.plugins -and $config.plugins.updater) {
    $config.plugins.PSObject.Properties.Remove("updater")
}

$config | ConvertTo-Json -Depth 100 | Set-Content -Path $UserTestConfigPath -Encoding UTF8

Write-Step "Building Windows NSIS installer"
# Use production config and build installer artifact users can install.
& pnpm.cmd tauri build --config src-tauri/tauri.conf.windows-user-test.json --bundles nsis
if ($LASTEXITCODE -ne 0) {
    throw "tauri build failed"
}

$BundleRoot = Join-Path $ProjectRoot "src-tauri/target/release/bundle"
$NsisArtifacts = @()
if (Test-Path (Join-Path $BundleRoot "nsis")) {
    $NsisArtifacts = @(Get-ChildItem (Join-Path $BundleRoot "nsis") -File | Where-Object { $_.Extension -eq ".exe" })
}

Write-Step "Build output"
Write-Host "Runtime tar: $RuntimeTar"
Write-Host "Managed WSL rootfs: $RuntimeRootfsArtifact"
Write-Host "Bundle dir: $BundleRoot"
if ($NsisArtifacts.Count -gt 0) {
    Write-Host "NSIS installer(s):"
    foreach ($artifact in $NsisArtifacts) {
        Write-Host "  $($artifact.FullName)"
    }
} else {
    Write-Host "No NSIS installer detected under $BundleRoot\\nsis"
}

Write-Host ""
Write-Host "Done."
