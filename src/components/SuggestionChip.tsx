import { LucideIcon } from "lucide-react";

export type SuggestionAction =
  | { type: "channel"; channel: "imessage" | "whatsapp" }
  | { type: "agent"; message: string };

type Props = {
  icon: LucideIcon;
  label: string;
  action: SuggestionAction;
  onClick: (action: SuggestionAction) => void;
};

export function SuggestionChip({ icon: Icon, label, action, onClick }: Props) {
  return (
    <button
      onClick={() => onClick(action)}
      className="flex items-center gap-2 px-4 py-2.5 rounded-full bg-[var(--bg-tertiary)] hover:bg-[var(--bg-secondary)] border border-[var(--glass-border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-all text-sm font-medium"
    >
      <Icon className="w-4 h-4" />
      <span>{label}</span>
    </button>
  );
}
