import { useEffect, useMemo, useState } from "react";
import { Download, Check } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import clsx from "clsx";

type Plugin = {
  id: string;
  name: string;
  description: string;
  author: string;
  rating?: number;
  downloads?: string;
  installed: boolean;
  enabled: boolean;
  managed?: boolean;
  category: "tools" | "integrations" | "memory" | "agents";
};

const FEATURED_ORDER = [
  "memory-lancedb",
  "memory-core",
  "discord",
  "telegram",
  "slack",
  "whatsapp",
  "imessage",
  "msteams",
  "voice-call",
  "matrix",
  "googlechat",
];

const META: Record<string, Partial<Plugin>> = {
  "memory-lancedb": {
    name: "Memory (Long‑Term)",
    description: "Keeps long‑term memories and recalls them automatically.",
    category: "memory",
  },
  "memory-core": {
    name: "Memory (Core)",
    description: "Lightweight memory search for recent conversations.",
    category: "memory",
  },
  discord: {
    name: "Discord",
    description: "Connect Zara to Discord servers and DMs.",
    category: "integrations",
  },
  telegram: {
    name: "Telegram",
    description: "Run your agent as a Telegram bot.",
    category: "integrations",
  },
  slack: {
    name: "Slack",
    description: "Connect Zara to Slack workspaces.",
    category: "integrations",
  },
  whatsapp: {
    name: "WhatsApp",
    description: "Use Zara in WhatsApp chats.",
    category: "integrations",
  },
  imessage: {
    name: "iMessage",
    description: "Connect Zara to iMessage via a Mac bridge.",
    category: "integrations",
  },
  msteams: {
    name: "Microsoft Teams",
    description: "Connect Zara to Teams channels.",
    category: "integrations",
  },
  "voice-call": {
    name: "Voice Call",
    description: "Talk to Zara on the phone.",
    category: "tools",
  },
  matrix: {
    name: "Matrix",
    description: "Connect Zara to Matrix rooms.",
    category: "integrations",
  },
  googlechat: {
    name: "Google Chat",
    description: "Connect Zara to Google Chat spaces.",
    category: "integrations",
  },
};

const CATEGORIES = [
  { id: "all", label: "All" },
  { id: "tools", label: "Tools" },
  { id: "integrations", label: "Integrations" },
  { id: "memory", label: "Memory" },
  { id: "agents", label: "Agents" },
];

export function Store() {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [category, setCategory] = useState("all");
  const [installing, setInstalling] = useState<string | null>(null);

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    const list = await invoke<
      Array<{
        id: string;
        kind?: string | null;
        channels: string[];
        installed: boolean;
        enabled: boolean;
        managed: boolean;
      }>
    >("get_plugin_store");

    const normalized: Plugin[] = list.map((p) => {
      const meta = META[p.id] || {};
      const category: Plugin["category"] =
        meta.category ||
        (p.kind === "memory"
          ? "memory"
          : p.channels.length > 0
          ? "integrations"
          : "tools");
      return {
        id: p.id,
        name: meta.name || p.id,
        description: meta.description || "OpenClaw plugin",
        author: "OpenClaw",
        installed: p.installed,
        enabled: p.enabled,
        managed: p.managed,
        category,
      };
    });

    setPlugins(normalized);
  }

  const filteredPlugins = useMemo(
    () =>
      category === "all"
        ? plugins
        : plugins.filter((p) => p.category === category),
    [category, plugins]
  );

  const sortedPlugins = useMemo(() => {
    const order = new Map(FEATURED_ORDER.map((id, i) => [id, i]));
    return [...filteredPlugins].sort((a, b) => {
      const ai = order.get(a.id);
      const bi = order.get(b.id);
      if (ai !== undefined || bi !== undefined) {
        return (ai ?? 999) - (bi ?? 999);
      }
      return a.name.localeCompare(b.name);
    });
  }, [filteredPlugins]);

  async function installPlugin(id: string) {
    setInstalling(id);
    await invoke("set_plugin_enabled", { id, enabled: true });
    setInstalling(null);
    await refresh();
  }

  async function disablePlugin(id: string) {
    setInstalling(id);
    await invoke("set_plugin_enabled", { id, enabled: false });
    setInstalling(null);
    await refresh();
  }

  return (
    <div className="p-6 h-full overflow-auto">
      <div className="max-w-4xl">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-gray-900">Plugin Store</h1>
          <p className="text-sm text-gray-500">
            Extend your AI with powerful capabilities
          </p>
        </div>

        {/* Category Filter */}
        <div className="flex gap-2 mb-6">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setCategory(cat.id)}
              className={clsx(
                "px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
                category === cat.id
                  ? "bg-violet-100 text-violet-700"
                  : "text-gray-600 hover:bg-gray-100"
              )}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {/* Plugin Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {sortedPlugins.map((plugin) => (
            <div
              key={plugin.id}
              className="bg-white border border-gray-200 rounded-xl p-4 hover:shadow-sm transition-shadow"
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-medium text-gray-900">{plugin.name}</h3>
                  <p className="text-xs text-gray-500">by {plugin.author}</p>
                </div>
                {plugin.managed ? (
                  <span className="text-xs text-gray-500">Managed in Settings</span>
                ) : plugin.enabled ? (
                  <span className="flex items-center gap-1 text-xs text-green-600 bg-green-50 px-2 py-1 rounded-full">
                    <Check className="w-3 h-3" />
                    Enabled
                  </span>
                ) : (
                  <button
                    onClick={() => installPlugin(plugin.id)}
                    disabled={installing === plugin.id}
                    className={clsx(
                      "flex items-center gap-1 text-xs px-2 py-1 rounded-full transition-colors",
                      installing === plugin.id
                        ? "bg-gray-100 text-gray-400"
                        : "bg-violet-50 text-violet-600 hover:bg-violet-100"
                    )}
                  >
                    <Download className="w-3 h-3" />
                    {installing === plugin.id ? "Installing..." : "Install"}
                  </button>
                )}
              </div>

              <p className="text-sm text-gray-600 mb-3">{plugin.description}</p>

              <div className="flex items-center gap-4 text-xs text-gray-500">
                {plugin.enabled && !plugin.managed && (
                  <button
                    onClick={() => disablePlugin(plugin.id)}
                    className="text-gray-500 hover:text-gray-700"
                  >
                    Disable
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* More plugins link */}
        <div className="mt-6 text-center text-xs text-gray-500">
          Showing bundled OpenClaw plugins available in your runtime.
        </div>
      </div>
    </div>
  );
}
