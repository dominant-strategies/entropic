param(
    [switch]$ForceExport,
    [switch]$DownloadFromRuntimeRelease,
    [string]$RuntimeReleaseRepo,
    [string]$RuntimeReleaseTag
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

function Get-RuntimeReleaseRepo {
    if (-not [string]::IsNullOrWhiteSpace($RuntimeReleaseRepo)) {
        return $RuntimeReleaseRepo.Trim()
    }
    if ($env:OPENCLAW_RUNTIME_RELEASE_REPO) {
        return $env:OPENCLAW_RUNTIME_RELEASE_REPO.Trim()
    }
    return "dominant-strategies/entropic-releases"
}

function Get-RuntimeReleaseTag {
    if (-not [string]::IsNullOrWhiteSpace($RuntimeReleaseTag)) {
        return $RuntimeReleaseTag.Trim()
    }
    if ($env:OPENCLAW_RUNTIME_RELEASE_TAG) {
        return $env:OPENCLAW_RUNTIME_RELEASE_TAG.Trim()
    }
    return "runtime-latest"
}

function Get-RuntimeManifestUrl {
    $repo = Get-RuntimeReleaseRepo
    $tag = Get-RuntimeReleaseTag
    return "https://github.com/$repo/releases/download/$tag/runtime-manifest.json"
}

function Get-DefaultRootfsAssetUrl {
    $repo = Get-RuntimeReleaseRepo
    $tag = Get-RuntimeReleaseTag
    return "https://github.com/$repo/releases/download/$tag/entropic-runtime-windows-x86_64.tar"
}

function Get-Sha256FromText([string]$Text) {
    if ([string]::IsNullOrWhiteSpace($Text)) {
        return $null
    }
    $match = [regex]::Match($Text, "(?i)\b([0-9a-f]{64})\b")
    if ($match.Success) {
        return $match.Groups[1].Value.ToLowerInvariant()
    }
    return $null
}

function Download-File([string]$Url, [string]$DestinationPath) {
    $parent = Split-Path -Parent $DestinationPath
    if ($parent) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    Invoke-WebRequest -Uri $Url -OutFile $DestinationPath
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
        throw "WSL is not available. Windows release builds require a Windows runner with WSL installed."
    }

    if ($LASTEXITCODE -ne 0) {
        throw "WSL is available but 'wsl -l -q' failed. Verify the runner can access WSL before releasing Windows builds."
    }

    foreach ($line in $lines) {
        $name = ("$line" -replace "`0", "").Trim()
        if (
            -not [string]::IsNullOrWhiteSpace($name) -and
            $name -ne "Access is denied." -and
            -not $name.StartsWith("Error code:") -and
            -not $name.StartsWith("Wsl/")
        ) {
            $distros += $name
        }
    }

    return $distros
}

