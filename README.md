# Entropic

<p align="center">
  Entropic is a local-first desktop AI workspace built with Tauri and OpenClaw.
</p>

<p align="center">
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/static/v1?label=License&message=MIT&color=2563eb"></a>
  <a href="https://github.com/dominant-strategies/entropic/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/dominant-strategies/entropic/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/dominant-strategies/entropic/actions/workflows/actionlint.yml"><img alt="Actionlint" src="https://github.com/dominant-strategies/entropic/actions/workflows/actionlint.yml/badge.svg"></a>
  <a href="./CONTRIBUTING.md"><img alt="Contributing" src="https://img.shields.io/static/v1?label=Contributing&message=Welcome&color=1f6feb"></a>
  <a href="./TRADEMARKS.md"><img alt="Trademark Policy" src="https://img.shields.io/static/v1?label=Trademark&message=Protected&color=555555"></a>
  <a href="./docs/OPEN_SOURCE_CHECKLIST.md"><img alt="OSS Checklist" src="https://img.shields.io/static/v1?label=OSS%20Checklist&message=In%20Progress&color=f59e0b"></a>
</p>

<p align="center">
  <a href="#quick-start"><img alt="Get Started" src="https://img.shields.io/static/v1?label=Get%20Started&message=Quick%20Start&color=111827"></a>
  <a href="https://github.com/dominant-strategies/entropic"><img alt="Repository" src="https://img.shields.io/static/v1?label=Repository&message=GitHub&color=111827"></a>
  <a href="./CONTRIBUTING.md"><img alt="Contribute" src="https://img.shields.io/static/v1?label=Contribute&message=Guidelines&color=111827"></a>
  <a href="https://github.com/dominant-strategies/entropic-releases/releases"><img alt="Preview Releases" src="https://img.shields.io/static/v1?label=Preview&message=Releases&color=111827"></a>
  <a href="./docs/OPEN_SOURCE_CHECKLIST.md"><img alt="Launch Checklist" src="https://img.shields.io/static/v1?label=Launch&message=Checklist&color=111827"></a>
</p>

Entropic runs [OpenClaw](https://github.com/dominant-strategies/openclaw) in a
hardened local runtime. Source builds default to a local-only profile -- hosted
auth, billing, auto-updates, and managed API access are all disabled unless you
explicitly opt into a managed build.

## Highlights

- Local-first by default. Contributors can clone, build, and run the app without an Entropic cloud account.
- Hardened runtime model. Entropic uses an isolated local runtime instead of running arbitrary commands directly on the host.
- Cross-platform target. macOS and Linux are first-class; Windows runs through the managed WSL workflow.
- Managed builds stay possible. Official hosted features are enabled with a single build profile instead of being baked into source defaults.

## Supported Platforms

- macOS
- Linux
- Windows via WSL

## Releases

- Preview builds are published to [`dominant-strategies/entropic-releases`](https://github.com/dominant-strategies/entropic-releases/releases).
- Building from source defaults to `ENTROPIC_BUILD_PROFILE=local` (no hosted services).
- Official releases use `ENTROPIC_BUILD_PROFILE=managed` to enable hosted features.

Preview releases:

- https://github.com/dominant-strategies/entropic-releases/releases

## Build Profiles

### `ENTROPIC_BUILD_PROFILE=local` (default)

- Hides hosted auth and billing UI
- Disables auto-updater and managed API proxy
- You bring your own API keys for each AI provider

### `ENTROPIC_BUILD_PROFILE=managed`

- Enables hosted Entropic features (auth, billing, updater, API proxy) when the required env vars are set
- Used for official releases and release automation

## Quick Start

### 1. Prerequisites

- Node.js 20+ and `pnpm`
- Rust via `rustup`
- Docker Engine running locally
- Tauri system dependencies for your platform
- a cloned copy of [`openclaw`](https://github.com/dominant-strategies/openclaw) next to the `entropic` directory

### 2. Build OpenClaw

```bash
cd /path/to/workspace
git clone https://github.com/dominant-strategies/openclaw openclaw
cd openclaw
pnpm install
pnpm build
```

### 3. Build the Entropic runtime image

```bash
cd /path/to/workspace/entropic
./scripts/build-openclaw-runtime.sh
```

To include an external skills bundle (optional):

```bash
ENTROPIC_SKILLS_SOURCE=../entropic-skills ./scripts/build-openclaw-runtime.sh
```

### 4. Install dependencies

```bash
pnpm install
```

### 5. Run a local build

```bash
ENTROPIC_BUILD_PROFILE=local pnpm tauri:dev
```

If `ENTROPIC_BUILD_PROFILE` is omitted, it still defaults to `local`.

### 6. Run a managed build

Only do this when intentionally validating hosted Entropic flows:

```bash
ENTROPIC_BUILD_PROFILE=managed pnpm tauri:dev
```

Managed builds require the relevant hosted env vars such as `VITE_API_URL`,
`VITE_SUPABASE_URL`, and `VITE_SUPABASE_ANON_KEY`.

## Windows

Use the WSL helper workflow:

```powershell
pnpm dev:wsl:status
pnpm dev:wsl:ensure
pnpm dev:wsl:up
```

User-test Windows bundles:

```powershell
pnpm user-test:build:win
pnpm user-test:run:win
```

Unsigned preview builds are currently acceptable for local and user-test use.

## Runtime Helpers

macOS and Linux:

```bash
pnpm dev:runtime:status   # Check if the runtime VM and Docker are ready
pnpm dev:runtime:start    # Start the runtime (Colima VM + Docker)
pnpm dev:runtime:up       # Start runtime and launch the OpenClaw container
pnpm dev:runtime:stop     # Stop the runtime
pnpm dev:runtime:prune    # Remove the runtime VM and reclaim disk space
pnpm dev:runtime:logs     # Tail the OpenClaw container logs
```

Windows:

```powershell
pnpm dev:wsl:status       # Check WSL runtime state
pnpm dev:wsl:start        # Start the WSL runtime
pnpm dev:wsl:stop         # Stop the WSL runtime
pnpm dev:wsl:prune        # Remove the WSL runtime and reclaim disk space
```

## Validation

```bash
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
```

## Project Docs

- [DEVELOPMENT.md](./DEVELOPMENT.md) -- platform-specific setup and day-to-day development workflows
- [SETUP.md](./SETUP.md) -- how build profiles, runtime isolation, and auth are architected
- [DISTRIBUTE.md](./DISTRIBUTE.md) -- signing, notarizing, and publishing macOS releases
- [CONTRIBUTING.md](./CONTRIBUTING.md) -- how to contribute (scope, PR expectations, review bar)
- [TRADEMARKS.md](./TRADEMARKS.md) -- rules for using the Entropic name and branding
- [docs/OPEN_SOURCE_CHECKLIST.md](./docs/OPEN_SOURCE_CHECKLIST.md) -- pre-launch readiness checklist

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=dominant-strategies/entropic&type=Date)](https://star-history.com/#dominant-strategies/entropic&Date)

## License

Entropic source code is licensed under [MIT](./LICENSE). The copyright license
does not grant rights to the Entropic name, logos, or other branding; see
[TRADEMARKS.md](./TRADEMARKS.md).
