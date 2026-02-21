import { invoke } from "@tauri-apps/api/core";

export type TaskBoardStatus = "todo" | "in_progress" | "blocked" | "done";
export type TaskBoardPriority = "low" | "medium" | "high" | "critical";
export type TaskBoardOwner = "user" | "agent";

export type TaskBoardItem = {
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

export type TaskBoardDoc = {
  version: 1;
  updatedAt: number;
  tasks: TaskBoardItem[];
};

export type CreateTaskBoardItemInput = {
  title: string;
  description?: string;
  status?: TaskBoardStatus;
  priority?: TaskBoardPriority;
  owner?: TaskBoardOwner;
  labels?: string[];
  dueAt?: string;
  linkedJobId?: string;
};

export type TaskBoardChatIntent =
  | {
      action: "create";
      title: string;
      description: string;
      status: TaskBoardStatus;
      priority: TaskBoardPriority;
      owner: TaskBoardOwner;
      labels: string[];
      dueAt?: string;
    };

export const TASK_BOARD_JSON_PATH = "tasks/board.json";
export const TASK_BOARD_MARKDOWN_PATH = "TASKS.md";
export const HEARTBEAT_PATH = "HEARTBEAT.md";
export const HEARTBEAT_TASK_BLOCK_START = "<!-- ENTROPIC_TASK_BOARD:START -->";
export const HEARTBEAT_TASK_BLOCK_END = "<!-- ENTROPIC_TASK_BOARD:END -->";
export const HEARTBEAT_TASK_LINE =
  "- Review TASKS.md and active board items. Surface blockers, deadlines, and next actions.";

export const TASK_BOARD_STATUS_ORDER: TaskBoardStatus[] = [
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

const TASK_BOARD_COLUMN_LABELS: Record<TaskBoardStatus, string> = {
  todo: "TODO",
  in_progress: "IN PROGRESS",
  blocked: "BLOCKED",
  done: "DONE",
};

const STATUS_TOKEN_MAP: Record<string, TaskBoardStatus> = {
  backlog: "todo",
  todo: "todo",
  "to do": "todo",
  inprogress: "in_progress",
  "in progress": "in_progress",
  blocked: "blocked",
  done: "done",
};

const PRIORITY_TOKEN_MAP: Record<string, TaskBoardPriority> = {
  p0: "critical",
  p1: "high",
  p2: "medium",
  p3: "low",
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
};

const OWNER_TOKEN_MAP: Record<string, TaskBoardOwner> = {
  user: "user",
  me: "user",
  myself: "user",
  human: "user",
  i: "user",
  agent: "agent",
  assistant: "agent",
  openclaw: "agent",
  entropic: "agent",
  ai: "agent",
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

function sanitizeLabelValue(label: string): string {
  return label.trim().replace(/\s+/g, " ");
}

function uniqueLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const label of labels) {
    const normalized = sanitizeLabelValue(label);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(normalized);
  }
  return next;
}

export function parseTaskLabels(raw: string): string[] {
  return uniqueLabels(raw.split(","));
}

export function isTaskBoardStatus(value: unknown): value is TaskBoardStatus {
  return value === "todo" || value === "in_progress" || value === "blocked" || value === "done";
}

function normalizeTaskStatus(value: unknown): TaskBoardStatus {
  if (value === "backlog") return "todo";
  return isTaskBoardStatus(value) ? value : "todo";
}

export function isTaskBoardPriority(value: unknown): value is TaskBoardPriority {
  return value === "low" || value === "medium" || value === "high" || value === "critical";
}

export function isTaskBoardOwner(value: unknown): value is TaskBoardOwner {
  return value === "user" || value === "agent";
}

function normalizeTaskOwner(value: unknown): TaskBoardOwner {
  if (isTaskBoardOwner(value)) return value;
  if (typeof value !== "string") return "user";
  const normalized = value.toLowerCase().trim();
  return OWNER_TOKEN_MAP[normalized] || "user";
}

function inferOwnerFromLabels(labels: string[]): TaskBoardOwner | null {
  for (const label of labels) {
    const normalized = label.toLowerCase().trim();
    if (
      normalized === "agent" ||
      normalized === "assistant" ||
      normalized === "openclaw" ||
      normalized === "entropic" ||
      normalized === "ai"
    ) {
      return "agent";
    }
    if (
      normalized === "user" ||
      normalized === "me" ||
      normalized === "myself" ||
      normalized === "human"
    ) {
      return "user";
    }
  }
  return null;
}

export function formatTaskDueDate(value?: string): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function formatTaskBoardOwnerLabel(owner: TaskBoardOwner): string {
  return owner === "agent" ? "Agent" : "You";
}

export function normalizeTaskBoardDoc(raw: unknown): TaskBoardDoc {
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
      ? uniqueLabels(
          parsed.labels.map((label) => (typeof label === "string" ? label : ""))
        )
      : [];
    const owner = normalizeTaskOwner(
      (parsed as Partial<TaskBoardItem> & { owner?: unknown }).owner || inferOwnerFromLabels(labels) || "user"
    );
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

export function buildTaskBoardMarkdown(tasks: TaskBoardItem[]): string {
  const lines: string[] = [];
  lines.push("# TASKS.md - Agent Task Board");
  lines.push("");
  lines.push("Current collaborative task board state.");
  lines.push("");
  for (const status of TASK_BOARD_STATUS_ORDER) {
    const statusTasks = tasks.filter((task) => task.status === status);
    lines.push(`## ${TASK_BOARD_COLUMN_LABELS[status]}`);
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

export function upsertHeartbeatTaskBlock(currentRaw: string): string {
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

export async function readWorkspaceText(path: string): Promise<string | null> {
  try {
    return await invoke<string>("read_workspace_file", { path });
  } catch {
    return null;
  }
}

export async function writeWorkspaceText(path: string, content: string): Promise<void> {
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

export async function loadTaskBoardDoc(): Promise<TaskBoardDoc> {
  const raw = await readWorkspaceText(TASK_BOARD_JSON_PATH);
  if (!raw || !raw.trim()) {
    return { version: 1, updatedAt: Date.now(), tasks: [] };
  }
  try {
    return normalizeTaskBoardDoc(JSON.parse(raw));
  } catch {
    throw new Error("Task board data is invalid. Repair or replace tasks/board.json.");
  }
}

export async function persistTaskBoardArtifacts(tasks: TaskBoardItem[]): Promise<void> {
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
}

export async function addTaskBoardItem(input: CreateTaskBoardItemInput): Promise<TaskBoardItem> {
  const title = input.title.trim();
  if (!title) {
    throw new Error("Task title is required.");
  }
  const doc = await loadTaskBoardDoc();
  const now = Date.now();
  const dueAt =
    typeof input.dueAt === "string" && Number.isFinite(Date.parse(input.dueAt))
      ? new Date(input.dueAt).toISOString()
      : undefined;
  const nextTask: TaskBoardItem = {
    id: crypto.randomUUID(),
    title,
    description: input.description?.trim() || "",
    status: input.status || "todo",
    priority: input.priority || "medium",
    owner: input.owner || "user",
    labels: uniqueLabels(input.labels || []),
    dueAt,
    linkedJobId: input.linkedJobId?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };
  const nextTasks = [nextTask, ...doc.tasks];
  await persistTaskBoardArtifacts(nextTasks);
  return nextTask;
}

function normalizeStatusToken(raw?: string): TaskBoardStatus | null {
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/\s+/g, " ").trim();
  return STATUS_TOKEN_MAP[key] || STATUS_TOKEN_MAP[key.replace(/\s+/g, "")] || null;
}

function normalizePriorityToken(raw?: string): TaskBoardPriority | null {
  if (!raw) return null;
  return PRIORITY_TOKEN_MAP[raw.toLowerCase().trim()] || null;
}

function normalizeOwnerToken(raw?: string): TaskBoardOwner | null {
  if (!raw) return null;
  return OWNER_TOKEN_MAP[raw.toLowerCase().trim()] || null;
}

function extractHashtagLabels(value: string): { stripped: string; labels: string[] } {
  const labels: string[] = [];
  const stripped = value.replace(/(^|\s)#([a-z0-9][a-z0-9_-]*)\b/gi, (_m, lead: string, label: string) => {
    labels.push(label);
    return lead;
  });
  return {
    stripped: stripped.replace(/\s+/g, " ").trim(),
    labels: uniqueLabels(labels),
  };
}

function extractTaskOwner(value: string): { stripped: string; owner?: TaskBoardOwner } {
  let working = value;
  let owner: TaskBoardOwner | undefined;

  const explicitMatch = working.match(
    /\b(?:owner|assignee|assigned\s+to)\s*[:=]\s*(agent|assistant|openclaw|entropic|ai|user|human|me|myself|i)\b/i
  );
  if (explicitMatch) {
    owner = normalizeOwnerToken(explicitMatch[1]) || undefined;
    working = working.replace(explicitMatch[0], " ");
  }

  if (!owner) {
    if (
      /^\s*(?:agent|assistant|openclaw|entropic|ai)\s+(?:needs\s+to|should)\s+/i.test(working) ||
      /\bfor\s+(?:the\s+)?(?:agent|assistant|openclaw|entropic|ai)\b/i.test(working)
    ) {
      owner = "agent";
    } else if (
      /^\s*i\s+need\s+to\s+/i.test(working) ||
      /\bfor\s+(?:me|myself|user)\b/i.test(working)
    ) {
      owner = "user";
    }
  }

  working = working
    .replace(/^\s*(?:for\s+(?:the\s+)?(?:agent|assistant|openclaw|entropic|ai)\s*[:\-]?\s*)/i, "")
    .replace(/^\s*(?:for\s+(?:me|myself|user)\s*[:\-]?\s*)/i, "")
    .replace(/^\s*(?:agent|assistant|openclaw|entropic|ai)\s+(?:needs\s+to|should)\s+/i, "")
    .replace(/^\s*i\s+need\s+to\s+/i, "")
    .replace(/\s+for\s+(?:the\s+)?(?:agent|assistant|openclaw|entropic|ai)\b/i, " ")
    .replace(/\s+for\s+(?:me|myself|user)\b/i, " ")
    .replace(/\s+/g, " ")
    .trim();

  return { stripped: working, owner };
}

export function formatTaskBoardStatusLabel(status: TaskBoardStatus): string {
  return TASK_BOARD_COLUMN_LABELS[status];
}

export function parseTaskBoardChatIntent(message: string): TaskBoardChatIntent | null {
  const trimmed = message.trim();
  if (!trimmed) return null;

  let status: TaskBoardStatus = "todo";
  let body = "";

  const directTaskMatch = trimmed.match(
    /^(?:please\s+)?(?:add|create|track)\s+(?:a\s+)?task(?:\s+(?:to|in)\s+(backlog|todo|to\s*do|in\s*progress|blocked|done))?\s*[:\-]\s*(.+)$/i
  );
  const boardMatch = trimmed.match(
    /^(?:please\s+)?(?:add|create|track)\s+(?:this\s+)?(?:to\s+)?(?:my\s+)?(?:task\s+)?board\s*[:\-]\s*(.+)$/i
  );
  const boardTaskFirstMatch = trimmed.match(
    /^(?:please\s+)?(?:add|create|track)\s+(?:a\s+)?task\s+(?:on|to)\s+(?:my\s+)?(?:task\s+)?board\s*(?:(?:[:\-]\s*)|(?:to\s+))?(.+)$/i
  );
  const statusFirstMatch = trimmed.match(
    /^(?:please\s+)?(?:add|create)\s+(?:to\s+)?(backlog|todo|to\s*do|in\s*progress|blocked|done)\s*[:\-]\s*(.+)$/i
  );
  const naturalTaskBoardMatch = trimmed.match(
    /^(?:please\s+)?(?:add|create|track)\s+(?:a\s+)?task\s+(?:to\s+)?(.+?)\s+(?:on|to)\s+(?:my\s+)?(?:task\s+)?board[.!?]*$/i
  );
  const naturalBoardMatch = trimmed.match(
    /^(?:please\s+)?(?:add|create|track)\s+(.+?)\s+(?:on|to)\s+(?:my\s+)?(?:task\s+)?board[.!?]*$/i
  );

  if (directTaskMatch) {
    status = normalizeStatusToken(directTaskMatch[1] || "") || "todo";
    body = directTaskMatch[2] || "";
  } else if (statusFirstMatch) {
    status = normalizeStatusToken(statusFirstMatch[1] || "") || "todo";
    body = statusFirstMatch[2] || "";
  } else if (boardMatch) {
    body = boardMatch[1] || "";
  } else if (boardTaskFirstMatch) {
    body = boardTaskFirstMatch[1] || "";
  } else if (naturalTaskBoardMatch) {
    body = naturalTaskBoardMatch[1] || "";
  } else if (naturalBoardMatch) {
    body = naturalBoardMatch[1] || "";
  } else {
    return null;
  }

  let working = body.trim();
  if (!working) return null;

  const dueMatch = working.match(/\bdue\s*[:=]\s*(\d{4}-\d{2}-\d{2})\b/i);
  const dueAt = dueMatch?.[1];
  if (dueMatch?.[0]) {
    working = working.replace(dueMatch[0], " ").replace(/\s+/g, " ").trim();
  }

  const priorityMatch = working.match(/\b(?:priority|prio)\s*[:=]\s*(critical|high|medium|low|p0|p1|p2|p3)\b/i);
  const priority = normalizePriorityToken(priorityMatch?.[1] || "") || "medium";
  if (priorityMatch?.[0]) {
    working = working.replace(priorityMatch[0], " ").replace(/\s+/g, " ").trim();
  }

  const ownerMatch = extractTaskOwner(working);
  working = ownerMatch.stripped;
  const owner = ownerMatch.owner || "user";

  const parts = working.split(/\s+\|\s+/, 2);
  const extracted = extractHashtagLabels(parts[0] || "");
  const title = extracted.stripped.replace(/[.!?]+$/, "").trim();
  const description = parts.length > 1 ? parts[1].trim() : "";
  if (!title) return null;

  return {
    action: "create",
    title,
    description,
    status,
    priority,
    owner,
    labels: extracted.labels,
    dueAt,
  };
}
