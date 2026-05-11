import type { WindowKey } from "./windowManager";

export const DESKTOP_ACTION_EVENT = "entropic-desktop-action";

export type DesktopAction =
  | { type: "open_workspace_file"; path: string }
  | { type: "open_workspace_folder"; path: string }
  | { type: "open_browser_url"; url: string }
  | { type: "focus_window"; window: WindowKey }
  | { type: "close_window"; window: WindowKey }
  | { type: "new_chat_task"; prompt: string; sessionId?: string; autoSubmit?: boolean; speakResponse?: boolean };

export type DesktopActionHandlers = {
  openWorkspaceFile: (path: string) => void | Promise<void>;
  openWorkspaceFolder: (path: string) => void | Promise<void>;
  openBrowserUrl: (url: string) => void | Promise<void>;
  focusWindow: (window: WindowKey) => void | Promise<void>;
  closeWindow: (window: WindowKey) => void | Promise<void>;
  newChatTask: (
    prompt: string,
    sessionId?: string,
    autoSubmit?: boolean,
    speakResponse?: boolean,
  ) => void | Promise<void>;
};

export type DesktopActionValidationOptions = {
  isTrustedLocalPreviewUrl?: (url: string) => boolean;
};

const WINDOW_KEYS: ReadonlySet<string> = new Set<WindowKey>([
  "finder",
  "chat",
  "browser",
  "terminal",
  "plugins",
  "skills",
  "channels",
  "tasks",
  "jobs",
  "logs",
  "billing",
  "settings",
  "preview",
  "sheets",
  "docs",
  "slides",
  "integrations",
  "voiceOverlay",
]);

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

export function isWindowKey(value: string): value is WindowKey {
  return WINDOW_KEYS.has(value);
}

export function sanitizeWorkspaceActionPath(path: string): string {
  const trimmed = path.trim().split("\\").join("/");
  if (!trimmed) return "";
  if (trimmed.includes("\0") || trimmed.includes("\n") || trimmed.includes("\r")) {
    throw new Error("Workspace path contains invalid characters.");
  }
  if (trimmed.startsWith("/") || trimmed.startsWith("~") || /^[a-zA-Z]:\//.test(trimmed)) {
    throw new Error("Workspace path must be relative to the Entropic workspace.");
  }
  const parts: string[] = [];
  for (const part of trimmed.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      throw new Error("Workspace path cannot escape the workspace.");
    }
    parts.push(part);
  }
  return parts.join("/");
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((part) => Number(part));
  if (nums.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = nums;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function validateBrowserActionUrl(
  rawUrl: string,
  options: DesktopActionValidationOptions = {},
): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error("Browser URL is empty.");
  }
  if (options.isTrustedLocalPreviewUrl?.(trimmed)) {
    return trimmed;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Browser URL must be absolute.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Browser URL must use http or https.");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (LOCAL_HOSTS.has(hostname) || isPrivateIpv4(hostname)) {
    throw new Error("Local browser URLs must use a trusted Entropic preview URL.");
  }
  return parsed.toString();
}

export function validateDesktopAction(
  action: DesktopAction,
  options: DesktopActionValidationOptions = {},
): DesktopAction {
  switch (action.type) {
    case "open_workspace_file":
      {
        const path = sanitizeWorkspaceActionPath(action.path);
        if (!path) {
          throw new Error("Workspace file path is empty.");
        }
        return { ...action, path };
      }
    case "open_workspace_folder":
      return { ...action, path: sanitizeWorkspaceActionPath(action.path) };
    case "open_browser_url":
      return { ...action, url: validateBrowserActionUrl(action.url, options) };
    case "focus_window":
    case "close_window":
      if (!isWindowKey(action.window)) {
        throw new Error(`Unknown desktop window: ${action.window}`);
      }
      return action;
    case "new_chat_task": {
      const prompt = action.prompt.trim();
      if (!prompt) {
        throw new Error("Chat task prompt is empty.");
      }
      const validated: DesktopAction = {
        ...action,
        prompt,
        autoSubmit: action.autoSubmit === true,
      };
      if (action.speakResponse === true) {
        return { ...validated, speakResponse: true };
      }
      return validated;
    }
    default: {
      const neverAction: never = action;
      throw new Error(`Unsupported desktop action: ${JSON.stringify(neverAction)}`);
    }
  }
}

export async function dispatchDesktopAction(
  action: DesktopAction,
  handlers: DesktopActionHandlers,
  options: DesktopActionValidationOptions = {},
) {
  const validated = validateDesktopAction(action, options);
  switch (validated.type) {
    case "open_workspace_file":
      await handlers.openWorkspaceFile(validated.path);
      return;
    case "open_workspace_folder":
      await handlers.openWorkspaceFolder(validated.path);
      return;
    case "open_browser_url":
      await handlers.openBrowserUrl(validated.url);
      return;
    case "focus_window":
      await handlers.focusWindow(validated.window);
      return;
    case "close_window":
      await handlers.closeWindow(validated.window);
      return;
    case "new_chat_task":
      await handlers.newChatTask(
        validated.prompt,
        validated.sessionId,
        validated.autoSubmit,
        validated.speakResponse,
      );
      return;
  }
}
