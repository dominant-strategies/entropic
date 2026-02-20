import { invoke } from "@tauri-apps/api/core";

const DEFAULT_GATEWAY_URL = "ws://localhost:19789";

function generateSessionGatewayToken(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

const SESSION_GATEWAY_TOKEN = generateSessionGatewayToken();

type GatewayAuthResponse = {
  ws_url?: string;
  token?: string;
};

export async function resolveGatewayAuth(): Promise<{ wsUrl: string; token: string }> {
  try {
    const auth = await invoke<GatewayAuthResponse>("get_gateway_auth");
    const wsUrl = auth?.ws_url?.trim() || DEFAULT_GATEWAY_URL;
    const token = auth?.token?.trim() || SESSION_GATEWAY_TOKEN;
    return { wsUrl, token };
  } catch {
    const wsUrl =
      (await invoke<string>("get_gateway_ws_url").catch(() => "")) || DEFAULT_GATEWAY_URL;
    return { wsUrl, token: SESSION_GATEWAY_TOKEN };
  }
}
