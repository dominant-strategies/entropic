import type { DesktopAction } from "../actions";
import type { WindowKey } from "../windowManager";

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
  email: "browser",
  mail: "browser",
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

function stripWorkspaceLocationFromVoiceTarget(target: string): { target: string; desktop: boolean } {
  let cleaned = target;
  let desktop = false;
  const desktopLocationPattern =
    /\s+(?:(?:that|which)\s+is\s+|that's\s+)?(?:on|in|inside|from)\s+(?:my\s+|the\s+)?(?:entropic\s+)?desktop(?:\s+folder)?\b.*$/i;
  if (desktopLocationPattern.test(cleaned)) {
    desktop = true;
    cleaned = cleaned.replace(desktopLocationPattern, "");
  }
  return { target: cleaned, desktop };
}

function applyWorkspaceLocationToPath(path: string, location: { desktop: boolean }): string {
  if (!location.desktop || /^desktop(?:\/|$)/i.test(path)) return path;
  return `Desktop/${path.replace(/^\/+/, "")}`;
}

function workspaceFilePathFromVoiceTarget(target: string): string | null {
  const hadSpokenDot = /\s+(?:dot|period)\s+/i.test(target);
  const location = stripWorkspaceLocationFromVoiceTarget(target);
  const cleaned = cleanVoiceTarget(location.target)
    .replace(/\s+(?:dot|period)\s+/gi, ".")
    .replace(/\s+(?:dash|hyphen)\s+/gi, "-")
    .replace(/\s+slash\s+/gi, "/")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;

  const literalMatch = cleaned.match(/^(.+\.(?:xlsx|xlsm|docx|pptx|pdf|txt|md|csv|html?))$/i);
  if (literalMatch?.[1]) {
    const path = cleanVoiceTarget(literalMatch[1]);
    if (!hadSpokenDot) return applyWorkspaceLocationToPath(path, location);
    const dotIndex = path.lastIndexOf(".");
    const basename = path.slice(0, dotIndex).replace(/\s+/g, "-");
    return applyWorkspaceLocationToPath(`${basename}${path.slice(dotIndex).toLowerCase()}`, location);
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
  return applyWorkspaceLocationToPath(`${basename}.${extension}`, location);
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

  const officeAppMatch = lower.match(
    /^(?:focus|show|switch to|open)\s+(?:the\s+)?(sheets|docs|slides)(?:\s+(?:window|app|page))?$/,
  );
  if (officeAppMatch?.[1]) {
    return { type: "focus_window", window: WINDOW_ALIASES[officeAppMatch[1]] ?? "sheets" };
  }

  const activeOfficeMatch = lower.match(
    /^(?:focus|show|switch to|open)\s+(?:the\s+|this\s+)?(spreadsheet|document|presentation)\s+(?:(?:window|app|page)|in\s+(sheets|docs|slides))$/,
  );
  if (activeOfficeMatch?.[1]) {
    return { type: "focus_window", window: WINDOW_ALIASES[activeOfficeMatch[2] || activeOfficeMatch[1]] ?? "sheets" };
  }

  const focusMatch = lower.match(
    /^(?:focus|show|switch to|open)\s+(?:the\s+)?(chat|browser|email|mail|finder|files|settings|integrations|skills|plugins|terminal|shell|tasks|jobs)(?:\s+window)?$/,
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

export function formatVoiceTaskPrompt(
  prompt: string,
  context?: VoiceDesktopContext,
): string {
  if (!context) return prompt;
  const lines = [
    `Spoken request: ${prompt}`,
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

export function listeningMessage(): string {
  return "Listening.";
}