function Assert-WslBaseDistroPresent {
    $baseDistro = Get-WslBaseDistroName
    $registered = Get-WslRegisteredDistros
    if ($registered -notcontains $baseDistro) {
        throw "Base WSL distro '$baseDistro' is not installed on this runner. Install or pre-provision it before running Windows release builds."
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

function Write-WslArtifactHashes([string]$ArtifactPath, [string]$ExpectedHash = "") {
    $hash = if (-not [string]::IsNullOrWhiteSpace($ExpectedHash)) {
        $ExpectedHash.ToLowerInvariant()
    } else {
        (Get-FileHash -Path $ArtifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    Set-Content -Path "$ArtifactPath.sha256" -Value $hash -NoNewline
    Set-Content -Path (Join-Path $RuntimeDir "entropic-runtime.sha256") -Value $hash -NoNewline
}

function Ensure-WslRuntimeArtifacts {
    $artifact = Join-Path $RuntimeDir "entropic-runtime.tar"
    $hashPath = Join-Path $RuntimeDir "entropic-runtime.sha256"

    Remove-StaleWslModeArtifacts

    if (-not $ForceExport -and (Test-FileNonEmpty $artifact) -and (Test-FileNonEmpty $hashPath)) {
        Write-Host "Using existing managed WSL rootfs artifact: $artifact"
        return $artifact
    }

    Remove-Item -Path $artifact -Force -ErrorAction SilentlyContinue
    Remove-Item -Path "$artifact.sha256" -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $hashPath -Force -ErrorAction SilentlyContinue

    if ($DownloadFromRuntimeRelease) {
        Write-Step "Downloading managed WSL distro artifact from runtime release"
        $manifestUrl = Get-RuntimeManifestUrl
        $assetUrl = $null
        $expectedHash = $null

        try {
            $manifest = Invoke-RestMethod -Uri $manifestUrl
            if ($manifest.windows_wsl_rootfs_url) {
                $assetUrl = "$($manifest.windows_wsl_rootfs_url)".Trim()
            }
            if ($manifest.windows_wsl_rootfs_sha256) {
                $expectedHash = Get-Sha256FromText -Text "$($manifest.windows_wsl_rootfs_sha256)"
            }
        } catch {
            Write-Warning "Failed to read runtime manifest at ${manifestUrl}: $($_.Exception.Message). Falling back to default Windows rootfs asset name."
        }

        if ([string]::IsNullOrWhiteSpace($assetUrl)) {
            $assetUrl = Get-DefaultRootfsAssetUrl
        }

        Download-File -Url $assetUrl -DestinationPath $artifact
        if (-not (Test-FileNonEmpty $artifact)) {
            throw "Downloaded Windows rootfs artifact is missing or empty: $assetUrl"
        }

        if (-not $expectedHash) {
            try {
                $sidecarPath = "$artifact.sha256.download"
                Download-File -Url "$assetUrl.sha256" -DestinationPath $sidecarPath
                $expectedHash = Get-Sha256FromText -Text (Get-Content -Path $sidecarPath -Raw)
                Remove-Item -Path $sidecarPath -Force -ErrorAction SilentlyContinue
            } catch {
                Write-Warning "Failed to download Windows rootfs SHA-256 sidecar: $($_.Exception.Message). Computing hash locally."
            }
        }
    } else {
        Write-Step "Preparing managed WSL distro artifact"
        Assert-WslBaseDistroPresent

        $baseDistro = Get-WslBaseDistroName
        & wsl --export $baseDistro $artifact
        if ($LASTEXITCODE -ne 0 -or -not (Test-FileNonEmpty $artifact)) {
            throw "Failed exporting base WSL distro '$baseDistro' to $artifact"
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($expectedHash)) {
        $actualHash = (Get-FileHash -Path $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $expectedHash.ToLowerInvariant()) {
            throw "SHA-256 mismatch for $artifact. Expected $expectedHash, got $actualHash"
        }
    }

    Write-WslArtifactHashes -ArtifactPath $artifact -ExpectedHash $expectedHash
    return $artifact
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir ".."))
Set-Location $ProjectRoot

$RuntimeDir = Join-Path $ProjectRoot "src-tauri/resources/runtime"
$ResourcesBinDir = Join-Path $ProjectRoot "src-tauri/resources/bin"
$ResourcesShareLimaDir = Join-Path $ProjectRoot "src-tauri/resources/share/lima"

Write-Host "Preparing Entropic Windows release resources..."
Write-Host "Project root: $ProjectRoot"

Write-Step "Preparing required resource paths"
New-Item -ItemType Directory -Force -Path $ResourcesBinDir | Out-Null
New-Item -ItemType Directory -Force -Path $ResourcesShareLimaDir | Out-Null
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null

# These deterministic markers keep Tauri resource globs valid on Windows-only builds.
Ensure-File -Path (Join-Path $ResourcesBinDir "windows-release-placeholder.txt") -Content "windows placeholder`n"
Ensure-File -Path (Join-Path $ResourcesShareLimaDir "windows-release-placeholder.txt") -Content "windows placeholder`n"
Ensure-File -Path (Join-Path $RuntimeDir "windows-release-placeholder.txt") -Content "windows placeholder`n"

$artifact = Ensure-WslRuntimeArtifacts

Write-Step "Prepared Windows release resources"
Write-Host "Managed WSL rootfs: $artifact"
Write-Host "Managed WSL rootfs hash: $artifact.sha256"
Write-Host "Runtime hash alias: $(Join-Path $RuntimeDir "entropic-runtime.sha256")"
