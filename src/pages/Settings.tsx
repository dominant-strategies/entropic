import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Power, Key, Shield, Info } from "lucide-react";
import clsx from "clsx";

type Props = {
  gatewayRunning: boolean;
  onGatewayToggle: () => void;
  isTogglingGateway: boolean;
};

export function Settings({ gatewayRunning, onGatewayToggle, isTogglingGateway }: Props) {
  const [apiKeys, setApiKeys] = useState({
    anthropic: "",
    openai: "",
    google: "",
  });

  function saveApiKey(provider: keyof typeof apiKeys, value: string) {
    setApiKeys((prev) => ({ ...prev, [provider]: value }));
    // TODO: Save to secure storage
    console.log("[Zara] Saving API key for:", provider);
  }

  return (
    <div className="p-6">
      <div className="max-w-2xl space-y-8">
        {/* Gateway Section */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Shield className="w-5 h-5 text-violet-600" />
            Gateway
          </h2>
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-gray-900">OpenClaw Gateway</p>
                <p className="text-sm text-gray-500">
                  {gatewayRunning
                    ? "Running on localhost:19789"
                    : "Secure sandbox for AI execution"}
                </p>
              </div>
              <button
                onClick={onGatewayToggle}
                disabled={isTogglingGateway}
                className={clsx(
                  "flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors",
                  gatewayRunning
                    ? "bg-red-50 text-red-600 hover:bg-red-100"
                    : "bg-violet-600 text-white hover:bg-violet-700",
                  isTogglingGateway && "opacity-50 cursor-not-allowed"
                )}
              >
                <Power className="w-4 h-4" />
                {isTogglingGateway ? "..." : gatewayRunning ? "Stop" : "Start"}
              </button>
            </div>
          </div>
        </section>

        {/* API Keys Section */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Key className="w-5 h-5 text-violet-600" />
            API Keys
          </h2>
          <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
            <ApiKeyInput
              provider="Anthropic"
              description="Claude models (Opus, Sonnet, Haiku)"
              value={apiKeys.anthropic}
              onChange={(v) => saveApiKey("anthropic", v)}
            />
            <ApiKeyInput
              provider="OpenAI"
              description="GPT-4, GPT-3.5, DALL-E"
              value={apiKeys.openai}
              onChange={(v) => saveApiKey("openai", v)}
            />
            <ApiKeyInput
              provider="Google AI"
              description="Gemini models"
              value={apiKeys.google}
              onChange={(v) => saveApiKey("google", v)}
            />
          </div>
          <p className="text-xs text-gray-400 mt-3 flex items-center gap-1">
            <Info className="w-3 h-3" />
            Keys are stored locally in your system keychain
          </p>
        </section>

        {/* About Section */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-4">About</h2>
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <div className="flex items-center gap-3 mb-3">
              <Shield className="w-8 h-8 text-violet-600" />
              <div>
                <p className="font-semibold text-gray-900">Zara</p>
                <p className="text-sm text-gray-500">Version 0.1.0</p>
              </div>
            </div>
            <p className="text-sm text-gray-600">
              Secure AI assistant with sandboxed execution. Built with Tauri and
              OpenClaw.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

function ApiKeyInput({
  provider,
  description,
  value,
  onChange,
}: {
  provider: string;
  description: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [tempValue, setTempValue] = useState(value);

  function save() {
    onChange(tempValue);
    setIsEditing(false);
  }

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <p className="font-medium text-gray-900">{provider}</p>
          <p className="text-sm text-gray-500">{description}</p>
        </div>
        {!isEditing && (
          <button
            onClick={() => {
              setTempValue(value);
              setIsEditing(true);
            }}
            className="text-sm text-violet-600 hover:text-violet-700 font-medium"
          >
            {value ? "Change" : "Add"}
          </button>
        )}
      </div>
      {isEditing && (
        <div className="flex gap-2 mt-2">
          <input
            type="password"
            value={tempValue}
            onChange={(e) => setTempValue(e.target.value)}
            placeholder="sk-..."
            className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
            autoFocus
          />
          <button
            onClick={save}
            className="px-3 py-2 bg-violet-600 text-white text-sm rounded-lg hover:bg-violet-700"
          >
            Save
          </button>
          <button
            onClick={() => setIsEditing(false)}
            className="px-3 py-2 text-gray-600 text-sm hover:bg-gray-100 rounded-lg"
          >
            Cancel
          </button>
        </div>
      )}
      {!isEditing && value && (
        <div className="text-sm text-gray-400 font-mono">••••••••••••{value.slice(-4)}</div>
      )}
    </div>
  );
}
