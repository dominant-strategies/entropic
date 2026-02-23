import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  CalendarClock,
  Plus,
  Play,
  Pencil,
  Clock,
  Trash2,
  X,
  Smartphone,
  Info,
  ChevronRight,
  CheckCircle2,
  AlertCircle,
  MoreHorizontal,
  History,
  Loader2,
  Sparkles,
} from "lucide-react";
import clsx from "clsx";
import { invoke } from "@tauri-apps/api/core";
import {
  GatewayClient,
  createGatewayClient,
  type ChatEvent,
  type CronJob,
  type CronSchedule,
  type CronPayload,
  type CronRunLogEntry,
} from "../lib/gateway";
import { resolveGatewayAuth } from "../lib/gateway-auth";
import { getIntegrations, getIntegrationsCached, type Integration } from "../lib/integrations";

type Props = {
  gatewayRunning: boolean;
  view?: PlannerView;
};

const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:19789";

function formatScheduleTime(hour: number, minute: number): string {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function describeSchedule(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case "at":
      return `One-time on ${new Date(schedule.atMs).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
    case "every": {
      const ms = schedule.everyMs;
      if (ms < 60_000) return `Every ${Math.max(1, Math.round(ms / 1000))} seconds`;
      if (ms < 3_600_000) return `Every ${Math.max(1, Math.round(ms / 60_000))} minutes`;
      if (ms < 86_400_000) {
        const hours = Math.max(1, Math.round(ms / 3_600_000));
        return hours === 1 ? "Every hour" : `Every ${hours} hours`;
      }
      const days = Math.max(1, Math.round(ms / 86_400_000));
      return days === 1 ? "Every day" : `Every ${days} days`;
    }
    case "cron": {
      const parsed = parseCron(schedule.expr);
      if (!parsed) return `Custom cron (${schedule.expr})`;
      const time = formatScheduleTime(parsed.hour, parsed.minute);
      switch (parsed.days) {
        case "*":
          return `Daily at ${time}`;
        case "1-5":
          return `Weekdays at ${time}`;
        case "0,6":
          return `Weekends at ${time}`;
        case "1,3,5":
          return `Mon, Wed, Fri at ${time}`;
        default:
          return `Custom schedule at ${time}`;
      }
    }
    default:
      return "Unknown schedule";
  }
}

function statusBadge(job: CronJob) {
  if (!job.enabled) return { label: "Disabled", className: "bg-gray-100 text-gray-500 border-gray-200" };
  if (job.state === "running") return { label: "Running", className: "bg-amber-50 text-amber-600 border-amber-100" };
  if (job.state === "error") return { label: "Error", className: "bg-red-50 text-red-600 border-red-100" };
  return { label: "Active", className: "bg-green-50 text-green-600 border-green-100" };
}

function formatRunTime(run: CronRunLogEntry): string {
  const ts = run.startedAt ?? run.runAtMs ?? run.ts;
  if (!Number.isFinite(ts)) return "Unknown time";
  return new Date(ts as number).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function formatRunDuration(run: CronRunLogEntry): string | null {
  if (Number.isFinite(run.durationMs)) {
    return `${((run.durationMs as number) / 1000).toFixed(1)}s`;
  }
  if (Number.isFinite(run.startedAt) && Number.isFinite(run.finishedAt)) {
    const delta = (run.finishedAt as number) - (run.startedAt as number);
    if (Number.isFinite(delta)) return `${(delta / 1000).toFixed(1)}s`;
  }
  return null;
}

const CRON_GUARD_LINES = [
  "This is a scheduled run. Do NOT create, edit, or run cron jobs.",
  "Do NOT use gateway or exec tools. Just perform the task now and report results.",
];
const CRON_GUARD_BLOCK = `${CRON_GUARD_LINES.join("\n")}\n\n`;

function stripCronGuards(message: string): string {
  const trimmed = message ?? "";
  if (trimmed.startsWith(CRON_GUARD_BLOCK)) {
    return trimmed.slice(CRON_GUARD_BLOCK.length);
  }
  const guardLineBlock = CRON_GUARD_LINES.join("\n");
  if (trimmed.startsWith(guardLineBlock)) {
    const remainder = trimmed.slice(guardLineBlock.length);
    return remainder.replace(/^\n\n?/, "");
  }
  return trimmed;
}

type ScheduleType = "every" | "at" | "cron";
type SchedulePreset = "every_hour" | "daily" | "weekdays" | "weekends" | "mwf" | "once" | "custom";

type EditorState = {
  name: string;
  description: string;
  scheduleType: ScheduleType;
  schedulePreset: SchedulePreset;
  scheduleTime: string;
  intervalMinutes: string;
  atDate: string;
  cronExpr: string;
  message: string;
  sessionTarget: "main" | "isolated";
  enabled: boolean;
  skillIds: string[];
  notifyEnabled: boolean;
  notifyChannel: string;
  notifyTo: string;
};

const defaultEditor: EditorState = {
  name: "",
  description: "",
  scheduleType: "every",
  schedulePreset: "custom",
  scheduleTime: "09:00",
  intervalMinutes: "5",
  atDate: "",
  cronExpr: "",
  message: "",
  sessionTarget: "isolated",
  enabled: true,
  skillIds: [],
  notifyEnabled: false,
  notifyChannel: "",
  notifyTo: "",
};

type SkillOption = {
  id: string;
  label: string;
  source: "integration" | "plugin";
  description?: string;
  hint?: string;
};

const INTEGRATION_LABELS: Record<string, { label: string; hint?: string }> = {
  google_calendar: {
    label: "Google Calendar",
    hint: "Use the Google Calendar integration to ",
  },
  google_email: {
    label: "Gmail",
    hint: "Use the Gmail integration to ",
  },
  google_calendar_email: {
    label: "Google Calendar + Gmail",
    hint: "Use Google Calendar and Gmail to ",
  },
};

const PLUGIN_LABELS: Record<string, string> = {
  discord: "Discord",
  telegram: "Telegram",
  slack: "Slack",
  googlechat: "Google Chat",
};

const SCHEDULE_PRESETS: Array<{ id: SchedulePreset; label: string; needsTime?: boolean }> = [
  { id: "every_hour", label: "Hourly" },
  { id: "daily", label: "Daily", needsTime: true },
  { id: "weekdays", label: "Weekdays", needsTime: true },
  { id: "weekends", label: "Weekends", needsTime: true },
  { id: "mwf", label: "MWF", needsTime: true },
  { id: "once", label: "One-time", needsTime: true },
  { id: "custom", label: "Custom" },
];

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function buildCronExpr(time: string, days: string): string {
  const [hh, mm] = time.split(":");
  const hour = Math.min(23, Math.max(0, parseInt(hh || "0", 10)));
  const minute = Math.min(59, Math.max(0, parseInt(mm || "0", 10)));
  return `${minute} ${hour} * * ${days}`;
}

function parseCron(expr: string): { minute: number; hour: number; days: string } | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minStr, hourStr, _dom, _mon, dow] = parts;
  const minute = Number(minStr);
  const hour = Number(hourStr);
  if (!Number.isFinite(minute) || !Number.isFinite(hour)) return null;
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
  return { minute, hour, days: dow };
}

function toLocalInputValue(ms: number): string {
  const date = new Date(ms);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function inferPreset(schedule: CronSchedule): { preset: SchedulePreset; time?: string } {
  if (schedule.kind === "at") {
    const date = new Date(schedule.atMs);
    const hours = date.getHours().toString().padStart(2, "0");
    const minutes = date.getMinutes().toString().padStart(2, "0");
    return { preset: "once", time: `${hours}:${minutes}` };
  }
  if (schedule.kind === "every") {
    if (Math.round(schedule.everyMs / 60_000) === 60) {
      return { preset: "every_hour" };
    }
    return { preset: "custom" };
  }
  const parsed = parseCron(schedule.expr);
  if (!parsed) return { preset: "custom" };
  const time = `${pad2(parsed.hour)}:${pad2(parsed.minute)}`;
  switch (parsed.days) {
    case "*":
      return { preset: "daily", time };
    case "1-5":
      return { preset: "weekdays", time };
    case "0,6":
      return { preset: "weekends", time };
    case "1,3,5":
      return { preset: "mwf", time };
    default:
      return { preset: "custom", time };
  }
}

function editorFromJob(job: CronJob): EditorState {
  const inferred = inferPreset(job.schedule);
  const state: EditorState = {
    ...defaultEditor,
    name: job.name,
    description: job.description || "",
    enabled: job.enabled,
    schedulePreset: inferred.preset,
    scheduleTime: inferred.time || defaultEditor.scheduleTime,
  };

  switch (job.schedule.kind) {
    case "every":
      state.scheduleType = "every";
      state.intervalMinutes = String(Math.round(job.schedule.everyMs / 60_000));
      break;
    case "at":
      state.scheduleType = "at";
      state.atDate = toLocalInputValue(job.schedule.atMs);
      break;
    case "cron":
      state.scheduleType = "cron";
      state.cronExpr = job.schedule.expr;
      break;
  }

  switch (job.payload.kind) {
    case "systemEvent":
      state.message = job.payload.text;
      state.sessionTarget = job.sessionTarget || "main";
      break;
    case "agentTurn":
      state.message = stripCronGuards(job.payload.message || "");
      state.sessionTarget = job.sessionTarget || "isolated";
      state.notifyEnabled = job.payload.deliver === true;
      state.notifyChannel = job.payload.channel || "";
      state.notifyTo = job.payload.to || "";
      break;
  }

  return state;
}

function buildSkillHint(skills: SkillOption[]): string {
  if (skills.length === 0) return "";
  if (skills.length === 1 && skills[0].hint) return skills[0].hint;
  const labels = skills.map((skill) => skill.label).join(", ");
  return `Use ${labels} to `;
}

function buildGeneratePrompt(editor: EditorState, selected: SkillOption[]): string {
  const goal = editor.description.trim() || editor.name.trim() || "this task";
  const skillLabels = selected.map((skill) => skill.label);
  const skillsLine =
    skillLabels.length > 0
      ? `Selected plugins: ${skillLabels.join(", ")}`
      : "Selected plugins: none";

  return [
    "You are helping a user create a scheduled job for Entropic/OpenClaw.",
    `Job name: ${editor.name.trim() || "(untitled)"}`,
    `Task description: ${editor.description.trim() || "(none)"}`,
    `Goal: ${goal}`,
    skillsLine,
    "",
    "Infer the most likely user intent from the name/description and selected plugins.",
    "Write the job instructions the agent should run on each schedule.",
    "Requirements:",
    "- Use the selected plugins explicitly by name if provided.",
    "- Keep it concise and actionable.",
    "- Output only the job instructions (no preamble or explanations).",
    "- Use a short 'Steps' list and an 'Output' section.",
  ].join("\n");
}

function waitForChatCompletion(
  client: GatewayClient,
  runId: string,
  timeoutMs = 20_000
): Promise<string> {
  return new Promise((resolve, reject) => {
    let lastText = "";
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for OpenClaw response"));
    }, timeoutMs);

    const handler = (event: ChatEvent) => {
      if (!event?.runId || event.runId !== runId) return;
      if (event.state === "delta" || event.state === "final") {
        let text = "";
        if (typeof event.message?.content === "string") {
          text = event.message.content;
        } else if (Array.isArray(event.message?.content)) {
          text = event.message.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text || "")
            .join("");
        }
        if (text) lastText = text;
        if (event.state === "final") {
          cleanup();
          window.dispatchEvent(new Event("entropic-local-credits-changed"));
          resolve(lastText.trim());
        }
      } else if (event.state === "error") {
        cleanup();
        window.dispatchEvent(new Event("entropic-local-credits-changed"));
        reject(new Error(event.errorMessage || "OpenClaw error"));
      } else if (event.state === "aborted") {
        cleanup();
        window.dispatchEvent(new Event("entropic-local-credits-changed"));
        reject(new Error("OpenClaw generation aborted"));
      }
    };

    function cleanup() {
      window.clearTimeout(timer);
      client.off("chat", handler);
    }

    client.on("chat", handler);
  });
}

type HistoryMessage = {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
};

function extractLatestAssistantMessage(messages: HistoryMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    const text =
      msg.content
        ?.filter((c) => c?.type === "text")
        .map((c) => c?.text || "")
        .join("") || "";
    if (text.trim()) return text.trim();
  }
  return "";
}

async function resolveGatewayConnection(): Promise<{ wsUrl: string; token: string }> {
  const { wsUrl, token } = await resolveGatewayAuth();
  return {
    wsUrl: wsUrl || DEFAULT_GATEWAY_URL,
    token,
  };
}

function editorToSchedule(editor: EditorState): CronSchedule {
  switch (editor.scheduleType) {
    case "every":
      return { kind: "every", everyMs: (parseFloat(editor.intervalMinutes) || 5) * 60_000 };
    case "at":
      return {
        kind: "at",
        atMs: Number.isFinite(Date.parse(editor.atDate))
          ? Date.parse(editor.atDate)
          : Date.now(),
      };
    case "cron":
      return { kind: "cron", expr: editor.cronExpr || "0 * * * *" };
  }
}

function editorToPayload(editor: EditorState): CronPayload {
  const baseMessage = stripCronGuards(editor.message || "Hello");
  const message = `${CRON_GUARD_BLOCK}${baseMessage}`;
  const payload: CronPayload = {
    kind: "agentTurn",
    message,
  };

  if (editor.notifyEnabled) {
    payload.deliver = true;
    payload.channel = editor.notifyChannel || "last";
    if (editor.notifyTo.trim()) {
      payload.to = editor.notifyTo.trim();
    }
    // best-effort so delivery failures don't kill the entire job run
    payload.bestEffortDeliver = true;
  } else {
    // Explicitly disable delivery to prevent the runtime from attempting it
    payload.deliver = false;
  }

  return payload;
}

type PlannerTab = "tasks" | "jobs";
type PlannerView = "tasks" | "jobs" | "all";
type TaskBoardStatus = "todo" | "in_progress" | "blocked" | "done";
type TaskBoardPriority = "low" | "medium" | "high" | "critical";
type TaskBoardOwner = "user" | "agent";

type TaskBoardItem = {
  id: string;
  title: string;
  description: string;
  status: TaskBoardStatus;
  priority: TaskBoardPriority;
  owner: TaskBoardOwner;
  labels: string[];
  dueAt?: string;
  linkedJobId?: string;
  createdAt: number;
  updatedAt: number;
};

type TaskBoardDoc = {
  version: 1;
  updatedAt: number;
  tasks: TaskBoardItem[];
};

type TaskEditorState = {
  title: string;
  description: string;
  status: TaskBoardStatus;
  priority: TaskBoardPriority;
  owner: TaskBoardOwner;
  dueAt: string;
  labelsInput: string;
};

type QuickTaskErrorKind = "generic" | "billing" | "auth";
type QuickTaskErrorState = {
  message: string;
  kind: QuickTaskErrorKind;
};

const TASK_BOARD_JSON_PATH = "tasks/board.json";
const TASK_BOARD_MARKDOWN_PATH = "TASKS.md";
const HEARTBEAT_PATH = "HEARTBEAT.md";
const HEARTBEAT_TASK_BLOCK_START = "<!-- ENTROPIC_TASK_BOARD:START -->";
const HEARTBEAT_TASK_BLOCK_END = "<!-- ENTROPIC_TASK_BOARD:END -->";
const HEARTBEAT_TASK_LINE =
  "- Review TASKS.md and active board items. Surface blockers, deadlines, and next actions.";

const TASK_BOARD_STATUS_ORDER: TaskBoardStatus[] = [
  "todo",
  "in_progress",
  "blocked",
  "done",
];

const TASK_BOARD_PRIORITY_ORDER: TaskBoardPriority[] = [
  "critical",
  "high",
  "medium",
  "low",
];

const TASK_BOARD_COLUMN_META: Record<TaskBoardStatus, { label: string; accent: string }> = {
  todo: { label: "TODO", accent: "text-blue-600" },
  in_progress: { label: "IN PROGRESS", accent: "text-indigo-600" },
  blocked: { label: "BLOCKED", accent: "text-rose-600" },
  done: { label: "DONE", accent: "text-emerald-600" },
};

type BoardCleanupAction = "remove_done" | "remove_in_progress" | "remove_todo" | "clear_all";

const BOARD_CLEANUP_ACTION_LABEL: Record<BoardCleanupAction, string> = {
  remove_done: "Remove all from DONE",
  remove_in_progress: "Remove all from IN PROGRESS",
  remove_todo: "Remove all from TODO",
  clear_all: "Clear entire board",
};

const QUICK_TASK_BILLING_MESSAGE =
  "You're out of credits. Add credits to keep creating tasks with OpenClaw.";

const defaultTaskEditorState: TaskEditorState = {
  title: "",
  description: "",
  status: "todo",
  priority: "medium",
  owner: "user",
  dueAt: "",
  labelsInput: "",
};

function encodeUtf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.slice(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function parseTaskLabels(raw: string): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const part of raw.split(",")) {
    const normalized = part.trim().replace(/\s+/g, " ");
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(normalized);
  }
  return labels;
}

function formatTaskDueDate(value?: string): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toLocaleDateString([], { month: "short", day: "numeric" });
}

function taskPriorityClass(priority: TaskBoardPriority): string {
  switch (priority) {
    case "critical":
      return "bg-red-50 text-red-600 border-red-100";
    case "high":
      return "bg-orange-50 text-orange-600 border-orange-100";
    case "low":
      return "bg-slate-100 text-slate-500 border-slate-200";
    case "medium":
    default:
      return "bg-blue-50 text-blue-600 border-blue-100";
  }
}

function taskOwnerClass(owner: TaskBoardOwner): string {
  if (owner === "agent") {
    return "bg-violet-50 text-violet-700 border-violet-200";
  }
  return "bg-sky-50 text-sky-700 border-sky-200";
}

function formatTaskOwnerLabel(owner: TaskBoardOwner): string {
  return owner === "agent" ? "Agent" : "You";
}

function isTaskBoardStatus(value: unknown): value is TaskBoardStatus {
  return value === "todo" || value === "in_progress" || value === "blocked" || value === "done";
}

function normalizeTaskStatus(value: unknown): TaskBoardStatus {
  if (value === "backlog") return "todo";
  return isTaskBoardStatus(value) ? value : "todo";
}

function isTaskBoardPriority(value: unknown): value is TaskBoardPriority {
  return value === "low" || value === "medium" || value === "high" || value === "critical";
}

function isTaskBoardOwner(value: unknown): value is TaskBoardOwner {
  return value === "user" || value === "agent";
}

function normalizeTaskOwner(value: unknown, labels: string[]): TaskBoardOwner {
  if (isTaskBoardOwner(value)) return value;
  if (typeof value === "string") {
    const normalized = value.toLowerCase().trim();
    if (normalized === "me" || normalized === "myself" || normalized === "human" || normalized === "user") {
      return "user";
    }
    if (
      normalized === "agent" ||
      normalized === "assistant" ||
      normalized === "openclaw" ||
      normalized === "entropic" ||
      normalized === "ai"
    ) {
      return "agent";
    }
  }
  for (const label of labels) {
    const normalized = label.toLowerCase().trim();
    if (normalized === "agent" || normalized === "assistant" || normalized === "openclaw") {
      return "agent";
    }
    if (normalized === "user" || normalized === "me" || normalized === "myself") {
      return "user";
    }
  }
  return "user";
}

function inferTaskOwnerFromPrompt(prompt: string): TaskBoardOwner {
  const lower = prompt.toLowerCase();
  if (
    /\b(agent|assistant|openclaw|entropic|ai|bot)\b/.test(lower) ||
    /\bfor\s+(the\s+)?agent\b/.test(lower)
  ) {
    return "agent";
  }
  return "user";
}

function isQuickTaskBillingIssueMessage(raw?: string | null): boolean {
  if (!raw) return false;
  const message = raw.toLowerCase();
  return (
    message.includes("insufficient credits") ||
    message.includes("out of credits") ||
    message.includes("out of free credits") ||
    message.includes("trial credits") ||
    message.includes("add more credits") ||
    message.includes("payment required") ||
    message.includes("billing issue")
  );
}

function classifyQuickTaskError(error: unknown): QuickTaskErrorState {
  const message = error instanceof Error ? error.message : String(error || "");
  const normalized = message.toLowerCase();

  if (isQuickTaskBillingIssueMessage(message)) {
    return { kind: "billing", message: QUICK_TASK_BILLING_MESSAGE };
  }
  if (
    normalized.includes("not authenticated") ||
    normalized.includes("failed to authenticate request with clerk") ||
    normalized.includes("unauthorized")
  ) {
    return {
      kind: "auth",
      message: "Sign in to continue creating tasks with OpenClaw.",
    };
  }
  if (normalized.includes("gateway is offline")) {
    return {
      kind: "generic",
      message: "Gateway is offline. Start it to add tasks.",
    };
  }
  if (normalized.includes("timed out")) {
    return {
      kind: "generic",
      message: "Saving took too long. Please try again.",
    };
  }

  const fallback = message.trim() || "Failed to add task. Please try again.";
  return { kind: "generic", message: fallback };
}

function fallbackTaskTitleFromPrompt(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  if (!compact) return "Untitled task";
  if (compact.length <= 120) return compact;
  return `${compact.slice(0, 117).trimEnd()}...`;
}

function parseTaskJsonFromAssistantReply(reply: string): Record<string, unknown> | null {
  const trimmed = (reply || "").trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let candidate = fenced ? fenced[1].trim() : trimmed;
  if (!candidate.startsWith("{")) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      candidate = candidate.slice(start, end + 1).trim();
    }
  }
  if (!candidate.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildTaskFromAgentReply(userPrompt: string, reply: string): Omit<TaskBoardItem, "id" | "createdAt" | "updatedAt"> {
  const parsed = parseTaskJsonFromAssistantReply(reply);
  const fallbackTitle = fallbackTaskTitleFromPrompt(userPrompt);

  const titleCandidate = typeof parsed?.title === "string" ? parsed.title.trim() : "";
  const title = titleCandidate || fallbackTitle;

  const description = typeof parsed?.description === "string" ? parsed.description.trim() : "";
  const status = isTaskBoardStatus(parsed?.status) ? parsed.status : "todo";
  const priority = isTaskBoardPriority(parsed?.priority) ? parsed.priority : "medium";

  let owner: TaskBoardOwner = inferTaskOwnerFromPrompt(userPrompt);
  if (isTaskBoardOwner(parsed?.owner)) {
    owner = parsed.owner;
  }

  const rawLabels = parsed && Array.isArray(parsed.labels) ? parsed.labels : [];
  const labels = parseTaskLabels(
    rawLabels.filter((value): value is string => typeof value === "string").join(",")
  );
  const dueAt =
    typeof parsed?.dueAt === "string" && Number.isFinite(Date.parse(parsed.dueAt))
      ? new Date(parsed.dueAt).toISOString()
      : undefined;

  return {
    title,
    description,
    status,
    priority,
    owner,
    labels,
    dueAt,
  };
}

function normalizeTaskBoardDoc(raw: unknown): TaskBoardDoc {
  if (!raw || typeof raw !== "object") {
    return { version: 1, updatedAt: Date.now(), tasks: [] };
  }
  const doc = raw as { tasks?: unknown; updatedAt?: unknown };
  const source = Array.isArray(doc.tasks) ? doc.tasks : [];
  const tasks: TaskBoardItem[] = [];
  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const parsed = item as Partial<TaskBoardItem>;
    const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    if (!title) continue;
    const status = normalizeTaskStatus(parsed.status);
    const priority = isTaskBoardPriority(parsed.priority) ? parsed.priority : "medium";
    const labels = Array.isArray(parsed.labels)
      ? parsed.labels
          .map((label) => (typeof label === "string" ? label.trim() : ""))
          .filter((label) => Boolean(label))
      : [];
    const owner = normalizeTaskOwner((parsed as Partial<TaskBoardItem> & { owner?: unknown }).owner, labels);
    const dueAt = typeof parsed.dueAt === "string" && parsed.dueAt.trim() ? parsed.dueAt.trim() : undefined;
    const createdAt = Number.isFinite(parsed.createdAt) ? Number(parsed.createdAt) : Date.now();
    const updatedAt = Number.isFinite(parsed.updatedAt) ? Number(parsed.updatedAt) : createdAt;
    tasks.push({
      id:
        typeof parsed.id === "string" && parsed.id.trim()
          ? parsed.id.trim()
          : crypto.randomUUID(),
      title,
      description: typeof parsed.description === "string" ? parsed.description : "",
      status,
      priority,
      owner,
      labels,
      dueAt,
      linkedJobId: typeof parsed.linkedJobId === "string" ? parsed.linkedJobId : undefined,
      createdAt,
      updatedAt,
    });
  }
  const updatedAt = Number.isFinite(doc.updatedAt) ? Number(doc.updatedAt) : Date.now();
  return { version: 1, updatedAt, tasks };
}

function buildTaskBoardMarkdown(tasks: TaskBoardItem[]): string {
  const lines: string[] = [];
  lines.push("# TASKS.md - Agent Task Board");
  lines.push("");
  lines.push("Current collaborative task board state.");
  lines.push("");
  for (const status of TASK_BOARD_STATUS_ORDER) {
    const statusTasks = tasks.filter((task) => task.status === status);
    const label = TASK_BOARD_COLUMN_META[status].label;
    lines.push(`## ${label}`);
    if (statusTasks.length === 0) {
      lines.push("- _(none)_");
      lines.push("");
      continue;
    }
    const sorted = [...statusTasks].sort((a, b) => {
      const priorityDelta =
        TASK_BOARD_PRIORITY_ORDER.indexOf(a.priority) - TASK_BOARD_PRIORITY_ORDER.indexOf(b.priority);
      if (priorityDelta !== 0) return priorityDelta;
      return b.updatedAt - a.updatedAt;
    });
    for (const task of sorted) {
      const extras: string[] = [`priority: ${task.priority}`, `owner: ${task.owner}`];
      if (task.dueAt) {
        const due = formatTaskDueDate(task.dueAt);
        if (due) extras.push(`due: ${due}`);
      }
      if (task.labels.length > 0) {
        extras.push(`labels: ${task.labels.join(", ")}`);
      }
      lines.push(`- **${task.title}** (${extras.join(" | ")})`);
      if (task.description.trim()) {
        lines.push(`  - ${task.description.trim()}`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

function upsertHeartbeatTaskBlock(currentRaw: string): string {
  const block = [HEARTBEAT_TASK_BLOCK_START, HEARTBEAT_TASK_LINE, HEARTBEAT_TASK_BLOCK_END].join("\n");
  const trimmed = currentRaw.trim();
  if (!trimmed) {
    return `# HEARTBEAT.md\n\n${block}\n`;
  }
  const blockRe = new RegExp(
    `${HEARTBEAT_TASK_BLOCK_START}[\\s\\S]*?${HEARTBEAT_TASK_BLOCK_END}`,
    "m"
  );
  if (blockRe.test(currentRaw)) {
    return currentRaw.replace(blockRe, block);
  }
  const normalized = currentRaw.endsWith("\n") ? currentRaw : `${currentRaw}\n`;
  return `${normalized}\n${block}\n`;
}

function parseSuggestedCleanupAction(reply: string): BoardCleanupAction | null {
  const lineMatch = reply.match(
    /SUGGESTED_ACTION\s*:\s*(remove_done|remove_in_progress|remove_todo|clear_all|none)/i
  );
  if (lineMatch) {
    const action = lineMatch[1].toLowerCase();
    if (action === "none") return null;
    return action as BoardCleanupAction;
  }
  return null;
}

function summarizeBoardForCleanup(tasks: TaskBoardItem[]): string {
  if (tasks.length === 0) return "Board is empty.";
  const lines: string[] = [];
  for (const status of TASK_BOARD_STATUS_ORDER) {
    const entries = tasks
      .filter((task) => task.status === status)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 10);
    lines.push(`- ${TASK_BOARD_COLUMN_META[status].label}: ${entries.length} shown`);
    for (const task of entries) {
      const due = task.dueAt ? ` due:${formatTaskDueDate(task.dueAt) || "n/a"}` : "";
      const labels = task.labels.length ? ` labels:${task.labels.join(",")}` : "";
      lines.push(`  - ${task.title} [${task.priority}] owner:${task.owner}${due}${labels}`);
    }
  }
  return lines.join("\n");
}

// Module-level cache so jobs persist across component remounts (navigation).
let _cachedJobs: CronJob[] = [];

export function Tasks({ gatewayRunning, view = "tasks" }: Props) {
  const jobsEnabled = view !== "tasks";
  const tasksEnabled = view !== "jobs";
  const showTabs = view === "all";
  const [plannerTab, setPlannerTab] = useState<PlannerTab>(view === "jobs" ? "jobs" : "tasks");
  const activeTab: PlannerTab = showTabs ? plannerTab : view === "jobs" ? "jobs" : "tasks";
  const [jobs, setJobs] = useState<CronJob[]>(_cachedJobs);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [boardTasks, setBoardTasks] = useState<TaskBoardItem[]>([]);
  const [boardLoading, setBoardLoading] = useState(false);
  const [boardSaving, setBoardSaving] = useState(false);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [boardQuickCreateOpen, setBoardQuickCreateOpen] = useState(false);
  const [boardQuickPrompt, setBoardQuickPrompt] = useState("");
  const [boardQuickCreating, setBoardQuickCreating] = useState(false);
  const [boardQuickError, setBoardQuickError] = useState<QuickTaskErrorState | null>(null);
  const [boardQuickSuccess, setBoardQuickSuccess] = useState<string | null>(null);
  const [boardEditorOpen, setBoardEditorOpen] = useState(false);
  const [editingBoardTaskId, setEditingBoardTaskId] = useState<string | null>(null);
  const [boardEditor, setBoardEditor] = useState<TaskEditorState>(defaultTaskEditorState);
  const [boardFilter, setBoardFilter] = useState<"all" | TaskBoardPriority>("all");
  const [boardOwnerFilter, setBoardOwnerFilter] = useState<"all" | TaskBoardOwner>("all");
  const [boardNotice, setBoardNotice] = useState<string | null>(null);
  const [cleanupModalOpen, setCleanupModalOpen] = useState(false);
  const [cleanupPrompt, setCleanupPrompt] = useState(
    "Clean up my board. Focus on stale or completed tasks and suggest one cleanup action."
  );
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [cleanupReply, setCleanupReply] = useState<string>("");
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [cleanupSuggestedAction, setCleanupSuggestedAction] = useState<BoardCleanupAction | null>(null);
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);

  // Editor modal
  const [editingJob, setEditingJob] = useState<CronJob | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState>(defaultEditor);
  const [saving, setSaving] = useState(false);
  const [generatingSteps, setGeneratingSteps] = useState(false);
  const [generateStepsError, setGenerateStepsError] = useState<string | null>(null);

  // Track jobs being manually triggered
  const [runningJobIds, setRunningJobIds] = useState<Set<string>>(new Set());

  // History modal
  const [historyJobId, setHistoryJobId] = useState<string | null>(null);
  const [historyJobName, setHistoryJobName] = useState("");
  const [runs, setRuns] = useState<CronRunLogEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const pollRef = useRef<number | null>(null);
  const boardPollRef = useRef<number | null>(null);
  const boardQuickSuccessTimeoutRef = useRef<number | null>(null);
  const draggingTaskIdRef = useRef<string | null>(null);
  const tasksClientRef = useRef<GatewayClient | null>(null);
  const tasksConnectingRef = useRef<Promise<GatewayClient> | null>(null);
  const lastAutoMessageRef = useRef<string | null>(null);
  const lastAutoKindRef = useRef<"hint" | "generated" | null>(null);

  useEffect(() => {
    if (view === "jobs" || view === "tasks") {
      setPlannerTab(view);
    }
  }, [view]);

  useEffect(() => {
    if (!jobsEnabled) {
      setSkills([]);
      setSkillsLoading(false);
      setSkillsError(null);
      return;
    }
    let cancelled = false;
    async function loadSkills() {
      setSkillsLoading(true);
      setSkillsError(null);
      const next: SkillOption[] = [];
      const seen = new Set<string>();

      try {
        try {
          const cached = await getIntegrationsCached();
          cached
            .filter((i) => i.connected)
            .forEach((i: Integration) => {
              const id = `integration:${i.provider}`;
              if (seen.has(id)) return;
              seen.add(id);
              const meta = INTEGRATION_LABELS[i.provider] || {
                label: i.provider,
              };
              next.push({
                id,
                label: meta.label,
                source: "integration",
                description: i.email ? `Connected as ${i.email}` : "Connected",
                hint: meta.hint,
              });
            });
        } catch (e) {
          // ignore cache failures
        }
        const integrations = await getIntegrations();
        integrations
          .filter((i) => i.connected)
          .forEach((i: Integration) => {
            const id = `integration:${i.provider}`;
            if (seen.has(id)) return;
            seen.add(id);
            const meta = INTEGRATION_LABELS[i.provider] || {
              label: i.provider,
            };
            next.push({
              id,
              label: meta.label,
              source: "integration",
              description: i.email ? `Connected as ${i.email}` : "Connected",
              hint: meta.hint,
            });
          });
      } catch (e) {
        // Likely not authenticated or integrations not configured.
      }

      try {
        const plugins = await invoke<any[]>("get_plugin_store");
        for (const p of plugins || []) {
          if (!p?.enabled) continue;
          if (p?.kind === "memory") continue;
          const label = PLUGIN_LABELS[p.id] || p.id;
          next.push({
            id: `plugin:${p.id}`,
            label,
            source: "plugin",
            description: "Enabled",
            hint: `Use the ${label} tool to `,
          });
        }
      } catch (e) {
        setSkillsError("Failed to load connected plugins");
      }

      if (!cancelled) {
        setSkills(next);
        setSkillsLoading(false);
      }
    }

    loadSkills();
    return () => {
      cancelled = true;
    };
  }, [jobsEnabled]);

  const fetchJobs = useCallback(async () => {
    // Only show the full-screen spinner when there are no cached jobs to display.
    if (_cachedJobs.length === 0) {
      setLoading(true);
    }
    setError(null);
    try {
      const result = await withGatewayClient((client) => client.listCronJobs(true));
      setJobs(result);
      _cachedJobs = result;
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Gateway is offline. Start it to manage jobs."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  async function readWorkspaceText(path: string): Promise<string | null> {
    try {
      return await invoke<string>("read_workspace_file", { path });
    } catch {
      return null;
    }
  }

  async function writeWorkspaceText(path: string, content: string): Promise<void> {
    const parts = path.split("/").filter((part) => part.length > 0);
    const fileName = parts.pop();
    if (!fileName) throw new Error(`Invalid file path: ${path}`);
    const destPath = parts.join("/");
    await invoke("upload_workspace_file", {
      fileName,
      base64: encodeUtf8ToBase64(content),
      destPath,
    });
  }

  async function persistBoardArtifacts(
    tasks: TaskBoardItem[],
    options?: { skipSavingIndicator?: boolean }
  ) {
    const skipSavingIndicator = options?.skipSavingIndicator === true;
    if (!gatewayRunning) {
      throw new Error("Gateway is offline. Start it to persist board tasks.");
    }
    if (!skipSavingIndicator) setBoardSaving(true);
    try {
      const nextDoc: TaskBoardDoc = {
        version: 1,
        updatedAt: Date.now(),
        tasks,
      };
      await writeWorkspaceText(TASK_BOARD_JSON_PATH, JSON.stringify(nextDoc, null, 2));
      await writeWorkspaceText(TASK_BOARD_MARKDOWN_PATH, buildTaskBoardMarkdown(tasks));
      const heartbeatRaw = (await readWorkspaceText(HEARTBEAT_PATH)) || "";
      const nextHeartbeat = upsertHeartbeatTaskBlock(heartbeatRaw);
      if (nextHeartbeat !== heartbeatRaw) {
        await writeWorkspaceText(HEARTBEAT_PATH, nextHeartbeat);
      }
    } finally {
      if (!skipSavingIndicator) setBoardSaving(false);
    }
  }

  const loadBoard = useCallback(async () => {
    if (!gatewayRunning) {
      setBoardTasks([]);
      setBoardLoading(false);
      return;
    }
    setBoardLoading(true);
    setBoardError(null);
    try {
      const raw = await readWorkspaceText(TASK_BOARD_JSON_PATH);
      let tasks: TaskBoardItem[] = [];
      if (raw && raw.trim()) {
        try {
          const parsed = normalizeTaskBoardDoc(JSON.parse(raw));
          tasks = parsed.tasks;
        } catch {
          throw new Error("Task board data is invalid. Repair or replace tasks/board.json.");
        }
      }
      setBoardTasks(tasks);
      await persistBoardArtifacts(tasks, { skipSavingIndicator: true });
    } catch (e) {
      setBoardError(
        e instanceof Error ? e.message : "Failed to load board tasks from workspace."
      );
    } finally {
      setBoardLoading(false);
    }
  }, [gatewayRunning]);

  async function persistBoardTasks(nextTasks: TaskBoardItem[]) {
    setBoardTasks(nextTasks);
    setBoardError(null);
    try {
      await persistBoardArtifacts(nextTasks);
    } catch (e) {
      setBoardError(
        e instanceof Error ? e.message : "Failed to persist board tasks to workspace."
      );
    }
  }

  useEffect(() => {
    if (!jobsEnabled || !gatewayRunning) {
      tasksClientRef.current = null;
      // Keep _cachedJobs intact so remounts don't flash the spinner.
      // Only clear displayed state when there's nothing cached.
      if (_cachedJobs.length === 0) {
        setJobs([]);
      }
      setLoading(false);
      return;
    }
    if (activeTab !== "jobs") {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      setLoading(false);
      return;
    }

    const refreshJobs = () => {
      void fetchJobs();
    };
    const handleWindowFocus = () => {
      refreshJobs();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        refreshJobs();
      }
    };

    refreshJobs();
    pollRef.current = window.setInterval(refreshJobs, 15_000);
    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [gatewayRunning, jobsEnabled, activeTab, fetchJobs]);

  useEffect(() => {
    if (!tasksEnabled || !gatewayRunning) {
      setBoardTasks([]);
      setBoardLoading(false);
      if (boardPollRef.current) {
        window.clearInterval(boardPollRef.current);
        boardPollRef.current = null;
      }
      return;
    }
    if (activeTab !== "tasks") {
      if (boardPollRef.current) {
        window.clearInterval(boardPollRef.current);
        boardPollRef.current = null;
      }
      setBoardLoading(false);
      return;
    }

    const refreshBoard = () => {
      void loadBoard();
    };
    const handleWindowFocus = () => {
      refreshBoard();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        refreshBoard();
      }
    };

    refreshBoard();
    boardPollRef.current = window.setInterval(refreshBoard, 20_000);
    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      if (boardPollRef.current) {
        window.clearInterval(boardPollRef.current);
        boardPollRef.current = null;
      }
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [gatewayRunning, tasksEnabled, activeTab, loadBoard]);

  useEffect(() => {
    const handleJobsUpdated = () => {
      if (!jobsEnabled || !gatewayRunning) return;
      void fetchJobs();
    };
    const handleTaskBoardUpdated = () => {
      if (!tasksEnabled || !gatewayRunning) return;
      void loadBoard();
    };
    if (jobsEnabled) {
      window.addEventListener("entropic-tasks-updated", handleJobsUpdated);
    }
    if (tasksEnabled) {
      window.addEventListener("entropic-task-board-updated", handleTaskBoardUpdated);
    }
    return () => {
      if (jobsEnabled) {
        window.removeEventListener("entropic-tasks-updated", handleJobsUpdated);
      }
      if (tasksEnabled) {
        window.removeEventListener("entropic-task-board-updated", handleTaskBoardUpdated);
      }
    };
  }, [gatewayRunning, jobsEnabled, tasksEnabled, fetchJobs, loadBoard]);

  useEffect(() => {
    return () => {
      tasksClientRef.current = null;
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
      }
      if (boardPollRef.current) {
        window.clearInterval(boardPollRef.current);
      }
      if (boardQuickSuccessTimeoutRef.current) {
        window.clearTimeout(boardQuickSuccessTimeoutRef.current);
        boardQuickSuccessTimeoutRef.current = null;
      }
    };
  }, []);

  function openCreate() {
    setEditingJob(null);
    setEditor(defaultEditor);
    lastAutoMessageRef.current = null;
    lastAutoKindRef.current = null;
    setGenerateStepsError(null);
    setEditorOpen(true);
  }

  function openTaskBoardProgressTemplate() {
    setEditingJob(null);
    setEditor({
      ...defaultEditor,
      name: "Make progress on task board and update items",
      description: "Advance tasks, update statuses, and surface blockers with clear unblock actions.",
      scheduleType: "cron",
      schedulePreset: "daily",
      scheduleTime: "09:00",
      cronExpr: buildCronExpr("09:00", "*"),
      message: [
        "Review TASKS.md and tasks/board.json.",
        "Move each task to TODO, IN PROGRESS, BLOCKED, or DONE based on current reality.",
        "For BLOCKED tasks, update description with: what is blocked, why, and the exact unblock action needed.",
        "Prioritize high/critical tasks first and keep updates concise.",
        "At the end, summarize what changed and list all BLOCKED tasks with owner/action needed.",
      ].join("\n"),
    });
    lastAutoMessageRef.current = null;
    lastAutoKindRef.current = null;
    setGenerateStepsError(null);
    setError(null);
    setEditorOpen(true);
  }

  function openEdit(job: CronJob) {
    setEditingJob(job);
    setEditor(editorFromJob(job));
    lastAutoMessageRef.current = null;
    lastAutoKindRef.current = null;
    setGenerateStepsError(null);
    setEditorOpen(true);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const schedule = editorToSchedule(editor);
      const payload = editorToPayload(editor);
      const sessionTarget: "main" | "isolated" = "isolated";
      if (editingJob) {
        await withGatewayClient((client) =>
          client.updateCronJob(editingJob.id, {
            name: editor.name,
            description: editor.description || undefined,
            schedule,
            payload,
            sessionTarget,
            enabled: editor.enabled,
          })
        );
      } else {
        await withGatewayClient((client) =>
          client.addCronJob({
            name: editor.name,
            description: editor.description || undefined,
            schedule,
            payload,
            sessionTarget,
            wakeMode: "next-heartbeat",
            enabled: editor.enabled,
          })
        );
      }
      setEditorOpen(false);
      fetchJobs();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Gateway is offline. Start it to save jobs."
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(job: CronJob) {
    if (!confirm(`Delete job "${job.name}"? This cannot be undone.`)) return;
    try {
      await withGatewayClient((client) => client.removeCronJob(job.id));
      fetchJobs();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Gateway is offline. Start it to delete jobs."
      );
    }
  }

  async function handleRun(job: CronJob) {
    try {
      setRunningJobIds((prev) => new Set(prev).add(job.id));
      await withGatewayClient((client) => client.runCronJob(job.id, "force"));
      // Poll until the job finishes running, then show the result
      const pollUntilDone = async () => {
        for (let i = 0; i < 120; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          try {
            const refreshed = await withGatewayClient((c) => c.listCronJobs(true));
            setJobs(refreshed);
            _cachedJobs = refreshed;
            const current = refreshed.find((j) => j.id === job.id);
            if (!current || current.state !== "running") break;
          } catch {
            break;
          }
        }
        setRunningJobIds((prev) => {
          const next = new Set(prev);
          next.delete(job.id);
          return next;
        });
        // Automatically open history so the user sees the run output
        openHistory(job);
      };
      pollUntilDone();
      // Initial refresh to pick up the "running" state
      setTimeout(fetchJobs, 1000);
    } catch (e) {
      setRunningJobIds((prev) => {
        const next = new Set(prev);
        next.delete(job.id);
        return next;
      });
      setError(
        e instanceof Error ? e.message : "Gateway is offline. Start it to run jobs."
      );
    }
  }

  async function handleToggle(job: CronJob) {
    try {
      await withGatewayClient((client) =>
        client.updateCronJob(job.id, { enabled: !job.enabled })
      );
      fetchJobs();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Gateway is offline. Start it to update jobs."
      );
    }
  }

  async function openHistory(job: CronJob) {
    setHistoryJobId(job.id);
    setHistoryJobName(job.name);
    setHistoryLoading(true);
    try {
      const result = await withGatewayClient((client) => client.getCronRuns(job.id, 20));
      setRuns(result);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Gateway is offline. Start it to view job history."
      );
    } finally {
      setHistoryLoading(false);
    }
  }

  function updateEditor(patch: Partial<EditorState>) {
    setEditor((prev) => ({ ...prev, ...patch }));
  }

  function updateSkillSelection(nextIds: string[]) {
    setEditor((prev) => {
      const nextState: EditorState = { ...prev, skillIds: nextIds };
      const selected = skills.filter((skill) => nextIds.includes(skill.id));
      const hint = buildSkillHint(selected);
      const trimmed = prev.message.trim();
      const lastAuto = lastAutoMessageRef.current;
      const lastKind = lastAutoKindRef.current;

      if (!hint) {
        if (lastKind === "hint" && lastAuto && trimmed === lastAuto) {
          nextState.message = "";
        }
        lastAutoMessageRef.current = null;
        lastAutoKindRef.current = null;
        return nextState;
      }

      if (!trimmed || (lastKind === "hint" && lastAuto && trimmed === lastAuto)) {
        nextState.message = hint;
        lastAutoMessageRef.current = hint;
        lastAutoKindRef.current = "hint";
      }

      return nextState;
    });
  }

  function applySchedulePreset(preset: SchedulePreset) {
    if (preset === "every_hour") {
      updateEditor({
        schedulePreset: preset,
        scheduleType: "every",
        intervalMinutes: "60",
      });
      return;
    }
    if (preset === "once") {
      updateEditor({
        schedulePreset: preset,
        scheduleType: "at",
        atDate: editor.atDate || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
      return;
    }
    if (preset === "custom") {
      updateEditor({ schedulePreset: preset });
      return;
    }

    const time = editor.scheduleTime || defaultEditor.scheduleTime;
    const days =
      preset === "daily"
        ? "*"
        : preset === "weekdays"
          ? "1-5"
          : preset === "weekends"
            ? "0,6"
            : "1,3,5";
    updateEditor({
      schedulePreset: preset,
      scheduleType: "cron",
      scheduleTime: time,
      cronExpr: buildCronExpr(time, days),
    });
  }

  const integrations = useMemo(
    () => skills.filter((s) => s.source === "integration"),
    [skills]
  );
  const plugins = useMemo(
    () => skills.filter((s) => s.source === "plugin"),
    [skills]
  );
  const selectedSkills = useMemo(
    () => skills.filter((s) => editor.skillIds.includes(s.id)),
    [skills, editor.skillIds]
  );
  const selectedSkillLabels = useMemo(
    () => selectedSkills.map((skill) => skill.label).join(", "),
    [selectedSkills]
  );

  async function ensureTasksClient(): Promise<GatewayClient> {
    if (tasksClientRef.current?.isConnected()) return tasksClientRef.current;
    if (tasksConnectingRef.current) return tasksConnectingRef.current;
    if (!gatewayRunning) {
      throw new Error("Gateway is offline. Start it to manage jobs.");
    }
    tasksConnectingRef.current = (async () => {
      const { wsUrl, token } = await resolveGatewayConnection();
      const client = createGatewayClient(wsUrl, token);
      if (!client.isConnected()) {
        const timeoutMs = 8_000;
        let timeoutId: number | null = null;
        const timeout = new Promise<never>((_, reject) => {
          timeoutId = window.setTimeout(() => {
            reject(new Error("Gateway connection timed out"));
          }, timeoutMs);
        });
        try {
          await Promise.race([client.connect(), timeout]);
        } finally {
          if (timeoutId) window.clearTimeout(timeoutId);
        }
      }
      tasksClientRef.current = client;
      return client;
    })();
    try {
      return await tasksConnectingRef.current;
    } finally {
      tasksConnectingRef.current = null;
    }
  }

  async function withGatewayClient<T>(
    action: (client: GatewayClient) => Promise<T>
  ): Promise<T> {
    const client = await ensureTasksClient();
    return action(client);
  }

  async function handleGenerateSteps() {
    setGenerateStepsError(null);
    let client: GatewayClient;
    try {
      client = await withGatewayClient(async (connected) => connected);
    } catch (err) {
      setGenerateStepsError(
        err instanceof Error ? err.message : "Gateway is offline. Start it and try again."
      );
      return;
    }

    setGeneratingSteps(true);
    const sessionKey = client.createSessionKey();
    const prompt = buildGeneratePrompt(editor, selectedSkills);

    try {
      const runId = await client.sendMessage(sessionKey, prompt);
      let reply = "";
      try {
        reply = await waitForChatCompletion(client, runId, 12_000);
      } catch {
        // Fall back to polling + history if we didn't receive streamed events.
      }

      if (!reply) {
        const status = await client.rpc<{ status?: string }>("agent.wait", {
          runId,
          timeoutMs: 20_000,
        });
        if (status?.status === "timeout") {
          throw new Error("Timed out waiting for OpenClaw");
        }
        const history = await client.getChatHistory(sessionKey, 20);
        reply = extractLatestAssistantMessage(history as HistoryMessage[]);
      }

      if (!reply) throw new Error("No response received from OpenClaw");
      updateEditor({ message: reply });
      lastAutoMessageRef.current = reply;
      lastAutoKindRef.current = "generated";
    } catch (e) {
      setGenerateStepsError(e instanceof Error ? e.message : "Failed to generate steps");
    } finally {
      setGeneratingSteps(false);
      client
        .rpc("sessions.delete", { key: sessionKey })
        .catch(() => {});
    }
  }

  function openCreateBoardTask() {
    if (!gatewayRunning) {
      setBoardError("Gateway is offline. Start it to add tasks.");
      return;
    }
    if (boardQuickSuccessTimeoutRef.current) {
      window.clearTimeout(boardQuickSuccessTimeoutRef.current);
      boardQuickSuccessTimeoutRef.current = null;
    }
    setBoardQuickPrompt("");
    setBoardQuickError(null);
    setBoardQuickSuccess(null);
    setBoardQuickCreating(false);
    setBoardError(null);
    setBoardNotice(null);
    setBoardQuickCreateOpen(true);
  }

  function closeBoardQuickCreate() {
    if (boardQuickSuccessTimeoutRef.current) {
      window.clearTimeout(boardQuickSuccessTimeoutRef.current);
      boardQuickSuccessTimeoutRef.current = null;
    }
    setBoardQuickCreateOpen(false);
    setBoardQuickPrompt("");
    setBoardQuickError(null);
    setBoardQuickSuccess(null);
    setBoardQuickCreating(false);
  }

  function openBillingFromQuickTask() {
    window.dispatchEvent(
      new CustomEvent("entropic-open-page", {
        detail: { page: "billing" },
      })
    );
  }

  function requestSignInFromQuickTask() {
    window.dispatchEvent(
      new CustomEvent("entropic-require-signin", {
        detail: { source: "tasks-quick-create" },
      })
    );
  }

  async function createBoardTaskFromPrompt() {
    if (!gatewayRunning) {
      setBoardQuickError({
        kind: "generic",
        message: "Gateway is offline. Start it to add tasks.",
      });
      return;
    }
    const userPrompt = boardQuickPrompt.trim();
    if (!userPrompt) {
      setBoardQuickError({
        kind: "generic",
        message: "Describe what needs to be done.",
      });
      return;
    }

    let client: GatewayClient;
    try {
      client = await withGatewayClient(async (connected) => connected);
    } catch (e) {
      setBoardQuickError(classifyQuickTaskError(e));
      return;
    }

    if (boardQuickSuccessTimeoutRef.current) {
      window.clearTimeout(boardQuickSuccessTimeoutRef.current);
      boardQuickSuccessTimeoutRef.current = null;
    }
    setBoardQuickCreating(true);
    setBoardQuickError(null);
    setBoardQuickSuccess(null);
    const sessionKey = client.createSessionKey();
    const prompt = [
      "You are creating one task board item for Entropic.",
      "Output JSON only. No markdown. No code fences. No prose.",
      "Schema:",
      '{"title":"string","description":"string","status":"todo|in_progress|blocked|done","priority":"critical|high|medium|low","owner":"user|agent","labels":["string"],"dueAt":"ISO-8601 datetime or empty string"}',
      "Guidelines:",
      "- Keep title short and action-oriented.",
      "- Keep description concise and specific.",
      "- Infer status/priority/owner from the request.",
      "- If no clear due date, set dueAt to an empty string.",
      "",
      `User request: ${userPrompt}`,
    ].join("\n");

    try {
      const runId = await client.sendMessage(sessionKey, prompt);
      let reply = "";
      try {
        reply = await waitForChatCompletion(client, runId, 14_000);
      } catch {
        // Fall back to polling + history if stream events are missed.
      }
      if (!reply) {
        const status = await client.rpc<{ status?: string }>("agent.wait", {
          runId,
          timeoutMs: 20_000,
        });
        if (status?.status === "timeout") {
          throw new Error("Timed out waiting for OpenClaw");
        }
        const history = await client.getChatHistory(sessionKey, 20);
        reply = extractLatestAssistantMessage(history as HistoryMessage[]);
      }

      const taskDraft = buildTaskFromAgentReply(userPrompt, reply);
      const now = Date.now();
      const nextTask: TaskBoardItem = {
        id: crypto.randomUUID(),
        ...taskDraft,
        createdAt: now,
        updatedAt: now,
      };
      let baseTasks = boardTasks;
      try {
        const latestRaw = await readWorkspaceText(TASK_BOARD_JSON_PATH);
        if (latestRaw && latestRaw.trim()) {
          baseTasks = normalizeTaskBoardDoc(JSON.parse(latestRaw)).tasks;
        }
      } catch {
        // Fall back to in-memory tasks if latest board snapshot can't be read.
      }
      await persistBoardTasks([nextTask, ...baseTasks]);
      setBoardNotice(`Added "${nextTask.title}" to ${TASK_BOARD_COLUMN_META[nextTask.status].label}.`);
      setBoardQuickSuccess(`Saved: ${nextTask.title}`);
      boardQuickSuccessTimeoutRef.current = window.setTimeout(() => {
        setBoardQuickSuccess(null);
        setBoardQuickCreateOpen(false);
        setBoardQuickPrompt("");
        setBoardQuickError(null);
        setBoardQuickCreating(false);
        boardQuickSuccessTimeoutRef.current = null;
      }, 1000);
    } catch (e) {
      setBoardQuickError(classifyQuickTaskError(e));
    } finally {
      setBoardQuickCreating(false);
      client.rpc("sessions.delete", { key: sessionKey }).catch(() => {});
    }
  }

  function openEditBoardTask(task: TaskBoardItem) {
    if (!gatewayRunning) {
      setBoardError("Gateway is offline. Start it to edit tasks.");
      return;
    }
    setEditingBoardTaskId(task.id);
    const localDueAt =
      task.dueAt && Number.isFinite(Date.parse(task.dueAt))
        ? toLocalInputValue(Date.parse(task.dueAt))
        : "";
    setBoardEditor({
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      owner: task.owner,
      dueAt: localDueAt,
      labelsInput: task.labels.join(", "),
    });
    setBoardError(null);
    setBoardNotice(null);
    setBoardEditorOpen(true);
  }

  function closeBoardEditor() {
    setBoardEditorOpen(false);
    setEditingBoardTaskId(null);
    setBoardEditor(defaultTaskEditorState);
  }

  function setDraggingTask(taskId: string | null) {
    draggingTaskIdRef.current = taskId;
  }

  function readDraggedTaskId(dataTransfer: DataTransfer | null): string | null {
    if (!dataTransfer) return draggingTaskIdRef.current;
    const taskId =
      dataTransfer.getData("text/task-id") ||
      dataTransfer.getData("text/plain") ||
      dataTransfer.getData("text") ||
      draggingTaskIdRef.current;
    const normalized = taskId?.trim() || "";
    return normalized || null;
  }

  async function saveBoardTask() {
    if (!gatewayRunning) {
      setBoardError("Gateway is offline. Start it to save task changes.");
      return;
    }
    const title = boardEditor.title.trim();
    if (!title) return;
    const labels = parseTaskLabels(boardEditor.labelsInput);
    const dueAt =
      boardEditor.dueAt && Number.isFinite(Date.parse(boardEditor.dueAt))
        ? new Date(boardEditor.dueAt).toISOString()
        : undefined;
    const now = Date.now();

    if (editingBoardTaskId) {
      const current = boardTasks.find((task) => task.id === editingBoardTaskId);
      if (!current) return;
      const nextTasks = boardTasks.map((task) =>
        task.id === editingBoardTaskId
          ? {
              ...task,
              title,
              description: boardEditor.description.trim(),
              status: boardEditor.status,
              priority: boardEditor.priority,
              owner: boardEditor.owner,
              dueAt,
              labels,
              updatedAt: now,
            }
          : task
      );
      await persistBoardTasks(nextTasks);
      closeBoardEditor();
      return;
    }

    const nextTask: TaskBoardItem = {
      id: crypto.randomUUID(),
      title,
      description: boardEditor.description.trim(),
      status: boardEditor.status,
      priority: boardEditor.priority,
      owner: boardEditor.owner,
      dueAt,
      labels,
      createdAt: now,
      updatedAt: now,
    };
    await persistBoardTasks([nextTask, ...boardTasks]);
    closeBoardEditor();
  }

  async function deleteBoardTask(task: TaskBoardItem) {
    if (!confirm(`Delete task "${task.title}"?`)) return;
    const nextTasks = boardTasks.filter((entry) => entry.id !== task.id);
    await persistBoardTasks(nextTasks);
  }

  async function moveBoardTask(taskId: string, nextStatus: TaskBoardStatus) {
    const current = boardTasks.find((task) => task.id === taskId);
    if (!current || current.status === nextStatus) return;
    const nextTasks = boardTasks.map((task) =>
      task.id === taskId
        ? {
            ...task,
            status: nextStatus,
            updatedAt: Date.now(),
          }
        : task
    );
    await persistBoardTasks(nextTasks);
  }

  async function applyBoardCleanupAction(
    action: BoardCleanupAction,
    options?: { skipConfirm?: boolean }
  ) {
    const nextTasks =
      action === "remove_done"
        ? boardTasks.filter((task) => task.status !== "done")
        : action === "remove_in_progress"
          ? boardTasks.filter((task) => task.status !== "in_progress")
          : action === "remove_todo"
            ? boardTasks.filter((task) => task.status !== "todo")
            : [];
    const removedCount = boardTasks.length - nextTasks.length;
    if (removedCount <= 0) {
      setBoardNotice("No tasks matched that cleanup action.");
      return;
    }
    if (!options?.skipConfirm) {
      const confirmed = confirm(
        `${BOARD_CLEANUP_ACTION_LABEL[action]}? This will remove ${removedCount} task${
          removedCount === 1 ? "" : "s"
        }.`
      );
      if (!confirmed) return;
    }
    await persistBoardTasks(nextTasks);
    setBoardNotice(
      `${BOARD_CLEANUP_ACTION_LABEL[action]} complete. Removed ${removedCount} task${
        removedCount === 1 ? "" : "s"
      }.`
    );
  }

  function openCleanupConversation() {
    setCleanupModalOpen(true);
    setCleanupError(null);
    setCleanupReply("");
    setCleanupSuggestedAction(null);
  }

  function closeCleanupConversation() {
    setCleanupModalOpen(false);
    setCleanupLoading(false);
  }

  async function runCleanupConversation() {
    if (!gatewayRunning) {
      setCleanupError("Gateway is offline. Start it to ask OpenClaw.");
      return;
    }

    let client: GatewayClient;
    try {
      client = await withGatewayClient(async (connected) => connected);
    } catch (e) {
      setCleanupError(
        e instanceof Error ? e.message : "Gateway is offline. Start it to ask OpenClaw."
      );
      return;
    }

    setCleanupLoading(true);
    setCleanupError(null);
    setCleanupReply("");
    setCleanupSuggestedAction(null);
    const sessionKey = client.createSessionKey();
    const request = cleanupPrompt.trim() || "Clean up my board with minimal risk.";
    const prompt = [
      "You are helping clean a task board in Entropic.",
      "Available statuses are exactly: todo, in_progress, blocked, done.",
      "Suggest practical cleanup steps while preserving active work.",
      `User request: ${request}`,
      "",
      "Current board snapshot:",
      summarizeBoardForCleanup(boardTasks),
      "",
      "Respond with:",
      "1) A short recommendation (2-5 bullets).",
      "2) One final line exactly in this format:",
      "SUGGESTED_ACTION: <remove_done|remove_in_progress|remove_todo|clear_all|none>",
    ].join("\n");

    try {
      const runId = await client.sendMessage(sessionKey, prompt);
      let reply = "";
      try {
        reply = await waitForChatCompletion(client, runId, 14_000);
      } catch {
        // Fall back to polling + history if stream events are missed.
      }
      if (!reply) {
        const status = await client.rpc<{ status?: string }>("agent.wait", {
          runId,
          timeoutMs: 20_000,
        });
        if (status?.status === "timeout") {
          throw new Error("Timed out waiting for OpenClaw");
        }
        const history = await client.getChatHistory(sessionKey, 20);
        reply = extractLatestAssistantMessage(history as HistoryMessage[]);
      }
      if (!reply) throw new Error("No response received from OpenClaw");
      setCleanupReply(reply);
      setCleanupSuggestedAction(parseSuggestedCleanupAction(reply));
    } catch (e) {
      setCleanupError(e instanceof Error ? e.message : "Failed to run cleanup conversation.");
    } finally {
      setCleanupLoading(false);
      client.rpc("sessions.delete", { key: sessionKey }).catch(() => {});
    }
  }

  const filteredBoardTasks = useMemo(() => {
    return boardTasks.filter((task) => {
      const priorityMatches = boardFilter === "all" || task.priority === boardFilter;
      const ownerMatches = boardOwnerFilter === "all" || task.owner === boardOwnerFilter;
      return priorityMatches && ownerMatches;
    });
  }, [boardTasks, boardFilter, boardOwnerFilter]);

  const tasksByStatus = useMemo(() => {
    const grouped: Record<TaskBoardStatus, TaskBoardItem[]> = {
      todo: [],
      in_progress: [],
      blocked: [],
      done: [],
    };
    for (const task of filteredBoardTasks) {
      grouped[task.status].push(task);
    }
    for (const status of TASK_BOARD_STATUS_ORDER) {
      grouped[status].sort((a, b) => {
        const priorityDelta =
          TASK_BOARD_PRIORITY_ORDER.indexOf(a.priority) - TASK_BOARD_PRIORITY_ORDER.indexOf(b.priority);
        if (priorityDelta !== 0) return priorityDelta;
        return b.updatedAt - a.updatedAt;
      });
    }
    return grouped;
  }, [filteredBoardTasks]);

  return (
    <div className="h-full flex flex-col p-6">
      <div className="mb-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold" style={{ color: "var(--text-primary)" }}>
            {showTabs ? "Tasks + Jobs" : activeTab === "tasks" ? "Tasks" : "Jobs"}
          </h1>
          <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>
            {showTabs
              ? "Plan work in Tasks. Run automation in Jobs."
              : activeTab === "tasks"
                ? "Plan work, prioritize, and track progress."
                : "Run and manage cron automation."}
          </p>
          {showTabs && (
            <div className="mt-3 inline-flex rounded-xl border border-[var(--border-default)] bg-white p-1 shadow-sm">
              <button
                onClick={() => setPlannerTab("tasks")}
                className={clsx(
                  "px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors",
                  activeTab === "tasks"
                    ? "bg-[var(--system-blue)] text-white"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                )}
              >
                Tasks Board
              </button>
              <button
                onClick={() => setPlannerTab("jobs")}
                className={clsx(
                  "px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors",
                  activeTab === "jobs"
                    ? "bg-[var(--system-blue)] text-white"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                )}
              >
                Jobs (Cron)
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {activeTab === "tasks" ? (
            <>
              <button
                onClick={openCreateBoardTask}
                className="px-4 py-2 bg-[var(--system-blue)] text-white rounded-lg font-semibold text-sm hover:opacity-90 transition-all flex items-center gap-2 whitespace-nowrap"
              >
                <Plus className="w-4 h-4" />
                New Task
              </button>
            </>
          ) : (
            <>
              <button
                onClick={openCreate}
                disabled={!gatewayRunning}
                className="px-4 py-2 bg-[var(--system-blue)] text-white rounded-lg font-semibold text-sm hover:opacity-90 transition-all flex items-center gap-2 whitespace-nowrap"
              >
                <Plus className="w-4 h-4" />
                New Job
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto w-full animate-in fade-in slide-in-from-bottom-4 duration-500">

        {activeTab === "tasks" ? (
          <>
            {!gatewayRunning && (
              <div className="mb-6 p-4 bg-amber-50 border border-amber-100 rounded-xl flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-white border border-amber-100 flex items-center justify-center shrink-0">
                  <AlertCircle className="w-5 h-5 text-amber-500" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-amber-900">Secure Sandbox is Offline</h2>
                  <p className="text-sm text-amber-700">Task board sync requires the gateway to be online.</p>
                </div>
              </div>
            )}

            <div className="mb-6 p-5 rounded-xl border border-[var(--border-default)] bg-white shadow-sm">
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-[var(--text-primary)]">Agent Task Board</h2>
                  <p className="text-sm text-[var(--text-secondary)] mt-1">
                    Saved to workspace and synced to heartbeat checks automatically.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={boardFilter}
                    onChange={(event) =>
                      setBoardFilter((event.target.value as "all" | TaskBoardPriority) || "all")
                    }
                    className="form-input !py-2 !text-xs !w-[150px]"
                  >
                    <option value="all">All priorities</option>
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                  <select
                    value={boardOwnerFilter}
                    onChange={(event) =>
                      setBoardOwnerFilter((event.target.value as "all" | TaskBoardOwner) || "all")
                    }
                    className="form-input !py-2 !text-xs !w-[145px]"
                  >
                    <option value="all">All owners</option>
                    <option value="user">You</option>
                    <option value="agent">Agent</option>
                  </select>
                  <button
                    onClick={() => void applyBoardCleanupAction("remove_done")}
                    disabled={!gatewayRunning || boardSaving}
                    className="px-2.5 py-2 rounded-lg border border-[var(--border-default)] bg-white text-[11px] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--system-gray-6)] disabled:opacity-50"
                  >
                    Remove all from DONE
                  </button>
                  <button
                    onClick={openCleanupConversation}
                    disabled={!gatewayRunning || boardSaving || cleanupLoading}
                    className="px-2.5 py-2 rounded-lg border border-[var(--border-default)] bg-white text-[11px] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--system-gray-6)] disabled:opacity-50"
                  >
                    Clean up my board
                  </button>
                  {boardSaving ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-default)] bg-white px-2.5 py-1 text-[11px] text-[var(--text-tertiary)]">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Syncing
                    </span>
                  ) : null}
                </div>
              </div>
            </div>

            {boardNotice ? (
              <div className="mb-4 p-3 rounded-lg bg-emerald-50 border border-emerald-100 text-sm text-emerald-700">
                {boardNotice}
              </div>
            ) : null}

            {boardError ? (
              <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-100 text-sm text-red-600">
                {boardError}
              </div>
            ) : null}

            {boardLoading ? (
              <div className="py-24 flex flex-col items-center gap-3">
                <Loader2 className="w-8 h-8 animate-spin text-[var(--system-blue)]" />
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                  Loading task board
                </p>
              </div>
            ) : (
              <div className="pb-20">
                <div className="flex flex-nowrap gap-3 overflow-x-auto pb-3 pr-1">
                  {TASK_BOARD_STATUS_ORDER.map((status) => {
                    const columnTasks = tasksByStatus[status];
                    const meta = TASK_BOARD_COLUMN_META[status];
                    return (
                      <div
                        key={status}
                        className="w-[248px] shrink-0 rounded-xl border border-[var(--border-subtle)] bg-white/85 shadow-sm min-h-[540px] max-h-[70vh] flex flex-col"
                        onDragOver={(event) => {
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "move";
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          const droppedTaskId = readDraggedTaskId(event.dataTransfer);
                          if (!droppedTaskId) return;
                          setDraggingTask(null);
                          void moveBoardTask(droppedTaskId, status);
                        }}
                      >
                        <div className="px-3 py-2.5 border-b border-[var(--border-subtle)] flex items-center justify-between">
                          <span className={clsx("text-[12px] font-semibold uppercase tracking-wide", meta.accent)}>
                            {meta.label}
                          </span>
                          <span className="text-[11px] text-[var(--text-tertiary)]">{columnTasks.length}</span>
                        </div>
                        <div
                          className="p-2.5 space-y-2 overflow-y-auto flex-1"
                          onDragOver={(event) => {
                            event.preventDefault();
                            event.dataTransfer.dropEffect = "move";
                          }}
                          onDrop={(event) => {
                            event.preventDefault();
                            const droppedTaskId = readDraggedTaskId(event.dataTransfer);
                            if (!droppedTaskId) return;
                            setDraggingTask(null);
                            void moveBoardTask(droppedTaskId, status);
                          }}
                        >
                          {columnTasks.length === 0 ? (
                            <div className="text-[11px] text-[var(--text-tertiary)] border border-dashed border-[var(--border-default)] rounded-lg p-3">
                              Drop tasks here
                            </div>
                          ) : (
                            columnTasks.map((task) => (
                              <div
                                key={task.id}
                                draggable
                                onDragStart={(event) => {
                                  setDraggingTask(task.id);
                                  event.dataTransfer.setData("text/plain", task.id);
                                  event.dataTransfer.setData("text", task.id);
                                  event.dataTransfer.setData("text/task-id", task.id);
                                  event.dataTransfer.effectAllowed = "move";
                                }}
                                onDragEnd={() => setDraggingTask(null)}
                                className="rounded-lg border border-[var(--border-subtle)] bg-white p-3 shadow-sm cursor-grab active:cursor-grabbing"
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <h3 className="text-sm font-semibold text-[var(--text-primary)] leading-tight">
                                    {task.title}
                                  </h3>
                                  <div className="flex flex-col items-end gap-1">
                                    <span
                                      className={clsx(
                                        "text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border",
                                        taskPriorityClass(task.priority)
                                      )}
                                    >
                                      {task.priority}
                                    </span>
                                    <span
                                      className={clsx(
                                        "text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border",
                                        taskOwnerClass(task.owner)
                                      )}
                                    >
                                      {formatTaskOwnerLabel(task.owner)}
                                    </span>
                                  </div>
                                </div>
                                {task.description ? (
                                  <p className="text-[12px] text-[var(--text-secondary)] mt-1 line-clamp-3">
                                    {task.description}
                                  </p>
                                ) : null}
                                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                  {task.labels.map((label) => (
                                    <span
                                      key={`${task.id}-${label}`}
                                      className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--system-gray-6)] text-[var(--text-tertiary)]"
                                    >
                                      {label}
                                    </span>
                                  ))}
                                  {task.dueAt ? (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-100">
                                      Due {formatTaskDueDate(task.dueAt)}
                                    </span>
                                  ) : null}
                                </div>
                                <div className="mt-2 flex items-center justify-between">
                                  <button
                                    onClick={() => openEditBoardTask(task)}
                                    className="text-[11px] text-[var(--system-blue)] font-semibold hover:underline"
                                  >
                                    Edit
                                  </button>
                                  <button
                                    onClick={() => void deleteBoardTask(task)}
                                    className="text-[11px] text-red-600 font-semibold hover:underline"
                                  >
                                    Delete
                                  </button>
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="max-w-6xl mx-auto">
            {/* Offline Warning */}
            {!gatewayRunning && (
              <div className="mb-6 p-4 bg-amber-50 border border-amber-100 rounded-xl flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-white border border-amber-100 flex items-center justify-center shrink-0">
                  <AlertCircle className="w-5 h-5 text-amber-500" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-amber-900">Secure Sandbox is Offline</h2>
                  <p className="text-sm text-amber-700">Scheduled jobs will not execute until the gateway is started.</p>
                </div>
              </div>
            )}

            {/* Compact Informational Banner */}
            <div className="mb-8 p-5 bg-[var(--text-primary)] rounded-xl text-white relative overflow-hidden shadow-sm">
              <div className="relative z-10 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-xl bg-[var(--system-blue)] flex items-center justify-center shrink-0">
                    <Smartphone className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold">Keep Jobs Running</h3>
                    <p className="text-sm text-white/75 mt-1">
                      Jobs execute only when this computer is awake.
                    </p>
                    <p className="text-xs text-white/65 mt-1">
                      Try the "Task board progress template" job to advance tasks and surface BLOCKED items.
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-8 gap-y-3 pt-4 lg:pt-0 lg:border-l lg:border-white/10 lg:pl-8">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-blue-300 mb-0.5">macOS</p>
                    <p className="text-[12px] text-white/80">Displays → Advanced → Prevent Sleep</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-green-300 mb-0.5">Windows</p>
                    <p className="text-[12px] text-white/80">Power → Plugged in, Never Sleep</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-purple-300 mb-0.5">Linux</p>
                    <p className="text-[12px] text-white/80">Use systemd-inhibit tools</p>
                  </div>
                </div>
              </div>
              <div className="absolute -bottom-24 -right-24 w-64 h-64 bg-[var(--system-blue)]/20 rounded-full blur-3xl" />
            </div>

            <h2 className="text-[13px] font-medium uppercase tracking-wide mb-3 px-1 text-[var(--text-secondary)]">
              Scheduled Jobs
            </h2>

            {/* Job List */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pb-20">
              {gatewayRunning && loading && jobs.length === 0 ? (
                <div className="col-span-full py-32 flex flex-col items-center gap-4">
                  <Loader2 className="w-10 h-10 animate-spin text-blue-600" />
                  <p className="text-gray-400 font-bold uppercase tracking-widest text-[10px]">Syncing jobs...</p>
                </div>
              ) : gatewayRunning && jobs.length === 0 ? (
                <div className="col-span-full py-20 text-center bg-white rounded-xl border border-dashed border-[var(--border-default)]">
                  <CalendarClock className="w-16 h-16 mx-auto mb-6 text-gray-200" strokeWidth={1.5} />
                  <h3 className="text-xl font-semibold text-[var(--text-primary)] mb-2">No jobs scheduled</h3>
                  <p className="text-[var(--text-secondary)] mb-6">Ready to automate? Create your first scheduled job or start with a suggestion below.</p>
                  <button onClick={openCreate} className="px-6 py-2.5 bg-[var(--text-primary)] text-white rounded-lg font-semibold text-sm hover:opacity-90 transition-all">Create First Job</button>
                  <div className="mt-8 mx-auto w-full max-w-md text-left rounded-xl border border-[var(--border-default)] bg-[var(--system-gray-6)]/60 p-4">
                    <h4 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-2">
                      Suggested first jobs
                    </h4>
                    <button
                      onClick={openTaskBoardProgressTemplate}
                      className="w-full rounded-lg border border-[var(--border-default)] bg-white px-3 py-2 text-left hover:bg-[var(--system-gray-6)] transition-colors"
                    >
                      <p className="text-sm font-semibold text-[var(--text-primary)]">Task board progress template</p>
                      <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                        Review tasks, update TODO/IN PROGRESS/BLOCKED/DONE, and surface unblock actions.
                      </p>
                    </button>
                  </div>
                </div>
              ) : (
                jobs.map((job) => {
                  const isManuallyRunning = runningJobIds.has(job.id) || job.state === "running";
                  const badge = isManuallyRunning
                    ? { label: "Running", className: "bg-amber-50 text-amber-600 border-amber-100" }
                    : statusBadge(job);
                  return (
                    <div key={job.id} className="group bg-white rounded-xl p-5 shadow-sm border border-[var(--border-subtle)] hover:shadow-md transition-all duration-300 flex flex-col">
                      <div className="flex items-start justify-between gap-4 mb-6">
                        <div className="flex items-start gap-4">
                          <div className={clsx(
                            "w-12 h-12 rounded-xl flex items-center justify-center border transition-all duration-300 shrink-0",
                            job.enabled ? "bg-blue-50 border-blue-100 text-blue-600" : "bg-gray-50 border-gray-100 text-gray-400"
                          )}>
                            <CalendarClock className="w-6 h-6" />
                          </div>
                          <div className="min-w-0">
                            <h3 className="font-semibold text-[var(--text-primary)] text-base mb-1 truncate leading-tight">{job.name}</h3>
                            <div className="flex items-center gap-2">
                              <span className={clsx("px-2.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide border", badge.className)}>
                                {badge.label}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Toggle Switch */}
                        <button
                          onClick={() => handleToggle(job)}
                          className={clsx(
                            "relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none",
                            job.enabled ? "bg-blue-600" : "bg-gray-200"
                          )}
                        >
                          <span className={clsx(
                            "pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out",
                            job.enabled ? "translate-x-5" : "translate-x-0"
                          )} />
                        </button>
                      </div>

                      <div className="flex-1 mb-6">
                        <div className="flex items-center gap-2 mb-2">
                          <Clock className="w-3.5 h-3.5 text-[var(--system-blue)]" />
                          <span className="text-[14px] font-semibold text-[var(--system-blue)]">{describeSchedule(job.schedule)}</span>
                        </div>
                        {job.description && (
                          <p className="text-[14px] text-[var(--text-secondary)] leading-relaxed line-clamp-2 italic">"{job.description}"</p>
                        )}
                      </div>

                      <div className="flex items-center justify-between pt-4 border-t border-[var(--border-subtle)] mt-auto">
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => handleRun(job)}
                            disabled={job.state === "running" || runningJobIds.has(job.id)}
                            className={clsx(
                              "p-2 rounded-lg transition-all border border-[var(--border-subtle)]",
                              job.state === "running" || runningJobIds.has(job.id)
                                ? "bg-amber-50 text-amber-600 border-amber-200 cursor-not-allowed"
                                : "bg-[var(--system-gray-6)] text-[var(--text-secondary)] hover:bg-green-50 hover:text-green-600"
                            )}
                            title={job.state === "running" || runningJobIds.has(job.id) ? "Running..." : "Run Now"}
                          >
                            {job.state === "running" || runningJobIds.has(job.id) ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Play className="w-4 h-4 fill-current" />
                            )}
                          </button>
                          <button
                            onClick={() => openEdit(job)}
                            className="p-2 rounded-lg bg-[var(--system-gray-6)] text-[var(--text-secondary)] hover:bg-blue-50 hover:text-blue-600 transition-all border border-[var(--border-subtle)]"
                            title="Edit Job"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => openHistory(job)}
                            className="p-2 rounded-lg bg-[var(--system-gray-6)] text-[var(--text-secondary)] hover:bg-[var(--system-gray-5)] hover:text-[var(--text-primary)] transition-all border border-[var(--border-subtle)]"
                            title="History"
                          >
                            <History className="w-4 h-4" />
                          </button>
                        </div>
                        <button
                          onClick={() => handleDelete(job)}
                          className="p-2 rounded-lg bg-[var(--system-gray-6)] text-[var(--text-tertiary)] hover:bg-red-50 hover:text-red-600 transition-all border border-[var(--border-subtle)]"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Editor Modal ────────────────────────────────────────── */}
      {activeTab === "jobs" && editorOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 backdrop-blur-sm px-4">
          <div className="w-full max-w-2xl max-h-[90vh] bg-white rounded-2xl border border-[var(--border-subtle)] shadow-xl flex flex-col animate-in zoom-in-95 duration-200">
            <div className="px-6 py-4 border-b border-[var(--border-subtle)] flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-[var(--text-primary)]">
                  {editingJob ? "Edit Job" : "New Job"}
                </h2>
                <p className="text-xs text-[var(--text-tertiary)] mt-1">
                  Configure schedule, tools, and instructions.
                </p>
              </div>
              <button
                onClick={() => setEditorOpen(false)}
                className="p-2 rounded-lg hover:bg-[var(--system-gray-6)] text-[var(--text-tertiary)] transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-6 py-5 overflow-auto space-y-6">
              {/* Basic Info */}
              <div className="bg-[var(--system-gray-6)]/60 rounded-xl border border-[var(--border-subtle)] p-4 space-y-4">
                <div>
                  <label className="block text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2 ml-1">Job Name</label>
                  <input
                    type="text"
                    className="w-full px-4 py-3 bg-white border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--system-blue)]/20"
                    placeholder="Morning Briefing, Inbox Triage, etc."
                    value={editor.name}
                    onChange={(e) => updateEditor({ name: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2 ml-1">Goal (optional)</label>
                  <input
                    type="text"
                    className="w-full px-4 py-3 bg-white border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--system-blue)]/20"
                    placeholder="What is this task trying to achieve?"
                    value={editor.description}
                    onChange={(e) => updateEditor({ description: e.target.value })}
                  />
                </div>
              </div>

              {/* Schedule Section */}
              <div className="bg-[var(--system-gray-6)]/60 rounded-xl border border-[var(--border-subtle)] p-4 space-y-4">
                <label className="block text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-1 ml-1">Select Schedule</label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {SCHEDULE_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => applySchedulePreset(preset.id)}
                      className={clsx(
                        "px-3 py-2 rounded-lg text-xs font-semibold transition-all border",
                        editor.schedulePreset === preset.id
                          ? "bg-[var(--system-blue)] text-white border-[var(--system-blue)]"
                          : "bg-white text-[var(--text-secondary)] border-[var(--border-default)] hover:bg-[var(--system-gray-6)]"
                      )}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>

                {/* Conditional Inputs */}
                <div className="pt-1">
                  {["daily", "weekdays", "weekends", "mwf"].includes(editor.schedulePreset) && (
                    <div className="flex flex-col gap-2">
                      <label className="text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wide ml-1">Execution Time</label>
                      <input
                        type="time"
                        className="w-full px-4 py-3 bg-white border border-[var(--border-default)] rounded-lg text-sm font-semibold text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--system-blue)]/20"
                        value={editor.scheduleTime}
                        onChange={(e) => {
                          const nextTime = e.target.value || defaultEditor.scheduleTime;
                          const days =
                            editor.schedulePreset === "daily" ? "*" :
                            editor.schedulePreset === "weekdays" ? "1-5" :
                            editor.schedulePreset === "weekends" ? "0,6" : "1,3,5";
                          updateEditor({
                            scheduleTime: nextTime,
                            scheduleType: "cron",
                            cronExpr: buildCronExpr(nextTime, days),
                          });
                        }}
                      />
                    </div>
                  )}
                  {editor.schedulePreset === "once" && (
                    <div className="flex flex-col gap-2">
                      <label className="text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wide ml-1">Date & Time</label>
                      <input
                        type="datetime-local"
                        className="w-full px-4 py-3 bg-white border border-[var(--border-default)] rounded-lg text-sm font-semibold text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--system-blue)]/20"
                        value={editor.atDate ? editor.atDate.slice(0, 16) : ""}
                        onChange={(e) =>
                          updateEditor({
                            scheduleType: "at",
                            atDate: new Date(e.target.value).toISOString(),
                          })
                        }
                      />
                    </div>
                  )}
                  {editor.schedulePreset === "custom" && editor.scheduleType === "every" && (
                    <div className="flex flex-col gap-2">
                      <label className="text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wide ml-1">Interval (minutes)</label>
                      <input
                        type="number"
                        min="1"
                        className="w-full px-4 py-3 bg-white border border-[var(--border-default)] rounded-lg text-sm font-semibold text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--system-blue)]/20"
                        value={editor.intervalMinutes}
                        onChange={(e) => updateEditor({ scheduleType: "every", intervalMinutes: e.target.value })}
                      />
                    </div>
                  )}
                  {editor.schedulePreset === "custom" && editor.scheduleType === "cron" && (
                    <div className="flex flex-col gap-2">
                      <label className="text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wide ml-1">Cron Expression</label>
                      <input
                        type="text"
                        className="w-full px-4 py-3 bg-white border border-[var(--border-default)] rounded-lg text-sm font-mono text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--system-blue)]/20"
                        placeholder="0 * * * *"
                        value={editor.cronExpr}
                        onChange={(e) => updateEditor({ scheduleType: "cron", cronExpr: e.target.value })}
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Plugins Selection */}
              <div className="bg-[var(--system-gray-6)]/60 rounded-xl border border-[var(--border-subtle)] p-4">
                <div className="flex items-center justify-between mb-3">
                  <label className="text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wide ml-1">Select Tools</label>
                  {skills.length > 0 && (
                    <div className="flex gap-3">
                      <button type="button" className="text-[11px] font-semibold text-[var(--system-blue)] hover:underline" onClick={() => updateSkillSelection(skills.map(s => s.id))}>Select All</button>
                      <button type="button" className="text-[11px] font-semibold text-[var(--text-tertiary)] hover:underline" onClick={() => updateSkillSelection([])}>Clear</button>
                    </div>
                  )}
                </div>

                {skills.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {skills.map((skill) => {
                      const sel = editor.skillIds.includes(skill.id);
                      return (
                        <button
                          key={skill.id}
                          type="button"
                          onClick={() => {
                            const next = sel ? editor.skillIds.filter(id => id !== skill.id) : [...editor.skillIds, skill.id];
                            updateSkillSelection(next);
                          }}
                          className={clsx(
                            "px-3 py-1.5 rounded-full text-[11px] font-semibold transition-all border",
                            sel ? "bg-[var(--system-blue)]/10 text-[var(--system-blue)] border-[var(--system-blue)]/20" : "bg-white text-[var(--text-secondary)] border-[var(--border-default)] hover:bg-[var(--system-gray-6)]"
                          )}
                        >
                          {skill.label}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-[var(--text-tertiary)] italic ml-1">No tools connected.</p>
                )}
              </div>

              {/* Instructions Section */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wide ml-1">Job Instructions</label>
                  <button
                    type="button"
                    onClick={handleGenerateSteps}
                    disabled={generatingSteps}
                    className="flex items-center gap-1.5 text-[var(--system-blue)] hover:opacity-80 font-semibold text-xs"
                  >
                    {generatingSteps ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                    Auto-Generate
                  </button>
                </div>
                <textarea
                  className="w-full px-4 py-3.5 bg-white border border-[var(--border-default)] rounded-xl text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--system-blue)]/20 min-h-[160px] leading-relaxed"
                  placeholder="Tell Joulie exactly what steps to execute on each run..."
                  value={editor.message}
                  onChange={(e) => updateEditor({ message: e.target.value })}
                />
                {generateStepsError && <p className="text-xs text-red-500 font-semibold ml-1">{generateStepsError}</p>}
              </div>

            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 border-t border-[var(--border-subtle)] bg-white flex items-center gap-3">
              <button
                onClick={() => setEditorOpen(false)}
                className="flex-1 py-2.5 text-sm font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--system-gray-6)] rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !editor.name.trim()}
                className="flex-1 py-2.5 text-sm font-semibold bg-[var(--system-blue)] text-white rounded-lg hover:opacity-90 disabled:opacity-50 transition-all"
              >
                {saving ? "Saving..." : editingJob ? "Update Job" : "Create Job"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Cleanup Modal ─────────────────────────────────────────── */}
      {activeTab === "tasks" && cleanupModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 backdrop-blur-sm px-4">
          <div className="w-full max-w-2xl max-h-[90vh] bg-white rounded-2xl border border-[var(--border-subtle)] shadow-xl flex flex-col animate-in zoom-in-95 duration-200">
            <div className="px-6 py-4 border-b border-[var(--border-subtle)] flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-[var(--text-primary)]">Clean up task board</h2>
                <p className="text-xs text-[var(--text-tertiary)] mt-1">
                  Ask OpenClaw what should be cleaned, then apply a suggested action.
                </p>
              </div>
              <button
                onClick={closeCleanupConversation}
                className="p-2 rounded-lg hover:bg-[var(--system-gray-6)] text-[var(--text-tertiary)] transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="px-6 py-5 overflow-auto space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => {
                    setCleanupPrompt("Remove all completed work from done.");
                    void (async () => {
                      await applyBoardCleanupAction("remove_done", { skipConfirm: true });
                      closeCleanupConversation();
                    })();
                  }}
                  className="px-3 py-1.5 rounded-full text-[11px] font-semibold border border-[var(--border-default)] bg-white text-[var(--text-secondary)] hover:bg-[var(--system-gray-6)]"
                >
                  Remove all from DONE
                </button>
                <button
                  onClick={() => setCleanupPrompt("Suggest the safest cleanup action for this board right now.")}
                  className="px-3 py-1.5 rounded-full text-[11px] font-semibold border border-[var(--border-default)] bg-white text-[var(--text-secondary)] hover:bg-[var(--system-gray-6)]"
                >
                  Suggest safest cleanup
                </button>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2 ml-1">
                  Cleanup request
                </label>
                <textarea
                  className="w-full px-4 py-3 bg-white border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--system-blue)]/20 min-h-[120px]"
                  placeholder="Ask OpenClaw what should be cleaned up."
                  value={cleanupPrompt}
                  onChange={(event) => setCleanupPrompt(event.target.value)}
                />
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => void runCleanupConversation()}
                  disabled={cleanupLoading || !gatewayRunning}
                  className="px-4 py-2 rounded-lg bg-[var(--system-blue)] text-white text-sm font-semibold hover:opacity-90 disabled:opacity-50"
                >
                  {cleanupLoading ? "Asking OpenClaw..." : "Ask OpenClaw"}
                </button>
                {cleanupSuggestedAction ? (
                  <button
                    onClick={() => {
                      void (async () => {
                        await applyBoardCleanupAction(cleanupSuggestedAction, {
                          skipConfirm: true,
                        });
                        closeCleanupConversation();
                      })();
                    }}
                    className="px-4 py-2 rounded-lg border border-[var(--border-default)] bg-white text-sm font-semibold text-[var(--text-primary)] hover:bg-[var(--system-gray-6)]"
                  >
                    Apply suggestion: {BOARD_CLEANUP_ACTION_LABEL[cleanupSuggestedAction]}
                  </button>
                ) : null}
              </div>

              {cleanupError ? (
                <div className="p-3 rounded-lg bg-red-50 border border-red-100 text-sm text-red-600">
                  {cleanupError}
                </div>
              ) : null}

              {cleanupReply ? (
                <div className="rounded-xl border border-[var(--border-default)] bg-[var(--system-gray-6)]/60 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mb-2">
                    OpenClaw recommendation
                  </p>
                  <pre className="whitespace-pre-wrap text-sm text-[var(--text-primary)] font-sans leading-relaxed">
                    {cleanupReply}
                  </pre>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* ── Quick Task Create Modal ────────────────────────────────── */}
      {activeTab === "tasks" && boardQuickCreateOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 backdrop-blur-sm px-4">
          <div className="w-full max-w-xl bg-white rounded-2xl border border-[var(--border-subtle)] shadow-xl flex flex-col animate-in zoom-in-95 duration-200">
            <div className="px-6 py-4 border-b border-[var(--border-subtle)] flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-[var(--text-primary)]">New Task</h2>
                <p className="text-xs text-[var(--text-tertiary)] mt-1">
                  Describe what needs to be done. OpenClaw will add it to your board.
                </p>
              </div>
              <button
                onClick={closeBoardQuickCreate}
                className="p-2 rounded-lg hover:bg-[var(--system-gray-6)] text-[var(--text-tertiary)] transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2 ml-1">
                  What needs to be done?
                </label>
                <textarea
                  className="w-full px-4 py-3 bg-white border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--system-blue)]/20 min-h-[140px]"
                  placeholder="Example: Follow up with design on dashboard polish and move blocked API items forward this week."
                  value={boardQuickPrompt}
                  onChange={(event) => {
                    setBoardQuickPrompt(event.target.value);
                    if (boardQuickError) setBoardQuickError(null);
                  }}
                />
              </div>
              {boardQuickCreating ? (
                <div className="p-3 rounded-lg bg-[var(--system-gray-6)] border border-[var(--border-default)] text-sm text-[var(--text-secondary)] flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-[var(--system-blue)]" />
                  Saving task...
                </div>
              ) : null}
              {boardQuickSuccess ? (
                <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-100 text-sm text-emerald-700 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4" />
                  {boardQuickSuccess}
                </div>
              ) : null}
              {boardQuickError ? (
                <div className="p-3 rounded-lg bg-red-50 border border-red-100 text-sm text-red-600 space-y-3">
                  <p>{boardQuickError.message}</p>
                  {boardQuickError.kind === "billing" ? (
                    <button
                      type="button"
                      onClick={openBillingFromQuickTask}
                      className="px-3 py-1.5 rounded-lg border border-red-200 bg-white text-[12px] font-semibold text-red-700 hover:bg-red-100/60"
                    >
                      Open Billing
                    </button>
                  ) : null}
                  {boardQuickError.kind === "auth" ? (
                    <button
                      type="button"
                      onClick={requestSignInFromQuickTask}
                      className="px-3 py-1.5 rounded-lg border border-red-200 bg-white text-[12px] font-semibold text-red-700 hover:bg-red-100/60"
                    >
                      Sign In
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="px-6 py-4 border-t border-[var(--border-subtle)] bg-white flex items-center gap-3">
              <button
                onClick={closeBoardQuickCreate}
                className="flex-1 py-2.5 text-sm font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--system-gray-6)] rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void createBoardTaskFromPrompt()}
                disabled={boardQuickCreating || Boolean(boardQuickSuccess) || !boardQuickPrompt.trim()}
                className="flex-1 inline-flex items-center justify-center gap-1.5 py-2.5 text-sm font-semibold bg-[var(--system-blue)] text-white rounded-lg hover:opacity-90 disabled:opacity-50 transition-all"
              >
                {boardQuickCreating ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : boardQuickSuccess ? (
                  <>
                    <CheckCircle2 className="w-4 h-4" />
                    Saved
                  </>
                ) : (
                  "Add Task"
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Board Task Modal ───────────────────────────────────────── */}
      {activeTab === "tasks" && boardEditorOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 backdrop-blur-sm px-4">
          <div className="w-full max-w-xl bg-white rounded-2xl border border-[var(--border-subtle)] shadow-xl flex flex-col animate-in zoom-in-95 duration-200">
            <div className="px-6 py-4 border-b border-[var(--border-subtle)] flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-[var(--text-primary)]">Edit Task</h2>
                <p className="text-xs text-[var(--text-tertiary)] mt-1">
                  Update task details saved in your workspace.
                </p>
              </div>
              <button
                onClick={closeBoardEditor}
                className="p-2 rounded-lg hover:bg-[var(--system-gray-6)] text-[var(--text-tertiary)] transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2 ml-1">
                  Title
                </label>
                <input
                  type="text"
                  className="w-full px-4 py-3 bg-white border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--system-blue)]/20"
                  placeholder="What needs to happen?"
                  value={boardEditor.title}
                  onChange={(event) => setBoardEditor((prev) => ({ ...prev, title: event.target.value }))}
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2 ml-1">
                  Description
                </label>
                <textarea
                  className="w-full px-4 py-3 bg-white border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--system-blue)]/20 min-h-[110px]"
                  placeholder="Context, acceptance criteria, or implementation notes."
                  value={boardEditor.description}
                  onChange={(event) => setBoardEditor((prev) => ({ ...prev, description: event.target.value }))}
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2 ml-1">
                    Status
                  </label>
                  <select
                    value={boardEditor.status}
                    onChange={(event) =>
                      setBoardEditor((prev) => ({
                        ...prev,
                        status: (event.target.value as TaskBoardStatus) || "todo",
                      }))
                    }
                    className="form-input !py-2.5"
                  >
                    {TASK_BOARD_STATUS_ORDER.map((statusOption) => (
                      <option key={statusOption} value={statusOption}>
                        {TASK_BOARD_COLUMN_META[statusOption].label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2 ml-1">
                    Priority
                  </label>
                  <select
                    value={boardEditor.priority}
                    onChange={(event) =>
                      setBoardEditor((prev) => ({
                        ...prev,
                        priority: (event.target.value as TaskBoardPriority) || "medium",
                      }))
                    }
                    className="form-input !py-2.5"
                  >
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2 ml-1">
                    Owner
                  </label>
                  <select
                    value={boardEditor.owner}
                    onChange={(event) =>
                      setBoardEditor((prev) => ({
                        ...prev,
                        owner: (event.target.value as TaskBoardOwner) || "user",
                      }))
                    }
                    className="form-input !py-2.5"
                  >
                    <option value="user">You</option>
                    <option value="agent">Agent (OpenClaw)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2 ml-1">
                    Due (optional)
                  </label>
                  <input
                    type="datetime-local"
                    className="w-full px-4 py-2.5 bg-white border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--system-blue)]/20"
                    value={boardEditor.dueAt}
                    onChange={(event) => setBoardEditor((prev) => ({ ...prev, dueAt: event.target.value }))}
                  />
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-2 ml-1">
                  Labels
                </label>
                <input
                  type="text"
                  className="w-full px-4 py-2.5 bg-white border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--system-blue)]/20"
                  placeholder="comma, separated, labels"
                  value={boardEditor.labelsInput}
                  onChange={(event) => setBoardEditor((prev) => ({ ...prev, labelsInput: event.target.value }))}
                />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-[var(--border-subtle)] bg-white flex items-center gap-3">
              <button
                onClick={closeBoardEditor}
                className="flex-1 py-2.5 text-sm font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--system-gray-6)] rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void saveBoardTask()}
                disabled={boardSaving || !boardEditor.title.trim()}
                className="flex-1 py-2.5 text-sm font-semibold bg-[var(--system-blue)] text-white rounded-lg hover:opacity-90 disabled:opacity-50 transition-all"
              >
                {boardSaving ? "Saving..." : "Update Task"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── History Modal ───────────────────────────────────────── */}
      {activeTab === "jobs" && historyJobId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 backdrop-blur-md px-4" onClick={() => setHistoryJobId(null)}>
          <div className="bg-white p-8 w-full max-w-xl max-h-[80vh] flex flex-col rounded-[36px] shadow-2xl border border-gray-100 animate-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-8">
              <div>
                <h2 className="text-2xl font-bold text-gray-900 tracking-tight">Run History</h2>
                <p className="text-sm text-gray-500 font-medium mt-1">{historyJobName}</p>
              </div>
              <button
                onClick={() => setHistoryJobId(null)}
                className="p-2 rounded-full hover:bg-gray-100 text-gray-400 transition-colors"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            <div className="flex-1 overflow-auto space-y-3 pr-2 custom-scrollbar">
              {historyLoading ? (
                <div className="py-24 flex flex-col items-center gap-4">
                  <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
                  <p className="text-gray-400 font-bold uppercase tracking-widest text-[10px]">Loading logs...</p>
                </div>
              ) : runs.length === 0 ? (
                <div className="py-24 text-center">
                  <Clock className="w-12 h-12 mx-auto mb-4 text-gray-200" strokeWidth={1.5} />
                  <p className="text-gray-500 font-medium">No execution logs found for this job.</p>
                </div>
              ) : (
                runs.map((run) => (
                  <div
                    key={run.id}
                    className="p-5 rounded-[22px] bg-gray-50 border border-gray-100 group hover:bg-white hover:shadow-md transition-all duration-300"
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <div className={clsx(
                          "w-2 h-2 rounded-full",
                          run.status === "ok" ? "bg-green-500" : run.status === "skipped" ? "bg-gray-400" : "bg-red-500"
                        )} />
                        <span className="text-[14px] font-bold text-gray-900">{formatRunTime(run)}</span>
                      </div>
                      <span
                        className={clsx(
                          "text-[10px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-md border",
                          run.status === "ok" ? "bg-green-50 text-green-600 border-green-100" : 
                          run.status === "skipped" ? "bg-gray-100 text-gray-500 border-gray-200" : 
                          "bg-red-50 text-red-600 border-red-100"
                        )}
                      >
                        {run.status}
                      </span>
                    </div>
                    
                    <div className="flex items-center gap-4 text-xs text-gray-400 font-medium">
                      {formatRunDuration(run) && (
                        <div className="flex items-center gap-1.5">
                          <Clock className="w-3 h-3" />
                          <span>Took {formatRunDuration(run)}</span>
                        </div>
                      )}
                    </div>

                    {run.error && (
                      <div className="mt-4 p-3 bg-red-50 rounded-xl border border-red-100 text-[13px] text-red-600 font-medium leading-relaxed">
                        {run.error}
                      </div>
                    )}
                    {!run.error && run.summary && (
                      <div className="mt-4 text-[13px] text-gray-600 font-medium leading-relaxed line-clamp-3 group-hover:line-clamp-none transition-all">
                        {run.summary}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
