# Nova + OpenClaw Integrations Context (2026-02-09)

Summary
- Google Calendar/Gmail plugin now uses OpenAI-compatible tool names (underscores) so OpenRouter/OpenAI backends accept tool schemas.
- Nova writes tool allowlist config so optional plugin tools are exposed to the model.
- Gateway health probe moved to WebSocket health RPC (no HTTP /health).
- Runtime image build speedups (layer ordering + persistent staging + build cache).
- Nova integrations store path simplified to credentials dir.

Key changes

Nova (repo: /home/alan/agent/Nova, branch: skills-tasks-files)
- src-tauri/src/commands.rs
  - Ensure tools.alsoAllow includes "nova-integrations" when applying agent settings.
  - Gateway health check now uses WS connect + health RPC (client id: openclaw-probe, token: nova-local-gateway).
- openclaw-runtime/entrypoint.sh
  - Writes tools.alsoAllow ["nova-integrations"] into openclaw.json at boot.
  - Keeps web.search.perplexity baseUrl when NOVA_PROXY_MODE + NOVA_PROXY_BASE_URL set.
- openclaw-runtime/Dockerfile + scripts/build-openclaw-runtime.sh
  - Cache-friendly ordering, persistent staging dir (.build/openclaw-runtime), rsync --delete, BuildKit + cache-from.
- .gitignore includes .build/

OpenClaw (repo: /home/alan/agent/openclaw, branch: nova)
- extensions/nova-integrations/src/calendar-tools.ts
  - Renamed tools: calendar.list -> calendar_list, calendar.create -> calendar_create.
- extensions/nova-integrations/src/gmail-tools.ts
  - Renamed tools: gmail.search -> gmail_search, gmail.get -> gmail_get, gmail.send -> gmail_send.
- extensions/nova-integrations/src/store.ts
  - Resolve credentials dir from OPENCLAW_OAUTH_DIR / OPENCLAW_STATE_DIR (credentials/integrations.json).
  - Use openclaw/plugin-sdk import (no internal path fallback).

Recent commits
- Nova: 6692c6d (Enable nova integrations tool allowlist)
- OpenClaw: 307726bd4 (Rename Nova integration tool names for OpenAI compatibility)
- OpenClaw: 22fa8c7bb (Update nova integrations store path)
- OpenClaw: fca5da3d3 (Revert OpenClaw core tool-name sanitization)

How to pick up changes
- Rebuild OpenClaw and runtime image, then restart container:
  - cd /home/alan/agent/openclaw && pnpm build
  - cd /home/alan/agent/Nova && ./scripts/build-openclaw-runtime.sh
  - docker rm -f nova-openclaw && relaunch Nova
- Start a new chat session so the updated tool list is injected.

Expected tool names in model
- calendar_list, calendar_create, gmail_search, gmail_get, gmail_send

Notes
- TOOLS.md is user guidance only; tool availability is controlled by tools.allow/alsoAllow + plugin optional allowlist.
