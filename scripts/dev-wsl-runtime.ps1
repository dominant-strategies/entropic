param(
    [Parameter(Position = 0)]
    [string]$Command = "help",

    [Parameter(Position = 1)]
    [string]$Mode = "all",

    [switch]$Force
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$DevDistro = if ($env:ENTROPIC_WSL_DEV_DISTRO) { $env:ENTROPIC_WSL_DEV_DISTRO } else { "entropic-dev" }
$ProdDistro = if ($env:ENTROPIC_WSL_PROD_DISTRO) { $env:ENTROPIC_WSL_PROD_DISTRO } else { "entropic-prod" }
$BaseDistro = if ($env:ENTROPIC_WSL_BASE_DISTRO) { $env:ENTROPIC_WSL_BASE_DISTRO } else { "Ubuntu" }
$LocalAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { (Join-Path $HOME "AppData\Local") }
$RuntimeRoot = Join-Path $LocalAppData "Entropic\runtime\wsl"
$SeedDir = Join-Path $RuntimeRoot "seed"

function Write-Usage {
    @"
Usage: ./scripts/dev-wsl-runtime.ps1 <command> [mode] [--Force]

Commands:
  status [mode]     Show runtime distro status (registered/running/version)
  ensure [mode]     Create missing distros by cloning base distro ($BaseDistro)
  start [mode]      Ensure + start runtime distros
  stop [mode]       Stop runtime distros
  prune [mode]      Unregister runtime distros and delete local runtime dirs
  shell <mode>      Open interactive shell in runtime distro (dev or prod)
  help              Show this help

Modes:
  dev | prod | all

Environment overrides:
  ENTROPIC_WSL_BASE_DISTRO  (default: Ubuntu)
  ENTROPIC_WSL_DEV_DISTRO   (default: entropic-dev)
  ENTROPIC_WSL_PROD_DISTRO  (default: entropic-prod)
"@
}

function Assert-WslAvailable {
    try {
        & wsl --version *> $null
    } catch {
        throw "WSL is not available. Install it first: wsl --install -d Ubuntu"
    }
}

function Get-Targets([string]$SelectedMode) {
    switch ($SelectedMode.ToLowerInvariant()) {
        "dev" { return @([pscustomobject]@{ Mode = "dev"; Name = $DevDistro }) }
        "prod" { return @([pscustomobject]@{ Mode = "prod"; Name = $ProdDistro }) }
        "all" {
            return @(
                [pscustomobject]@{ Mode = "dev"; Name = $DevDistro },
                [pscustomobject]@{ Mode = "prod"; Name = $ProdDistro }
            )
        }
        default { throw "Invalid mode '$SelectedMode'. Use dev, prod, or all." }
    }
}

function Get-RegisteredDistros {
    $names = @()
    try {
        $lines = & wsl -l -q 2>$null
        if ($LASTEXITCODE -ne 0) {
            return @()
        }
        foreach ($line in $lines) {
            $name = ("$line" -replace "`0", "").Trim()
            if (
                -not [string]::IsNullOrWhiteSpace($name) -and
                $name -ne "Access is denied." -and
                -not $name.StartsWith("Error code:") -and
                -not $name.StartsWith("Wsl/")
            ) {
                $names += $name
            }
        }
    } catch {
        return @()
    }
    return $names
}

function Get-DistroStates {
    $map = @{}
    try {
        $lines = & wsl -l -v 2>$null
        if ($LASTEXITCODE -ne 0) {
            return @{}
        }
        foreach ($line in $lines) {
            $text = ("$line" -replace "`0", "").Trim()
            if ($text -match "^(NAME|The operation completed successfully)") {
                continue
            }
            if ($text -match "^\*?\s*(\S+)\s+(\S+)\s+(\d+)$") {
                $map[$Matches[1]] = [pscustomobject]@{
                    State = $Matches[2]
                    Version = $Matches[3]
                }
            }
        }
    } catch {
        return @{}
    }
    return $map
}

function Test-DistroReachable([string]$Name) {
    try {
        & wsl -d $Name --exec sh -lc "true" *> $null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

function Ensure-BaseDistroRegistered {
    $registered = Get-RegisteredDistros
    if ($registered -notcontains $BaseDistro) {
        throw "Base distro '$BaseDistro' is not installed. Install it first: wsl --install -d $BaseDistro"
    }
}

function Get-DefaultDistroCandidate {
    $registered = Get-RegisteredDistros
    if ($registered -contains $BaseDistro) {
        return $BaseDistro
    }

    foreach ($name in $registered) {
        if ($name -in @($DevDistro, $ProdDistro, "docker-desktop", "docker-desktop-data")) {
            continue
        }
        return $name
    }

    return $null
}

function Set-BaseDistroAsDefault {
    $candidate = Get-DefaultDistroCandidate
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        Write-Warning "Could not determine a non-runtime default WSL distro. Docker Desktop may still try to integrate the runtime distro."
        return
    }
    try {
        & wsl --set-default $candidate *> $null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "[wsl] Default distro set to $candidate."
        } else {
            Write-Warning "Failed to set default WSL distro to '$candidate'. Docker Desktop may still try to integrate the runtime distro."
        }
    } catch {
        Write-Warning "Failed to set default WSL distro to '$candidate': $($_.Exception.Message)"
    }
}

function Get-DistroInstallPath([string]$Name) {
    return (Join-Path $RuntimeRoot $Name)
}

function Ensure-Distro([string]$Name) {
    $registered = Get-RegisteredDistros
    if ($registered -contains $Name) {
        Write-Host "[wsl] $Name already registered."
        return
    }

    if (Test-DistroReachable $Name) {
        Write-Host "[wsl] $Name already reachable."
        return
    }

    Ensure-BaseDistroRegistered

    New-Item -ItemType Directory -Force -Path $SeedDir | Out-Null
    $seedTar = Join-Path $SeedDir "$BaseDistro-seed.tar"

    if ($Force -or -not (Test-Path $seedTar)) {
        Write-Host "[wsl] Exporting base distro '$BaseDistro' to seed tar..."
        & wsl --export $BaseDistro $seedTar
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to export base distro '$BaseDistro'."
        }
    }

    $installPath = Get-DistroInstallPath $Name
    New-Item -ItemType Directory -Force -Path $installPath | Out-Null

    Write-Host "[wsl] Importing runtime distro '$Name'..."
    & wsl --import $Name $installPath $seedTar --version 2
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to import distro '$Name'."
    }
}

