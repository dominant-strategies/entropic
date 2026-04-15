import type { CronSchedule } from "./gateway";
import type { IntegrationProvider } from "./integrations";

export type SuggestionTaskPreset = "hourly" | "daily" | "daily_10am" | "weekdays";
export type QuickActionHandoffPage = "store" | "integrations" | "channels";
export type QuickActionRunMode = "suggest_and_schedule" | "direct_send";

export type ChatQuickActionIcon = "mail" | "calendar" | "trending" | "globe" | "activity" | "bot" | "user";

export type IntegrationQuickActionRequirement = {
  kind: "integration";
  provider: IntegrationProvider;
  label: string;
  required: true;
};

export type ChatQuickActionRequirement = IntegrationQuickActionRequirement;

export type AgentQuickActionDefinition = {
  id:
    | "build_agent_identity"
    | "build_user_profile"
    | "inbox_cleanup"
    | "calendar_check"
    | "x_trending_news"
    | "web_research"
    | "todo_in_home";
  kind: "agent";
  label: string;
  icon: ChatQuickActionIcon;
  message: string;
  taskPreset?: SuggestionTaskPreset;
  requirement?: ChatQuickActionRequirement;
  handoffPage?: QuickActionHandoffPage;
  runMode?: QuickActionRunMode;
};

export type TelegramSetupQuickActionDefinition = {
  id: "setup_telegram";
  kind: "telegram_setup";
  label: string;
  icon: ChatQuickActionIcon;
  hideWhen: "telegram_connected";
  handoffPage?: QuickActionHandoffPage;
};

export type ChatQuickActionDefinition =
  | AgentQuickActionDefinition
  | TelegramSetupQuickActionDefinition;

