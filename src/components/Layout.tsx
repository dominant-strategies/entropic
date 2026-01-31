import { ReactNode, useEffect, useState } from "react";
import {
  MessageSquare,
  Radio,
  ScrollText,
  Settings,
  Shield,
  ShoppingBag,
} from "lucide-react";
import clsx from "clsx";
import { loadProfile, type AgentProfile } from "../lib/profile";

export type Page = "chat" | "store" | "channels" | "logs" | "settings";

type Props = {
  currentPage: Page;
  onNavigate: (page: Page) => void;
  children: ReactNode;
  gatewayRunning: boolean;
};

const navItems: { id: Page; label: string; icon: typeof MessageSquare }[] = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "store", label: "Store", icon: ShoppingBag },
  { id: "channels", label: "Channels", icon: Radio },
  { id: "logs", label: "Logs", icon: ScrollText },
  { id: "settings", label: "Settings", icon: Settings },
];

export function Layout({ currentPage, onNavigate, children, gatewayRunning }: Props) {
  const [profile, setProfile] = useState<AgentProfile>({ name: "Zara" });

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      loadProfile()
        .then((data) => {
          if (!cancelled) setProfile(data);
        })
        .catch(() => {});
    };
    refresh();
    const handler = () => refresh();
    window.addEventListener("zara-profile-updated", handler);
    return () => {
      cancelled = true;
      window.removeEventListener("zara-profile-updated", handler);
    };
  }, []);

  return (
    <div className="h-screen w-screen flex bg-gray-50">
      {/* Sidebar */}
      <div className="w-56 bg-white border-r border-gray-200 flex flex-col">
        {/* Logo */}
        <div
          data-tauri-drag-region
          className="h-14 flex items-center gap-2 px-4 border-b border-gray-100"
        >
          <Shield className="w-6 h-6 text-violet-600" />
          <span className="font-semibold text-gray-900">Zara</span>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-3 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentPage === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onNavigate(item.id)}
                className={clsx(
                  "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                  isActive
                    ? "bg-violet-50 text-violet-700"
                    : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                )}
              >
                <Icon className="w-5 h-5" />
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Agent Profile */}
        <div className="px-3 pb-2">
          <button
            onClick={() => onNavigate("settings")}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-100 text-left"
          >
            <div className="w-9 h-9 rounded-full bg-gray-100 overflow-hidden flex items-center justify-center">
              {profile.avatarDataUrl ? (
                <img
                  src={profile.avatarDataUrl}
                  alt="Agent avatar"
                  className="w-full h-full object-cover"
                />
              ) : (
                <span className="text-xs font-semibold text-gray-500">
                  {profile.name.slice(0, 2).toUpperCase()}
                </span>
              )}
            </div>
            <div className="flex-1">
              <div className="text-sm font-medium text-gray-900">{profile.name}</div>
              <div className="text-xs text-gray-500">Edit profile</div>
            </div>
          </button>
        </div>

        {/* Gateway Status */}
        <div className="p-3 border-t border-gray-100">
          <div className="flex items-center gap-2 px-3 py-2">
            <div
              className={clsx(
                "w-2 h-2 rounded-full",
                gatewayRunning ? "bg-green-500" : "bg-gray-300"
              )}
            />
            <span className="text-xs text-gray-500">
              Gateway {gatewayRunning ? "Running" : "Stopped"}
            </span>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col">
        {/* Drag region for window */}
        <div data-tauri-drag-region className="h-8 bg-gray-50" />

        {/* Page Content */}
        <div className="flex-1 overflow-auto">
          {children}
        </div>
      </div>
    </div>
  );
}
