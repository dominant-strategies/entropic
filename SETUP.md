# Entropic Development Setup

## Prerequisites

- Docker installed on host machine
- Access to Docker socket (may need `sg docker -c "..."` wrapper)

## Quick Start

```bash
# 1. Start the dev container
./dev.sh

# 2. Inside dev container - install dependencies (first time only)
pnpm install

# 3. Build the OpenClaw runtime image (first time or after changes)
./scripts/build-openclaw-runtime.sh

# 4. Run the app
pnpm tauri dev
```

**Dev OAuth isolation (recommended for local dev):**
```bash
pnpm tauri:dev
pnpm dev:protocol   # Linux only, registers entropic-dev:// handler
```
Add `entropic-dev://auth/callback` to Supabase Auth → Additional Redirect URLs.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Host Machine                                               │
│  ┌────────────────────┐    ┌─────────────────────────────┐  │
│  │  entropic-dev          │    │  entropic-openclaw              │  │
│  │  (dev container)   │    │  (runtime container)        │  │
│  │                    │    │                             │  │
│  │  - Tauri app       │───▶│  - OpenClaw gateway         │  │
│  │  - React frontend  │    │  - API key in tmpfs         │  │
│  │  - Rust backend    │    │  - Hardened (no caps, etc)  │  │
│  └────────────────────┘    └─────────────────────────────┘  │
│           │                            │                    │
│           └────────── entropic-net ────────┘                    │
│                    (Docker network)                         │
└─────────────────────────────────────────────────────────────┘
```

## Dev Container (entropic-dev)

The dev container provides a consistent build environment with:
- Node.js 22
- Rust + Cargo
- Tauri CLI
- GTK/WebKit dependencies

```bash
# Start dev container
./dev.sh

# Available commands inside:
pnpm install        # Install JS dependencies
pnpm dev            # React frontend only (http://localhost:5174)
pnpm tauri dev      # Full Tauri app with Rust backend
pnpm tauri:dev      # Dev config (entropic-dev:// scheme + isolated auth store)
pnpm tauri build    # Build release binary
```

## OpenClaw Runtime Container (entropic-openclaw)

The runtime container runs OpenClaw gateway in a hardened environment.

### Build the Image

```bash
# From inside dev container OR host (needs Docker access)
./scripts/build-openclaw-runtime.sh
```

This script:
1. Copies OpenClaw dist from `~/agent/openclaw/dist`
2. Copies templates from `~/agent/openclaw/docs/reference/templates`
3. Bundles any plugins found in the sibling `../entropic-skills` repo (if present)
4. Builds Docker image `openclaw-runtime:latest`

**Optional: custom skills path**
```bash
ENTROPIC_SKILLS_SOURCE=/path/to/entropic-skills ./scripts/build-openclaw-runtime.sh
```

### Container Security

The container runs with:
- `--cap-drop=ALL` - No Linux capabilities
- `--read-only` - Immutable filesystem
- `--security-opt no-new-privileges` - Can't escalate
- `--user 1000:1000` - Non-root
- `--tmpfs /home/node/.openclaw` - Writable area in memory only
- Network isolated to `entropic-net`

### API Keys

API keys flow:
1. User pastes in UI
2. Stored in Rust backend memory
3. Passed to container as env vars (`-e OPENAI_API_KEY=...`)
4. `entrypoint.sh` creates `auth-profiles.json` in tmpfs
5. OpenClaw reads the file

**Keys never touch host disk** - only exist in memory/tmpfs.

## Common Tasks

### Rebuild Everything

```bash
# Rebuild OpenClaw runtime image
./scripts/build-openclaw-runtime.sh

# Remove old container (picks up new image)
sg docker -c "docker rm -f entropic-openclaw"

