import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Store } from "@tauri-apps/plugin-store";
import { Power, Key, Shield, Sparkles, Cpu, Image, ChevronRight, User, Palette } from "lucide-react";
import clsx from "clsx";
import { loadProfile, saveProfile, type AgentProfile } from "../lib/profile";
import { useAuth } from "../contexts/AuthContext";
import { ModelSelector } from "../components/ModelSelector";
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

function SettingsGroup({ title, children }: { title?: string, children: React.ReactNode }) {
  return (
    <div className="mb-8">
      {title && (
        <h3 className="text-[13px] font-medium text-[var(--text-secondary)] uppercase tracking-wide mb-2 px-1">
          {title}
        </h3>
      )}
      <div className="bg-white border border-[var(--border-subtle)] rounded-xl overflow-hidden shadow-sm divide-y divide-[var(--border-subtle)]">
        {children}
      </div>
    </div>
  );
}

function SettingsRow({ 
  label, 
  children, 
  icon: Icon,
  description,
  onClick
}: { 
  label: string, 
  children?: React.ReactNode, 
  icon?: any,
  description?: string,
  onClick?: () => void
}) {
  return (
    <div className={clsx("p-4 flex items-center justify-between gap-4 transition-colors", onClick && "cursor-pointer hover:bg-[var(--system-gray-6)]")} onClick={onClick}>
      <div className="flex items-center gap-3 overflow-hidden">
        {Icon && (
          <div className="w-7 h-7 rounded-md bg-[var(--system-blue)]/10 text-[var(--system-blue)] flex items-center justify-center flex-shrink-0">
            <Icon className="w-4 h-4" />
          </div>
        )}
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-[var(--text-primary)]">{label}</div>
          {description && <div className="text-[12px] text-[var(--text-secondary)] truncate">{description}</div>}
        </div>
      </div>
      <div className="flex-shrink-0 flex items-center gap-2">
        {children}
      </div>
    </div>
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

  const [isEditingPersonality, setIsEditingPersonality] = useState(false);

  const PERSONALITY_TEMPLATES = [
    { label: "Helpful Assistant", text: "You are a helpful, knowledgeable, and friendly AI assistant." },
    { label: "Health Coach", text: "You are an encouraging and knowledgeable health coach. Focus on wellness, nutrition, and positive habits." },
    { label: "Comedian", text: "You are a witty stand-up comedian. Be funny, sarcastic, and entertaining in your responses." },
    { label: "Mentor", text: "You are a wise and patient mentor. Guide the user with insightful advice and Socratic questioning." },
    { label: "Coder", text: "You are an expert software engineer. Focus on clean, efficient code and best practices." },
  ];

  return (
    <div className="max-w-3xl mx-auto py-8 px-4">
      <h1 className="text-2xl font-bold mb-8 px-1">Settings</h1>

      <SettingsGroup title="Profile">
        <div className="p-4 flex items-start gap-6">
          <div className="relative group cursor-pointer flex-shrink-0">
            <div className="w-20 h-20 rounded-full bg-[var(--system-gray-5)] overflow-hidden shadow-sm">
              {profile.avatarDataUrl ? (
                <img src={profile.avatarDataUrl} alt="Avatar" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-2xl font-semibold text-[var(--text-secondary)]">
                  {profile.name.slice(0, 2).toUpperCase()}
                </div>
              )}
            </div>
            <input
              type="file"
              accept="image/*"
              className="absolute inset-0 opacity-0 cursor-pointer"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                  const avatarDataUrl = reader.result as string;
                  setProfile((p) => {
                    const next = { ...p, avatarDataUrl };
                    saveProfile(next)
                      .then(() => window.dispatchEvent(new Event("nova-profile-updated")))
                      .catch(() => {});
                    return next;
                  });
                };
                reader.readAsDataURL(file);
              }}
            />
          </div>
          
          <div className="flex-1 space-y-4 pt-1">
            <div>
              <label className="text-xs font-bold text-[var(--text-secondary)] uppercase tracking-wide block mb-1">Name</label>
              <input
                type="text"
                value={profile.name}
                onChange={(e) => {
                  const newName = e.target.value;
                  setProfile(p => ({ ...p, name: newName }));
                  saveProfile({ ...profile, name: newName }).catch(() => {});
                  window.dispatchEvent(new Event("nova-profile-updated"));
                }}
                className="w-full bg-transparent text-xl font-bold text-[var(--text-primary)] focus:outline-none border-b border-transparent focus:border-[var(--system-blue)] transition-colors placeholder:text-[var(--text-tertiary)]"
                placeholder="Name your agent"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-bold text-[var(--text-secondary)] uppercase tracking-wide">Personality</label>
                <button 
                  onClick={() => setIsEditingPersonality(!isEditingPersonality)}
                  className="text-xs font-semibold text-[var(--system-blue)] hover:underline"
                >
                  {isEditingPersonality ? "Done" : "Edit"}
                </button>
              </div>
              
              {isEditingPersonality ? (
                <div className="space-y-3 animate-fade-in">
                  <div className="flex flex-wrap gap-2 mb-2">
                    {PERSONALITY_TEMPLATES.map((t) => (
                      <button
                        key={t.label}
                        onClick={() => {
                          setSoul(t.text);
                          invoke("set_personality", { soul: t.text });
                        }}
                        className="px-3 py-1 text-xs rounded-full bg-[var(--system-gray-6)] hover:bg-[var(--system-blue)] hover:text-white transition-colors border border-[var(--border-subtle)]"
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                  <textarea 
                    value={soul} 
                    onChange={e => setSoul(e.target.value)}
                    onBlur={() => invoke("set_personality", { soul })}
                    className="w-full p-3 rounded-xl bg-[var(--system-gray-6)] border-transparent focus:bg-white focus:ring-2 focus:ring-[var(--system-blue)]/20 transition-all text-sm text-[var(--text-primary)] resize-none"
                    rows={4}
                    placeholder="Describe how your assistant should behave..."
                    autoFocus
                  />
                </div>
              ) : (
                <p className="text-sm text-[var(--text-secondary)] line-clamp-3 leading-relaxed">
                  {soul || "Default helpful assistant personality."}
                </p>
              )}
            </div>
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup title="Appearance">
        <SettingsRow 
          label="Desktop Wallpaper" 
          icon={Palette} 
          description="Customize the background"
          onClick={() => setWallpaperPickerOpen(true)}
        >
          <div className="flex items-center gap-2">
            <div className="w-12 h-12 rounded-md bg-[var(--system-gray-5)] border border-[var(--border-subtle)] overflow-hidden shadow-sm">
              {(() => {
                const wp = getWallpaperById(wallpaperId);
                const isPhoto = (wallpaperId === "custom" && customWallpaper) || wp?.type === "photo";
                const css = wallpaperId === "custom" && customWallpaper
                  ? `url(${customWallpaper})`
                  : wp?.css || WALLPAPERS[0].css;
                return <div className="w-full h-full" style={isPhoto ? { backgroundImage: css, backgroundSize: "cover" } : { background: css }} />;
              })()}
            </div>
            <ChevronRight className="w-4 h-4 text-[var(--text-tertiary)]" />
          </div>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="System">
        <SettingsRow label="Gateway Status" icon={Shield} description={gatewayRunning ? "Running on localhost:19789" : "Secure sandbox stopped"}>
          <button 
            onClick={onGatewayToggle} 
            disabled={isTogglingGateway}
            className={clsx(
              "relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none",
              gatewayRunning ? "bg-[var(--system-blue)]" : "bg-[var(--system-gray-4)]"
            )}
          >
            <span
              className={clsx(
                "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out",
                gatewayRunning ? "translate-x-5" : "translate-x-0"
              )}
            />
          </button>
        </SettingsRow>
      </SettingsGroup>


      {proxyEnabled && (
        <SettingsGroup title="Intelligence">
          <SettingsRow label="Primary Model" icon={Cpu}>
            <div className="w-80">
              <ModelSelector selectedModel={selectedModel} onModelChange={onModelChange} />
            </div>
          </SettingsRow>
          <SettingsRow label="Coding Model" icon={Cpu}>
            <div className="w-80">
              <ModelSelector selectedModel={codeModel} onModelChange={onCodeModelChange} />
            </div>
          </SettingsRow>
          <SettingsRow label="Vision Model" icon={Image}>
            <div className="w-80">
              <ModelSelector selectedModel={imageModel} onModelChange={onImageModelChange} />
            </div>
          </SettingsRow>
        </SettingsGroup>
      )}

      {/* Wallpaper Picker Modal */}
      {wallpaperPickerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm"
          onClick={() => setWallpaperPickerOpen(false)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl p-6 w-full max-w-4xl max-h-[85vh] overflow-auto border border-[var(--border-subtle)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold">Choose Wallpaper</h2>
              <button onClick={() => setWallpaperPickerOpen(false)} className="btn-secondary">Done</button>
            </div>

            <div className="space-y-8">
              <div>
                <h4 className="text-sm font-semibold text-[var(--text-secondary)] uppercase mb-4 tracking-wide">Scenic</h4>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-4">
                  {WALLPAPERS.filter((wp) => wp.type === "photo").map((wp) => (
                    <button
                      key={wp.id}
                      onClick={() => handleWallpaperPick(wp.id)}
                      className={clsx(
                        "aspect-video rounded-xl overflow-hidden transition-all hover:opacity-90 shadow-sm hover:shadow-md",
                        wallpaperId === wp.id ? "ring-4 ring-[var(--system-blue)] ring-offset-2" : ""
                      )}
                    >
                      <div 
                        className="w-full h-full bg-cover bg-center"
                        style={{ backgroundImage: wp.thumbnail ? `url(${wp.thumbnail})` : wp.css }}
                      />
                    </button>
                  ))}
                </div>
              </div>
              
              <div>
                <h4 className="text-sm font-semibold text-[var(--text-secondary)] uppercase mb-4 tracking-wide">Colors</h4>
                <div className="grid grid-cols-6 sm:grid-cols-8 gap-4">
                  {WALLPAPERS.filter((wp) => wp.type === "gradient").map((wp) => (
                    <button
                      key={wp.id}
                      onClick={() => handleWallpaperPick(wp.id)}
                      className={clsx(
                        "aspect-square rounded-full overflow-hidden transition-all hover:scale-105 shadow-sm",
                        wallpaperId === wp.id ? "ring-4 ring-[var(--system-blue)] ring-offset-2" : ""
                      )}
                      style={{ background: wp.css }}
                    />
                  ))}
                </div>
              </div>

              <div>
                <button
                   onClick={() => wallpaperInputRef.current?.click()}
                   className="flex items-center gap-2 text-[var(--system-blue)] hover:underline text-sm font-medium"
                >
                  <Plus className="w-4 h-4" />
                  Upload Custom Image...
                </button>
                <input ref={wallpaperInputRef} type="file" accept="image/*" className="hidden" onChange={handleCustomWallpaperUpload} />
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

// Icon for the upload button
function Plus({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
    </svg>
  );
}