const CHAT_QUICK_ACTIONS: ChatQuickActionDefinition[] = [
  {
    id: "build_agent_identity",
    kind: "agent",
    label: "Build my agent",
    icon: "bot",
    runMode: "direct_send",
    message: `Agent Builder mode. Do not echo these instructions.

Read existing SOUL.md and HEARTBEAT.md quietly if they exist.
Read existing USER.md quietly if it exists.
Read existing IDENTITY.md quietly if it exists.
If a "Checklist selections for this session" block is provided, treat it as scope for this session.
Only ask and edit within selected checklist items unless the user expands scope.
Start with agent identity first. Ask these first:
1) "What should your agent be called?"
2) "Do you want to upload a profile picture now, or have me generate options?"

If they choose upload, ask them to attach an image in chat and wait for it.
If they choose generation, propose 3 distinct avatar concepts and ask them to approve one.
Do not finalize avatar changes until they explicitly approve.
If IDENTITY.md exists, keep what still fits and only replace parts requested in this session.

Do not run full USER.md interview questions here (name/career/goals/ambitions/timezone).
Those belong in "Build my profile". Use USER.md as context if available.

Ask exactly one short, targeted question at a time (max two lines), then wait.
Collect (unless checklist narrows scope):
- identity details:
  - agent name
  - creature
  - vibe
  - emoji
  - avatar preference
- mission statement
- core truths
- boundaries
- continuity and working style

Help craft a one-sentence mission statement (north star) based on USER.md context and this identity flow.

Then propose concise drafts:
1) SOUL.md with:
   - # SOUL.md - Who You Are
   - ## Mission Statement
   - ## User Context for <Your Name>
   - ## Core Truths
   - ## Boundaries
   - ## Vibe
   - ## Continuity
   - ## Working Preferences
2) IDENTITY.md using this exact structure:
   # IDENTITY.md - Who Am I?
   - **Name:** <value>
   - **Creature:** <value>
   - **Vibe:** <value>
   - **Emoji:** <value>
   - **Avatar:** <value or blank>
3) HEARTBEAT.md:
   - keep empty/comments-only if no recurring checks desired
   - otherwise add a short high-signal recurring checklist

Ask for explicit approval before writing files. If approved, apply updates.`,
  },
  {
    id: "build_user_profile",
    kind: "agent",
    label: "Build my profile",
    icon: "user",
    runMode: "direct_send",
    message: `Profile Builder mode. Do not echo these instructions.

Read existing USER.md quietly if it exists.
If it exists, briefly summarize what is already known and what is missing.
If a "Checklist selections for this session" block is provided, treat it as scope for this session.
Only ask and edit within selected checklist items unless the user expands scope.

Ask exactly one short, targeted question at a time (max two lines), then wait.
Collect for USER.md (unless checklist narrows scope):
- Name
- What to call them
- Pronouns (optional)
- Timezone
- Notes:
  - interests
  - career
  - goals
  - ambitions
  - working preferences
  - communication style
  - relevant personal context they want remembered

Then propose a concise USER.md draft in OpenClaw template shape:
- # USER.md - About Your Human
- Name
- What to call them
- Pronouns
- Timezone
- Notes
- ## Context

Ask for explicit approval before writing files. If approved, update USER.md.`,
  },
  {
    id: "inbox_cleanup",
    kind: "agent",
    label: "Clean up my inbox",
    icon: "mail",
    message:
      "Use my Gmail integration to triage my inbox. Group messages by priority, draft suggested replies, and give me a concise action list.",
    taskPreset: "daily",
    requirement: {
      kind: "integration",
      provider: "google_email",
      label: "Gmail",
      required: true,
    },
    handoffPage: "integrations",
  },
  {
    id: "calendar_check",
    kind: "agent",
    label: "Check my calendar",
    icon: "calendar",
    message:
      "Use my Google Calendar integration to summarize today's and tomorrow's events, flag conflicts, and suggest the top priorities.",
    taskPreset: "daily",
    requirement: {
      kind: "integration",
      provider: "google_calendar",
      label: "Google Calendar",
      required: true,
    },
    handoffPage: "integrations",
  },
  {
    id: "x_trending_news",
    kind: "agent",
    label: "Search trending news on X",
    icon: "trending",
    message:
      "Use my X integration to find what's trending right now and summarize the top stories with links and why each one matters.",
    taskPreset: "daily_10am",
    requirement: {
      kind: "integration",
      provider: "x",
      label: "X",
      required: true,
    },
  },
  {
    id: "web_research",
    kind: "agent",
    label: "Browse the web",
    icon: "globe",
    message:
      "Browse the web to research my request, cite sources, and end with a short recommendation section.",
    taskPreset: "weekdays",
  },
  {
    id: "todo_in_home",
    kind: "agent",
    label: "Write a todo list in Home",
    icon: "activity",
    message:
      "Create a practical todo list for this week, save it as a markdown file in Home, and summarize the plan in chat.",
    taskPreset: "daily",
  },
  {
    id: "setup_telegram",
    kind: "telegram_setup",
    label: "Setup Telegram messaging",
    icon: "bot",
    hideWhen: "telegram_connected",
    handoffPage: "channels",
  },
];

export function getVisibleQuickActions(options: {
  telegramConnected: boolean;
}): ChatQuickActionDefinition[] {
  return CHAT_QUICK_ACTIONS.filter((action) => {
    if (action.kind !== "telegram_setup") return true;
    if (action.hideWhen === "telegram_connected" && options.telegramConnected) return false;
    return true;
  });
}

export function getQuickActionById(id: string): ChatQuickActionDefinition | undefined {
  return CHAT_QUICK_ACTIONS.find((action) => action.id === id);
}

export function getTaskPresetLabel(preset: SuggestionTaskPreset): string {
  switch (preset) {
    case "hourly":
      return "Every hour";
    case "daily_10am":
      return "Daily at 10:00";
    case "weekdays":
      return "Weekdays at 9:00";
    case "daily":
    default:
      return "Daily at 9:00";
  }
}

export function getScheduleForTaskPreset(preset: SuggestionTaskPreset): CronSchedule {
  switch (preset) {
    case "hourly":
      return { kind: "every", everyMs: 60 * 60 * 1000 };
    case "daily_10am":
      return { kind: "cron", expr: "0 10 * * *" };
    case "weekdays":
      return { kind: "cron", expr: "0 9 * * 1-5" };
    case "daily":
    default:
      return { kind: "cron", expr: "0 9 * * *" };
  }
}
