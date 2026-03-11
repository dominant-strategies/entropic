import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Terminal, Copy, CheckCircle2, ExternalLink, RefreshCw } from "lucide-react";
import clsx from "clsx";

type Props = {
  onDockerReady: () => void;
};

type Distro = "ubuntu" | "debian" | "fedora" | "arch" | "other";

const INSTALL_COMMANDS: Record<Distro, string[]> = {
  ubuntu: [
    "sudo apt update",
    "sudo apt install -y docker.io",
    "sudo systemctl enable --now docker",
    "sudo usermod -aG docker $USER",
  ],
  debian: [
    "sudo apt update",
    "sudo apt install -y docker.io",
    "sudo systemctl enable --now docker",
    "sudo usermod -aG docker $USER",
  ],
  fedora: [
    "sudo dnf install -y docker",
    "sudo systemctl enable --now docker",
    "sudo usermod -aG docker $USER",
  ],
  arch: [
    "sudo pacman -S docker",
    "sudo systemctl enable --now docker",
    "sudo usermod -aG docker $USER",
  ],
  other: [
    "# Install Docker from https://docs.docker.com/engine/install/",
    "# Then run:",
    "sudo systemctl enable --now docker",
    "sudo usermod -aG docker $USER",
  ],
};

export function DockerInstall({ onDockerReady }: Props) {
  const [distro, setDistro] = useState<Distro>("ubuntu");
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);

  const commands = INSTALL_COMMANDS[distro];
  const fullCommand = commands.join(" && ");

  async function copyToClipboard() {
    await navigator.clipboard.writeText(fullCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function checkDocker() {
    setChecking(true);
    try {
      const status = await invoke<{ docker_ready: boolean }>("check_runtime_status");
      if (status.docker_ready) {
        onDockerReady();
      } else {
        alert("Docker not detected yet. Make sure to log out and back in after installing, or run: newgrp docker");
      }
    } catch (error) {
      alert("Could not check Docker status");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center bg-gradient-to-b from-[var(--bg-muted)] to-[var(--bg-tertiary)] p-8">
      {/* Header */}
      <div className="mb-8 text-center">
        <div className="w-16 h-16 bg-blue-500 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg">
          <Terminal className="w-8 h-8 text-white" />
        </div>
        <h1 className="text-2xl font-semibold text-[var(--text-primary)] mb-2">
          Install Docker
        </h1>
        <p className="text-[var(--text-secondary)] max-w-md">
          Entropic needs Docker to run AI commands in a secure sandbox.
          This is a one-time setup.
        </p>
      </div>

      {/* Install Card */}
      <div className="bg-[var(--bg-card)] rounded-2xl shadow-xl p-6 max-w-xl w-full">
        {/* Distro Selector */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">
            Select your Linux distribution:
          </label>
          <div className="flex flex-wrap gap-2">
            {(["ubuntu", "debian", "fedora", "arch", "other"] as Distro[]).map((d) => (
              <button
                key={d}
                onClick={() => setDistro(d)}
                className={clsx(
                  "px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
                  distro === d
                    ? "bg-blue-500/15 text-blue-500 border-2 border-blue-500/30"
                    : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border-2 border-transparent hover:bg-[var(--bg-secondary)]"
                )}
              >
                {d.charAt(0).toUpperCase() + d.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Commands */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-medium text-[var(--text-secondary)]">
              Run in terminal:
            </label>
            <button
              onClick={copyToClipboard}
              className="flex items-center gap-1 text-sm text-blue-500 hover:text-blue-400"
            >
              {copied ? (
                <>
                  <CheckCircle2 className="w-4 h-4" />
                  Copied!
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4" />
                  Copy all
                </>
              )}
            </button>
          </div>
          <div className="bg-[#1A1A2E] rounded-lg p-4 font-mono text-sm overflow-x-auto">
            {commands.map((cmd, i) => (
              <div key={i} className="text-gray-100">
                <span className="text-green-400">$</span> {cmd}
              </div>
            ))}
          </div>
        </div>

        {/* Important Note */}
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 mb-4">
          <p className="text-sm text-[var(--text-secondary)]">
            <strong>Important:</strong> After running these commands, you need to{" "}
            <strong>log out and log back in</strong> (or restart) for the group
            change to take effect.
          </p>
        </div>

        {/* Check Button */}
        <button
          onClick={checkDocker}
          disabled={checking}
          className={clsx(
            "w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl transition-colors flex items-center justify-center gap-2",
            checking && "opacity-50 cursor-not-allowed"
          )}
        >
          <RefreshCw className={clsx("w-4 h-4", checking && "animate-spin")} />
          {checking ? "Checking..." : "I've installed Docker - Check now"}
        </button>

        {/* Help Link */}
        <a
          href="https://docs.docker.com/engine/install/"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-1 mt-4 text-sm text-[var(--text-secondary)] hover:text-[var(--text-secondary)]"
        >
          <ExternalLink className="w-4 h-4" />
          Official Docker installation docs
        </a>
      </div>
    </div>
  );
}
