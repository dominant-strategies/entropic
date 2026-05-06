import type { DesktopAction } from "../actions";
import type { WindowKey } from "../windowManager";

export type VoiceMode = "dictation" | "command" | "conversation";

export type VoiceDesktopContext = {
  focusedWindow: WindowKey | null;
  openWindows: WindowKey[];
  finderPath: string;
  selectedWorkspaceFile: string | null;
  browser: { url: string; title: string | null } | null;
  office: { appKind: "sheets" | "docs" | "slides"; path: string | null; name: string | null } | null;
  integrations: string;
};

const WINDOW_ALIASES: Record<string, WindowKey> = {
  chat: "chat",
  browser: "browser",
  finder: "finder",
  files: "finder",
  settings: "settings",
  integrations: "integrations",
  skills: "skills",
  plugins: "plugins",
  terminal: "terminal",
  shell: "terminal",
  tasks: "tasks",
  jobs: "tasks",
  sheets: "sheets",
  spreadsheet: "sheets",
  docs: "docs",
  document: "docs",
  slides: "slides",
  presentation: "slides",
};

const VOICE_URL_ALIASES: Record<string, string> = {
  asana: "https://app.asana.com",
  github: "https://github.com",
  gmail: "https://mail.google.com",
  google: "https://google.com",
  outlook: "https://outlook.office.com",
  teams: "https://teams.microsoft.com",
};

const SPOKEN_FILE_EXTENSIONS = ["xlsx", "xlsm", "docx", "pptx", "pdf", "txt", "md", "csv", "html", "htm"] as const;

