import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  CalendarClock,
  Plus,
  RefreshCw,
  Play,
  Pencil,
  Clock,
  Trash2,
  ToggleLeft,
  ToggleRight,
  X,
} from "lucide-react";
import clsx from "clsx";
import { invoke } from "@tauri-apps/api/core";
import {
  getGatewayClient,
  GatewayClient,
  type ChatEvent,
  type CronJob,
  type CronSchedule,
  type CronPayload,
  type CronRunLogEntry,
} from "../lib/gateway";
import { getIntegrations, type Integration } from "../lib/integrations";

type Props = {
  gatewayRunning: boolean;
};

const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:19789";
const GATEWAY_TOKEN = "nova-local-gateway";

function describeSchedule(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case "at":
      return `Once at ${new Date(schedule.atMs).toLocaleString()}`;
    case "every": {
      const ms = schedule.everyMs;
      if (ms < 60_000) return `Every ${Math.round(ms / 1000)}s`;
      if (ms < 3_600_000) return `Every ${Math.round(ms / 60_000)} minutes`;
      if (ms < 86_400_000) return `Every ${Math.round(ms / 3_600_000)} hours`;
      return `Every ${Math.round(ms / 86_400_000)} days`;
    }
    case "cron":
      return `Cron: ${schedule.expr}`;
    default:
      return "Unknown schedule";
  }
}

function statusDot(job: CronJob): { color: string; title: string } {
  if (!job.enabled) return { color: "#9ca3af", title: "Disabled" };
  if (job.state === "running") return { color: "#eab308", title: "Running" };
  if (job.state === "error") return { color: "#ef4444", title: "Last run errored" };
  return { color: "#22c55e", title: "Enabled" };
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
};

const CHANNEL_OPTIONS: Array<{ id: string; label: string; helper: string }> = [
  { id: "telegram", label: "Telegram", helper: "Chat ID or @username" },
  { id: "whatsapp", label: "WhatsApp", helper: "Phone number with country code" },
  { id: "imessage", label: "iMessage", helper: "Phone number or email" },
  { id: "discord", label: "Discord", helper: "User ID or channel ID" },
];

