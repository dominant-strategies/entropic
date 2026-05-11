import { invoke } from "@tauri-apps/api/core";
import { loadProfile, type AgentProfile } from "./profile";

export type AgentProfileState = {
  memory_sessions_enabled?: boolean;
  memory_enabled?: boolean;
  memory_qmd_enabled?: boolean;
  runtime_cpu?: number;
  runtime_memory_gb?: number;
  runtime_disk_gb?: number;
  soul?: string;
  identity_name?: string;
  identity_avatar?: string | null;
};

export type RuntimeVersionInfo = {
  entropic_version: string;
  runtime_version: string;
  runtime_openclaw_commit?: string | null;
  runtime_download_asset_name?: string | null;
  runtime_download_size_bytes?: number | null;
  applied_runtime_version?: string | null;
  applied_runtime_openclaw_commit?: string | null;
  applied_runtime_image_id?: string | null;
  app_manifest_version?: string | null;
  app_manifest_pub_date?: string | null;
};

export type AuthStateSnapshot = {
  active_provider: string | null;
  providers: Array<{ id: string; has_key: boolean; last4?: string | null }>;
};

export type SettingsWarmState = {
  profile?: AgentProfile;
  agentProfileState?: AgentProfileState;
  runtimeVersionInfo?: RuntimeVersionInfo;
  oauthStatus?: Record<string, string>;
  authState?: AuthStateSnapshot;
};

let cachedWarmState: SettingsWarmState | null = null;
let warmStatePromise: Promise<SettingsWarmState> | null = null;

function cloneWarmState(state: SettingsWarmState): SettingsWarmState {
  return {
    profile: state.profile ? { ...state.profile } : undefined,
    agentProfileState: state.agentProfileState ? { ...state.agentProfileState } : undefined,
    runtimeVersionInfo: state.runtimeVersionInfo ? { ...state.runtimeVersionInfo } : undefined,
    oauthStatus: state.oauthStatus ? { ...state.oauthStatus } : undefined,
    authState: state.authState
      ? {
          active_provider: state.authState.active_provider,
          providers: state.authState.providers.map((provider) => ({ ...provider })),
        }
      : undefined,
  };
}

function isWarmStateComplete(state: SettingsWarmState): boolean {
  return (
    state.profile !== undefined &&
    state.agentProfileState !== undefined &&
    state.runtimeVersionInfo !== undefined &&
    state.oauthStatus !== undefined &&
    state.authState !== undefined
  );
}

async function maybeEnableConversationMemoryIndexing(
  state: AgentProfileState | undefined,
): Promise<AgentProfileState | undefined> {
  if (!state || state.memory_sessions_enabled !== false) {
    return state;
  }
  try {
    await invoke("set_memory_session_indexing", { enabled: true });
    return { ...state, memory_sessions_enabled: true };
  } catch (error) {
    console.warn("[Entropic] Failed to normalize conversation memory indexing:", error);
    return state;
  }
}

export function getCachedSettingsWarmState(): SettingsWarmState | null {
  return cachedWarmState ? cloneWarmState(cachedWarmState) : null;
}

export async function loadSettingsWarmState(opts?: {
  force?: boolean;
}): Promise<SettingsWarmState> {
  if (!opts?.force && cachedWarmState && isWarmStateComplete(cachedWarmState)) {
    return cloneWarmState(cachedWarmState);
  }
  if (!opts?.force && warmStatePromise) {
    return warmStatePromise.then(cloneWarmState);
  }

  warmStatePromise = (async () => {
    const baseState = cachedWarmState ? cloneWarmState(cachedWarmState) : {};
    const shouldLoadAll = Boolean(opts?.force);
    const tasks: Array<Promise<void>> = [];

    if (shouldLoadAll || baseState.profile === undefined) {
      tasks.push(
        loadProfile()
          .then((profile) => {
            baseState.profile = profile;
          })
          .catch(() => undefined),
      );
    }

    if (shouldLoadAll || baseState.agentProfileState === undefined) {
      tasks.push(
        invoke<AgentProfileState>("get_agent_profile_state")
          .then((state) => maybeEnableConversationMemoryIndexing(state))
          .then((state) => {
            baseState.agentProfileState = state;
          })
          .catch(() => undefined),
      );
    }

    if (shouldLoadAll || baseState.runtimeVersionInfo === undefined) {
      tasks.push(
        invoke<RuntimeVersionInfo>("get_runtime_version_info")
          .then((runtimeVersionInfo) => {
            baseState.runtimeVersionInfo = runtimeVersionInfo;
          })
          .catch(() => undefined),
      );
    }

    if (shouldLoadAll || baseState.oauthStatus === undefined) {
      tasks.push(
        invoke<Record<string, string>>("get_oauth_status")
          .then((oauthStatus) => {
            baseState.oauthStatus = oauthStatus;
          })
          .catch(() => undefined),
      );
    }

    if (shouldLoadAll || baseState.authState === undefined) {
      tasks.push(
        invoke<AuthStateSnapshot>("get_auth_state")
          .then((authState) => {
            baseState.authState = authState;
          })
          .catch(() => undefined),
      );
    }

    await Promise.all(tasks);

    cachedWarmState = cloneWarmState(baseState);
    return cloneWarmState(baseState);
  })().finally(() => {
    warmStatePromise = null;
  });

  return warmStatePromise.then(cloneWarmState);
}
