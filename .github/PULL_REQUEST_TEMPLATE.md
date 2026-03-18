## Summary

<!-- Describe what changed and why. -->

## Validation

- [ ] `pnpm install --frozen-lockfile` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm build` passes
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` passes
- [ ] `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` passes
- [ ] GitHub checks are green (`CI`, `Actionlint`, `security-lint`)
- [ ] Docs updated (if setup or contributor workflow changed)

## Affected platforms and profiles

These boxes describe scope, not test coverage. Check all that apply:

- [ ] macOS
- [ ] Linux
- [ ] Windows / WSL
- [ ] `local` build profile
- [ ] `managed` build profile

## Notes

<!-- If this change touches auth, billing, updater, runtime, or Windows bootstrap behavior, describe the impact here. Otherwise delete this section. -->
