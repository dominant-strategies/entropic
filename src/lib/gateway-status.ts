import { invoke } from "@tauri-apps/api/core";

type CacheEntry = { value: boolean; ts: number };

let cache: CacheEntry | null = null;
let inFlight: Promise<boolean> | null = null;

export async function getGatewayStatusCached(opts?: {
  force?: boolean;
  maxAgeMs?: number;
}): Promise<boolean> {
  const maxAgeMs = opts?.maxAgeMs ?? 4000;
  const now = Date.now();
  if (!opts?.force && cache && now - cache.ts <= maxAgeMs) {
    return cache.value;
  }
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const running = await invoke<boolean>("get_gateway_status");
      cache = { value: running, ts: Date.now() };
      return running;
    } catch {
      cache = { value: false, ts: Date.now() };
      return false;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function clearGatewayStatusCache() {
  cache = null;
}
