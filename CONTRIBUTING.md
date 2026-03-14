# Contributing

## Scope

Entropic accepts fixes, docs improvements, tests, workflow hardening, and
feature work that fits the local-first desktop app direction.

Before starting large work, open an issue or draft PR to align on scope and
avoid duplicate effort.

## Development Defaults

- Source builds default to `ENTROPIC_BUILD_PROFILE=local`.
- Local builds should work without Entropic-hosted auth, billing, updater, or
  managed API access.
- Official managed builds enable hosted features explicitly at build time.

## Setup

Follow [README.md](./README.md) for the supported development flow.

The supported paths are:

- macOS: host-native development
- Linux: host-native development
- Windows: WSL-based development/runtime workflow

## Pull Requests

Keep PRs narrow and reviewable.

Include:

- what changed
- why it changed
- how you tested it
- platform impact, if any

If your change affects runtime setup, auth, billing, updater behavior, or
Windows bootstrap behavior, call that out explicitly in the PR description.

## Coding Expectations

- Prefer small, targeted changes over broad refactors.
- Keep local builds free of unintended hosted-service dependencies.
- Add or update tests when behavior changes.
- Update docs when setup, workflow, or contributor expectations change.

## Commit Style

There is no required commit format, but commits should be descriptive and
focused. If a change needs context to understand, the PR description should
carry it.

## Review Bar

Changes should be safe for external contributors to reproduce locally. That
means:

- no reliance on private secrets for normal validation
- no new hardcoded private infrastructure defaults
- no breaking the host-native macOS/Linux or WSL Windows workflows

## Security

Do not open public issues or PRs containing secrets, tokens, customer data, or
private infrastructure details. Follow [SECURITY.md](./SECURITY.md) for
vulnerability disclosure.
