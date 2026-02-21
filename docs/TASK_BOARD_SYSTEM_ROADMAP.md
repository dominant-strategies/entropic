# Task Board System Roadmap (Nova-first, Minimal OpenClaw)

## Outcome
Deliver a shared task board for Entropic where natural chat can manage tasks, jobs run on cron, and heartbeat always reviews active work, without adding invasive OpenClaw task RPC/tool surface.

## Direction (Chosen)
- Keep OpenClaw unchanged for task-board RPC/tooling.
- Use Nova as the task-board orchestration layer.
- Reuse existing OpenClaw primitives only:
  - `cron.list/add/update/remove/run/runs` for Jobs.
  - `agent` (with `extraSystemPrompt`) for heartbeat task context.

## Design Principles
- No slash-command dependency: natural chat intent should be enough.
- Minimal OpenClaw footprint: only existing stable APIs.
- Explicit ownership: Tasks are Nova-owned, Jobs are OpenClaw cron-owned.
- Clear join model: `taskId <-> cronJobId` link managed by Nova.
- No hidden writes: every mutation gets user-visible confirmation.

## Shared Contract
- Board statuses: `backlog | todo | in_progress | blocked | done`
- Priorities: `low | medium | high | critical`
- Jobs source: OpenClaw cron APIs
- Task source: Nova task board store/capability layer

## Current Baseline (Nova)
- Tasks board + Jobs tabs are unified in Tasks screen.
- Chat can create task cards from high-confidence natural language patterns.
- Board refresh events sync Chat and Tasks UI (`entropic-task-board-updated`).
- Heartbeat checks can be driven from Nova context injection.

---

## Phase 1: Stabilize Nova-owned Board
### Nova files
- `src/lib/taskBoard.ts`
  - Canonical task schema, parsing, and persistence helpers.
  - Intent parsing for natural chat create-task flows.
- `src/pages/Chat.tsx`
  - Detect task intents and mutate board through shared task-board helpers.
  - Emit board update event after mutation.
- `src/pages/Tasks.tsx`
  - Load/render board state and keep in sync with chat/job events.

### OpenClaw files
- No new task-board methods/tools.

### Acceptance Criteria
- `add task to backlog: tighten oauth retry logic #auth priority: high` creates a card.
- Board updates appear in Tasks UI without manual refresh.
- OpenClaw does not require `task.board.*` methods.

---

## Phase 2: Chat + Jobs Linkage
### Nova files
- `src/pages/Chat.tsx`
  - Expand intents for move/update/done/block/link job.
  - Add confirmations for destructive operations.
- `src/pages/Tasks.tsx`
  - Link/unlink tasks to cron jobs in the UI.
  - Show job health signals (last run, failure, next run) on linked tasks.
- `src/lib/gateway.ts`
  - Continue using existing cron methods as the only job backend.

### OpenClaw files
- No required changes.

### Acceptance Criteria
- Natural chat can create and link a task + job flow end-to-end.
- Linked job status is visible on each related task card.
- No OpenClaw task-specific RPC additions.

---

## Phase 3: Heartbeat Intelligence (without new task RPC)
### Nova files
- Build compact task digest from board state:
  - blocked tasks,
  - overdue tasks,
  - stale in-progress tasks.
- Inject digest through chat/agent calls as `extraSystemPrompt` on heartbeat runs.

### OpenClaw files
- Optional only: heartbeat behavior tuning if needed, using existing `agent`/cron pathways.

### Acceptance Criteria
- Heartbeat always checks task state per OpenClaw heartbeat cadence.
- Alerts are concise and actionable.
- Implementation stays within existing OpenClaw interfaces.

---

## Non-Functional Requirements
- Backward compatible migration for users with no existing task board state.
- Validation around task mutation payloads and merge safety.
- Telemetry on mutation success/failure and job-link reliability.

## Suggested Rollout
1. Finalize Phase 1 Nova task-board capability.
2. Ship Phase 2 task-job linking UX.
3. Add Phase 3 heartbeat digest injection.
