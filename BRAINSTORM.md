# Zara - OpenClaw Desktop App

## Vision
A beautiful, Apple-like desktop app that lets anyone run OpenClaw with one click. No terminal, no Docker knowledge, no configuration files.

---

## Core Questions

### 1. What does "secure for normies" mean?
- No exposed ports to the network (localhost only)
- No raw API keys visible in UI
- Sandboxed execution environment
- Auto-updates with signed binaries
- Clear permission prompts ("Zara wants to access your microphone")

### 2. What's the runtime strategy?

**Option A: Bundled Node.js**
- Ship Node.js inside the .app bundle
- Pros: Works offline, predictable version
- Cons: Larger app size (~100MB+), need to update Node separately

**Option B: System Node.js (require install)**
- Check for Node, prompt to install if missing
- Pros: Smaller bundle
- Cons: Extra step, version mismatches, not "1-click"

**Option C: Compile to native binary**
- Use `bun build --compile` or `pkg` to create standalone binary
- Pros: True single binary, fast startup
- Cons: May not work for all OpenClaw features, dynamic requires

**Option D: Docker under the hood**
- Bundle Docker Desktop or use lightweight container runtime (Lima, Colima)
- Pros: Matches current deployment model, isolated
- Cons: Heavy dependency, Docker licensing issues

**Recommendation:** Start with Option A (bundled Node) or Option C (Bun compile). Avoid Docker for normie experience.

---

### 3. Tauri + React Architecture

```
Zara.app/
├── Contents/
│   ├── MacOS/
│   │   └── zara              # Tauri Rust binary
│   ├── Resources/
│   │   ├── openclaw/         # Bundled openclaw dist
│   │   ├── node/             # Bundled Node.js (if Option A)
│   │   └── assets/           # App icons, images
│   └── Info.plist
```

**Frontend (React + TypeScript)**
- Clean onboarding wizard
- Status dashboard (gateway running, channels connected)
- Channel configuration (Discord, Telegram, etc.)
- Logs viewer (pretty, not raw terminal)
- Settings panel

**Backend (Tauri/Rust)**
- Spawn and manage openclaw gateway process
- Handle IPC between React UI and openclaw
- System tray / menu bar integration
- Auto-launch on login
- Keychain integration for secrets

---

### 4. Onboarding Flow (Apple-like)

```
[Welcome to Zara]
     ↓
[Sign in with Claude] ← OAuth or session key
     ↓
[Choose your channels]
  ☐ Discord
  ☐ Telegram
  ☐ Slack
     ↓
[Connect Discord] ← Guided bot token setup
     ↓
[You're all set!] ← Gateway starts automatically
```

---

### 5. Security Considerations

| Concern | Solution |
|---------|----------|
| API keys in plaintext | Use macOS Keychain (Tauri has `tauri-plugin-stronghold` or native keychain access) |
| Gateway exposed to network | Force `--bind loopback`, hide from user |
| Unsigned binary warnings | Apple Developer ID signing + notarization |
| Auto-updates | Tauri updater with signed manifests |
| Subprocess escape | Run openclaw with dropped privileges, no shell access from UI |

---

### 6. Distribution

**DMG Contents:**
- Zara.app (drag to Applications)
- Optional: Uninstaller or "Move to Trash" instructions

**Signing & Notarization:**
- Requires Apple Developer account ($99/year)
- `codesign` + `notarytool` + `stapler`
- Without this: "App is damaged" or Gatekeeper blocks

**Auto-updates:**
- Tauri built-in updater
- Host update manifest on GitHub Releases or S3
- Delta updates for smaller downloads

---

### 7. MVP Feature Scope

**Phase 1 - MVP**
- [ ] Bundled openclaw + Node runtime
- [ ] Basic onboarding (Claude login)
- [ ] Start/stop gateway
- [ ] System tray with status
- [ ] Discord channel setup
- [ ] Signed + notarized DMG

