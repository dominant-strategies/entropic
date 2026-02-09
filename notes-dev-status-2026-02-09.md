# Nova/OpenClaw Dev Status — 2026-02-09

## Summary
- Stabilized scheduled tasks (cron) and run history display.
- Added guard-rail instructions for cron agent turns to avoid `cron`, `gateway`, and `exec` tool usage.
- Fixed cron history parsing to use OpenClaw `entries` payload and display summary/error/duration.
- Throttled Supabase auth refresh to prevent `/token` 429s that caused “Not authenticated” flapping.
- Added Chat session list to sidebar and “New Chat” entry.

## Key Fixes
1) **Cron payload + session target**
- Scheduled tasks use `sessionTarget: isolated` (required for `agentTurn` payloads).
- Main-lane jobs require `payload.kind=systemEvent`, so cron remains isolated.
- Guard-rail instructions appended to cron message to avoid calling `cron`, `gateway`, `exec`.
- Existing tasks must be edited + saved once to apply new payload.

2) **Cron run history**
- OpenClaw `cron.runs` returns `{ entries: [...] }` with fields: `ts`, `runAtMs`, `durationMs`, `summary`, `status`.
- Nova now maps `entries` into a unified `CronRunLogEntry` and displays:
  - time (no more “Invalid Date”)
  - duration (from `durationMs`)
  - status (ok/error/skipped)
  - summary or error

3) **Auth refresh throttling**
- Prevents repeated `refreshSession()` calls that triggered 429s.
- Refresh only when token is near expiry; dedupe in-flight refreshes.
- OAuth pending polling no longer calls refresh every second.

4) **Chat navigation**
- Sidebar shows recent chat sessions and a dedicated “New Chat” entry.

## Commits (Nova)
- `5d45426` Fix scheduled task payload defaults
- `3b679ef` Improve task run history details
- `45f4ea2` Throttle auth refresh to prevent 429s

## Files Touched (Nova)
- `src/pages/Tasks.tsx` (cron payload guard-rails, history display improvements)
- `src/lib/gateway.ts` (cron history parsing; supports `entries`)
- `src/lib/auth.ts` (refresh throttling + dedupe)
- `src/contexts/AuthContext.tsx` (avoid aggressive refresh polling)
- `src/components/Layout.tsx` + `src/pages/Dashboard.tsx` (chat sessions in sidebar)

## Known Issues / Follow-ups
- Verify profile photo upload no longer logs out (was likely 429 refresh storm).
- If cron still calls tools, consider explicit tool allowlist for scheduled runs (would require OpenClaw change).

## Operational Notes
- Cron run logs are stored by OpenClaw with `summary` + `error`; full output is not saved.
- To apply new cron payload, edit + save existing tasks once.
