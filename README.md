# Nova

Nova is a Tauri desktop app that runs OpenClaw in a hardened local container to provide a secure, "normie-friendly" AI assistant.

## Quick Start

### Prerequisites

- Node.js 18+ and pnpm
- Rust (for Tauri)
- Docker (Linux) or the app bundles Colima (macOS)
- **OpenClaw** (openclaw repo) - built separately

### 1. Build OpenClaw

Nova requires the OpenClaw runtime. Clone and build it first:

```bash
# Clone openclaw as a sibling directory
git clone https://github.com/dominant-strategies/openclaw ../openclaw
cd ../openclaw
pnpm install
pnpm build
cd ../Nova
```

### 2. Build the runtime image

```bash
./scripts/build-openclaw-runtime.sh
```

This creates the `openclaw-runtime:latest` Docker image.

**Optional: bundle Nova skills**
```bash
# Sibling repo (recommended)
NOVA_SKILLS_SOURCE=../nova-skills ./scripts/build-openclaw-runtime.sh
```
Plugins under `nova-skills` with `openclaw.plugin.json` are bundled into the image.

### 3. Run Nova

```bash
pnpm install
pnpm tauri dev
```

**Isolated dev OAuth (nova-dev://)**
```bash
pnpm tauri:dev
pnpm dev:protocol   # Linux only, registers nova-dev:// handler
```
Add `nova-dev://auth/callback` to Supabase Auth → Additional Redirect URLs.

## Platform-Specific Setup

### macOS

No additional setup needed. Nova bundles Colima for Docker support.

### Linux

Create an isolated user for container security:
```bash
sudo useradd -u 1337 -M -s /bin/false novauser
```

For X11 display access (dev container):
```bash
xhost +si:localuser:novauser
./dev.sh
```

## Project Structure

```
Nova/
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

Nova stores data in `~/.local/share/ai.openclaw.nova/`:

| File | Purpose |
|------|---------|
| `nova-auth.json` | OAuth session and tokens |
| `nova-profile.json` | User profile settings |
| `localstorage/` | Web storage data |

Dev builds use a separate identifier and auth store:
- `~/.local/share/ai.openclaw.nova.dev/`
- `nova-auth-dev.json`

To reset OAuth:
```bash
rm ~/.local/share/ai.openclaw.nova/nova-auth.json
```

To fully reset all data:
```bash
rm -rf ~/.local/share/ai.openclaw.nova/
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| GTK init error | Run `xhost +si:localuser:novauser` on host |
| Port 5174 in use | `pkill -f vite` |
| Docker access denied | Check `/var/run/docker.sock` permissions |
| OpenClaw image not found | Run `./scripts/build-openclaw-runtime.sh` |
| DRM/KMS permission denied | Run with `WEBKIT_DISABLE_COMPOSITING_MODE=1 pnpm tauri dev` |
