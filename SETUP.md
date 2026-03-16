# Setup Architecture

## Overview

Entropic has two distinct build profiles:

- `local`: the default source-development profile
- `managed`: the profile used for official hosted-feature builds

This split is intentional. External contributors should be able to clone,
build, and run the app without any Entropic cloud account or private secrets.

## Local Profile

`ENTROPIC_BUILD_PROFILE=local`

This is the default for contributors and forks. It:

- Hides hosted auth and billing UI
- Disables the auto-updater
- Disables the managed API proxy
- Keeps provider-direct auth and API-key flows available (you bring your own keys)

## Managed Profile

`ENTROPIC_BUILD_PROFILE=managed`

Used for official releases. It enables:

- Hosted auth (requires Supabase env vars)
- Hosted billing
- Auto-updater
- Managed API proxy

These features activate only when the corresponding env vars are set at build or
runtime.

## Runtime Model

Entropic runs OpenClaw inside an isolated local runtime rather than directly on
your machine:

- **macOS:** Colima VM running Docker (lightweight Linux VM via Virtualization.framework)
- **Linux:** Docker Engine directly
- **Windows:** Docker inside a managed WSL instance

The runtime container image is built from the adjacent `openclaw` repository
using `./scripts/build-openclaw-runtime.sh`.

## Windows Runtime Notes

Windows support uses a managed WSL workflow. The platform path works end-to-end,
but preview builds may be unsigned and test coverage is still being expanded
(particularly around runtime-manager integration).

## Managed Infrastructure

Managed builds may use:

- Supabase auth
- managed Entropic API endpoints
- updater metadata and release endpoints

These are configured explicitly via env vars and are never assumed in source
builds.

## Contributor Principle

If a change makes the app unusable without private hosted services when using
the default `local` build profile, that is a regression.
