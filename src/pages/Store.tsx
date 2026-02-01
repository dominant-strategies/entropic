import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import clsx from "clsx";

type Plugin = {
  id: string;
  name: string;
  description: string;
  author: string;
  installed: boolean;
  enabled: boolean;
  managed?: boolean;
  category: "tools" | "integrations" | "memory" | "agents";
};

const META: Record<string, Partial<Plugin>> = {
  "memory-lancedb": { name: "Memory (Long‑Term)", description: "Keeps long‑term memories and recalls them automatically.", category: "memory" },
  "memory-core": { name: "Memory (Core)", description: "Lightweight memory search for recent conversations.", category: "memory" },
  discord: { name: "Discord", description: "Connect Nova to Discord servers and DMs.", category: "integrations" },
  telegram: { name: "Telegram", description: "Run your agent as a Telegram bot.", category: "integrations" },
  slack: { name: "Slack", description: "Connect Nova to Slack workspaces.", category: "integrations" },
};

const CATEGORIES = [
  { id: "all", label: "All" },
  { id: "tools", label: "Tools" },
  { id: "integrations", label: "Integrations" },
  { id: "memory", label: "Memory" },
];

export function Store() {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [category, setCategory] = useState("all");
  const [installing, setInstalling] = useState<string | null>(null);

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    const list = await invoke<any[]>("get_plugin_store");
    const normalized: Plugin[] = list.map(p => {
      const meta = META[p.id] || {};
      const category: Plugin["category"] = meta.category || (p.kind === "memory" ? "memory" : p.channels?.length > 0 ? "integrations" : "tools");
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

  const filteredPlugins = useMemo(() =>
    category === "all" ? plugins : plugins.filter(p => p.category === category),
    [category, plugins]
  );

  async function togglePlugin(id: string, enabled: boolean) {
    setInstalling(id);
    try {
      await invoke("set_plugin_enabled", { id, enabled });
    } finally {
      setInstalling(null);
      await refresh();
    }
  }

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-[var(--text-primary)]">Plugin Store</h1>
        <p className="text-sm text-[var(--text-secondary)]">Extend your AI with powerful capabilities</p>
      </div>

      <div className="flex gap-2 mb-6">
        {CATEGORIES.map(cat => (
          <button key={cat.id} onClick={() => setCategory(cat.id)}
            className={clsx("btn btn-secondary !text-sm", category === cat.id && "bg-black/10")}>
            {cat.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filteredPlugins.map(plugin => (
          <div key={plugin.id} className="glass-card p-4 flex flex-col">
            <div className="flex items-start justify-between mb-2">
              <div>
                <h3 className="font-medium text-[var(--text-primary)]">{plugin.name}</h3>
                <p className="text-xs text-[var(--text-tertiary)]">by {plugin.author}</p>
              </div>
              {plugin.managed ? (
                <span className="text-xs text-[var(--text-tertiary)]">Managed in Settings</span>
              ) : (
                <button onClick={() => togglePlugin(plugin.id, !plugin.enabled)} disabled={installing === plugin.id}
                  className={clsx("btn !text-xs", plugin.enabled ? "btn-secondary" : "btn-primary")}>
                  {installing === plugin.id ? "..." : plugin.enabled ? "Disable" : "Install"}
                </button>
              )}
            </div>
            <p className="text-sm text-[var(--text-secondary)] flex-1">{plugin.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
