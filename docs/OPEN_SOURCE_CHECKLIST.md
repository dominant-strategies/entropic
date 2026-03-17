# Open Source Checklist

Complete these items before declaring the repository publicly open-source ready.

## Required

- `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, and
  `TRADEMARKS.md` are present and current.
- Source builds default to `ENTROPIC_BUILD_PROFILE=local`.
- Local builds do not require Entropic-hosted auth, billing, updater, or
  managed API access.
- Supported contributor docs match the actual workflow.
- Pull request CI runs without private secrets.

## Before Public Launch

- all existing Rust compiler warnings are resolved
- CI treats warnings as errors (`-D warnings`)
- Windows bootstrap tests pass reliably
- release automation and managed-build env vars are documented
- GitHub review ownership (CODEOWNERS) and CI automation are configured

## Optional but Recommended

- add `CODEOWNERS`
- keep actionlint workflow validation aligned with any custom runner labels
- add a dedicated launch/readiness issue or milestone
