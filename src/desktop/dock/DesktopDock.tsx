import type { ReactNode } from "react";
import {
  CalendarClock,
  CreditCard,
  FileText,
  Folder,
  Globe,
  Image,
  LayoutGrid,
  ListTodo,
  MessageSquare,
  Plus,
  Radio,
  ScrollText,
  Settings as SettingsIcon,
  Sparkles,
  Terminal,
} from "lucide-react";
import type { WindowKey } from "../windowManager";

type DesktopDockProps = {
  active: {
    finder: boolean;
    chat: boolean;
    browser: boolean;
    sheets: boolean;
    docs: boolean;
    slides: boolean;
    terminal: boolean;
    skills: boolean;
    channels: boolean;
    tasks: boolean;
    jobs: boolean;
    logs: boolean;
    billing: boolean;
    settings: boolean;
  };
  billingEnabled: boolean;
  onFocusWindow: (window: WindowKey) => void;
  onOpenBrowser: () => void;
  onToggleWallpaper: () => void;
  onAddFiles: () => void;
};

function DockIconButton({
  label,
  active = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative flex flex-col items-center"
      aria-label={label}
    >
      <div
        className="pointer-events-none absolute bottom-full mb-2 translate-y-1 whitespace-nowrap rounded-lg border px-2.5 py-1 text-[11px] font-medium opacity-0 transition-all duration-150 group-hover:translate-y-0 group-hover:opacity-100"
        style={{
          background: "rgba(17,24,39,0.88)",
          color: "rgba(255,255,255,0.96)",
          borderColor: "rgba(255,255,255,0.16)",
          boxShadow: "0 10px 24px rgba(0,0,0,0.28)",
          backdropFilter: "blur(18px)",
          WebkitBackdropFilter: "blur(18px)",
        }}
      >
        {label}
      </div>
      {children}
      <div className={`mt-1 h-1 w-1 rounded-full transition-opacity ${active ? "bg-white/80" : "opacity-0"}`} />
    </button>
  );
}

function DockIcon({
  label,
  active,
  onClick,
  gradient,
  shadow,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  gradient: string;
  shadow: string;
  children: ReactNode;
}) {
  return (
    <DockIconButton label={label} active={active} onClick={onClick}>
      <div
        className="flex h-12 w-12 items-center justify-center rounded-[14px] transition-all duration-200 group-hover:-translate-y-2.5 group-hover:scale-[1.15]"
        style={{ background: gradient, boxShadow: shadow }}
      >
        {children}
      </div>
    </DockIconButton>
  );
}

