# Development

## Supported Workflows

Entropic supports host-native development for macOS and Linux, and a WSL-based
workflow for Windows.

The legacy `dev.sh` container-based workflow has been removed and is no longer supported.

## Requirements

### All Platforms

- Node.js 20+ with `pnpm`
- Rust via `rustup`
- [`openclaw`](https://github.com/dominant-strategies/openclaw) cloned and built in an adjacent directory (or pointed to via `OPENCLAW_SOURCE`)

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

What this means:

- Hosted auth and billing are disabled
- Auto-updater is disabled
- You bring your own API keys for each AI provider

### Managed

Use this only when intentionally validating Entropic-managed flows:

```bash
ENTROPIC_BUILD_PROFILE=managed pnpm tauri:dev
```

Managed mode requires hosted env vars (`VITE_API_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`).

## OpenClaw Runtime

Clone and build OpenClaw first (in an adjacent directory):

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

To include an external skills bundle (optional):

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

## Auth Expectations

- **Local builds:** No hosted Entropic account flows. Users authenticate
  directly with AI providers using their own API keys or OAuth.
- **Managed builds:** The only builds that expose hosted Entropic account
  creation, login, and billing.

## Validation Commands

Run these before opening a PR:

```bash
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml --no-default-features
```

If your change affects Windows bootstrap or runtime code, also validate with the
Windows WSL workflow (`pnpm dev:wsl:status`, `pnpm dev:wsl:up`).
