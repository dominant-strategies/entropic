param(
    [switch]$SkipRuntimeTarBuild,
    [switch]$SkipFrontendBuild,
    [switch]$NoBundle
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

function Get-RuntimeTarInputPaths {
    return @(
        (Join-Path $ProjectRoot "openclaw-runtime\entrypoint.sh"),
        (Join-Path $ProjectRoot "openclaw-runtime\Dockerfile"),
        (Join-Path $ProjectRoot "scripts\build-openclaw-runtime.sh"),
        (Join-Path $ProjectRoot "scripts\bundle-runtime-image.sh")
    )
}

function Test-RuntimeTarFresh([string]$RuntimeTarPath) {
    if (-not (Test-FileNonEmpty $RuntimeTarPath)) {
        return $false
    }

    $tarWriteTime = (Get-Item -Path $RuntimeTarPath).LastWriteTimeUtc
    foreach ($path in Get-RuntimeTarInputPaths) {
        if ((Test-Path -Path $path -PathType Leaf) -and ((Get-Item -Path $path).LastWriteTimeUtc -gt $tarWriteTime)) {
            return $false
        }
    }

    return $true
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

function Stage-ReleaseBinaryResources([string]$RuntimeTarPath) {
    $releaseResourcesDir = Join-Path $ProjectRoot "src-tauri/target/release/resources"
    New-Item -ItemType Directory -Force -Path $releaseResourcesDir | Out-Null

    $releaseRuntimeDir = Join-Path $releaseResourcesDir "runtime"
    New-Item -ItemType Directory -Force -Path $releaseRuntimeDir | Out-Null

    if (Test-Path -Path $RuntimeDir) {
        Copy-Item -Path (Join-Path $RuntimeDir "*") -Destination $releaseRuntimeDir -Recurse -Force
    }

    if (Test-FileNonEmpty $RuntimeTarPath) {
        $dest = Join-Path $releaseResourcesDir "openclaw-runtime.tar.gz"
        Copy-Item -Path $RuntimeTarPath -Destination $dest -Force
    }
}

function Stop-StaleReleaseEntropicProcess {
    $staleProcesses = Get-Process entropic -ErrorAction SilentlyContinue

    foreach ($process in $staleProcesses) {
        Stop-Process -Id $process.Id -Force
    }

    if ($staleProcesses) {
        Start-Sleep -Milliseconds 500
    }
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

function Invoke-WslProjectBash([string]$Command) {
    $projectRootWsl = Convert-ToWslPath $ProjectRoot
    & wsl -d entropic-dev --cd $projectRootWsl -- bash -lc $Command
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir ".."))
Set-Location $ProjectRoot
Stop-StaleReleaseEntropicProcess

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

if (-not (Test-RuntimeTarFresh $RuntimeTar)) {
    if ($SkipRuntimeTarBuild -and (Test-FileNonEmpty $RuntimeTar)) {
        Write-Host "Runtime tar is stale; rebuilding because runtime source files changed."
    } elseif ($SkipRuntimeTarBuild) {
        throw "Missing or empty runtime tar: $RuntimeTar. Re-run without -SkipRuntimeTarBuild to generate a valid runtime image tar."
    }

    Write-Step "Building runtime image tar via WSL (this can take a while)"

    $OpenClawDist = Join-Path $ProjectRoot "..\openclaw\dist"
    if (-not (Test-Path $OpenClawDist)) {
        throw "OpenClaw dist missing at $OpenClawDist. Build openclaw first."
    }

    Invoke-DevWslHelper -Command "start" -Mode "dev"
    $BashCommand = "set -euo pipefail; ENTROPIC_BUILD_ALLOW_DOCKER_DESKTOP=1 ./scripts/build-openclaw-runtime.sh; ENTROPIC_BUILD_ALLOW_DOCKER_DESKTOP=1 ./scripts/bundle-runtime-image.sh"

    Invoke-WslProjectBash -Command $BashCommand
    if ($LASTEXITCODE -ne 0) {
        throw "Failed generating runtime tar in WSL (entropic-dev)."
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
        Invoke-WslProjectBash -Command "pnpm build"
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
        "resources/runtime/*"
    )
}
if ($config.plugins -and $config.plugins.updater) {
    $config.plugins.PSObject.Properties.Remove("updater")
}

$config | ConvertTo-Json -Depth 100 | Set-Content -Path $UserTestConfigPath -Encoding UTF8

if ($NoBundle) {
    Write-Step "Building Windows release binary without installer"
    & pnpm.cmd tauri build --config src-tauri/tauri.conf.windows-user-test.json --no-bundle
} else {
    Write-Step "Building Windows NSIS installer"
    # Do not bundle the runtime image tar into NSIS. The combined runtime payload exceeds
    # the practical NSIS limit on Windows; direct release-binary runs still get the tar.
    & pnpm.cmd tauri build --config src-tauri/tauri.conf.windows-user-test.json --bundles nsis
}
if ($LASTEXITCODE -ne 0) {
    throw "tauri build failed"
}

Write-Step "Staging runtime resources for direct release-binary runs"
Stage-ReleaseBinaryResources -RuntimeTarPath $RuntimeTar

$BundleRoot = Join-Path $ProjectRoot "src-tauri/target/release/bundle"
$NsisArtifacts = @()
if (Test-Path (Join-Path $BundleRoot "nsis")) {
    $NsisArtifacts = @(Get-ChildItem (Join-Path $BundleRoot "nsis") -File | Where-Object { $_.Extension -eq ".exe" })
}

Write-Step "Build output"
Write-Host "Runtime tar: $RuntimeTar"
Write-Host "Managed WSL rootfs: $RuntimeRootfsArtifact"
Write-Host "Bundle dir: $BundleRoot"
if ($NoBundle) {
    Write-Host "Release binary: $(Join-Path $ProjectRoot "src-tauri\target\release\entropic.exe")"
} elseif ($NsisArtifacts.Count -gt 0) {
    Write-Host "NSIS installer(s):"
    foreach ($artifact in $NsisArtifacts) {
        Write-Host "  $($artifact.FullName)"
    }
} else {
    Write-Host "No NSIS installer detected under $BundleRoot\\nsis"
}

Write-Host ""
Write-Host "Done."
