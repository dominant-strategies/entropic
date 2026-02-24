# Windows Runtime Security Architecture (Colima-Parity)

## Status
- Draft v1
- Scope: Entropic desktop app runtime on Windows
- Goal: security parity with existing macOS Colima isolation model

## Design Principles
- Isolation first: Entropic runtime must not depend on shared Docker Desktop context by default.
- Explicit trust boundaries: every host <-> runtime crossing is authenticated and allowlisted.
- Fail closed: if isolated runtime is unavailable, do not silently fall back to shared engine.
- Least privilege: all host files, pipes, and processes run with minimum required permissions.
- Deterministic environments: dev and prod runtime state are strictly separated.

## Security Invariants (Parity Targets)
1. Runtime daemon isolation from user/global Docker contexts.
2. No implicit fallback to shared `\\\\.\\pipe\\docker_engine`.
3. Localhost-only gateway exposure (`127.0.0.1:19789`).
4. Hardened runtime container (`--cap-drop=ALL`, `--read-only`, `--security-opt no-new-privileges`, non-root user, tmpfs).
5. Per-install/session gateway token required for container control plane access.
6. Separate dev and prod runtime state and credentials.
7. Runtime artifacts are signed/hash-verified before use.
8. Secret material is memory-first and never persisted in plaintext by default.

## Architecture Overview

### Host Components
- `Entropic.exe` (Tauri app): UI + orchestration.
- `entropic-runtime-manager.exe`: privileged helper process for WSL lifecycle, pipe ACL management, and health checks.
- Host storage root:
  - `%LOCALAPPDATA%\\Entropic\\runtime\\dev`
  - `%LOCALAPPDATA%\\Entropic\\runtime\\prod`

### Manager Execution Model (v1 Decision)
- v1 runs `entropic-runtime-manager.exe` in user context (same logged-in user as `Entropic.exe`).
- Rationale:
  - keeps same-user SID trust boundary tight
  - avoids unnecessary service privilege surface
  - aligns with app-scoped runtime lifecycle
- Service mode is deferred unless a hard requirement emerges for runtime persistence across user logoff.

### Runtime Components (WSL2)
- Two dedicated WSL distributions:
  - `entropic-dev`
  - `entropic-prod`
- Each distro runs:
  - Docker Engine (rootful in distro, isolated from host/global engine)
  - Entropic runtime containers and networks

### Host <-> Runtime Control Plane
- Entropic-owned named pipes (host side):
  - `\\\\.\\pipe\\entropic-docker-dev`
  - `\\\\.\\pipe\\entropic-docker-prod`
- `entropic-runtime-manager` proxies pipe requests to per-distro Docker socket:
  - `/var/run/docker.sock` inside `entropic-dev`
  - `/var/run/docker.sock` inside `entropic-prod`
- Entropic app always targets these Entropic-owned pipes by mode.

## Trust Boundaries

### Boundary A: App -> Runtime Manager
- Local IPC only.
- Require per-launch nonce from app to manager.
- Manager accepts commands only from same-user SID and validated parent process.
- Manager executable must be code-signed.

### Boundary B: Manager -> Named Pipe Clients
- Pipe ACLs deny `Everyone`.
- Allow:
  - current user SID (read/write)
  - local system (full)
- Deny:
  - `ANONYMOUS LOGON`
  - `NETWORK`
  - `BUILTIN\\Users` broad access
- Use strict SDDL and validate ACL at startup.
- Create pipes with final DACL atomically (`CreateNamedPipe` + `SECURITY_ATTRIBUTES`).
- Do not create pipe first and apply ACL after creation (no TOCTOU window).

### Boundary C: Manager -> WSL Runtime
- Commands are allowlisted (`wsl.exe --install|--import|--distribution|--exec|--status|--version|--set-default-version` with fixed args template).
- No arbitrary shell passthrough from UI.
- Disable WSL interop and broad host path mounts for runtime distros.
- Log full resolved allowlisted command on every invocation (with secret redaction).

## WSL Runtime Hardening

### Distro Configuration
- Disable Windows process interop in runtime distro:
  - `interop=false`
  - `appendWindowsPath=false`
- Disable automatic host drive automount where feasible for runtime distro workflows.
- Use separate distro filesystem per mode.
- Run Docker daemon with controlled config (`daemon.json`) and no remote TCP API.
- Explicitly document that WSL2 distros share one kernel; dev/prod split is strong user-space/storage isolation, not kernel isolation.

### File Permissions and ACLs
- Runtime root ACL on host:
  - Owner: current user + SYSTEM
  - No inheritance from parent where unsafe
  - Deny non-owner local users
