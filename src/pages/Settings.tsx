import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Power, Key, Shield, Info, Clock, Sparkles, Brain, Sliders } from "lucide-react";
import clsx from "clsx";
import { loadProfile, saveProfile, type AgentProfile } from "../lib/profile";

type Props = {
  gatewayRunning: boolean;
  onGatewayToggle: () => void;
  isTogglingGateway: boolean;
};

export function Settings({ gatewayRunning, onGatewayToggle, isTogglingGateway }: Props) {
  const [apiKeys, setApiKeys] = useState({
    anthropic: "",
    openai: "",
    google: "",
  });
  const [profile, setProfile] = useState<AgentProfile>({ name: "Zara" });
  const [profileSaving, setProfileSaving] = useState(false);
  const [soul, setSoul] = useState("");
  const [heartbeatEvery, setHeartbeatEvery] = useState("30m");
  const [heartbeatTasks, setHeartbeatTasks] = useState<string[]>([]);
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [memoryLongTerm, setMemoryLongTerm] = useState(true);
  const [capabilities, setCapabilities] = useState<
    { id: string; label: string; enabled: boolean }[]
  >([]);
  const [savingAgent, setSavingAgent] = useState(false);

  function saveApiKey(provider: keyof typeof apiKeys, value: string) {
    setApiKeys((prev) => ({ ...prev, [provider]: value }));
    // TODO: Save to secure storage
    console.log("[Zara] Saving API key for:", provider);
  }

  useEffect(() => {
    loadProfile().then(setProfile).catch(() => {});
    invoke<{
      soul: string;
      heartbeat_every: string;
      heartbeat_tasks: string[];
      memory_enabled: boolean;
      memory_long_term: boolean;
      capabilities: { id: string; label: string; enabled: boolean }[];
    }>("get_agent_profile_state")
      .then((state) => {
        setSoul(state.soul || "");
        setHeartbeatEvery(state.heartbeat_every || "30m");
        setHeartbeatTasks(state.heartbeat_tasks || []);
        setMemoryEnabled(state.memory_enabled);
        setMemoryLongTerm(state.memory_long_term);
        setCapabilities(state.capabilities || []);
      })
      .catch(() => {});
  }, []);

  async function handleAvatarChange(file?: File) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      if (!result) return;
      setProfile((prev) => ({ ...prev, avatarDataUrl: result }));
    };
    reader.readAsDataURL(file);
  }

  async function saveAgentProfile() {
    setProfileSaving(true);
    try {
      const cleanName = profile.name.trim() || "Zara";
      await saveProfile({ ...profile, name: cleanName });
      setProfile((prev) => ({ ...prev, name: cleanName }));
      await invoke("set_identity", {
        name: cleanName,
        avatar_data_url: profile.avatarDataUrl ?? null,
      });
      window.dispatchEvent(new CustomEvent("zara-profile-updated"));
    } finally {
      setProfileSaving(false);
    }
  }

  async function savePersonality() {
    setSavingAgent(true);
    try {
      await invoke("set_personality", { soul });
    } finally {
      setSavingAgent(false);
    }
  }

  async function saveHeartbeat() {
    setSavingAgent(true);
    try {
      await invoke("set_heartbeat", { every: heartbeatEvery, tasks: heartbeatTasks });
    } finally {
      setSavingAgent(false);
    }
  }

  async function saveMemory() {
    setSavingAgent(true);
    try {
      await invoke("set_memory", { memory_enabled: memoryEnabled, long_term: memoryLongTerm });
    } finally {
      setSavingAgent(false);
    }
  }

  async function saveCapabilities() {
    setSavingAgent(true);
    try {
      await invoke("set_capabilities", { list: capabilities });
    } finally {
      setSavingAgent(false);
    }
  }

  return (
    <div className="p-6">
      <div className="max-w-2xl space-y-8">
        {/* Agent Profile */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Shield className="w-5 h-5 text-violet-600" />
            Agent Profile
          </h2>
          <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-4">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-full bg-gray-100 overflow-hidden flex items-center justify-center">
                {profile.avatarDataUrl ? (
                  <img
                    src={profile.avatarDataUrl}
                    alt="Agent avatar"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-sm font-semibold text-gray-500">
                    {profile.name.slice(0, 2).toUpperCase()}
                  </span>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Photo
                </label>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => handleAvatarChange(e.target.files?.[0])}
                  className="text-sm text-gray-600"
                />
              </div>
              {profile.avatarDataUrl && (
                <button
                  onClick={() => setProfile((prev) => ({ ...prev, avatarDataUrl: undefined }))}
                  className="text-sm text-gray-500 hover:text-gray-700"
                >
                  Remove
                </button>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Name
              </label>
              <input
                type="text"
                value={profile.name}
                onChange={(e) => setProfile((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="Zara"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
              />
            </div>

            <div className="flex items-center justify-end">
              <button
                onClick={saveAgentProfile}
                disabled={profileSaving}
                className={clsx(
                  "px-4 py-2 text-sm rounded-lg font-medium",
                  profileSaving
                    ? "bg-gray-200 text-gray-500"
                    : "bg-violet-600 text-white hover:bg-violet-700"
                )}
              >
                {profileSaving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </section>

        {/* Gateway Section */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Shield className="w-5 h-5 text-violet-600" />
            Gateway
          </h2>
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-gray-900">OpenClaw Gateway</p>
                <p className="text-sm text-gray-500">
                  {gatewayRunning
                    ? "Running on localhost:19789"
                    : "Secure sandbox for AI execution"}
                </p>
              </div>
              <button
                onClick={onGatewayToggle}
                disabled={isTogglingGateway}
                className={clsx(
                  "flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors",
                  gatewayRunning
                    ? "bg-red-50 text-red-600 hover:bg-red-100"
                    : "bg-violet-600 text-white hover:bg-violet-700",
                  isTogglingGateway && "opacity-50 cursor-not-allowed"
                )}
              >
                <Power className="w-4 h-4" />
                {isTogglingGateway ? "..." : gatewayRunning ? "Stop" : "Start"}
              </button>
            </div>
          </div>
        </section>

        {/* Personality */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-violet-600" />
            Personality
          </h2>
          <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
            <p className="text-sm text-gray-500">
              Describe how your agent should sound and behave. Short and simple is
              great.
            </p>
            <textarea
              value={soul}
              onChange={(e) => setSoul(e.target.value)}
              rows={6}
              placeholder="Be concise, helpful, and a little witty. Ask before doing anything public."
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
            />
            <div className="flex justify-end">
              <button
                onClick={savePersonality}
                disabled={savingAgent}
                className={clsx(
                  "px-4 py-2 text-sm rounded-lg font-medium",
                  savingAgent
                    ? "bg-gray-200 text-gray-500"
                    : "bg-violet-600 text-white hover:bg-violet-700"
                )}
              >
                {savingAgent ? "Saving..." : "Save personality"}
              </button>
            </div>
          </div>
        </section>

        {/* Check-ins */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Clock className="w-5 h-5 text-violet-600" />
            Check-ins
          </h2>
          <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-3">
              <label className="text-sm text-gray-700">Frequency</label>
              <select
                value={heartbeatEvery}
                onChange={(e) => setHeartbeatEvery(e.target.value)}
                className="text-sm border border-gray-200 rounded-lg px-3 py-1.5"
              >
                <option value="15m">Every 15 minutes</option>
                <option value="30m">Every 30 minutes</option>
                <option value="1h">Every hour</option>
                <option value="4h">Every 4 hours</option>
                <option value="12h">Every 12 hours</option>
                <option value="24h">Daily</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-700 mb-1">
                Checklist
              </label>
              <textarea
                value={heartbeatTasks.join("\n")}
                onChange={(e) => setHeartbeatTasks(
                  e.target.value.split("\n").map((t) => t.trim()).filter(Boolean)
                )}
                rows={4}
                placeholder="Check for urgent messages\nReview upcoming deadlines"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
              />
            </div>
            <div className="flex justify-end">
              <button
                onClick={saveHeartbeat}
                disabled={savingAgent}
                className={clsx(
                  "px-4 py-2 text-sm rounded-lg font-medium",
                  savingAgent
                    ? "bg-gray-200 text-gray-500"
                    : "bg-violet-600 text-white hover:bg-violet-700"
                )}
              >
                {savingAgent ? "Saving..." : "Save check-ins"}
              </button>
            </div>
          </div>
        </section>

        {/* Memory */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Brain className="w-5 h-5 text-violet-600" />
            Memory
          </h2>
          <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
            <label className="flex items-center gap-3 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={memoryEnabled}
                onChange={(e) => setMemoryEnabled(e.target.checked)}
              />
              Remember things between chats
            </label>
            <label className="flex items-center gap-3 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={memoryLongTerm}
                onChange={(e) => setMemoryLongTerm(e.target.checked)}
                disabled={!memoryEnabled}
              />
              Long‑term memory (better recall)
            </label>
            <div className="flex justify-end">
              <button
                onClick={saveMemory}
                disabled={savingAgent}
                className={clsx(
                  "px-4 py-2 text-sm rounded-lg font-medium",
                  savingAgent
                    ? "bg-gray-200 text-gray-500"
                    : "bg-violet-600 text-white hover:bg-violet-700"
                )}
              >
                {savingAgent ? "Saving..." : "Save memory"}
              </button>
            </div>
          </div>
        </section>

        {/* Capabilities */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Sliders className="w-5 h-5 text-violet-600" />
            Capabilities
          </h2>
          <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
            {capabilities.map((cap) => (
              <label key={cap.id} className="flex items-center gap-3 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={cap.enabled}
                  onChange={(e) =>
                    setCapabilities((prev) =>
                      prev.map((c) =>
                        c.id === cap.id ? { ...c, enabled: e.target.checked } : c
                      )
                    )
                  }
                />
                {cap.label}
              </label>
            ))}
            <div className="flex justify-end">
              <button
                onClick={saveCapabilities}
                disabled={savingAgent}
                className={clsx(
                  "px-4 py-2 text-sm rounded-lg font-medium",
                  savingAgent
                    ? "bg-gray-200 text-gray-500"
                    : "bg-violet-600 text-white hover:bg-violet-700"
                )}
              >
                {savingAgent ? "Saving..." : "Save capabilities"}
              </button>
            </div>
          </div>
        </section>

        {/* API Keys Section */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Key className="w-5 h-5 text-violet-600" />
            API Keys
          </h2>
          <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
            <ApiKeyInput
              provider="Anthropic"
              description="Claude models (Opus, Sonnet, Haiku)"
              value={apiKeys.anthropic}
              onChange={(v) => saveApiKey("anthropic", v)}
            />
            <ApiKeyInput
              provider="OpenAI"
              description="GPT-4, GPT-3.5, DALL-E"
              value={apiKeys.openai}
              onChange={(v) => saveApiKey("openai", v)}
            />
            <ApiKeyInput
              provider="Google AI"
              description="Gemini models"
              value={apiKeys.google}
              onChange={(v) => saveApiKey("google", v)}
            />
          </div>
          <p className="text-xs text-gray-400 mt-3 flex items-center gap-1">
            <Info className="w-3 h-3" />
            Keys are stored locally in your system keychain
          </p>
        </section>

        {/* About Section */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-4">About</h2>
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <div className="flex items-center gap-3 mb-3">
              <Shield className="w-8 h-8 text-violet-600" />
              <div>
                <p className="font-semibold text-gray-900">Zara</p>
                <p className="text-sm text-gray-500">Version 0.1.0</p>
              </div>
            </div>
            <p className="text-sm text-gray-600">
              Secure AI assistant with sandboxed execution. Built with Tauri and
              OpenClaw.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

function ApiKeyInput({
  provider,
  description,
  value,
  onChange,
}: {
  provider: string;
  description: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [tempValue, setTempValue] = useState(value);

  function save() {
    onChange(tempValue);
    setIsEditing(false);
  }

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <p className="font-medium text-gray-900">{provider}</p>
          <p className="text-sm text-gray-500">{description}</p>
        </div>
        {!isEditing && (
          <button
            onClick={() => {
              setTempValue(value);
              setIsEditing(true);
            }}
            className="text-sm text-violet-600 hover:text-violet-700 font-medium"
          >
            {value ? "Change" : "Add"}
          </button>
        )}
      </div>
      {isEditing && (
        <div className="flex gap-2 mt-2">
          <input
            type="password"
            value={tempValue}
            onChange={(e) => setTempValue(e.target.value)}
            placeholder="sk-..."
            className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
            autoFocus
          />
          <button
            onClick={save}
            className="px-3 py-2 bg-violet-600 text-white text-sm rounded-lg hover:bg-violet-700"
          >
            Save
          </button>
          <button
            onClick={() => setIsEditing(false)}
            className="px-3 py-2 text-gray-600 text-sm hover:bg-gray-100 rounded-lg"
          >
            Cancel
          </button>
        </div>
      )}
      {!isEditing && value && (
        <div className="text-sm text-gray-400 font-mono">••••••••••••{value.slice(-4)}</div>
      )}
    </div>
  );
}
