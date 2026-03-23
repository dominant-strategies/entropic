import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, Cpu, Key, Loader2, Shield } from "lucide-react";
import clsx from "clsx";
import {
  DEFAULT_LOCAL_MODEL_API_KEY,
  defaultLocalModelApiMode,
  defaultLocalModelBaseUrl,
  inspectLocalModelEndpoint,
  LOCAL_MODEL_API_MODE_OPTIONS,
  LOCAL_MODEL_SERVICE_OPTIONS,
  type LocalModelApiMode,
  type LocalModelConfig,
  type LocalModelServiceType,
} from "../lib/auth";

type Props = {
  config: LocalModelConfig;
  onChange: (config: LocalModelConfig) => void;
  className?: string;
};

export function LocalAiServiceForm({ config, onChange, className }: Props) {
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testError, setTestError] = useState<string | null>(null);
  const [discoveryStatus, setDiscoveryStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const discoveryRequestRef = useRef(0);
  const endpointSecurity = inspectLocalModelEndpoint(config.baseUrl);
  const endpointBlocked =
    endpointSecurity.status === "non-local" && !config.allowNonLocal;
  const endpointInvalid = endpointSecurity.status === "invalid";

  function requestApiKey(value: string): string | null {
    return value.trim() && value !== DEFAULT_LOCAL_MODEL_API_KEY ? value : null;
  }

  function updateConfig(nextConfig: LocalModelConfig) {
    setTestStatus("idle");
    setTestError(null);
    const endpointChanged =
      !nextConfig.enabled ||
      nextConfig.serviceType !== config.serviceType ||
      nextConfig.apiMode !== config.apiMode ||
      nextConfig.baseUrl.trim() !== config.baseUrl.trim() ||
      nextConfig.apiKey !== config.apiKey;
    if (endpointChanged) {
      setDiscoveryStatus("idle");
      setDiscoveryError(null);
      setSuggestions([]);
    }
    onChange(nextConfig);
  }

  function handleServiceTypeChange(serviceType: LocalModelServiceType) {
    const previousDefaultBaseUrl = defaultLocalModelBaseUrl(config.serviceType);
    const nextBaseUrl =
      !config.baseUrl.trim() || config.baseUrl === previousDefaultBaseUrl
        ? defaultLocalModelBaseUrl(serviceType)
        : config.baseUrl;
    updateConfig({
      ...config,
      enabled: true,
      serviceType,
      apiMode: defaultLocalModelApiMode(serviceType),
      baseUrl: nextBaseUrl,
    });
  }

  async function discoverModelIds(snapshot: LocalModelConfig, requestId: number) {
    setDiscoveryStatus("loading");
    setDiscoveryError(null);
    try {
      const discovered = await invoke<string[]>("discover_local_model_ids", {
        serviceType: snapshot.serviceType,
        apiMode: snapshot.apiMode,
        baseUrl: snapshot.baseUrl,
        apiKey: requestApiKey(snapshot.apiKey),
        allowNonLocal: snapshot.allowNonLocal,
      });
      if (discoveryRequestRef.current !== requestId) {
        return;
      }
      setSuggestions(discovered);
      setDiscoveryStatus("success");
      if (!snapshot.modelName.trim() && discovered.length === 1) {
        updateConfig({ ...snapshot, enabled: true, modelName: discovered[0] });
      }
    } catch (error: any) {
      if (discoveryRequestRef.current !== requestId) {
        return;
      }
      setDiscoveryStatus("error");
      setDiscoveryError(String(error));
      setSuggestions([]);
    }
  }

  useEffect(() => {
    if (!config.enabled || !config.baseUrl.trim() || endpointInvalid || endpointBlocked) {
      discoveryRequestRef.current += 1;
      setDiscoveryStatus("idle");
      setDiscoveryError(null);
      setSuggestions([]);
      return;
    }

    const requestId = discoveryRequestRef.current + 1;
    discoveryRequestRef.current = requestId;
    const snapshot = { ...config };
    setDiscoveryStatus("loading");
    setDiscoveryError(null);

    const timeoutId = window.setTimeout(() => {
      void discoverModelIds(snapshot, requestId);
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    config.enabled,
    config.serviceType,
    config.apiMode,
    config.baseUrl,
    config.apiKey,
    config.allowNonLocal,
    endpointInvalid,
    endpointBlocked,
  ]);

  async function testConnection() {
    setTestStatus("testing");
    setTestError(null);
    try {
      await invoke("test_local_model_connection", {
        serviceType: config.serviceType,
        apiMode: config.apiMode,
        baseUrl: config.baseUrl,
        apiKey: requestApiKey(config.apiKey),
        modelName: config.modelName,
        allowNonLocal: config.allowNonLocal,
      });
      setTestStatus("success");
    } catch (error: any) {
      setTestStatus("error");
      setTestError(String(error));
    }
  }

  const selectClassName =
    "w-full appearance-none rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2.5 pr-8 text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--system-blue)]/25";
  const inputClassName =
    "w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--system-blue)]/25";

  return (
    <div className={clsx("space-y-4", className)}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Service Type" icon={Cpu}>
          <div className="relative">
            <select
              value={config.serviceType}
              onChange={(event) =>
                handleServiceTypeChange(event.target.value as LocalModelServiceType)
              }
              className={selectClassName}
            >
              {LOCAL_MODEL_SERVICE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-tertiary)]" />
          </div>
        </Field>

        {config.serviceType !== "ollama" ? (
          <Field
            label="API Mode"
            icon={Shield}
            help="Select which API format this service uses."
          >
            <div className="relative">
              <select
                value={config.apiMode}
                onChange={(event) =>
                  updateConfig({
                    ...config,
                    enabled: true,
                    apiMode: event.target.value as LocalModelApiMode,
                  })
                }
                className={selectClassName}
              >
                {LOCAL_MODEL_API_MODE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-tertiary)]" />
            </div>
          </Field>
        ) : (
          <Field label="API Mode" icon={Shield} help="Ollama uses its native API automatically.">
            <div className={clsx(inputClassName, "flex items-center text-[var(--text-secondary)]")}>
              Ollama API
            </div>
          </Field>
        )}
      </div>

      <Field
        label="Base URL"
        icon={Key}
        help={
          config.serviceType === "ollama"
            ? "Example: http://localhost:11434/v1"
            : "Example: http://localhost:1234/v1"
        }
      >
        <input
          type="text"
          value={config.baseUrl}
          onChange={(event) =>
            updateConfig({ ...config, enabled: true, baseUrl: event.target.value })
          }
          className={inputClassName}
          placeholder={defaultLocalModelBaseUrl(config.serviceType)}
        />
        {endpointSecurity.status === "local" && (
          <div className="mt-2 text-xs text-green-600">
            Loopback endpoint detected. Local model traffic stays on this machine.
          </div>
        )}
        {endpointSecurity.status === "invalid" && (
          <div className="mt-2 text-xs text-red-500">{endpointSecurity.message}</div>
        )}
        {endpointSecurity.status === "non-local" && (
          <div className="mt-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
            <div className="font-medium text-amber-700">Non-local endpoint detected</div>
            <div className="mt-1 text-[var(--text-secondary)]">
              {endpointSecurity.host} is not a loopback address. Requests may traverse your LAN or
              another network.
              {!endpointSecurity.encrypted
                ? " This URL uses plain HTTP."
                : " This URL uses HTTPS."}
            </div>
            <label className="mt-3 flex items-start gap-2 text-[var(--text-primary)]">
              <input
                type="checkbox"
                checked={config.allowNonLocal}
                onChange={(event) =>
                  updateConfig({
                    ...config,
                    enabled: true,
                    allowNonLocal: event.target.checked,
                  })
                }
                className="mt-0.5 h-4 w-4 rounded border-[var(--border-subtle)]"
              />
              <span>
                Allow non-local endpoint
                <span className="mt-1 block text-[var(--text-secondary)]">
                  Use this only if you trust the server and network path.
                </span>
              </span>
            </label>
          </div>
        )}
      </Field>

      <Field
        label="API Key"
        icon={Key}
        help="Optional. Most local services don't require a key."
      >
        <input
          type="password"
          value={config.apiKey === DEFAULT_LOCAL_MODEL_API_KEY ? "" : config.apiKey}
          onChange={(event) =>
            updateConfig({
              ...config,
              enabled: true,
              apiKey: event.target.value || DEFAULT_LOCAL_MODEL_API_KEY,
            })
          }
          className={inputClassName}
          placeholder="Optional"
        />
      </Field>

      <Field label="Model ID" icon={Cpu} help="Models are detected automatically when available.">
        <div className="space-y-2">
          <div className="relative">
            <select
              value={suggestions.includes(config.modelName) ? config.modelName : ""}
              onChange={(event) =>
                updateConfig({ ...config, enabled: true, modelName: event.target.value })
              }
              disabled={discoveryStatus === "loading" || suggestions.length === 0}
              className={clsx(selectClassName, "disabled:opacity-60")}
            >
              <option value="">
                {discoveryStatus === "loading"
                  ? "Discovering models..."
                  : endpointInvalid
                    ? "Enter a valid base URL"
                    : endpointBlocked
                      ? "Allow non-local endpoint to continue"
                      : !config.baseUrl.trim()
                        ? "Enter a base URL first"
                        : discoveryStatus === "error"
                          ? "Could not detect models"
                          : suggestions.length === 0
                            ? "No models found"
                            : "Select a model..."}
              </option>
              {suggestions.map((modelId) => (
                <option key={modelId} value={modelId}>
                  {modelId}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-tertiary)]" />
          </div>

          <input
            type="text"
            value={config.modelName}
            onChange={(event) =>
              updateConfig({ ...config, enabled: true, modelName: event.target.value })
            }
            className={inputClassName}
            placeholder="qwen3:14b"
          />

          {discoveryStatus === "success" && suggestions.length > 0 && (
            <div className="text-xs text-[var(--text-secondary)]">
              Found {suggestions.length} model{suggestions.length === 1 ? "" : "s"} from this service.
            </div>
          )}
          {discoveryStatus === "success" && suggestions.length === 0 && (
            <div className="text-xs text-[var(--text-secondary)]">
              Connected, but no models were found. Type a model ID below.
            </div>
          )}
          {discoveryStatus === "error" && discoveryError && (
            <div className="text-xs text-red-500">{discoveryError}</div>
          )}
        </div>
      </Field>

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <button
          type="button"
          onClick={() => void testConnection()}
          disabled={
            testStatus === "testing" ||
            !config.modelName.trim() ||
            !config.baseUrl.trim() ||
            endpointInvalid ||
            endpointBlocked
          }
          className="rounded-xl bg-[var(--system-blue)] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {testStatus === "testing" ? "Testing..." : "Test Connection"}
        </button>
        {testStatus === "success" && (
          <span className="text-sm font-medium text-green-600">Connected</span>
        )}
        {testStatus === "error" && (
          <span className="max-w-full text-sm text-red-500" title={testError || undefined}>
            {testError}
          </span>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  icon: Icon,
  children,
  help,
}: {
  label: string;
  icon: typeof Cpu | typeof Key | typeof Shield;
  children: ReactNode;
  help?: string;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--system-blue)]/10 text-[var(--system-blue)]">
          <Icon className="h-4 w-4" />
        </span>
        <span>{label}</span>
      </div>
      {children}
      {help ? <div className="mt-1.5 text-xs text-[var(--text-secondary)]">{help}</div> : null}
    </label>
  );
}
