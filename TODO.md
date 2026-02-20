# Entropic TODO

## Completed

- [x] Colima UX: first-run setup, status, and recovery flow — `SetupScreen` + `run_first_time_setup` in Rust with VZ/QEMU fallback, download progress, error recovery with cleanup retry
- [x] Colima security posture — Isolated home (`~/.entropic/colima`, `0700`), dedicated profiles, system Docker socket excluded by default
- [x] Hardened container defaults — `--cap-drop=ALL`, `--read-only`, `--security-opt no-new-privileges`, `--user 1000:1000`, tmpfs
- [x] Docker socket isolation — All Docker commands pinned to Colima socket via `get_docker_host()`. No socket mounted into runtime container. System/Desktop sockets require explicit `ENTROPIC_RUNTIME_ALLOW_DOCKER_DESKTOP=1`.
- [x] Per-install gateway auth token — Generated per-session, passed as env to container
- [x] Signed builds + notarization — `release.yml` with certificate import, binary signing, notarytool, stapling. Local script also available.
- [x] Auto-updater — `tauri-plugin-updater` v2.10, silent check-on-launch, signed `latest.json` on GitHub Releases
- [x] Linux builds — AppImage via `release-linux.yml`

## Product
- [ ] Ship with QMD (https://github.com/tobi/qmd) bundled and enabled

## Security
- [ ] Secrets storage: keychain/secure storage for provider tokens and channel creds
- [ ] Resource limits for runtime container (`--memory`, `--cpus`, `--pids-limit`, `--ulimit nofile=...`)
- [ ] Host helper auth: localhost-only + token + allowlist enforcement (iMessage/other bridges)

## Platform
- [ ] Windows builds