function Start-Distro([string]$Name) {
    Write-Host "[wsl] Starting $Name..."
    & wsl -d $Name --exec sh -lc "true" *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to start distro '$Name'."
    }
}

function Test-DockerResponsive([string]$Name) {
    $probe = @(
        "if ! command -v docker >/dev/null 2>&1; then"
        "  exit 42"
        "fi"
        "if command -v curl >/dev/null 2>&1; then"
        "  timeout 10 curl -fsS --unix-socket /var/run/docker.sock http://localhost/_ping >/dev/null"
        "else"
        "  timeout 10 env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock docker version >/dev/null 2>&1"
        "fi"
    ) -join "`n"

    & wsl -d $Name --user root --exec bash -lc $probe *> $null
    return $LASTEXITCODE
}

function Ensure-DevDockerReady([string]$Name) {
    $probeExit = Test-DockerResponsive $Name
    if ($probeExit -eq 0) {
        return
    }

    if ($probeExit -eq 42) {
        throw "Docker is not installed in '$Name'. Recreate the dev runtime or install Docker in the distro."
    }

    Write-Host "[wsl] Docker in $Name is unresponsive. Restarting the distro..."
    Stop-Distro $Name
    Start-Distro $Name

    $repairCommand = @(
        "if command -v systemctl >/dev/null 2>&1; then"
        "  systemctl is-active docker >/dev/null 2>&1 || systemctl start docker >/dev/null 2>&1 || true"
        "fi"
    ) -join "`n"
    & wsl -d $Name --user root --exec bash -lc $repairCommand *> $null

    $retryExit = Test-DockerResponsive $Name
    if ($retryExit -eq 0) {
        Write-Host "[wsl] Docker in $Name recovered after distro restart."
        return
    }

    if ($retryExit -eq 42) {
        throw "Docker disappeared from '$Name' after restart. Recreate the dev runtime or install Docker in the distro."
    }

    throw "Docker in '$Name' is still unresponsive after restarting the distro. Run 'pnpm.cmd dev:wsl:prune:dev' if the runtime is corrupted, or restart WSL and retry."
}

