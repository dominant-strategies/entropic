# Nova Development Guide

## Prerequisites

- Node.js 18+ and pnpm
- Rust (for Tauri backend)
- Docker (Linux) or Colima (macOS)
- **OpenClaw** (clawdbot repo) - see below

### One-time host setup (Linux)

1. **Create nova user for isolated X11 access:**
   ```bash
   sudo useradd -u 1337 -M -s /bin/false novauser
   ```

2. **Docker must be installed and running**

---

## OpenClaw Setup (Required)

Nova requires the OpenClaw runtime image. This is built from the separate `clawdbot` repository.

### 1. Clone and build OpenClaw

```bash
# Clone clawdbot repo (sibling to Nova)
cd ~/agent
git clone https://github.com/dominant-strategies/openclaw clawdbot
cd clawdbot

# Install dependencies and build
pnpm install
pnpm build
```

### 2. Build the runtime image

```bash
cd ~/agent/Nova
./scripts/build-openclaw-runtime.sh
```

This creates the `openclaw-runtime:latest` Docker image containing:
- OpenClaw gateway server
- Bundled extensions (memory, discord, telegram, etc.)
- Node.js runtime

**Custom OpenClaw location:**
```bash
OPENCLAW_SOURCE=/path/to/clawdbot ./scripts/build-openclaw-runtime.sh
```

### 3. Verify the image

```bash
docker images openclaw-runtime:latest
```

---

## Development Workflow

### 1. Allow X11 access for Nova container
```bash
xhost +si:localuser:novauser
```

### 2. Start the dev container
```bash
cd /home/alan/agent/Nova
./dev.sh
```

First run builds the image (~5-10 min). Subsequent runs start instantly.

### 3. Inside the container

**Install dependencies (first time):**
```bash
pnpm install
```

**Run full Tauri app (React + Rust backend):**
```bash
pnpm tauri dev
```
- Compiles Rust (~2-3 min first time, fast after)
- Opens native window on your desktop

**Or run React UI only (faster, no Rust):**
```bash
pnpm dev
```
Then open http://localhost:5174 in your browser.

---

## Rebuild Container Image

If you change the Dockerfile in dev.sh:
```bash
docker rmi nova-dev:latest
./dev.sh
```

---

## Security Notes

- **Dev container** (`dev.sh`) runs as your user for file access
- **OpenClaw agent containers** run as UID 1337 (`novauser`) for isolation
- Only the Nova dev container has X11 display access
- Agent containers cannot access your display or home directory
- Project files are mounted read-write at `/app`

### Revoke X11 access after dev session
```bash
xhost -si:localuser:novauser
```

---

## Project Structure

```
Nova/
├── src/                    # React frontend
│   ├── App.tsx            # Main app, routing
│   ├── pages/
│   │   ├── SetupScreen.tsx    # macOS Colima setup
│   │   ├── DockerInstall.tsx  # Linux Docker install guide
│   │   └── Dashboard.tsx      # Main UI
│   └── index.css          # Tailwind styles
├── src-tauri/             # Rust backend
│   ├── src/
│   │   ├── lib.rs         # Tauri app entry
│   │   ├── commands.rs    # Backend commands (invoke handlers)
│   │   └── runtime.rs     # Docker/Colima detection
│   ├── Cargo.toml         # Rust dependencies
│   └── tauri.conf.json    # Tauri config
├── scripts/               # Build scripts
│   ├── bundle-docker.sh   # Bundle Docker CLI
│   ├── bundle-node.sh     # Bundle Node.js
│   ├── bundle-runtime.sh  # Bundle Colima (macOS) or helper (Linux)
│   └── bundle-openclaw.sh # Bundle OpenClaw (with security scan)
├── dev.sh                 # Development container launcher
├── package.json           # JS dependencies
└── vite.config.ts         # Vite config
```

---

## Building for Release

### Bundle dependencies (run on target platform)
```bash
./scripts/bundle-node.sh
./scripts/bundle-docker.sh
./scripts/bundle-runtime.sh
./scripts/bundle-openclaw.sh
```

### Build release binary
```bash
pnpm tauri build
```

Output: `src-tauri/target/release/bundle/`

---

## Troubleshooting

### "Failed to initialize GTK"
X11 access not granted. Run on host:
```bash
xhost +si:localuser:novauser
```

### "Port 5174 already in use"
Kill existing process:
```bash
pkill -f vite
```

### Container can't access Docker
Check socket mount:
```bash
ls -la /var/run/docker.sock
```

### Rust compilation errors
Clean and rebuild:
```bash
cd /app/src-tauri
cargo clean
pnpm tauri dev
```
