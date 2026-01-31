# Zara Improvements Roadmap

## Security Improvements

### High Priority
- [ ] **Random gateway token**: Generate cryptographically random token on first launch, store in system keychain (macOS Keychain, Linux Secret Service)
- [ ] **Docker socket proxy**: If sandbox containers needed, use tecnativa/docker-socket-proxy to filter dangerous API calls
- [ ] **TLS for gateway**: Add self-signed cert for localhost communication (defense in depth)
- [ ] **Code signing**: Sign macOS app with Developer ID, Windows with Authenticode

### Medium Priority
- [ ] **Sandbox containers**: Complete two-layer model where OpenClaw spawns isolated containers for untrusted actions
- [ ] **Network isolation**: Create dedicated Docker network for Zara containers
- [ ] **Resource limits**: Add `--memory`, `--cpus` limits to containers
- [ ] **Seccomp profile**: Custom seccomp profile for minimal syscall surface

## UX Improvements

### Onboarding
- [ ] **Setup wizard**: Guide users through Docker installation, API key configuration
- [ ] **Pre-built images**: Push openclaw-runtime to ghcr.io or Docker Hub
- [ ] **Auto-pull**: Automatically pull latest runtime image on first launch

### Settings UI
- [ ] **API keys management**: Secure input for OpenAI, Anthropic, etc.
- [ ] **Model selection**: Choose default agent model
- [ ] **Channel configuration**: Discord, Telegram, WhatsApp setup

### Distribution
- [ ] **macOS DMG**: Bundle Colima + Docker CLI for 1-click install
- [ ] **Linux packages**: .deb, .rpm, AppImage
- [ ] **Windows installer**: WSL2 auto-setup or Docker Desktop detection
- [ ] **Auto-updates**: Tauri updater plugin with signed updates

## Technical Debt

- [ ] **Error handling**: Better error messages in UI, not just console logs
- [ ] **Logging UI**: Show gateway logs in the app (the "Logs" card)
- [ ] **Health check robustness**: Handle WebSocket-only endpoints, retry logic
- [ ] **State persistence**: Remember gateway state across app restarts
