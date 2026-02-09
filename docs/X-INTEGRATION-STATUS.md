# X Integration Status (Nova)

Date: 2026-02-09

## Summary
Nova X integration is wired end-to-end for OAuth connect + API proxy, with billing in nova-web and tools exposed via `nova-x` OpenClaw plugin. Tokens are stored in Supabase `user_integrations` with PKCE state stored in `oauth_states` (code verifier).

## Repos & Commits
- `nova-web`: `bc27a12` — Add X OAuth endpoints and PKCE state.
- `Nova`: `557ec73` — Add X integration connect flow (Store UI + auth/deeplink refresh).
- `nova-skills`: `23d05cd` — Add `nova-x` plugin (tools + README + diagram).

## Nova (Desktop)
- Store UI shows X integration card under **Social**.
- Connect/Disconnect uses nova-web `/x/oauth/*` endpoints.
- Deep-link `nova://integrations/success` (and `nova-dev://…` in dev) triggers refresh (`nova-integration-updated`).
- Env:
  - `.env.example`: `VITE_INTEGRATIONS_REDIRECT_URL`, `VITE_AUTH_*`, etc.
  - `.env.development`: includes `VITE_INTEGRATIONS_REDIRECT_URL="nova-dev://integrations/success"`.

## nova-web (API)
### New endpoints
- `POST /api/x/oauth/start`
- `GET /api/x/oauth/callback`
- `GET /api/x/oauth/status`
- `POST /api/x/oauth/disconnect`

### Token storage
- Supabase `user_integrations` (provider `x`) stores access/refresh tokens and scopes.
- PKCE verifier stored in `oauth_states.code_verifier`.

### Auth
- Endpoints accept either Supabase JWT or gateway token (`gw_*`).

### Config (.env)
- `X_CLIENT_ID`
- `X_CLIENT_SECRET` (optional for PKCE; used for refresh + token exchange if present)
- `X_REDIRECT_URI` (e.g., `http://localhost:3000/api/x/oauth/callback`)
- `X_OAUTH_SCOPES` (default: `tweet.read users.read offline.access`)
- Optional: `X_BEARER_TOKEN` for app-only access.
- Optional pricing: `X_COST_*_CENTS`.

### Migration
- `nova-web/supabase/migrations/20260209000000_add_oauth_state_verifier.sql` adds `code_verifier` and updates `create_oauth_state` + `validate_oauth_state`.

## nova-skills / OpenClaw plugin
- Plugin: `nova-x` (in `/home/alan/agent/nova-skills/nova-x`).
- Tools: `x_search`, `x_profile`, `x_thread`, `x_user_tweets`.
- Tools call nova-web endpoints with `Authorization: Bearer <gateway_token>`.
- Requires `NOVA_WEB_BASE_URL` in container (set by Nova).

## Local Testing Checklist
1) Set `X_CLIENT_ID`, `X_CLIENT_SECRET` (optional), `X_REDIRECT_URI` in `nova-web/.env.local`.
2) Run `supabase db push` (apply migration).
3) Start nova-web (`pnpm dev`).
4) Start Nova (`WEBKIT_DISABLE_COMPOSITING_MODE=1 pnpm tauri:dev`).
5) Connect X from Store UI; browser opens X OAuth; redirect to `nova-dev://integrations/success`.
6) Verify `GET /api/x/oauth/status` returns `connected: true`.
7) Use X tools in chat (via `nova-x` plugin) and confirm billing deductions.

## Known TODOs
- Add user-context timeline endpoints (home timeline) and tools if needed.
- Optional: store X metadata (username, name) more robustly for display.
- Consider adding explicit “Reconnect” UI state on token expiry.