- Temp env files (if used) must be:
  - random filename
  - owner-only ACL
  - deleted immediately after `docker run`

### Network Controls
- Gateway binding remains loopback-only:
  - host published: `127.0.0.1:19789:18789`
- Block non-loopback binds in runtime manager policy.
- Optional Windows Firewall policy: deny inbound to runtime helper except local process access.

## Runtime Lifecycle

### First-Time Setup
1. Verify app signature and manager signature.
2. Create runtime roots (`dev`/`prod`) with secure ACLs.
3. Import or initialize WSL distros from signed base rootfs.
4. Install/start Docker engine in each distro.
5. Create named pipes and enforce ACL.
6. Download runtime image manifest and verify signature/hash.
7. Load `openclaw-runtime` image into target distro daemon.

### Bootstrap Flow (Official WSL Install + Entropic Distro Bundle)
- Policy: Entropic does not attach to user-provided WSL distros ("BYO WSL" unsupported).
- Policy: Entropic bootstraps WSL from official Microsoft delivery paths, then imports Entropic-managed distros.

1. Preflight checks (bootstrap gate)
   - Verify Windows version/build and virtualization capability.
   - Verify running context and request elevation only for WSL feature/bootstrap steps.
   - If `wsl --version` reports supported WSL, skip base install and continue.

2. Install WSL platform (official path only)
   - Run elevated `wsl --install --no-distribution` when WSL is missing.
   - If reboot is required, persist bootstrap state and resume automatically after restart.
   - Enforce WSL2 default via `wsl --set-default-version 2`.
   - Re-verify with `wsl --status` and `wsl --version`.

3. Import Entropic distro artifacts
   - Ship signed, versioned Entropic runtime base artifact (`.wsl` preferred, `.tar` fallback).
   - Verify artifact signature/hash before import.
   - Preferred install path: `wsl --install --from-file <artifact> --name entropic-prod --location <prod-root>`.
   - Install second isolated distro for dev with separate name and location.
   - Compatibility fallback: if `--from-file` is unavailable, use `wsl --import ... --version 2`.

4. Post-import hardening
   - Apply distro hardening (`interop=false`, `appendWindowsPath=false`, automount restrictions).
   - Install/configure Docker daemon with Entropic-pinned settings.
   - Stamp distro identity/attestation marker for daemon identity checks.
   - Register mode-specific pipe endpoints and ACL validation.

5. Bootstrap completion
   - Execute health checks (WSL distro status, Docker daemon health, pipe ACL integrity).
   - Mark runtime as `ready`; otherwise remain fail-closed and surface remediation UI.

### Colima-Like UX Contract (Windows)
- One-click runtime bootstrap from Entropic UI (no manual WSL shell steps).
- One mode selector (`dev` / `prod`) with explicit active-mode indicator.
- Same control semantics as Colima flow:
  - `Start` boots only selected mode runtime.
  - `Stop` stops only selected mode runtime.
  - `Reset mode` deletes and re-imports only selected mode distro/state.
- Runtime details are abstracted behind Entropic health states:
  - `Starting`, `Ready`, `Degraded`, `Needs reboot`, `Repair required`.
- No silent cross-mode operations: users cannot accidentally operate on `prod` while in `dev`.
- Escape hatch remains explicit and off by default.

### Start (Per Mode)
1. Resolve mode (`dev` or `prod`).
2. Connect only to `\\\\.\\pipe\\entropic-docker-{mode}`.
3. Verify daemon identity marker in target distro.
4. Verify runtime image digest matches expected manifest.
5. Start container with hardened flags.
6. Health-check gateway and verify expected token handshake.

### Stop/Prune
- Stop only mode-specific containers.
- Prune only mode-specific images/networks/volumes.
- Never touch global Docker Desktop resources unless explicit escape hatch is enabled.

## Compatibility Mapping (Colima -> Windows)

| Current Colima Model | Windows Equivalent |
| --- | --- |
| Isolated Colima home per mode | Isolated WSL distro + host runtime root per mode |
| Colima socket pinning | Entropic-owned named pipes pinning |
| `ENTROPIC_RUNTIME_ALLOW_DOCKER_DESKTOP` escape hatch | `ENTROPIC_RUNTIME_ALLOW_SHARED_DOCKER=1` escape hatch |
| Runtime VM lifecycle via Colima/Lima | Runtime distro lifecycle via WSL2 manager |
| Docker host resolution from Entropic paths only | Docker host resolution from Entropic pipes only |
| Colima bootstrap within app flow | Official WSL bootstrap + Entropic distro import in app flow |

## Escape Hatch Policy
- Disabled by default.
- Compile-time gated in release artifacts:
  - production builds must compile with shared-engine escape hatch disabled
  - internal/dev builds may enable with explicit build flag