# Restart Tauri app
pnpm tauri dev
```

### Dev Runtime Helpers

```bash
pnpm dev:runtime:status   # Check Colima, Docker socket, entropic-openclaw state
pnpm dev:runtime:start    # Ensure Colima runtime is started (if installed), verify Docker
pnpm dev:runtime:up       # Run start, auto-build/bundle missing runtime assets, launch `pnpm tauri:dev`
pnpm dev:runtime:stop     # Stop entropic-openclaw + scanner without removing volumes
pnpm dev:runtime:prune    # Remove dev containers/networks/volumes and reset dev Colima homes
pnpm dev:runtime:logs     # Tail entropic-openclaw logs
```

By default, dev helpers use `~/.entropic/colima-dev` (`ENTROPIC_COLIMA_HOME`) to isolate
development runtime state from production/other Colima installs. You can start dev
without setting it manually:

```bash
pnpm dev:runtime:up
```

Override this intentionally if you need a different location:

```bash
ENTROPIC_COLIMA_HOME=$HOME/.entropic/colima-dev-pilot pnpm dev:runtime:up
```

### Production User-Test Scripts

```bash
pnpm user-test:clean
pnpm user-test:build
```

These scripts force `ENTROPIC_RUNTIME_MODE=prod` and target the production Colima home (`~/.entropic/colima`) so they do not clean or build against dev runtime state.

### Check Container Logs

```bash
sg docker -c "docker logs entropic-openclaw"
```

### Check Container Status

```bash
sg docker -c "docker ps -a | grep entropic"
```

### Verify Entrypoint

```bash
# Should show [/app/entrypoint.sh]
sg docker -c "docker inspect openclaw-runtime:latest --format '{{.Config.Entrypoint}}'"
```

### Check Auth File in Container

```bash
sg docker -c "docker exec entropic-openclaw cat /home/node/.openclaw/agents/main/agent/auth-profiles.json"
```

### Reset Everything

```bash
# Remove container
sg docker -c "docker rm -f entropic-openclaw"

# Remove volume (chat history)
sg docker -c "docker volume rm entropic-openclaw-data"

# Remove image (forces rebuild)
sg docker -c "docker rmi openclaw-runtime:latest"
```

## Troubleshooting

### "No API key found for provider X"

1. Check that the correct provider's key was entered
2. Verify the container was rebuilt with new entrypoint:
   ```bash
   sg docker -c "docker inspect openclaw-runtime:latest --format '{{.Config.Entrypoint}}'"
   # Should show: [/app/entrypoint.sh]
   ```
3. Remove old container and restart:
   ```bash
   sg docker -c "docker rm -f entropic-openclaw"
   ```

### "EACCES: permission denied, mkdir..."

The entrypoint.sh should create all needed directories. If you see this:
1. Rebuild the image: `./scripts/build-openclaw-runtime.sh`
2. Remove old container: `sg docker -c "docker rm -f entropic-openclaw"`

### Model Using Wrong Provider

The model is selected based on which API key is provided:
- Anthropic key → `anthropic/claude-sonnet-4-20250514`
- OpenAI key → `openai/gpt-4o`
- Google key → `google/gemini-2.0-flash`

If wrong model is used, the container may have cached old env vars. Remove and restart.

### Gateway Not Connecting

1. Check if container is running:
   ```bash
   sg docker -c "docker ps | grep entropic-openclaw"
   ```
2. Check logs:
   ```bash
   sg docker -c "docker logs entropic-openclaw"
   ```
3. Verify network:
   ```bash
   sg docker -c "docker network inspect entropic-net"
   ```

## File Locations

| File | Purpose |
|------|---------|
| `dev.sh` | Starts dev container |
| `scripts/build-openclaw-runtime.sh` | Builds runtime image |
| `openclaw-runtime/Dockerfile` | Runtime container definition |
| `openclaw-runtime/entrypoint.sh` | Creates auth from env vars |
| `src-tauri/src/commands.rs` | Rust backend commands |
| `src/lib/gateway.ts` | WebSocket client for OpenClaw |
| `src/pages/Chat.tsx` | Chat UI with API key entry |

## Environment Variables

Set by Rust backend when starting container:

| Env Var | Purpose |
|---------|---------|
| `OPENCLAW_GATEWAY_TOKEN` | Auth token for gateway connection |
| `OPENCLAW_MODEL` | Model to use (auto-selected by provider) |
| `ANTHROPIC_API_KEY` | Anthropic API key (if provided) |
| `OPENAI_API_KEY` | OpenAI API key (if provided) |
| `GEMINI_API_KEY` | Google API key (if provided) |

## Next Steps (TODO)

- [ ] Ship with QMD (https://github.com/tobi/qmd) bundled and enabled
- [ ] Keychain integration for persistent API key storage
- [ ] Colima first-run setup + bundled CLI for normie install
- [ ] Colima security posture: locked-down defaults + limited VM networking
- [ ] Code signing + notarization for macOS
- [ ] Auto-updater
- [ ] Windows/Linux builds
