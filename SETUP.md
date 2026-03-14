# Setup Architecture

## Overview

Entropic has two distinct build profiles:

- `local`: the default source-development profile
- `managed`: the profile used for official hosted-feature builds

This split is intentional. External contributors should be able to clone,
build, and run the app without any Entropic cloud account or private secrets.

## Local Profile

`ENTROPIC_BUILD_PROFILE=local`

Defaults:

- hosted auth hidden
- hosted billing hidden
- updater disabled
- managed API proxy disabled
- local provider auth and API-key flows remain available

This is the correct default for contributors and forks.

## Managed Profile

`ENTROPIC_BUILD_PROFILE=managed`

Defaults:

- hosted auth available when Supabase env vars exist
- hosted billing available
- updater enabled
- managed API proxy allowed

Managed builds still require the relevant env vars at build/runtime.

## Runtime Model

Entropic runs OpenClaw in a local runtime:

- macOS: isolated Colima-based runtime
- Linux: Docker Engine
- Windows: managed WSL runtime path

The runtime image is built from the sibling `openclaw` repository with
`./scripts/build-openclaw-runtime.sh`.

## Windows Runtime Notes

Windows support is implemented around the managed WSL workflow and release/user
test scripts. Preview builds may be unsigned. The current remaining quality work
is around test confidence and runtime-manager integration, not the existence of
the platform path itself.

## Managed Infrastructure

Managed builds may use:

- Supabase auth
- managed Entropic API endpoints
- updater metadata and release endpoints

Those integrations should be configured explicitly, never assumed for source
builds.

## Contributor Principle

If a change makes the app unusable without private hosted services in the
default source workflow, that is a regression.