**Phase 2 - Polish**
- [ ] More channels (Telegram, Slack)
- [ ] Pretty logs viewer
- [ ] Auto-updates
- [ ] Memory/context viewer
- [ ] Themes (light/dark)

**Phase 3 - Advanced**
- [ ] Multi-agent support
- [ ] Plugin marketplace
- [ ] Voice mode integration
- [ ] Mobile companion app

---

### 8. Open Questions

1. **Licensing** - Is OpenClaw MIT? Can we bundle and distribute?
2. **Claude auth** - OAuth flow or manual session key paste?
3. **Windows/Linux** - Tauri supports all, but focus Mac first?
4. **Name** - Zara? Something else?
5. **Pricing** - Free? Freemium? Paid?

---

### 9. Tech Stack Summary

| Layer | Technology |
|-------|------------|
| UI Framework | React 18 + TypeScript |
| Styling | Tailwind CSS or CSS Modules |
| Desktop Shell | Tauri 2.0 (Rust) |
| Runtime | Bundled Node.js or Bun binary |
| Agent Core | OpenClaw (as subprocess) |
| Secrets | macOS Keychain via Tauri plugin |
| Updates | Tauri Updater |
| Build | GitHub Actions |
| Distribution | DMG + notarization |

---

### 10. Competitors / Inspiration

- **Ollama** - Beautiful CLI + app for local LLMs
- **Docker Desktop** - How they bundle a complex runtime
- **Raycast** - Apple-like polish, fast, extensible
- **Linear** - Clean UI patterns
- **Arc Browser** - Onboarding excellence

---

## Next Steps

1. Validate runtime strategy (build a proof-of-concept with bundled openclaw)
2. Design onboarding flow mockups
3. Spike Tauri + React setup with process spawning
4. Test code signing + notarization pipeline
5. Define MVP scope and timeline

---

## Notes

_Add discussion notes here as we brainstorm..._

---

## Deep Dive: Why Docker is Required

Docker is required for hard isolation on non-technical users' machines. It provides a consistent, hermetic runtime boundary so the agent cannot access arbitrary host resources, and any compromise or misbehavior is contained within the container. This also gives us a reproducible dependency graph (glibc, node/bun, system libs) without leaking into the user's system, and a clean lifecycle for start/stop, updates, and cleanup.

**Key reasons (non-negotiable):**
- Strong process and filesystem isolation from the host
- Consistent runtime and dependency pinning across machines
- Safe defaults: no host networking exposure by default
- Clean uninstall surface (remove container + images)
- Future policy enforcement (resource limits, seccomp/apparmor where available)

If Docker adds UX friction, we should solve that in onboarding (e.g., guided install or bundled runtime), not by removing isolation.

After reviewing openclaw source code, **Docker is not optional** - it's a security requirement.

### What OpenClaw Uses Docker For

1. **Sandbox Containers** (`src/agents/sandbox/docker.ts`)
   - AI-generated bash commands run inside a container, NOT on host
   - Read-only rootfs, dropped capabilities, seccomp profiles
   - Memory/CPU limits, PID limits
   - Network isolation (can be set to `none`)

2. **Browser Sandbox** (`src/config/types.sandbox.ts`)
   - Headless Chrome runs in a container
   - CDP/VNC ports exposed only to container network

### Without Docker = Security Nightmare
If we skip Docker, the AI can:
- `rm -rf /`
- Read ~/.ssh/id_rsa
- Install malware
- Exfiltrate data

**Conclusion: We must ship a container runtime.**

---

## Options for Shipping Containers on macOS

### Option 1: Require Docker Desktop (Current State)
- User installs Docker Desktop separately
- Zara checks for Docker, prompts to install if missing
- **Pros:** Battle-tested, familiar
- **Cons:** Not 1-click, Docker Desktop licensing ($), 700MB+ install

### Option 2: Bundle Colima + Docker CLI
- Colima is MIT licensed, uses Apple Virtualization.framework
- Bundle `colima` + `docker` CLI binaries in .app
- First launch: `colima start` (downloads ~300MB Linux VM)
- **Pros:** Open source, no licensing issues
- **Cons:** First-run download, VM boot time (~5-10s)

