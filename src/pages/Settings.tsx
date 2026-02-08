import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Store } from "@tauri-apps/plugin-store";
import { Power, Key, Shield, Sparkles, Cpu, CreditCard, Image } from "lucide-react";
import clsx from "clsx";
import { loadProfile, saveProfile, type AgentProfile } from "../lib/profile";
import { useAuth } from "../contexts/AuthContext";
import { ModelSelector } from "../components/ModelSelector";
import { Billing } from "../components/Billing";
import { WALLPAPERS, DEFAULT_WALLPAPER_ID, getWallpaperById } from "../lib/wallpapers";

type Props = {
  gatewayRunning: boolean;
  onGatewayToggle: () => void;
  isTogglingGateway: boolean;
  selectedModel: string;
  onModelChange: (model: string) => void;
  useLocalKeys: boolean;
  onUseLocalKeysChange: (value: boolean) => void;
  codeModel: string;
  imageModel: string;
  onCodeModelChange: (model: string) => void;
  onImageModelChange: (model: string) => void;
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

export function Settings({
  gatewayRunning,
  onGatewayToggle,
  isTogglingGateway,
  selectedModel,
  onModelChange,
  useLocalKeys,
  onUseLocalKeysChange,
  codeModel,
  imageModel,
  onCodeModelChange,
  onImageModelChange,
}: Props) {
  const { isAuthenticated, isAuthConfigured } = useAuth();
  const proxyEnabled = isAuthConfigured && isAuthenticated && !useLocalKeys;
  const [apiKeys, setApiKeys] = useState({ anthropic: "", openai: "", google: "" });
  const [profile, setProfile] = useState<AgentProfile>({ name: "Nova" });
  const [saving, setSaving] = useState(false);
  const [soul, setSoul] = useState("");
  const [_heartbeatEvery, setHeartbeatEvery] = useState("30m");
  const [_heartbeatTasks, setHeartbeatTasks] = useState<string[]>([]);
  const [_memoryEnabled, setMemoryEnabled] = useState(true);
  const [_memoryLongTerm, setMemoryLongTerm] = useState(true);
  const [_capabilities, setCapabilities] = useState<{ id: string; label: string; enabled: boolean }[]>([]);

  // Wallpaper state
  const [wallpaperId, setWallpaperId] = useState(DEFAULT_WALLPAPER_ID);
  const [customWallpaper, setCustomWallpaper] = useState<string | null>(null);
  const [wallpaperPickerOpen, setWallpaperPickerOpen] = useState(false);
  const wallpaperInputRef = useRef<HTMLInputElement>(null);

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
    Store.load("nova-settings.json").then(async (store) => {
      const wp = (await store.get("desktopWallpaper")) as string | null;
      if (wp) setWallpaperId(wp);
      const cwp = (await store.get("desktopCustomWallpaper")) as string | null;
      if (cwp) setCustomWallpaper(cwp);
    }).catch(() => {});
  }, []);

  async function saveWallpaper(id: string, custom?: string | null) {
    setWallpaperId(id);
    if (custom !== undefined) setCustomWallpaper(custom);
    try {
      const store = await Store.load("nova-settings.json");
      await store.set("desktopWallpaper", id);
      if (custom !== undefined) {
        if (custom) await store.set("desktopCustomWallpaper", custom);
        else await store.delete("desktopCustomWallpaper");
      }
      await store.save();
    } catch {}
  }

  async function handleWallpaperPick(id: string) {
    await saveWallpaper(id, undefined);
    setWallpaperPickerOpen(false);
  }

  function handleCustomWallpaperUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const reader = new FileReader();
    reader.onload = () => saveWallpaper("custom", reader.result as string);
    reader.readAsDataURL(file);
  }

  async function handleSave(saveAction: () => Promise<any>) {
    setSaving(true);
    try {
      await saveAction();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="w-full max-w-6xl mx-auto px-4 pb-10">
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
        <div className="space-y-8">
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

          <SettingsSection title="Desktop Wallpaper" icon={Image}>
        <p className="text-sm text-[var(--text-tertiary)] mb-3">Choose a background for the Files desktop view.</p>

        {/* Preview */}
        {(() => {
          const wp = getWallpaperById(wallpaperId);
          const isPhoto = (wallpaperId === "custom" && customWallpaper) || wp?.type === "photo";
          const css = wallpaperId === "custom" && customWallpaper
            ? `url(${customWallpaper})`
            : wp?.css || WALLPAPERS[0].css;
          return (
            <div
              className="w-full h-32 rounded-lg mb-4 flex items-end justify-end p-2"
              style={
                isPhoto
                  ? { backgroundImage: css, backgroundSize: "cover", backgroundPosition: "center" }
                  : { background: css }
              }
            >
              <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: "rgba(0,0,0,0.4)", color: "white" }}>
                {wallpaperId === "custom" ? "Custom" : wp?.label || "Unknown"}
              </span>
            </div>
          );
        })()}
        <div className="flex items-center justify-between">
          <button onClick={() => setWallpaperPickerOpen(true)} className="btn-secondary text-sm">
            Change wallpaper
          </button>
          <button onClick={() => wallpaperInputRef.current?.click()} className="btn-secondary text-sm">
            Upload custom
          </button>
        </div>
        <input ref={wallpaperInputRef} type="file" accept="image/*" className="hidden" onChange={handleCustomWallpaperUpload} />
          </SettingsSection>
        </div>

        <div className="space-y-8">
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

      {/* Proxy Mode */}
      {isAuthConfigured && isAuthenticated && (
        <SettingsSection title="AI Service Mode" icon={Sparkles}>
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-[var(--text-primary)]">Use Nova Managed Service</p>
              <p className="text-sm text-[var(--text-tertiary)]">
                Default option. Uses Nova credits and supports model switching automatically.
              </p>
            </div>
            <button
              onClick={() => onUseLocalKeysChange(!useLocalKeys)}
              className={clsx("btn", useLocalKeys ? "btn-secondary" : "btn-primary")}
            >
              {useLocalKeys ? "Switch to Nova" : "Using Nova"}
            </button>
          </div>
          <div className="mt-3 text-xs text-[var(--text-tertiary)]">
            Power users can switch to local API keys below.
          </div>
        </SettingsSection>
      )}

      {/* Model Selection - only show when proxy is enabled */}
      {proxyEnabled && (
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

      {/* Code Model Selection */}
      {proxyEnabled && (
        <SettingsSection title="Code Model" icon={Cpu}>
          <ModelSelector
            selectedModel={codeModel}
            onModelChange={onCodeModelChange}
          />
          <p className="text-sm text-[var(--text-tertiary)] mt-2">
            Used when you switch a chat to Code mode.
          </p>
        </SettingsSection>
      )}

      {/* Image Model Selection */}
      {proxyEnabled && (
        <SettingsSection title="Image Model" icon={Cpu}>
          <ModelSelector
            selectedModel={imageModel}
            onModelChange={onImageModelChange}
          />
          <p className="text-sm text-[var(--text-tertiary)] mt-2">
            Used for image understanding and image tool calls.
          </p>
        </SettingsSection>
      )}

      {/* Billing - only show when proxy is enabled */}
      {proxyEnabled && (
        <SettingsSection title="Billing & Credits" icon={CreditCard}>
          <Billing />
        </SettingsSection>
      )}

      {/* API Keys - show for power users or when not authenticated */}
      {(!proxyEnabled || useLocalKeys) && (
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
      </div>

      {wallpaperPickerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
          onClick={() => setWallpaperPickerOpen(false)}
        >
          <div
            className="glass-card p-6 w-full max-w-4xl mx-4 max-h-[85vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-[var(--text-primary)]">Choose wallpaper</h2>
              <button
                onClick={() => setWallpaperPickerOpen(false)}
                className="btn-secondary text-sm"
              >
                Close
              </button>
            </div>

            <div className="mb-5">
              <p className="text-xs font-medium mb-2 text-[var(--text-tertiary)]">Scenic</p>
              <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-2">
                {WALLPAPERS.filter((wp) => wp.type === "photo").map((wp) => (
                  <button
                    key={wp.id}
                    onClick={() => handleWallpaperPick(wp.id)}
                    className="h-16 rounded-lg transition-all hover:scale-105 overflow-hidden"
                    style={{
                      backgroundImage: wp.thumbnail ? `url(${wp.thumbnail})` : wp.css,
                      backgroundSize: "cover",
                      backgroundPosition: "center",
                      border:
                        wallpaperId === wp.id
                          ? "2px solid var(--purple-accent)"
                          : "2px solid var(--glass-border-subtle)",
                      boxShadow: wallpaperId === wp.id ? "0 0 0 2px var(--purple-accent)" : "none",
                    }}
                    title={wp.label}
                  />
                ))}
              </div>
            </div>

            <div className="mb-5">
              <p className="text-xs font-medium mb-2 text-[var(--text-tertiary)]">Gradients</p>
              <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-2">
                {WALLPAPERS.filter((wp) => wp.type === "gradient").map((wp) => (
                  <button
                    key={wp.id}
                    onClick={() => handleWallpaperPick(wp.id)}
                    className="h-16 rounded-lg transition-all hover:scale-105"
                    style={{
                      background: wp.css,
                      border:
                        wallpaperId === wp.id
                          ? "2px solid var(--purple-accent)"
                          : "2px solid var(--glass-border-subtle)",
                      boxShadow: wallpaperId === wp.id ? "0 0 0 2px var(--purple-accent)" : "none",
                    }}
                    title={wp.label}
                  />
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs font-medium mb-2 text-[var(--text-tertiary)]">Custom</p>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => wallpaperInputRef.current?.click()}
                  className="h-16 w-24 rounded-lg flex items-center justify-center transition-all hover:scale-105"
                  style={{
                    background: customWallpaper ? `url(${customWallpaper})` : "var(--bg-tertiary)",
                    backgroundSize: "cover",
                    backgroundPosition: "center",
                    border:
                      wallpaperId === "custom"
                        ? "2px solid var(--purple-accent)"
                        : "2px solid var(--glass-border-subtle)",
                    boxShadow: wallpaperId === "custom" ? "0 0 0 2px var(--purple-accent)" : "none",
                  }}
                  title="Custom image"
                >
                  {!customWallpaper && (
                    <div className="text-center">
                      <Image className="w-4 h-4 mx-auto" style={{ color: "var(--text-tertiary)" }} />
                      <span className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>Upload</span>
                    </div>
                  )}
                </button>
                {customWallpaper && (
                  <button
                    onClick={() => saveWallpaper(DEFAULT_WALLPAPER_ID, null)}
                    className="btn-secondary text-xs"
                  >
                    Remove custom
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
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
