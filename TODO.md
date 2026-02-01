# Zara TODO

## Product
- [ ] Ship with QMD (https://github.com/tobi/qmd) bundled and enabled

## Runtime / Isolation
- [ ] Colima UX: first-run setup, status, and recovery flow
- [ ] Colima security posture: limit VM networking + locked-down defaults

## Security
- [ ] Hardened container defaults (no-new-privileges, read-only FS, seccomp/apparmor baseline)
- [ ] Secrets storage: keychain/secure storage for provider tokens and channel creds
- [ ] Per-install gateway auth token (rotate on restart; avoid hardcoded token)
- [ ] Resource limits for runtime container (memory/cpu/pids/ulimits)
- [ ] Docker socket proxy or restricted API access for runtime control
- [ ] Signed builds + notarization for macOS; secure auto-updater pipeline
