# Open Source Checklist

Use this before calling the repository publicly open-source ready.

## Required

- `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, and
  `TRADEMARKS.md` are present and current.
- Source builds default to `ENTROPIC_BUILD_PROFILE=local`.
- Local builds do not require Entropic-hosted auth, billing, updater, or
  managed API access.
- Supported contributor docs match the actual workflow.
- Pull request CI runs without private secrets.

## Before Public Launch

- current Rust warning set is burned down
- CI policy for warnings-as-errors is enabled
- Windows bootstrap tests are reliable
- release automation and managed build envs are documented
- review ownership and automation are configured

## Optional but Recommended

- add `CODEOWNERS`
- add actionlint workflow validation
- add a dedicated launch/readiness issue or milestone
