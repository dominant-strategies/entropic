# Development

## Supported Workflows

Entropic supports host-native development for macOS and Linux, and a WSL-based
workflow for Windows.

The removed `dev.sh` container workflow is no longer supported.

## Requirements

### All Platforms

- Node.js 20+ with `pnpm`
- Rust via `rustup`
- `openclaw` built in a sibling directory or provided via `OPENCLAW_SOURCE`

### macOS

- macOS 12+
- Xcode Command Line Tools

### Linux

- Docker Engine
- Tauri/WebKit dependencies, for example on Ubuntu:

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
```

### Windows

- WSL available
- PowerShell execution policy that allows local project scripts

## Build Profiles

### Local

Use this for normal source development:

```bash
ENTROPIC_BUILD_PROFILE=local pnpm tauri:dev
```

Behavior:

- hosted auth disabled
- hosted billing disabled
- updater disabled
- local/provider-key flow expected

### Managed

Use this only when intentionally validating Entropic-managed flows:

```bash
ENTROPIC_BUILD_PROFILE=managed pnpm tauri:dev
```

Managed mode expects hosted env vars to be configured.

## OpenClaw Runtime

Build the sibling `openclaw` repo first:

```bash
cd /path/to/workspace/openclaw
pnpm install
pnpm build
```

Then build the runtime image from the Entropic repo:

```bash
cd /path/to/workspace/entropic
./scripts/build-openclaw-runtime.sh
```

Optional external skills:

```bash
ENTROPIC_SKILLS_SOURCE=../entropic-skills ./scripts/build-openclaw-runtime.sh
```

## macOS and Linux Workflow

Install dependencies:

```bash
pnpm install
```

Run the app:

```bash
ENTROPIC_BUILD_PROFILE=local pnpm tauri:dev
```

Useful helpers:

```bash
pnpm dev:runtime:status
pnpm dev:runtime:start
pnpm dev:runtime:up
pnpm dev:runtime:stop
pnpm dev:runtime:prune
pnpm dev:runtime:logs
```

## Windows Workflow

Install dependencies:

```powershell
pnpm install
```

Validate and start the managed WSL runtime:

```powershell
pnpm dev:wsl:status
pnpm dev:wsl:ensure
pnpm dev:wsl:up
```

Useful helpers:

```powershell
pnpm dev:wsl:start
pnpm dev:wsl:stop
pnpm dev:wsl:prune
pnpm dev:wsl:shell:dev
pnpm dev:wsl:shell:prod
```

## OAuth and Auth Expectations

- Local builds should be treated as local-only.
- Managed builds are the only builds that should expose hosted Entropic account
  flows.
- Provider OAuth and local API-key flows still belong in local builds.

## Validation Commands

Run these before opening a PR:

```bash
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
```

If you touch Windows bootstrap/runtime code, also run the relevant Windows
workflow or tests where possible.