### Option 3: Bundle Lima + nerdctl (Docker-compatible)
- Lima = lightweight Linux VMs
- nerdctl = containerd CLI (Docker-compatible)
- Same tradeoffs as Colima
- **Pros:** Slightly more lightweight
- **Cons:** Less Docker-compatible edge cases

### Option 4: Bundle OrbStack (Partnership)
- OrbStack is fast, lightweight, polished
- Would need commercial partnership
- **Pros:** Best UX, fastest
- **Cons:** Commercial dependency, not open source

### Option 5: Use macOS Virtualization.framework Directly
- Build our own minimal Linux VM runner in Rust/Swift
- Ship a pre-built minimal Alpine image (~50MB compressed)
- Run containerd inside the VM
- **Pros:** Full control, smallest footprint, no dependencies
- **Cons:** Significant engineering effort, edge cases

### Option 6: Apple's Container Framework (Future?)
- Apple is rumored to be building native containers
- Not available yet
- **Pros:** Native, no VM overhead
- **Cons:** Doesn't exist

---

## Recommendation

**For MVP: Bundle Colima + Docker CLI**

Rationale:
- Open source (MIT) - no licensing issues
- Uses Apple Virtualization.framework (fast, battery efficient)
- Docker-compatible CLI (openclaw works unchanged)
- ~15MB binary bundle + ~300MB VM download on first run
- Community maintained, proven

**Architecture:**
```
Zara.app/
├── Contents/
│   ├── MacOS/
│   │   └── zara                    # Tauri binary
│   ├── Resources/
│   │   ├── bin/
│   │   │   ├── colima              # Colima binary
│   │   │   ├── docker              # Docker CLI
│   │   │   └── node                # Node.js runtime
│   │   ├── openclaw/               # OpenClaw dist
│   │   └── vm/
│   │       └── alpine.qcow2        # Pre-built Linux VM (optional)
```

**First Launch Flow:**
1. Check if Colima VM exists
2. If not: Show "Setting up secure sandbox..." with progress
3. `colima start --arch aarch64 --vm-type vz --mount-type virtiofs`
4. VM downloads (~300MB) and boots
5. Gateway starts
6. "Ready!"

**Subsequent Launches:**
1. `colima start` (boots existing VM in ~5s)
2. Gateway starts
3. Ready

---

## Requirements Summary

| Component | Required | Size | Notes |
|-----------|----------|------|-------|
| Node.js 22+ | Yes | ~40MB | Runtime for openclaw |
| Colima | Yes | ~15MB | VM manager |
| Docker CLI | Yes | ~50MB | Container commands |
| Linux VM | Yes | ~300MB | Downloaded on first run |
| OpenClaw dist | Yes | ~20MB | The agent itself |

**Total app bundle:** ~125MB
**First-run download:** ~300MB (one-time)

---

## Hardware Requirements

Based on openclaw's sandbox config:

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| macOS | 12.0+ (Monterey) | 13.0+ (Ventura) |
| Chip | Apple Silicon or Intel | Apple Silicon |
| RAM | 8GB | 16GB |
| Disk | 2GB free | 10GB free |

Virtualization.framework requires:
- macOS 11+ for Intel
- macOS 12+ for Apple Silicon (Rosetta containers)
- macOS 13+ for native ARM containers

---

## Security Model (Normie-Friendly)

| Layer | Protection |
|-------|------------|
| **Network** | Gateway binds to localhost only |
| **Secrets** | macOS Keychain, not plaintext |
| **AI Commands** | Run in Docker container |
| **Container** | Read-only rootfs, no-new-privileges, seccomp |
| **App** | Signed + notarized, Gatekeeper approved |
| **Updates** | Signed update manifests |

**User sees:** "Your AI assistant runs in a secure sandbox"
**Under the hood:** Full container isolation with security hardening
