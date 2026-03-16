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

Every change must be reproducible by external contributors without private
access. That means:

- No reliance on private secrets to build or validate
- No hardcoded private infrastructure URLs or defaults
- No breaking the macOS/Linux native or Windows WSL workflows

## Security

Do not open public issues or PRs containing secrets, tokens, customer data, or
private infrastructure details. Follow [SECURITY.md](./SECURITY.md) for
vulnerability disclosure.
