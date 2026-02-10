# Model Routing + Performance Telemetry Spec

## Goal
Reduce perceived latency and total time for tool-heavy chats (calendar/email/X) while keeping quality for complex prompts. Add telemetry to explain where time is spent.

## Non‑Goals
- Changing OpenClaw core behavior.
- Building a full policy engine in the gateway.
- Replacing OpenRouter.

## Scope
Nova (desktop UI + local gateway config) and nova-web (API proxy).

---

## Design Overview
Introduce **tiered routing** and **timing telemetry**:

1. **Fast Tool Model** (default)
   - Low‑latency model for most requests.
   - Optimized for tool selection + short responses.
2. **Reasoning Model** (fallback)
   - Higher quality, slower.
   - Used only when the prompt is complex or the fast model fails.
3. **Image Model** (separate)
   - Dedicated image model (already supported).

Nova decides the model *before* calling the gateway (no OpenClaw core changes), using a simple classifier.

---

## Model Routing Policy

### Inputs
- User prompt (length, tool intent keywords, complexity hints).
- Optional UI toggle (“Prefer accuracy” vs “Prefer speed”).
- Tool‑required prompts (e.g., “calendar”, “email”, “X feed”, “search”).

### Heuristic (initial)
Route to **fast model** unless any of:
- Prompt length > 1,200 chars
- Contains strong reasoning cues: “why”, “prove”, “formal”, “compare deeply”
- Contains multi‑step requests (“step by step”, “plan”, “evaluate tradeoffs”)
- Prior response failure or user explicitly requests accuracy

Otherwise: use fast model.

### Fallbacks
If fast model returns:
- Tool errors or “needs more reasoning”
→ re‑issue with reasoning model (same session).

---

## Telemetry (Nova + nova-web)

### Client Logs (Nova)
Log per run:
- `send_ack`
- `first_delta`
- `tool_payload` (when tool results detected)
- `final`

### Server Logs (nova-web)
Log per request:
- `auth` time
- `upstream_headers`
- `upstream_first_chunk` (streaming)
- `upstream_done`
- OpenRouter headers (provider, processing time)

### Output (Diagnostics Panel)
Show:
- “Time to first token”
- “Time to tool result”
- “Total time”
- “Provider (if available)”

---

## UX

### Settings
Add a **Model Routing** section:
- Default: “Fast (recommended)”
- Optional: “Balanced”, “Reasoning”

### Chat
No new toggle in chat. OpenClaw decides based on Nova routing.

---

## Implementation Plan

### Nova
1. Add simple heuristic in chat send path.
2. Select model before `chat.send`.
3. Add fallback retry if fast model fails.

### nova-web
1. Timing logs already added (use `NOVA_LOG_TIMINGS=1` in prod).
2. Optional: add `x-request-id` propagation to client.

---

## Risks
- Over‑routing to fast model could reduce quality for complex prompts.
- Too many fallback retries could increase cost.

Mitigation: keep heuristic conservative and expose “Prefer accuracy”.

---

## Open Questions
- Should we store per‑user routing preference?
- Do we need model routing for cron/Tasks separately?
- Which fast model is best for tool calls on OpenRouter?