export function DesktopDock({
  active,
  billingEnabled,
  onFocusWindow,
  onOpenBrowser,
  onToggleWallpaper,
  onAddFiles,
}: DesktopDockProps) {
  return (
    <div
      className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-end justify-center gap-2 rounded-[22px] px-2.5 py-1.5"
      style={{
        background: "rgba(255,255,255,0.18)",
        backdropFilter: "blur(40px)",
        WebkitBackdropFilter: "blur(40px)",
        border: "1px solid rgba(255,255,255,0.25)",
        boxShadow: "0 8px 32px rgba(0,0,0,0.35), inset 0 0.5px 0 rgba(255,255,255,0.2)",
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <DockIcon
        label="Finder"
        active={active.finder}
        onClick={() => onFocusWindow("finder")}
        gradient="linear-gradient(180deg, #4dc7f0 0%, #1a9ad7 100%)"
        shadow="0 3px 10px rgba(26,154,215,0.4)"
      >
        <Folder className="h-6 w-6 text-white" />
      </DockIcon>
      <DockIcon
        label="Chat"
        active={active.chat}
        onClick={() => onFocusWindow("chat")}
        gradient="linear-gradient(180deg, #5be579 0%, #32b350 100%)"
        shadow="0 3px 10px rgba(50,179,80,0.4)"
      >
        <MessageSquare className="h-6 w-6 text-white" />
      </DockIcon>
      <DockIcon
        label="Browser"
        active={active.browser}
        onClick={onOpenBrowser}
        gradient="linear-gradient(180deg, #0ea5e9 0%, #0284c7 100%)"
        shadow="0 3px 10px rgba(2,132,199,0.4)"
      >
        <Globe className="h-6 w-6 text-white" />
      </DockIcon>
      <DockIcon
        label="Sheets"
        active={active.sheets}
        onClick={() => onFocusWindow("sheets")}
        gradient="linear-gradient(180deg, #34d399 0%, #059669 100%)"
        shadow="0 3px 10px rgba(5,150,105,0.38)"
      >
        <LayoutGrid className="h-6 w-6 text-white" />
      </DockIcon>
      <DockIcon
        label="Docs"
        active={active.docs}
        onClick={() => onFocusWindow("docs")}
        gradient="linear-gradient(180deg, #60a5fa 0%, #2563eb 100%)"
        shadow="0 3px 10px rgba(37,99,235,0.38)"
      >
        <FileText className="h-6 w-6 text-white" />
      </DockIcon>
      <DockIcon
        label="Slides"
        active={active.slides}
        onClick={() => onFocusWindow("slides")}
        gradient="linear-gradient(180deg, #fbbf24 0%, #f97316 100%)"
        shadow="0 3px 10px rgba(249,115,22,0.34)"
      >
        <Image className="h-6 w-6 text-white" />
      </DockIcon>
      <DockIcon
        label="Terminal"
        active={active.terminal}
        onClick={() => onFocusWindow("terminal")}
        gradient="linear-gradient(180deg, #1f2937 0%, #0f172a 100%)"
        shadow="0 3px 10px rgba(15,23,42,0.45)"
      >
        <Terminal className="h-6 w-6 text-white" />
      </DockIcon>
      <DockIcon
        label="Skills"
        active={active.skills}
        onClick={() => onFocusWindow("skills")}
        gradient="linear-gradient(180deg, #22d3ee 0%, #0ea5e9 100%)"
        shadow="0 3px 10px rgba(14,165,233,0.4)"
      >
        <Sparkles className="h-6 w-6 text-white" />
      </DockIcon>
      <DockIcon
        label="Messaging"
        active={active.channels}
        onClick={() => onFocusWindow("channels")}
        gradient="linear-gradient(180deg, #60a5fa 0%, #2563eb 100%)"
        shadow="0 3px 10px rgba(37,99,235,0.4)"
      >
        <Radio className="h-6 w-6 text-white" />
      </DockIcon>
      <DockIcon
        label="Tasks"
        active={active.tasks}
        onClick={() => onFocusWindow("tasks")}
        gradient="linear-gradient(180deg, #22c55e 0%, #16a34a 100%)"
        shadow="0 3px 10px rgba(22,163,74,0.35)"
      >
        <ListTodo className="h-6 w-6 text-white" />
      </DockIcon>
      <DockIcon
        label="Jobs"
        active={active.jobs}
        onClick={() => onFocusWindow("jobs")}
        gradient="linear-gradient(180deg, #f97316 0%, #ea580c 100%)"
        shadow="0 3px 10px rgba(234,88,12,0.35)"
      >
        <CalendarClock className="h-6 w-6 text-white" />
      </DockIcon>
      <DockIcon
        label="Logs"
        active={active.logs}
        onClick={() => onFocusWindow("logs")}
        gradient="linear-gradient(180deg, #94a3b8 0%, #475569 100%)"
        shadow="0 3px 10px rgba(71,85,105,0.4)"
      >
        <ScrollText className="h-6 w-6 text-white" />
      </DockIcon>
      {billingEnabled ? (
        <DockIcon
          label="Billing"
          active={active.billing}
          onClick={() => onFocusWindow("billing")}
          gradient="linear-gradient(180deg, #22c55e 0%, #16a34a 100%)"
          shadow="0 3px 10px rgba(34,197,94,0.35)"
        >
          <CreditCard className="h-6 w-6 text-white" />
        </DockIcon>
      ) : null}
      <DockIcon
        label="Settings"
        active={active.settings}
        onClick={() => onFocusWindow("settings")}
        gradient="linear-gradient(180deg, #f3f4f6 0%, #d1d5db 100%)"
        shadow="0 3px 10px rgba(148,163,184,0.35)"
      >
        <SettingsIcon className="h-6 w-6 text-[#111827]" />
      </DockIcon>
      <div className="mx-0.5 my-1.5 w-px self-stretch" style={{ background: "rgba(255,255,255,0.25)" }} />
      <DockIcon
        label="Wallpaper"
        onClick={onToggleWallpaper}
        gradient="linear-gradient(180deg, #c084fc 0%, #9333ea 100%)"
        shadow="0 3px 10px rgba(147,51,234,0.4)"
      >
        <Image className="h-6 w-6 text-white" />
      </DockIcon>
      <DockIcon
        label="Add Files"
        onClick={onAddFiles}
        gradient="linear-gradient(180deg, #fbbf24 0%, #f59e0b 100%)"
        shadow="0 3px 10px rgba(245,158,11,0.4)"
      >
        <Plus className="h-6 w-6 text-white" />
      </DockIcon>
    </div>
  );
}
