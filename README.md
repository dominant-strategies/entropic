# Entropic

<p align="center">
  Entropic is a local-first desktop AI workspace built with Tauri and OpenClaw.
</p>

<p align="center">
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache%202.0-blue.svg"></a>
  <a href="https://github.com/dominant-strategies/entropic/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/dominant-strategies/entropic/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/dominant-strategies/entropic/actions/workflows/actionlint.yml"><img alt="Actionlint" src="https://github.com/dominant-strategies/entropic/actions/workflows/actionlint.yml/badge.svg"></a>
  <a href="./CONTRIBUTING.md"><img alt="Contributing" src="https://img.shields.io/badge/contributions-welcome-1f6feb"></a>
  <a href="./TRADEMARKS.md"><img alt="Trademark Policy" src="https://img.shields.io/badge/branding-protected-555"></a>
  <a href="./docs/OPEN_SOURCE_CHECKLIST.md"><img alt="OSS Checklist" src="https://img.shields.io/badge/oss-checklist-in%20progress-f59e0b"></a>
</p>

<p align="center">
  <a href="#quick-start"><img alt="Get Started" src="https://img.shields.io/badge/get%20started-quick%20start-111827"></a>
  <a href="https://github.com/dominant-strategies/entropic"><img alt="Repository" src="https://img.shields.io/badge/repository-github-111827"></a>
  <a href="./CONTRIBUTING.md"><img alt="Contribute" src="https://img.shields.io/badge/contribute-guidelines-111827"></a>
  <a href="https://github.com/dominant-strategies/entropic-releases/releases"><img alt="Preview Releases" src="https://img.shields.io/badge/releases-preview%20builds-111827"></a>
  <a href="./docs/OPEN_SOURCE_CHECKLIST.md"><img alt="Launch Checklist" src="https://img.shields.io/badge/launch-checklist-111827"></a>
</p>

Entropic runs OpenClaw in a hardened local runtime. Source builds default to a
local-only profile: no Entropic-hosted auth, billing, updater, or managed API
access is enabled unless you explicitly opt into a managed build.

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

- Preview release artifacts currently live in `dominant-strategies/entropic-releases`.
- Source builds default to `ENTROPIC_BUILD_PROFILE=local`.
- Official managed releases should use `ENTROPIC_BUILD_PROFILE=managed`.

Preview releases:

- https://github.com/dominant-strategies/entropic-releases/releases

## Build Profiles

### `ENTROPIC_BUILD_PROFILE=local`

- default for source builds
- hides hosted auth and billing UI
- disables updater and managed API proxy defaults
- intended for local provider auth and API key usage

### `ENTROPIC_BUILD_PROFILE=managed`

- enables hosted Entropic features when the required env vars are present
- intended for official managed builds and release automation

## Quick Start

### 1. Prerequisites

- Node.js 20+ and `pnpm`
- Rust via `rustup`
- Docker Engine running locally
- Tauri system dependencies for your platform
- a sibling `openclaw` checkout

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

Optional skill bundle source:

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
pnpm dev:runtime:status
pnpm dev:runtime:start
pnpm dev:runtime:up
pnpm dev:runtime:stop
pnpm dev:runtime:prune
pnpm dev:runtime:logs
```

Windows:

```powershell
pnpm dev:wsl:status
pnpm dev:wsl:start
pnpm dev:wsl:stop
pnpm dev:wsl:prune
```

## Validation

```bash
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
```

## Project Docs

- [DEVELOPMENT.md](./DEVELOPMENT.md): supported contributor workflows
- [SETUP.md](./SETUP.md): runtime and profile architecture
- [DISTRIBUTE.md](./DISTRIBUTE.md): release-signing and distribution notes
- [CONTRIBUTING.md](./CONTRIBUTING.md): contribution expectations
- [TRADEMARKS.md](./TRADEMARKS.md): Entropic name and branding policy
- [docs/OPEN_SOURCE_CHECKLIST.md](./docs/OPEN_SOURCE_CHECKLIST.md): launch-readiness checklist
