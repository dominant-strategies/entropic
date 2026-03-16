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

function Convert-ToWslPath([string]$WindowsPath) {
    $full = [System.IO.Path]::GetFullPath($WindowsPath)
    if ($full -match "^[A-Za-z]:\\") {
        $drive = $full.Substring(0, 1).ToLowerInvariant()
        $rest = $full.Substring(2).Replace("\", "/")
        return "/mnt/$drive$rest"
    }
    throw "Cannot convert path to WSL form: $WindowsPath"
}

function Invoke-DistroRootBash([string]$Name, [string]$Script) {
    $tempDir = Join-Path $RuntimeRoot "bootstrap-scripts"
    New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

    $tempPath = Join-Path $tempDir ("bootstrap-" + [guid]::NewGuid().ToString("N") + ".sh")
    $encoding = [System.Text.UTF8Encoding]::new($false)
    $normalized = ($Script -replace "`r`n", "`n").TrimEnd() + "`n"
    [System.IO.File]::WriteAllText($tempPath, $normalized, $encoding)

    try {
        $tempPathWsl = Convert-ToWslPath $tempPath
        & wsl -d $Name --user root --exec bash $tempPathWsl
        return $LASTEXITCODE
    } finally {
        Remove-Item -Path $tempPath -Force -ErrorAction SilentlyContinue
    }
}

function Test-DockerResponsive([string]$Name) {
    $probe = @(
        "if ! command -v docker >/dev/null 2>&1; then"
        "  exit 42"
        "fi"
        "if command -v curl >/dev/null 2>&1; then"
        "  timeout 10 curl -fsS --unix-socket /var/run/docker.sock http://localhost/_ping >/dev/null 2>&1"
        "else"
        "  timeout 10 env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock docker version >/dev/null 2>&1"
        "fi"
    ) -join "`n"

    & wsl -d $Name --user root --exec bash -lc $probe *> $null
    return $LASTEXITCODE
}

function Start-DevDockerDaemon([string]$Name) {
    $startCommand = @(
        'set -euo pipefail'
        'if ! command -v docker >/dev/null 2>&1; then'
        '  exit 42'
        'fi'
        'if command -v systemctl >/dev/null 2>&1; then'
        '  systemctl enable docker >/dev/null 2>&1 || true'
        '  systemctl start docker >/dev/null 2>&1 || true'
        'fi'
        'if command -v service >/dev/null 2>&1; then'
        '  service docker start >/dev/null 2>&1 || true'
        'fi'
        'if [ ! -S /var/run/docker.sock ]; then'
        '  mkdir -p /run /var/log'
        '  nohup dockerd >/var/log/dockerd.log 2>&1 &'
        'fi'
        'i=0'
        'while [ "$i" -lt 30 ]; do'
        '  if env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock docker info >/dev/null 2>&1; then'
        '    exit 0'
        '  fi'
        '  i=$((i+1))'
        '  sleep 2'
        'done'
        'tail -n 120 /var/log/dockerd.log 2>/dev/null || true'
        'exit 1'
    ) -join "`n"

    Invoke-DistroRootBash $Name $startCommand
    return $LASTEXITCODE
}

function Bootstrap-DevDocker([string]$Name) {
    Write-Host "[wsl] Bootstrapping Docker inside $Name..."
    $bootstrapCommand = @(
        'set -euo pipefail'
        'export DEBIAN_FRONTEND=noninteractive'
        'if ! command -v apt-get >/dev/null 2>&1; then'
        '  echo "apt-get is required to install Docker in this distro." >&2'
        '  exit 1'
        'fi'
        'apt-get update'
        'apt-get install -y docker.io'
    ) -join "`n"

    Invoke-DistroRootBash $Name $bootstrapCommand
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to bootstrap Docker in '$Name'. Verify network access in the distro and inspect /var/log/dockerd.log."
    }

    Start-DevDockerDaemon $Name *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to bootstrap Docker in '$Name'. Verify network access in the distro and inspect /var/log/dockerd.log."
    }
}