function Stop-Distro([string]$Name) {
    Write-Host "[wsl] Stopping $Name..."
    & wsl --terminate $Name *> $null
}

function Prune-Distro([string]$Name) {
    $registered = Get-RegisteredDistros
    if ($registered -contains $Name) {
        Write-Host "[wsl] Unregistering $Name..."
        & wsl --terminate $Name *> $null
        & wsl --unregister $Name
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to unregister distro '$Name'."
        }
    } else {
        Write-Host "[wsl] $Name not registered; skipping unregister."
    }

    $installPath = Get-DistroInstallPath $Name
    if (Test-Path $installPath) {
        Write-Host "[wsl] Removing $installPath..."
        Remove-Item -Recurse -Force $installPath
    }
}

function Show-Status([object[]]$Targets) {
    $registered = Get-RegisteredDistros
    $states = Get-DistroStates

    $rows = @()
    foreach ($target in $Targets) {
        $name = $target.Name
        $installPath = Get-DistroInstallPath $name
        $isRegistered = $registered -contains $name
        $state = "N/A"
        $version = "N/A"
        if ($states.ContainsKey($name)) {
            $state = $states[$name].State
            $version = $states[$name].Version
        }

        $rows += [pscustomobject]@{
            Mode = $target.Mode
            Distro = $name
            Registered = if ($isRegistered) { "yes" } else { "no" }
            State = $state
            Version = $version
            Path = $installPath
        }
    }

    Write-Host "[wsl] Base distro: $BaseDistro"
    Write-Host "[wsl] Runtime root: $RuntimeRoot"
    $rows | Format-Table -AutoSize
}

Assert-WslAvailable
$targets = Get-Targets $Mode
$cmd = $Command.ToLowerInvariant()

switch ($cmd) {
    "status" {
        Show-Status $targets
    }
    "ensure" {
        Set-BaseDistroAsDefault
        foreach ($target in $targets) {
            Ensure-Distro $target.Name
        }
        Show-Status $targets
    }
    "start" {
        Set-BaseDistroAsDefault
        foreach ($target in $targets) {
            try {
                Ensure-Distro $target.Name
            } catch {
                Write-Warning "Failed to verify or import '$($target.Name)': $($_.Exception.Message). Trying to start the distro directly."
            }
            Start-Distro $target.Name
            if ($target.Mode -eq "dev") {
                Ensure-DevDockerReady $target.Name
            }
        }
        Show-Status $targets
    }
    "stop" {
        foreach ($target in $targets) {
            Stop-Distro $target.Name
        }
        Show-Status $targets
    }
    "prune" {
        foreach ($target in $targets) {
            Prune-Distro $target.Name
        }
        Show-Status $targets
    }
    "shell" {
        if ($Mode -eq "all") {
            throw "shell requires a single mode: dev or prod"
        }
        $target = $targets[0]
        Ensure-Distro $target.Name
        Write-Host "[wsl] Opening shell in $($target.Name)..."
        & wsl -d $target.Name
    }
    "help" {
        Write-Usage
    }
    default {
        throw "Unknown command '$Command'. Use 'help' for usage."
    }
}