function cleanVoiceTarget(value: string): string {
  return value
    .trim()
    .replace(/^[`"']+/, "")
    .replace(/[`"'.]+$/, "")
    .trim();
}

function urlAliasKey(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, "");
}

function urlFromVoiceTarget(target: string): string | null {
  const cleaned = cleanVoiceTarget(target);
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();
  const searchQuery = cleaned.match(/^(?:search for|search|look up|find)\s+(.+)$/i)?.[1];
  if (searchQuery) {
    return `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`;
  }
  if (VOICE_URL_ALIASES[lower]) return VOICE_URL_ALIASES[lower];
  const normalizedAlias = urlAliasKey(cleaned);
  if (VOICE_URL_ALIASES[normalizedAlias]) return VOICE_URL_ALIASES[normalizedAlias];
  if (/^https?:\/\//i.test(cleaned)) return cleaned;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:\/\S*)?$/i.test(cleaned)) {
    return `https://${cleaned}`;
  }
  return null;
}

function workspaceFilePathFromVoiceTarget(target: string): string | null {
  const hadSpokenDot = /\s+(?:dot|period)\s+/i.test(target);
  const cleaned = cleanVoiceTarget(target)
    .replace(/\s+(?:dot|period)\s+/gi, ".")
    .replace(/\s+(?:dash|hyphen)\s+/gi, "-")
    .replace(/\s+slash\s+/gi, "/")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;

  const literalMatch = cleaned.match(/^(.+\.(?:xlsx|xlsm|docx|pptx|pdf|txt|md|csv|html?))$/i);
  if (literalMatch?.[1]) {
    const path = cleanVoiceTarget(literalMatch[1]);
    if (!hadSpokenDot) return path;
    const dotIndex = path.lastIndexOf(".");
    const basename = path.slice(0, dotIndex).replace(/\s+/g, "-");
    return `${basename}${path.slice(dotIndex).toLowerCase()}`;
  }

  const spokenExtensionMatch = cleaned.match(
    new RegExp(`^(.+?)\\s+(${SPOKEN_FILE_EXTENSIONS.join("|")})$`, "i"),
  );
  if (!spokenExtensionMatch?.[1] || !spokenExtensionMatch[2]) return null;

  const basename = cleanVoiceTarget(spokenExtensionMatch[1])
    .replace(/\s+(?:dash|hyphen)\s+/gi, "-")
    .replace(/\s+/g, "-");
  const extension = spokenExtensionMatch[2].toLowerCase();
  if (!basename) return null;
  return `${basename}.${extension}`;
}

export function resolveVoiceAction(transcript: string): DesktopAction {
  const text = transcript.trim();
  const lower = text.toLowerCase();

  const browserAndTargetMatch = text.match(
    /\bopen\s+(?:a\s+)?(?:new\s+)?browser(?:\s+window)?\s+and\s+(?:go to|navigate to|open|search for|search)\s+(.+)$/i,
  );
  if (browserAndTargetMatch?.[1]) {
    const urlTarget = browserAndTargetMatch[0].toLowerCase().includes("search")
      ? `search for ${browserAndTargetMatch[1]}`
      : browserAndTargetMatch[1];
    const url = urlFromVoiceTarget(urlTarget);
    if (url) {
      return { type: "open_browser_url", url };
    }
  }

  const focusMatch = lower.match(
    /\b(?:focus|show|switch to|open)\s+(chat|browser|finder|files|settings|integrations|skills|plugins|terminal|shell|tasks|jobs|sheets|spreadsheet|docs|document|slides|presentation)\b/,
  );
  if (focusMatch?.[1]) {
    return { type: "focus_window", window: WINDOW_ALIASES[focusMatch[1]] ?? "chat" };
  }

  const fileMatch = text.match(
    /\bopen\s+(?:the\s+)?(?:file\s+)?(.+)$/i,
  );
  if (fileMatch?.[1]) {
    const path = workspaceFilePathFromVoiceTarget(fileMatch[1]);
    if (path) {
      return { type: "open_workspace_file", path };
    }
  }

  const browserMatch = text.match(
    /\b(?:open|go to|navigate to)\s+(?:a\s+)?(?:new\s+)?(?:browser\s+)?(?:window\s+)?(?:to\s+)?(.+)$/i,
  );
  const urlTarget = browserMatch?.[1] ?? null;
  const url = urlTarget ? urlFromVoiceTarget(urlTarget) : null;
  if (url) {
    return { type: "open_browser_url", url };
  }

  return { type: "new_chat_task", prompt: text };
}

export function chatTaskNeedsConfirmation(prompt: string): boolean {
  const riskText = prompt.match(/^Voice command:\s*(.+)$/m)?.[1] ?? prompt;
  return /\b(send|email|message|post|create|update|edit|delete|remove|move|rename|run|execute|asana|jira|linear|github|gmail|outlook|teams|slack)\b/i.test(
    riskText,
  );
}

export function previewForVoiceAction(
  action: DesktopAction,
): { message: string; confirmLabel: string } | null {
  switch (action.type) {
    case "open_workspace_file":
      return { message: `Open workspace file: ${action.path}?`, confirmLabel: "Open" };
    case "open_workspace_folder":
      return { message: `Open workspace folder: ${action.path || "/"}?`, confirmLabel: "Open" };
    case "open_browser_url":
      return { message: `Open browser URL: ${action.url}?`, confirmLabel: "Open" };
    case "new_chat_task":
      if (action.autoSubmit && chatTaskNeedsConfirmation(action.prompt)) {
        return { message: "Send this voice task to the agent now?", confirmLabel: "Send" };
      }
      return null;
    default:
      return null;
  }
}

export function formatVoiceTaskPrompt(
  prompt: string,
  mode: VoiceMode,
  context?: VoiceDesktopContext,
): string {
  if (!context) return prompt;
  const lines = [
    `Voice command: ${prompt}`,
    `Voice mode: ${mode}`,
    "",
    "Desktop context:",
    `- Focused window: ${context.focusedWindow || "none"}`,
    `- Open windows: ${context.openWindows.length > 0 ? context.openWindows.join(", ") : "none"}`,
    `- Finder folder: ${context.finderPath || "/"}`,
    `- Selected workspace file: ${context.selectedWorkspaceFile || "none"}`,
    `- Browser: ${context.browser ? `${context.browser.title || "Untitled"} (${context.browser.url})` : "closed"}`,
    `- Office: ${
      context.office
        ? `${context.office.appKind}${context.office.path ? `: ${context.office.path}` : ""}`
        : "closed"
    }`,
    `- Integrations: ${context.integrations}`,
    "",
    "Use the desktop context if it is relevant. Ask for confirmation before destructive actions or external side effects.",
  ];
  return lines.join("\n");
}

export function messageForMode(mode: VoiceMode): string {
  switch (mode) {
    case "dictation":
      return "Listening for dictation...";
    case "conversation":
      return "Listening for a conversation turn...";
    case "command":
    default:
      return "Listening for a desktop command...";
  }
}