function Ensure-DevDockerReady([string]$Name) {
    $probeExit = Test-DockerResponsive $Name
    if ($probeExit -eq 0) {
        return
    }

    if ($probeExit -eq 42) {
        Bootstrap-DevDocker $Name
        $probeExit = Test-DockerResponsive $Name
        if ($probeExit -eq 0) {
            Write-Host "[wsl] Docker in $Name is ready after bootstrap."
            return
        }
    }

    Write-Host "[wsl] Docker in $Name is unresponsive. Restarting the distro..."
    Stop-Distro $Name
    Start-Distro $Name

    $retryExit = Start-DevDockerDaemon $Name
    if ($retryExit -eq 0) {
        Write-Host "[wsl] Docker in $Name recovered after distro restart."
        return
    }

    if ($retryExit -eq 42) {
        Bootstrap-DevDocker $Name
        $retryExit = Test-DockerResponsive $Name
        if ($retryExit -eq 0) {
            Write-Host "[wsl] Docker in $Name recovered after bootstrap."
            return
        }
    }

    throw "Docker in '$Name' is still unresponsive after restarting the distro. Run 'pnpm.cmd dev:wsl:prune:dev' if the runtime is corrupted, or restart WSL and retry."
}

function Ensure-DevBuildToolchainReady([string]$Name) {
    $probeCommand = @(
        'if ! command -v node >/dev/null 2>&1; then'
        '  exit 41'
        'fi'
        'node_major=$(node -v 2>/dev/null | sed ''s/^v//; s/\..*$//'' || echo 0)'
        'if [ "${node_major:-0}" -lt 22 ]; then'
        '  exit 44'
        'fi'
        'if ! command -v pnpm >/dev/null 2>&1; then'
        '  exit 43'
        'fi'
        'pnpm --version >/dev/null 2>&1'
        'if ! command -v cmake >/dev/null 2>&1; then'
        '  exit 45'
        'fi'
    ) -join "`n"

    Invoke-DistroRootBash $Name $probeCommand *> $null
    if ($LASTEXITCODE -eq 0) {
        return
    }

    Write-Host "[wsl] Bootstrapping Linux build toolchain inside $Name..."
    $bootstrapCommand = @(
        'set -euo pipefail'
        'export DEBIAN_FRONTEND=noninteractive'
        'if ! command -v apt-get >/dev/null 2>&1; then'
        '  echo "apt-get is required to install the build toolchain in this distro." >&2'
        '  exit 1'
        'fi'
        'apt-get update'
        'apt-get install -y ca-certificates curl gnupg build-essential cmake git python3'
        'need_node=1'
        'if command -v node >/dev/null 2>&1; then'
        '  node_major=$(node -v 2>/dev/null | sed ''s/^v//; s/\..*$//'' || echo 0)'
        '  if [ "${node_major:-0}" -ge 22 ]; then'
        '    need_node=0'
        '  fi'
        'fi'
        'if [ "$need_node" -eq 1 ]; then'
        '  mkdir -p /etc/apt/keyrings'
        '  if [ ! -f /etc/apt/keyrings/nodesource.gpg ]; then'
        '    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg'
        '  fi'
        '  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list'
        '  apt-get update'
        '  apt-get install -y nodejs'
        'fi'
        'if ! command -v pnpm >/dev/null 2>&1 || ! pnpm --version >/dev/null 2>&1; then'
        '  if command -v corepack >/dev/null 2>&1; then'
        '    corepack enable'
        '    corepack prepare pnpm@10.23.0 --activate'
        '  else'
        '    npm install -g pnpm@10.23.0'
        '  fi'
        'fi'
    ) -join "`n"

    Invoke-DistroRootBash $Name $bootstrapCommand
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to bootstrap the Linux build toolchain in '$Name'. Verify network access in the distro and retry."
    }

    Invoke-DistroRootBash $Name $probeCommand *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "Linux build toolchain is still incomplete in '$Name' after bootstrap."
    }
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
                Ensure-DevBuildToolchainReady $target.Name
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
