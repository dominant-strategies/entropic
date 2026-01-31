import { ReactNode } from "react";
import {
  MessageSquare,
  Radio,
  ScrollText,
  Settings,
  Shield,
  ShoppingBag,
} from "lucide-react";
import clsx from "clsx";

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
