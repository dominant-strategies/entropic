# OAuth Bridge Context (Nova ↔ OpenClaw)

Date: 2026-02-08

## Goal
User wants **Nova UI OAuth** (Supabase) to connect skills and then **push tokens locally into OpenClaw**, so day‑to‑day Gmail/Calendar/etc actions do **not** depend on the backend. Agentic flows should still be executed by OpenClaw.

## Key Clarifications
- Supabase OAuth tokens live in Supabase (`user_integrations`) and are fetched via `integrations-token` edge function; Nova uses them to call Gmail/Calendar APIs.
- OpenClaw does **not** read Supabase tokens and does not have Gmail send/read as a built‑in tool (OpenClaw Gmail docs cover Pub/Sub watch for inbound events).
- Plugins are the right mechanism to add new tools like `gmail.send`, `calendar.list`, `slack.post`, etc.

## Desired UX
- User clicks **Connect Gmail/Calendar/Slack/Figma** in Nova UI.
- Browser OAuth completes.
- Nova **exports tokens** and **pushes them into local OpenClaw**.
- OpenClaw tools use local tokens to call provider APIs directly (no backend dependency after connect).

## Proposed Architecture (Token Push)
1. Supabase Edge Function: `integrations-token-export`
   - Authenticated; returns encrypted token bundle for a provider.
2. Nova Desktop:
   - Fetch OpenClaw `integrations.pubkey`.
   - Call `integrations-token-export` with nonce + device_id.
   - Call OpenClaw `integrations.import` to store tokens locally.
3. OpenClaw:
   - Stores tokens in local vault.
   - Plugin tools (gmail/calendar/slack/figma) use local tokens directly.

## Notes / Open Questions
- How to handle Pub/Sub Gmail watch if needed (OpenClaw’s existing Gmail webhook flow is separate).
- Whether to support a second "local OAuth" flow inside OpenClaw to avoid Supabase entirely.
- Token sync across devices (not required for local‑only flow).

## Why Plugins
Plugins can register tools and RPC handlers in OpenClaw. That’s how Gmail/Calendar/etc capabilities should be exposed to the agent.