const SCHEDULE_PRESETS: Array<{ id: SchedulePreset; label: string; needsTime?: boolean }> = [
  { id: "every_hour", label: "Every hour" },
  { id: "daily", label: "Once a day", needsTime: true },
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
      state.message = job.payload.message;
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
    skillLabels.length > 0 ? `Selected skills: ${skillLabels.join(", ")}` : "Selected skills: none";

  return [
    "You are helping a user create a scheduled task for Nova/OpenClaw.",
    `Task name: ${editor.name.trim() || "(untitled)"}`,
    `Task description: ${editor.description.trim() || "(none)"}`,
    `Goal: ${goal}`,
    skillsLine,
    "",
    "Infer the most likely user intent from the name/description and selected skills.",
    "Write the task instructions the agent should run on each schedule.",
    "Requirements:",
    "- Use the selected skills explicitly by name if provided.",
    "- Keep it concise and actionable.",
    "- Output only the task instructions (no preamble or explanations).",
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
        const text =
          event.message?.content?.filter((c) => c.type === "text").map((c) => c.text).join("") ??
          "";
        if (text) lastText = text;
        if (event.state === "final") {
          cleanup();
          resolve(lastText.trim());
        }
      } else if (event.state === "error") {
        cleanup();
        reject(new Error(event.errorMessage || "OpenClaw error"));
      } else if (event.state === "aborted") {
        cleanup();
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

async function resolveGatewayUrl(): Promise<string> {
  try {
    const url = await invoke<string>("get_gateway_ws_url");
    return url || DEFAULT_GATEWAY_URL;
  } catch {
    return DEFAULT_GATEWAY_URL;
  }
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
  const payload: CronPayload = {
    kind: "agentTurn",
    message: editor.message || "Hello",
  };

  if (editor.notifyEnabled) {
    payload.deliver = true;
    payload.channel = editor.notifyChannel || "last";
    if (editor.notifyTo.trim()) {
      payload.to = editor.notifyTo.trim();
    }
    payload.bestEffortDeliver = false;
  }

  return payload;
}

export function Tasks({ gatewayRunning }: Props) {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [channelOptions, setChannelOptions] = useState<Array<{ id: string; label: string; helper: string }>>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [channelsError, setChannelsError] = useState<string | null>(null);

  // Editor modal
  const [editingJob, setEditingJob] = useState<CronJob | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState>(defaultEditor);
  const [saving, setSaving] = useState(false);
  const [generatingSteps, setGeneratingSteps] = useState(false);
  const [generateStepsError, setGenerateStepsError] = useState<string | null>(null);

  // History modal
  const [historyJobId, setHistoryJobId] = useState<string | null>(null);
  const [historyJobName, setHistoryJobName] = useState("");
  const [runs, setRuns] = useState<CronRunLogEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const pollRef = useRef<number | null>(null);
  const tasksClientRef = useRef<GatewayClient | null>(null);
  const tasksConnectingRef = useRef<Promise<GatewayClient> | null>(null);
  const lastAutoMessageRef = useRef<string | null>(null);
  const lastAutoKindRef = useRef<"hint" | "generated" | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadSkills() {
      setSkillsLoading(true);
      setSkillsError(null);
      const next: SkillOption[] = [];

      try {
        const integrations = await getIntegrations();
        integrations
          .filter((i) => i.connected)
          .forEach((i: Integration) => {
            const meta = INTEGRATION_LABELS[i.provider] || {
              label: i.provider,
            };
            next.push({
              id: `integration:${i.provider}`,
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
        setSkillsError("Failed to load connected skills");
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
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadChannels() {
      setChannelsLoading(true);
      setChannelsError(null);
      try {
        const state = await invoke<{
          telegram_enabled?: boolean;
          whatsapp_enabled?: boolean;
          discord_enabled?: boolean;
          imessage_enabled?: boolean;
        }>("get_agent_profile_state");
        if (cancelled) return;
        const enabledIds = new Set<string>();
        if (state.telegram_enabled) enabledIds.add("telegram");
        if (state.whatsapp_enabled) enabledIds.add("whatsapp");
        if (state.discord_enabled) enabledIds.add("discord");
        if (state.imessage_enabled) enabledIds.add("imessage");
        const filtered = CHANNEL_OPTIONS.filter((c) => enabledIds.has(c.id));
        setChannelOptions(filtered);
      } catch (e) {
        if (!cancelled) setChannelsError("Failed to load channels");
      } finally {
        if (!cancelled) setChannelsLoading(false);
      }
    }
    loadChannels();
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchJobs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await withGatewayClient((client) => client.listCronJobs(true));
      setJobs(result);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Gateway is offline. Start it to manage tasks."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!gatewayRunning) {
      tasksClientRef.current?.disconnect();
      tasksClientRef.current = null;
      setJobs([]);
      return;
    }

    (async () => {
      try {
        await ensureTasksClient();
        if (!cancelled) {
          fetchJobs();
          pollRef.current = window.setInterval(fetchJobs, 15_000);
        }
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error ? e.message : "Gateway is offline. Start it to manage tasks."
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [gatewayRunning, fetchJobs]);

  useEffect(() => {
    return () => {
      tasksClientRef.current?.disconnect();
      tasksClientRef.current = null;
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
      const sessionTarget = editor.sessionTarget || "isolated";
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
        e instanceof Error ? e.message : "Gateway is offline. Start it to save tasks."
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(job: CronJob) {
    if (!confirm(`Delete task "${job.name}"? This cannot be undone.`)) return;
    try {
      await withGatewayClient((client) => client.removeCronJob(job.id));
      fetchJobs();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Gateway is offline. Start it to delete tasks."
      );
    }
  }

  async function handleRun(job: CronJob) {
    try {
      await withGatewayClient((client) => client.runCronJob(job.id, "force"));
      // Refresh after a brief delay to pick up state change
      setTimeout(fetchJobs, 1000);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Gateway is offline. Start it to run tasks."
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
        e instanceof Error ? e.message : "Gateway is offline. Start it to update tasks."
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
        e instanceof Error ? e.message : "Gateway is offline. Start it to view history."
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
  const notifyInvalid =
    editor.notifyEnabled && (!editor.notifyChannel || !editor.notifyTo.trim());
  const selectedChannelMeta = useMemo(
    () => CHANNEL_OPTIONS.find((c) => c.id === editor.notifyChannel) || null,
    [editor.notifyChannel]
  );

  async function ensureTasksClient(): Promise<GatewayClient> {
    if (tasksClientRef.current?.isConnected()) return tasksClientRef.current;
    if (tasksConnectingRef.current) return tasksConnectingRef.current;
    if (!gatewayRunning) {
      throw new Error("Gateway is offline. Start it to manage tasks.");
    }
    tasksConnectingRef.current = (async () => {
      const url = await resolveGatewayUrl();
      const client = tasksClientRef.current ?? new GatewayClient(url, GATEWAY_TOKEN);
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

  return (
    <div className="p-6 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold" style={{ color: "var(--text-primary)" }}>
            Tasks
          </h1>
          <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>
            Scheduled tasks that run automatically
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={openCreate}
            disabled={!gatewayRunning}
            className="btn-primary flex items-center gap-2 text-sm"
          >
            <Plus className="w-4 h-4" />
            New Task
          </button>
          <button
            onClick={fetchJobs}
            disabled={loading || !gatewayRunning}
            className="btn-secondary flex items-center gap-2 text-sm"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>
      <div
        className="mb-4 p-3 rounded-lg text-xs flex items-center gap-2"
        style={{
          background: "var(--bg-secondary, #f5f5f5)",
          color: "var(--text-tertiary)",
          border: "1px solid var(--glass-border-subtle)",
        }}
      >
        Tasks run only while your laptop is awake and connected to the internet.
      </div>
      <div
        className="mb-6 p-3 rounded-lg text-xs"
        style={{
          background: "var(--bg-secondary, #f5f5f5)",
          color: "var(--text-secondary)",
          border: "1px solid var(--glass-border-subtle)",
        }}
      >
        <div className="font-medium mb-2" style={{ color: "var(--text-primary)" }}>
          Run tasks overnight
        </div>
        <ul className="list-disc list-inside space-y-1">
          <li>macOS: System Settings → Displays → Advanced → Prevent automatic sleeping. Optional: allow display off but keep system awake.</li>
          <li>Windows: Power settings → When plugged in, never sleep.</li>
          <li>Linux: `systemd-inhibit` or your power settings UI.</li>
          <li>This keeps tasks running but uses power and generates heat.</li>
        </ul>
      </div>

      {/* Gateway offline banner */}
      {!gatewayRunning && (
        <div
          className="mb-4 p-3 rounded-lg text-sm flex items-center gap-2"
          style={{
            background: "var(--bg-secondary, #f5f5f5)",
            color: "var(--text-secondary)",
            border: "1px solid var(--glass-border-subtle)",
          }}
        >
          <CalendarClock className="w-4 h-4 flex-shrink-0" />
          Gateway is offline. Start it to manage scheduled tasks.
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mb-4 p-3 rounded-lg text-sm bg-red-50 text-red-600 border border-red-200">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">
            dismiss
          </button>
        </div>
      )}

      {/* Task List */}
      <div className="flex-1 overflow-auto space-y-1">
        {gatewayRunning && loading && jobs.length === 0 ? (
          <div className="text-center py-12" style={{ color: "var(--text-tertiary)" }}>
            <RefreshCw className="w-6 h-6 mx-auto mb-2 animate-spin" />
            Loading tasks…
          </div>
        ) : gatewayRunning && jobs.length === 0 ? (
          <div className="text-center py-12" style={{ color: "var(--text-tertiary)" }}>
            <CalendarClock className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="text-sm font-medium mb-1">No scheduled tasks</p>
            <p className="text-xs">Create a task to run actions on a schedule</p>
          </div>
        ) : (
          jobs.map((job) => {
            const dot = statusDot(job);
            return (
              <div key={job.id} className="glass-card flex items-center gap-3 px-4 py-3">
                {/* Toggle */}
                <button
                  onClick={() => handleToggle(job)}
                  className="flex-shrink-0"
                  title={job.enabled ? "Disable" : "Enable"}
                >
                  {job.enabled ? (
                    <ToggleRight className="w-6 h-6" style={{ color: "var(--purple-accent)" }} />
                  ) : (
                    <ToggleLeft className="w-6 h-6" style={{ color: "var(--text-tertiary)" }} />
                  )}
                </button>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className="text-sm font-medium truncate"
                      style={{ color: "var(--text-primary)" }}
                    >
                      {job.name}
                    </span>
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ background: dot.color }}
                      title={dot.title}
                    />
                  </div>
                  <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                    {describeSchedule(job.schedule)}
                    {job.description ? ` · ${job.description}` : ""}
                  </span>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => handleRun(job)}
                    className="p-1.5 rounded hover:bg-black/10 transition-colors"
                    title="Run now"
                  >
                    <Play className="w-4 h-4" style={{ color: "var(--text-tertiary)" }} />
                  </button>
                  <button
                    onClick={() => openEdit(job)}
                    className="p-1.5 rounded hover:bg-black/10 transition-colors"
                    title="Edit"
                  >
                    <Pencil className="w-4 h-4" style={{ color: "var(--text-tertiary)" }} />
                  </button>
                  <button
                    onClick={() => openHistory(job)}
                    className="p-1.5 rounded hover:bg-black/10 transition-colors"
                    title="History"
                  >
                    <Clock className="w-4 h-4" style={{ color: "var(--text-tertiary)" }} />
                  </button>
                  <button
                    onClick={() => handleDelete(job)}
                    className="p-1.5 rounded hover:bg-red-50 transition-colors"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4 text-red-400" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* ── Editor Modal ────────────────────────────────────────── */}
      {editorOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
          onClick={() => setEditorOpen(false)}
        >
          <div
            className="glass-card p-6 w-full max-w-lg mx-4 max-h-[85vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
                {editingJob ? "Edit Task" : "New Task"}
              </h2>
              <button
                onClick={() => setEditorOpen(false)}
                className="p-1 rounded hover:bg-black/10"
              >
                <X className="w-5 h-5" style={{ color: "var(--text-tertiary)" }} />
              </button>
            </div>

            <div className="space-y-4">
              {/* Name */}
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: "var(--text-secondary)" }}>
                  Name
                </label>
                <input
                  type="text"
                  className="form-input w-full text-sm"
                  placeholder="My scheduled task"
                  value={editor.name}
                  onChange={(e) => updateEditor({ name: e.target.value })}
                />
              </div>

              {/* Description */}
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: "var(--text-secondary)" }}>
                  Description (optional)
                </label>
                <input
                  type="text"
                  className="form-input w-full text-sm"
                  placeholder="What does this task do?"
                  value={editor.description}
                  onChange={(e) => updateEditor({ description: e.target.value })}
                />
              </div>

              {/* Schedule Type */}
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: "var(--text-secondary)" }}>
                  Schedule
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {SCHEDULE_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => applySchedulePreset(preset.id)}
                      className={clsx(
                        "btn text-sm !py-2 !px-3",
                        editor.schedulePreset === preset.id
                          ? "bg-[var(--purple-accent)] text-white"
                          : "btn-secondary"
                      )}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Schedule config */}
              {editor.schedulePreset === "every_hour" && (
                <div className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                  Runs once every hour.
                </div>
              )}
              {["daily", "weekdays", "weekends", "mwf"].includes(editor.schedulePreset) && (
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: "var(--text-secondary)" }}>
                    Time
                  </label>
                  <input
                    type="time"
                    className="form-input w-full text-sm"
                    value={editor.scheduleTime}
                    onChange={(e) => {
                      const nextTime = e.target.value || defaultEditor.scheduleTime;
                      const days =
                        editor.schedulePreset === "daily"
                          ? "*"
                          : editor.schedulePreset === "weekdays"
                            ? "1-5"
                            : editor.schedulePreset === "weekends"
                              ? "0,6"
                              : "1,3,5";
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
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: "var(--text-secondary)" }}>
                    Date & Time
                  </label>
                  <input
                    type="datetime-local"
                    className="form-input w-full text-sm"
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
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: "var(--text-secondary)" }}>
                    Interval (minutes)
                  </label>
                  <input
                    type="number"
                    min="1"
                    className="form-input w-full text-sm"
                    value={editor.intervalMinutes}
                    onChange={(e) =>
                      updateEditor({
                        schedulePreset: "custom",
                        scheduleType: "every",
                        intervalMinutes: e.target.value,
                      })
                    }
                  />
                </div>
              )}
              {editor.schedulePreset === "custom" && editor.scheduleType === "at" && (
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: "var(--text-secondary)" }}>
                    Date & Time
                  </label>
                  <input
                    type="datetime-local"
                    className="form-input w-full text-sm"
                    value={editor.atDate ? editor.atDate.slice(0, 16) : ""}
                    onChange={(e) =>
                      updateEditor({
                        schedulePreset: "custom",
                        scheduleType: "at",
                        atDate: new Date(e.target.value).toISOString(),
                      })
                    }
                  />
                </div>
              )}
              {editor.schedulePreset === "custom" && editor.scheduleType === "cron" && (
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: "var(--text-secondary)" }}>
                    Cron Expression
                  </label>
                  <input
                    type="text"
                    className="form-input w-full text-sm font-mono"
                    placeholder="0 * * * *"
                    value={editor.cronExpr}
                    onChange={(e) =>
                      updateEditor({
                        schedulePreset: "custom",
                        scheduleType: "cron",
                        cronExpr: e.target.value,
                      })
                    }
                  />
                </div>
              )}
              {editor.schedulePreset === "custom" && (
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: "var(--text-secondary)" }}>
                    Advanced schedule type
                  </label>
                  <select
                    className="form-input w-full text-sm"
                    value={editor.scheduleType}
                    onChange={(e) =>
                      updateEditor({
                        schedulePreset: "custom",
                        scheduleType: e.target.value as ScheduleType,
                      })
                    }
                  >
                    <option value="every">Interval (every N minutes)</option>
                    <option value="at">One-time (at date/time)</option>
                    <option value="cron">Cron expression</option>
                  </select>
                </div>
              )}

              {/* Payload config */}
              <>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label
                      className="block text-sm font-medium"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      Skills (optional)
                    </label>
                    {skills.length > 0 && (
                      <div className="flex items-center gap-3 text-xs">
                        <button
                          type="button"
                          className="underline"
                          onClick={() => updateSkillSelection(skills.map((skill) => skill.id))}
                        >
                          Select all
                        </button>
                        <button
                          type="button"
                          className="underline"
                          onClick={() => updateSkillSelection([])}
                        >
                          Clear
                        </button>
                      </div>
                    )}
                  </div>
                  {skillsLoading && (
                    <p className="text-xs mb-2" style={{ color: "var(--text-tertiary)" }}>
                      Loading connected skills…
                    </p>
                  )}
                  {!skillsLoading && skillsError && (
                    <p className="text-xs mb-2" style={{ color: "#ef4444" }}>
                      {skillsError}
                    </p>
                  )}
                  {!skillsLoading && skills.length === 0 && (
                    <p className="text-xs mb-2" style={{ color: "var(--text-tertiary)" }}>
                      No connected skills yet. Connect one in the Skills tab.
                    </p>
                  )}
                  {integrations.length > 0 && (
                    <div className="mb-3">
                      <p className="text-xs mb-2" style={{ color: "var(--text-tertiary)" }}>
                        Connected integrations
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {integrations.map((skill) => {
                          const selected = editor.skillIds.includes(skill.id);
                          return (
                            <button
                              key={skill.id}
                              type="button"
                              onClick={() => {
                                const nextIds = selected
                                  ? editor.skillIds.filter((id) => id !== skill.id)
                                  : [...editor.skillIds, skill.id];
                                updateSkillSelection(nextIds);
                              }}
                              className={clsx(
                                "px-3 py-1.5 rounded-full text-xs transition-colors border",
                                selected
                                  ? "bg-[var(--purple-accent)] text-white border-transparent"
                                  : "bg-[var(--bg-secondary)] text-[var(--text-secondary)] border-[var(--glass-border-subtle)]"
                              )}
                            >
                              {skill.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {plugins.length > 0 && (
                    <div className="mb-3">
                      <p className="text-xs mb-2" style={{ color: "var(--text-tertiary)" }}>
                        Enabled tools
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {plugins.map((skill) => {
                          const selected = editor.skillIds.includes(skill.id);
                          return (
                            <button
                              key={skill.id}
                              type="button"
                              onClick={() => {
                                const nextIds = selected
                                  ? editor.skillIds.filter((id) => id !== skill.id)
                                  : [...editor.skillIds, skill.id];
                                updateSkillSelection(nextIds);
                              }}
                              className={clsx(
                                "px-3 py-1.5 rounded-full text-xs transition-colors border",
                                selected
                                  ? "bg-[var(--purple-accent)] text-white border-transparent"
                                  : "bg-[var(--bg-secondary)] text-[var(--text-secondary)] border-[var(--glass-border-subtle)]"
                              )}
                            >
                              {skill.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {selectedSkillLabels && (
                    <p className="text-xs mt-1" style={{ color: "var(--text-tertiary)" }}>
                      Selected: {selectedSkillLabels}
                    </p>
                  )}
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
                      Message
                    </label>
                    <button
                      type="button"
                      className="text-xs underline"
                      onClick={handleGenerateSteps}
                      disabled={generatingSteps}
                    >
                      {generatingSteps ? "Generating…" : "Generate steps"}
                    </button>
                  </div>
                  <textarea
                    className="form-input w-full text-sm"
                    rows={5}
                    placeholder="What should the agent do?"
                    value={editor.message}
                    onChange={(e) => {
                      lastAutoMessageRef.current = null;
                      lastAutoKindRef.current = null;
                      setGenerateStepsError(null);
                      updateEditor({ message: e.target.value });
                    }}
                  />
                  <p className="text-xs mt-1" style={{ color: "var(--text-tertiary)" }}>
                    Tip: reference selected skills in your message for more reliable results.
                  </p>
                  {generateStepsError && (
                    <p className="text-xs mt-2" style={{ color: "#ef4444" }}>
                      {generateStepsError}
                    </p>
                  )}
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
                      Notifications
                    </label>
                    <label className="flex items-center gap-2 text-xs" style={{ color: "var(--text-tertiary)" }}>
                      <input
                        type="checkbox"
                        checked={editor.notifyEnabled}
                        onChange={(e) => {
                          const enabled = e.target.checked;
                          if (enabled) {
                            const fallback = editor.notifyChannel || channelOptions[0]?.id || "";
                            updateEditor({
                              notifyEnabled: true,
                              notifyChannel: fallback,
                            });
                          } else {
                            updateEditor({ notifyEnabled: false });
                          }
                        }}
                        style={{ accentColor: "var(--purple-600)" }}
                      />
                      Send a notification
                    </label>
                  </div>

                  {editor.notifyEnabled && (
                    <div className="space-y-2">
                      {channelsLoading && (
                        <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                          Loading channels…
                        </p>
                      )}
                      {!channelsLoading && channelsError && (
                        <p className="text-xs" style={{ color: "#ef4444" }}>
                          {channelsError}
                        </p>
                      )}
                      {!channelsLoading && channelOptions.length === 0 && (
                        <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                          No channels connected yet. Connect one in the Channels tab.
                        </p>
                      )}
                      {channelOptions.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {channelOptions.map((channel) => {
                            const selected = editor.notifyChannel === channel.id;
                            return (
                              <button
                                key={channel.id}
                                type="button"
                                onClick={() => updateEditor({ notifyChannel: channel.id })}
                                className={clsx(
                                  "px-3 py-1.5 rounded-full text-xs transition-colors border",
                                  selected
                                    ? "bg-[var(--purple-accent)] text-white border-transparent"
                                    : "bg-[var(--bg-secondary)] text-[var(--text-secondary)] border-[var(--glass-border-subtle)]"
                                )}
                              >
                                {channel.label}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <input
                        type="text"
                        className="form-input w-full text-sm"
                        placeholder={
                          selectedChannelMeta
                            ? selectedChannelMeta.helper
                            : "Recipient (phone, chat ID, etc.)"
                        }
                        value={editor.notifyTo}
                        onChange={(e) => updateEditor({ notifyTo: e.target.value })}
                        disabled={!editor.notifyChannel}
                      />
                      {notifyInvalid && (
                        <p className="text-xs" style={{ color: "#ef4444" }}>
                          Select a channel and add a recipient to send notifications.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-2 mt-6">
              <button onClick={() => setEditorOpen(false)} className="btn-secondary text-sm">
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !editor.name.trim() || notifyInvalid}
                className="btn-primary text-sm"
              >
                {saving ? "Saving…" : editingJob ? "Update" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── History Modal ───────────────────────────────────────── */}
      {historyJobId !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
          onClick={() => setHistoryJobId(null)}
        >
          <div
            className="glass-card p-6 w-full max-w-lg mx-4 max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
                Run History — {historyJobName}
              </h2>
              <button
                onClick={() => setHistoryJobId(null)}
                className="p-1 rounded hover:bg-black/10"
              >
                <X className="w-5 h-5" style={{ color: "var(--text-tertiary)" }} />
              </button>
            </div>

            <div className="flex-1 overflow-auto space-y-2">
              {historyLoading ? (
                <div className="text-center py-8" style={{ color: "var(--text-tertiary)" }}>
                  <RefreshCw className="w-5 h-5 mx-auto mb-2 animate-spin" />
                  Loading…
                </div>
              ) : runs.length === 0 ? (
                <div className="text-center py-8" style={{ color: "var(--text-tertiary)" }}>
                  <Clock className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <p className="text-sm">No runs yet</p>
                </div>
              ) : (
                runs.map((run) => (
                  <div
                    key={run.id}
                    className="p-3 rounded-lg text-sm"
                    style={{
                      background: "var(--bg-primary)",
                      border: "1px solid var(--glass-border-subtle)",
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <span style={{ color: "var(--text-primary)" }}>
                        {new Date(run.startedAt).toLocaleString()}
                      </span>
                      <span
                        className="text-xs font-medium px-2 py-0.5 rounded-full"
                        style={{
                          background: run.status === "ok" ? "#dcfce7" : "#fee2e2",
                          color: run.status === "ok" ? "#16a34a" : "#dc2626",
                        }}
                      >
                        {run.status}
                      </span>
                    </div>
                    {run.finishedAt && (
                      <div className="text-xs mt-1" style={{ color: "var(--text-tertiary)" }}>
                        Duration: {((run.finishedAt - run.startedAt) / 1000).toFixed(1)}s
                      </div>
                    )}
                    {run.error && (
                      <div className="text-xs mt-1 text-red-500 truncate">{run.error}</div>
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
