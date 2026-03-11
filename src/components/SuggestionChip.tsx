import { LucideIcon } from "lucide-react";
import type { AgentQuickActionDefinition, TelegramSetupQuickActionDefinition } from "../lib/chatQuickActions";

export type SuggestionAction = {
  type: "quick_action";
  actionId: AgentQuickActionDefinition["id"] | TelegramSetupQuickActionDefinition["id"];
};

type Props = {
  icon: LucideIcon;
  label: string;
  action: SuggestionAction;
  onClick: (action: SuggestionAction) => void;
  variant?: "default" | "builder";
};

export function SuggestionChip({ icon: Icon, label, action, onClick, variant = "default" }: Props) {
  const baseClass =
    "flex items-center gap-2 px-4 py-2.5 rounded-full border transition-all text-sm font-medium";
  const toneClass =
    variant === "builder"
      ? "bg-[var(--purple-accent-subtle)] border-[var(--purple-accent)]/40 text-[var(--text-accent)] hover:border-[var(--purple-accent)]/60 hover:bg-[var(--purple-accent-subtle)]"
      : "bg-[var(--bg-card)] hover:bg-[var(--bg-tertiary)] border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]";
  return (
    <button
      onClick={() => onClick(action)}
      className={`${baseClass} ${toneClass}`}
    >
      <Icon className="w-4 h-4" />
      <span>{label}</span>
    </button>
  );
}
