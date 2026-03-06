# Entropic

Entropic is a Tauri desktop app that runs OpenClaw in a hardened local container to provide a secure, "normie-friendly" AI assistant.

## Quick Start

### Prerequisites

- Node.js 18+ and pnpm
- Rust (for Tauri)
- Docker (Linux) or the app bundles Colima (macOS)
- **OpenClaw** (openclaw repo) - built separately

### 1. Build OpenClaw

Entropic requires the OpenClaw runtime. Clone and build it first:

```bash
# Clone openclaw as a sibling directory
git clone https://github.com/dominant-strategies/openclaw ../openclaw
cd ../openclaw
pnpm install
pnpm build
cd ../Entropic
```

### 2. Build the runtime image

```bash
./scripts/build-openclaw-runtime.sh
```

This creates the `openclaw-runtime:latest` Docker image.

**Optional: bundle Entropic skills**
```bash
# Sibling repo (recommended)
ENTROPIC_SKILLS_SOURCE=../entropic-skills ./scripts/build-openclaw-runtime.sh
```
Plugins under `entropic-skills` with `openclaw.plugin.json` are bundled into the image.

### 3. Run Entropic

```bash
pnpm install
pnpm tauri dev
```

### Dev Runtime Helpers (macOS/Linux)

```bash
pnpm dev:runtime:start   # Ensure Docker/Colima are ready for Entropic runtime
pnpm dev:runtime:up      # Run start, auto-build/bundle missing runtime assets, launch `pnpm tauri:dev`
pnpm dev:runtime:status  # Check Colima + entropic-openclaw state
pnpm dev:runtime:stop    # Stop entropic-openclaw + scanner (not image/volume)
pnpm dev:runtime:prune   # Remove dev containers/networks/volumes and reset dev Colima home
pnpm dev:runtime:logs    # Tail entropic-openclaw logs
```

Dev mode now uses an isolated Colima home by default:
`~/.entropic/colima-dev`. It does not share that with production/default Colima (`~/.colima`) unless you intentionally override it:

```bash
pnpm dev:runtime:up
```

To use a custom dev path intentionally:

```bash
ENTROPIC_COLIMA_HOME=$HOME/.entropic/colima-dev-pilot pnpm dev:runtime:up
```

### Windows WSL Runtime Helpers

For Windows development, use the WSL runtime helper to manage isolated distros
(`entropic-dev` and `entropic-prod`) similarly to Colima profiles. The default
`dev:wsl:*` commands now target `entropic-dev`; use explicit `:prod` or `:all`
variants when you need them:

```powershell
pnpm dev:wsl:status
pnpm dev:wsl:start
pnpm dev:wsl:up
pnpm dev:wsl:status:prod
pnpm dev:wsl:start:prod
pnpm dev:wsl:status:all
pnpm dev:wsl:ensure:all
pnpm dev:wsl:stop
pnpm dev:wsl:prune
pnpm dev:wsl:shell:dev
pnpm dev:wsl:shell:prod
```

`pnpm dev:wsl:up` starts the managed WSL dev runtime, forces the app into
managed-WSL mode, and launches `pnpm tauri:dev`.

Optional overrides:
- `ENTROPIC_WSL_BASE_DISTRO` (default `Ubuntu`)
- `ENTROPIC_WSL_DEV_DISTRO` (default `entropic-dev`)
- `ENTROPIC_WSL_PROD_DISTRO` (default `entropic-prod`)

Windows user-test bundle (local `.exe` + NSIS installer):
```powershell
pnpm user-test:build:win
# Faster rebuild that reuses an existing non-empty runtime tar:
pnpm user-test:build:win:fast
# Use when frontend dist is prebuilt (for example built in WSL):
pnpm user-test:build:win:prebuilt
pnpm user-test:build:win:prebuilt:fast
pnpm user-test:run:win
```

`pnpm user-test:build:win` now prepares the managed WSL base artifact
(`resources/runtime/entropic-runtime.tar`) plus the bundled
`openclaw-runtime.tar.gz` image tar. `pnpm user-test:run:win` launches the built
release binary in managed-WSL `prod` mode to mimic the installer/runtime path
without reinstalling first.

### User-Test Production Pipeline

```bash
pnpm user-test:clean   # clean production-mode Colima/runtime/build artifacts only
pnpm user-test:build   # build production-mode user-test app bundle
```

Both scripts force `ENTROPIC_RUNTIME_MODE=prod` and target `~/.entropic/colima` by default.
They do not touch dev runtime state in `~/.entropic/colima-dev`.

For containerized local dev, the app now keeps runtime containers up on app exit; this makes iterative starts faster and avoids full warm-up when restarting the app frequently.

**Isolated dev OAuth (entropic-dev://)**
```bash
pnpm tauri:dev
pnpm dev:protocol   # Linux only, registers entropic-dev:// handler
```
Add `entropic-dev://auth/callback` to Supabase Auth → Additional Redirect URLs.

## Platform-Specific Setup

### macOS

No additional setup needed. Entropic bundles Colima for Docker support.

### Linux

Create an isolated user for container security:
```bash
sudo useradd -u 1337 -M -s /bin/false entropicuser
```

For X11 display access (dev container):
```bash
xhost +si:localuser:entropicuser
./dev.sh
```

## Project Structure

```
Entropic/
├── src/                    # React frontend
├── src-tauri/              # Rust backend (Tauri)
├── openclaw-runtime/       # Docker image for OpenClaw
├── scripts/                # Build scripts
└── dev.sh                  # Dev container launcher (Linux)
```

## Documentation

- [DEVELOPMENT.md](./DEVELOPMENT.md) - Full development workflow
- [DISTRIBUTE.md](./DISTRIBUTE.md) - macOS signing & notarization
- [SETUP.md](./SETUP.md) - Runtime architecture details

## Data Storage

Entropic stores data in `~/.local/share/ai.openclaw.entropic/`:

| File | Purpose |
|------|---------|
| `entropic-auth.json` | OAuth session and tokens |
| `entropic-profile.json` | User profile settings |
| `localstorage/` | Web storage data |

Dev builds use a separate identifier and auth store:
- `~/.local/share/ai.openclaw.entropic.dev/`
- `entropic-auth-dev.json`

To reset OAuth:
```bash
rm ~/.local/share/ai.openclaw.entropic/entropic-auth.json
```

To fully reset all data:
```bash
rm -rf ~/.local/share/ai.openclaw.entropic/
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| GTK init error | Run `xhost +si:localuser:entropicuser` on host |
| Port 5174 in use | `pkill -f vite` |
| Docker access denied | Check `/var/run/docker.sock` permissions |
| OpenClaw image not found | Run `./scripts/build-openclaw-runtime.sh` |
| DRM/KMS permission denied | Run with `WEBKIT_DISABLE_COMPOSITING_MODE=1 pnpm tauri dev` |