- If enabled, allow shared Docker Desktop engine only for explicit troubleshooting.
- UI must show persistent warning:
  - "Shared Docker mode is less isolated and not recommended."
- All logs and telemetry must mark session as `shared_runtime_mode=true`.

## Secrets and Identity
- Keep API keys in memory wherever possible.
- If env-file transfer is required:
  - owner-only ACL
  - short TTL
  - delete on success/failure path
- Move persistent provider credentials to OS secure store (Windows Credential Manager/DPAPI-backed store).
- Rotate gateway token on app restart and runtime reset.

## Supply Chain and Artifact Integrity
- Runtime manifest is signed.
- `openclaw-runtime.tar.gz` and scanner image tar have required SHA-256 match before load.
- Reject unsigned or mismatched artifacts.
- Pin expected OpenClaw commit in manifest metadata.

### WSL Base Image Patching Strategy
- Preferred update path: immutable re-import from signed, versioned rootfs artifact.
- In-place package patching is emergency-only and must set `runtime_drifted=true` audit marker.
- After emergency in-place patching, force reconcile to next signed rootfs on next maintenance window.
- Keep per-mode base-image version recorded in local runtime metadata for audit.

## Telemetry and Audit
- Log security-relevant events:
  - pipe ACL mismatch
  - fallback mode enabled
  - manifest verification failure
  - daemon identity mismatch
  - non-loopback bind attempt blocked
- Log every allowlisted `wsl.exe` command invocation after argument resolution (redacted).
- Keep logs local by default and redact secrets.

## Health and Liveness
- App and runtime manager use heartbeat protocol (request/response with monotonic timestamp).
- UI surfaces proactive degraded state when heartbeat misses threshold.
- Heartbeat failure must include actionable state:
  - manager down
  - pipe unavailable
  - WSL distro not running
  - Docker daemon not healthy

## Threat Model Coverage

### In-Scope
- Another local user process attempting to use Entropic Docker control endpoint.
- Accidental fallback to shared Docker Desktop daemon.
- Host path overexposure into runtime.
- Runtime image tampering.
- Token leakage through temp files/logging.

### Out-of-Scope
- Fully compromised local admin account.
- Kernel-level host compromise.
- Cross-distro compromise via shared WSL2 kernel vulnerability (acknowledged residual risk).
- Supply-chain compromise of trusted signing keys (handled operationally, not by local architecture alone).

## Acceptance Criteria (Must Pass)
1. Entropic starts and runs with Docker Desktop installed but never uses `\\\\.\\pipe\\docker_engine` by default.
2. Dev and prod mode use separate distros, images, volumes, and credentials.
3. Container launch flags match hardened policy exactly.
4. External host cannot reach gateway port; only localhost can.
5. Runtime image load fails if hash/signature mismatch.
6. Escape hatch mode is explicit, logged, and user-visible.
7. Security regression suite passes on Windows 11 clean machine and enterprise-managed machine.
8. Dev-mode operations are not observable from prod mode and vice versa (container/network/volume enumeration scoped per mode).
9. Named pipe security test verifies no ACL race window exists at creation time.
10. App surfaces runtime degraded state within heartbeat SLA when manager/runtime path is unhealthy.
11. Fresh Windows machine without WSL can complete bootstrap to `ready` through Entropic UI, including reboot-resume path.
12. Runtime manager never attaches to user-created distros; only Entropic-managed distro names are accepted.

## Implementation Plan

### Phase 0: Bootstrap
- Build bootstrap preflight + elevation/resume flow for WSL install.
- Implement official WSL install path and validation (`--install --no-distribution`, `--status`, `--version`).
- Implement Entropic distro import pipeline (`--install --from-file` with `--import` fallback).

### Phase 1: Foundations
- Add `entropic-runtime-manager` with strict command allowlist.
- Implement named pipe proxy + ACL enforcement.
- Add mode-aware pipe resolution in Rust runtime layer.

### Phase 2: Isolated Runtime
- Provision/import `entropic-dev` and `entropic-prod` WSL distros.
- Configure Docker engine and hardening defaults in each distro.
- Wire start/stop/prune flows to mode-scoped distro operations.

### Phase 3: Security Controls
- Enforce artifact signature/hash verification.
- Enforce localhost bind policy.
- Add secure secret transport (short-lived env-file or stdin injection path).

### Phase 4: Productization
- Windows setup UX and recovery UX.
- CI pipeline for Windows build and security regression tests.
- Documentation and runbooks for support and incident handling.

## Open Questions
1. Do we require Hyper-V isolation controls beyond WSL2 defaults for enterprise tier?
