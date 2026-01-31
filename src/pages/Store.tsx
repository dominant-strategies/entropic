import { useState } from "react";
import { Download, Star, Check, ExternalLink } from "lucide-react";
import clsx from "clsx";

type Plugin = {
  id: string;
  name: string;
  description: string;
  author: string;
  rating: number;
  downloads: string;
  installed: boolean;
  category: "tools" | "integrations" | "memory" | "agents";
};

const PLUGINS: Plugin[] = [
  {
    id: "web-browser",
    name: "Web Browser",
    description: "Let the AI browse the web, search, and extract information from websites.",
    author: "OpenClaw",
    rating: 4.8,
    downloads: "12.5k",
    installed: false,
    category: "tools",
  },
  {
    id: "code-executor",
    name: "Code Executor",
    description: "Safely run Python, JavaScript, and shell scripts in a sandboxed environment.",
    author: "OpenClaw",
    rating: 4.9,
    downloads: "18.2k",
    installed: false,
    category: "tools",
  },
  {
    id: "file-manager",
    name: "File Manager",
    description: "Read, write, and manage files on your system with permission controls.",
    author: "OpenClaw",
    rating: 4.7,
    downloads: "9.8k",
    installed: false,
    category: "tools",
  },
  {
    id: "discord-bot",
    name: "Discord Integration",
    description: "Connect your AI to Discord servers and respond to messages.",
    author: "OpenClaw",
    rating: 4.6,
    downloads: "7.3k",
    installed: false,
    category: "integrations",
  },
  {
    id: "telegram-bot",
    name: "Telegram Bot",
    description: "Run your AI as a Telegram bot for messaging on the go.",
    author: "OpenClaw",
    rating: 4.5,
    downloads: "5.1k",
    installed: false,
    category: "integrations",
  },
  {
    id: "memory-core",
    name: "Memory Core",
    description: "Long-term memory for your AI to remember past conversations and facts.",
    author: "OpenClaw",
    rating: 4.9,
    downloads: "21.4k",
    installed: false,
    category: "memory",
  },
  {
    id: "research-agent",
    name: "Research Agent",
    description: "Autonomous agent that can research topics and compile reports.",
    author: "OpenClaw",
    rating: 4.7,
    downloads: "6.2k",
    installed: false,
    category: "agents",
  },
];

const CATEGORIES = [
  { id: "all", label: "All" },
  { id: "tools", label: "Tools" },
  { id: "integrations", label: "Integrations" },
  { id: "memory", label: "Memory" },
  { id: "agents", label: "Agents" },
];

export function Store() {
  const [plugins, setPlugins] = useState(PLUGINS);
  const [category, setCategory] = useState("all");
  const [installing, setInstalling] = useState<string | null>(null);

  const filteredPlugins =
    category === "all"
      ? plugins
      : plugins.filter((p) => p.category === category);

  async function installPlugin(id: string) {
    setInstalling(id);
    console.log("[Zara] Installing plugin:", id);

    // Simulate installation
    await new Promise((r) => setTimeout(r, 1500));

    setPlugins((prev) =>
      prev.map((p) => (p.id === id ? { ...p, installed: true } : p))
    );
    setInstalling(null);

    // TODO: Actually install via gateway
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
          {filteredPlugins.map((plugin) => (
            <div
              key={plugin.id}
              className="bg-white border border-gray-200 rounded-xl p-4 hover:shadow-sm transition-shadow"
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-medium text-gray-900">{plugin.name}</h3>
                  <p className="text-xs text-gray-500">by {plugin.author}</p>
                </div>
                {plugin.installed ? (
                  <span className="flex items-center gap-1 text-xs text-green-600 bg-green-50 px-2 py-1 rounded-full">
                    <Check className="w-3 h-3" />
                    Installed
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
                <span className="flex items-center gap-1">
                  <Star className="w-3 h-3 fill-yellow-400 text-yellow-400" />
                  {plugin.rating}
                </span>
                <span className="flex items-center gap-1">
                  <Download className="w-3 h-3" />
                  {plugin.downloads}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* More plugins link */}
        <div className="mt-6 text-center">
          <a
            href="#"
            className="text-sm text-violet-600 hover:text-violet-700 inline-flex items-center gap-1"
          >
            Browse more plugins on openclaw.dev
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </div>
    </div>
  );
}
