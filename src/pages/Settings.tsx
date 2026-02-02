import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Power, Key, Shield, Sparkles, Cpu, CreditCard } from "lucide-react";
import clsx from "clsx";
import { loadProfile, saveProfile, type AgentProfile } from "../lib/profile";
import { useAuth } from "../contexts/AuthContext";
import { ModelSelector } from "../components/ModelSelector";
import { Billing } from "../components/Billing";

type Props = {
  gatewayRunning: boolean;
  onGatewayToggle: () => void;
  isTogglingGateway: boolean;
  selectedModel: string;
  onModelChange: (model: string) => void;
};

// A section wrapper for consistent styling
function SettingsSection({ title, icon: Icon, children }: { title: string, icon: any, children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold mb-3 flex items-center gap-2 text-[var(--text-primary)]">
        <Icon className="w-5 h-5 text-[var(--text-accent)]" />
        {title}
      </h2>
      <div className="glass-card p-4 space-y-4">
        {children}
      </div>
    </section>
  );
}

export function Settings({ gatewayRunning, onGatewayToggle, isTogglingGateway, selectedModel, onModelChange }: Props) {
  const { isAuthenticated, isAuthConfigured } = useAuth();
  const showProxyFeatures = isAuthConfigured && isAuthenticated;
  const [apiKeys, setApiKeys] = useState({ anthropic: "", openai: "", google: "" });
  const [profile, setProfile] = useState<AgentProfile>({ name: "Nova" });
  const [saving, setSaving] = useState(false);
  const [soul, setSoul] = useState("");
  const [_heartbeatEvery, setHeartbeatEvery] = useState("30m");
  const [_heartbeatTasks, setHeartbeatTasks] = useState<string[]>([]);
  const [_memoryEnabled, setMemoryEnabled] = useState(true);
  const [_memoryLongTerm, setMemoryLongTerm] = useState(true);
  const [_capabilities, setCapabilities] = useState<{ id: string; label: string; enabled: boolean }[]>([]);

  // Load initial state
  useEffect(() => {
    loadProfile().then(setProfile).catch(() => {});
    invoke<any>("get_agent_profile_state").then(state => {
      setSoul(state.soul || "");
      setHeartbeatEvery(state.heartbeat_every || "30m");
      setHeartbeatTasks(state.heartbeat_tasks || []);
      setMemoryEnabled(state.memory_enabled);
      setMemoryLongTerm(state.memory_long_term);
      setCapabilities(state.capabilities || []);
    }).catch(() => {});
  }, []);

  async function handleSave(saveAction: () => Promise<any>) {
    setSaving(true);
    try {
      await saveAction();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-8">
      <SettingsSection title="Agent Profile" icon={Shield}>
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-full bg-black/5 flex-shrink-0 overflow-hidden flex items-center justify-center">
            {profile.avatarDataUrl ? (
              <img src={profile.avatarDataUrl} alt="Agent avatar" className="w-full h-full object-cover" />
            ) : (
              <span className="text-sm font-semibold text-[var(--text-accent)]">{profile.name.slice(0, 2).toUpperCase()}</span>
            )}
          </div>
          <input type="file" accept="image/*" className="text-sm text-[var(--text-secondary)]"
            onChange={e => e.target.files?.[0] && (() => {
              const reader = new FileReader();
              reader.onload = () => setProfile(p => ({ ...p, avatarDataUrl: reader.result as string }));
              reader.readAsDataURL(e.target.files[0]);
            })()} />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1 text-[var(--text-secondary)]">Name</label>
          <input type="text" value={profile.name} onChange={e => setProfile(p => ({ ...p, name: e.target.value }))}
            placeholder="Nova" className="form-input" />
        </div>
        <div className="flex justify-end">
          <button onClick={() => handleSave(() => saveProfile(profile))} disabled={saving} className="btn-primary">
            {saving ? "Saving..." : "Save Profile"}
          </button>
        </div>
      </SettingsSection>

      <SettingsSection title="Gateway" icon={Shield}>
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium text-[var(--text-primary)]">OpenClaw Gateway</p>
            <p className="text-sm text-[var(--text-tertiary)]">{gatewayRunning ? "Running on localhost:19789" : "Secure sandbox for AI execution"}</p>
          </div>
          <button onClick={onGatewayToggle} disabled={isTogglingGateway}
            className={clsx("btn", gatewayRunning ? "bg-red-500/10 text-red-500 hover:bg-red-500/20" : "btn-primary")}>
            <Power className="w-4 h-4 mr-2" />
            {isTogglingGateway ? "..." : gatewayRunning ? "Stop" : "Start"}
          </button>
        </div>
      </SettingsSection>

      <SettingsSection title="Personality" icon={Sparkles}>
        <p className="text-sm text-[var(--text-tertiary)]">Describe how your assistant should sound and behave.</p>
        <textarea value={soul} onChange={e => setSoul(e.target.value)} rows={6}
          placeholder="Be concise, helpful, and a little witty." className="form-input" />
        <div className="flex justify-end">
          <button onClick={() => handleSave(() => invoke("set_personality", { soul }))} disabled={saving} className="btn-primary">
            {saving ? "Saving..." : "Save Personality"}
          </button>
        </div>
      </SettingsSection>

      {/* Model Selection - only show when authenticated (using proxy) */}
      {showProxyFeatures && (
        <SettingsSection title="AI Model" icon={Cpu}>
          <ModelSelector
            selectedModel={selectedModel}
            onModelChange={onModelChange}
          />
          <p className="text-sm text-[var(--text-tertiary)] mt-2">
            Choose the AI model to use. Different models have different capabilities and costs.
          </p>
        </SettingsSection>
      )}

      {/* Billing - only show when authenticated */}
      {showProxyFeatures && (
        <SettingsSection title="Billing & Credits" icon={CreditCard}>
          <Billing />
        </SettingsSection>
      )}

      {/* API Keys - only show when NOT using proxy (for users with their own keys) */}
      {!showProxyFeatures && (
        <SettingsSection title="API Keys" icon={Key}>
          <p className="text-sm text-[var(--text-tertiary)] mb-4">
            Add your own API keys to use AI models directly. Or sign in to use Nova's pay-as-you-go service.
          </p>
          <div className="divide-y divide-[var(--glass-border-subtle)] -m-4">
            <ApiKeyInput provider="Anthropic" description="Claude models" value={apiKeys.anthropic} onChange={v => setApiKeys(k => ({...k, anthropic: v}))} />
            <ApiKeyInput provider="OpenAI" description="GPT-4, DALL-E" value={apiKeys.openai} onChange={v => setApiKeys(k => ({...k, openai: v}))} />
            <ApiKeyInput provider="Google AI" description="Gemini models" value={apiKeys.google} onChange={v => setApiKeys(k => ({...k, google: v}))} />
          </div>
        </SettingsSection>
      )}
    </div>
  );
}

function ApiKeyInput({ provider, description, value, onChange }: { provider: string; description: string; value: string; onChange: (value: string) => void; }) {
  const [isEditing, setIsEditing] = useState(false);
  const [tempValue, setTempValue] = useState(value);

  const handleSave = () => {
    // invoke("set_api_key", { provider: provider.toLowerCase(), key: tempValue });
    onChange(tempValue);
    setIsEditing(false);
  };

  return (
    <div className="p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium text-[var(--text-primary)]">{provider}</p>
          <p className="text-sm text-[var(--text-tertiary)]">{description}</p>
        </div>
        {!isEditing && (
          <button onClick={() => { setTempValue(value); setIsEditing(true); }} className="text-sm font-medium text-[var(--text-accent)]">
            {value ? "Change" : "Add Key"}
          </button>
        )}
      </div>
      {isEditing && (
        <div className="flex gap-2">
          <input type="password" value={tempValue} onChange={e => setTempValue(e.target.value)} placeholder="sk-..." className="form-input flex-1" autoFocus />
          <button onClick={handleSave} className="btn-primary">Save</button>
          <button onClick={() => setIsEditing(false)} className="btn-secondary">Cancel</button>
        </div>
      )}
      {!isEditing && value && <div className="text-sm font-mono text-[var(--text-tertiary)]">••••••••••••{value.slice(-4)}</div>}
    </div>
  );
}
