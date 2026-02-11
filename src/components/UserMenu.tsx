import { useState } from "react";
import { User, CreditCard, LogOut, ChevronDown, Settings, Camera } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";

interface UserMenuProps {
  onOpenBilling?: () => void;
  onOpenSettings?: () => void;
}

export function UserMenu({ onOpenBilling, onOpenSettings }: UserMenuProps) {
  const { user, balance, signOut } = useAuth();
  const [isOpen, setIsOpen] = useState(false);

  const handleSignOut = async () => {
    setIsOpen(false);
    await signOut();
  };

  const balanceDollars = balance ? parseFloat(balance.balance_dollars) : 0;
  const isLowBalance = balanceDollars < 1;

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-2 rounded-xl
                 hover:bg-[var(--bg-tertiary)] transition-colors group"
      >
        <div className="relative">
          <div className="w-8 h-8 rounded-full bg-[var(--purple-accent)]/20
                        flex items-center justify-center overflow-hidden border border-[var(--purple-accent)]/10">
            {user?.user_metadata?.avatar_url ? (
              <img src={user.user_metadata.avatar_url} alt="Avatar" className="w-full h-full object-cover" />
            ) : (
              <User className="w-4 h-4 text-[var(--purple-accent)]" />
            )}
          </div>
          {/* Change Avatar Indicator */}
          <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-black border border-white
                        flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
            <Camera className="w-2 h-2 text-white" />
          </div>
        </div>
        <div className="text-left hidden sm:block">
          <div className="text-sm font-medium text-[var(--text-primary)] truncate max-w-[120px]">
            {user?.email?.split("@")[0] || "User"}
          </div>
          <div className={`text-xs ${isLowBalance ? "text-amber-400" : "text-[var(--text-tertiary)]"}`}>
            ${balance?.balance_dollars || "0.00"}
          </div>
        </div>
        <ChevronDown className={`w-4 h-4 text-[var(--text-tertiary)] transition-transform ${isOpen ? "rotate-180" : ""}`} />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute right-0 mt-2 w-56 z-50
                        bg-[var(--bg-secondary)] border border-[var(--border-primary)]
                        rounded-xl shadow-xl overflow-hidden">
            {/* User Info */}
            <div className="px-4 py-3 border-b border-[var(--border-primary)]">
              <div className="font-medium text-[var(--text-primary)] truncate">
                {user?.email || "Unknown"}
              </div>
              <div className={`text-sm ${isLowBalance ? "text-amber-400" : "text-[var(--text-tertiary)]"}`}>
                Balance: ${balance?.balance_dollars || "0.00"}
                {isLowBalance && " (Low)"}
              </div>
            </div>

            {/* Menu Items */}
            <div className="py-1">
              {onOpenBilling && (
                <button
                  onClick={() => {
                    setIsOpen(false);
                    onOpenBilling();
                  }}
                  className="w-full flex items-center gap-3 px-4 py-2.5
                           hover:bg-[var(--bg-tertiary)] transition-colors"
                >
                  <CreditCard className="w-4 h-4 text-[var(--text-tertiary)]" />
                  <span className="text-sm text-[var(--text-primary)]">Billing & Credits</span>
                </button>
              )}

              {onOpenSettings && (
                <button
                  onClick={() => {
                    setIsOpen(false);
                    onOpenSettings();
                  }}
                  className="w-full flex items-center gap-3 px-4 py-2.5
                           hover:bg-[var(--bg-tertiary)] transition-colors"
                >
                  <Settings className="w-4 h-4 text-[var(--text-tertiary)]" />
                  <span className="text-sm text-[var(--text-primary)]">Settings</span>
                </button>
              )}

              <button
                onClick={handleSignOut}
                className="w-full flex items-center gap-3 px-4 py-2.5
                         hover:bg-[var(--bg-tertiary)] transition-colors
                         text-red-400"
              >
                <LogOut className="w-4 h-4" />
                <span className="text-sm">Sign Out</span>
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
