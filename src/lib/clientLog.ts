import { invoke } from "@tauri-apps/api/core";

const RECENT_DEDUPE_WINDOW_MS = 1500;
const recentMessages = new Map<string, number>();

function compactError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function compactData(data: unknown): string {
  if (data == null) return "";
  try {
    return JSON.stringify(data);
  } catch {
    return compactError(data);
  }
}

export function clientLog(event: string, data?: unknown): void {
  const payload = compactData(data);
  const line = payload ? `${event} ${payload}` : event;
  const now = Date.now();
  const last = recentMessages.get(line) ?? 0;
  if (now - last < RECENT_DEDUPE_WINDOW_MS) {
    return;
  }
  recentMessages.set(line, now);

  void invoke("append_client_log", { message: line }).catch(() => {
    // Logging should never break app behavior.
  });
}
