import clsx from "clsx";
import {
  CONNECTION_MODE_OPTIONS,
  type ConnectionMode,
} from "../lib/auth";

type Props = {
  value: ConnectionMode;
  onChange: (value: ConnectionMode) => void;
  className?: string;
};

export function ConnectionModeSelector({ value, onChange, className }: Props) {
  return (
    <div className={clsx("grid gap-2 sm:grid-cols-3", className)}>
      {CONNECTION_MODE_OPTIONS.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={clsx(
              "rounded-2xl border px-4 py-3 text-left transition-colors",
              active
                ? "border-[var(--system-blue)] bg-[var(--system-blue)]/10 shadow-sm"
                : "border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)]"
            )}
          >
            <div className="text-sm font-semibold text-[var(--text-primary)]">
              {option.label}
            </div>
            <div className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">
              {option.description}
            </div>
          </button>
        );
      })}
    </div>
  );
}
