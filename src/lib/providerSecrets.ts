import { invoke } from "@tauri-apps/api/core";
import {
  listProviderSecrets,
  removeProviderSecret as removeProviderSecretFromVault,
  saveProviderSecret as saveProviderSecretToVault,
} from "./vault";

type ProviderSecretMap = Record<string, string>;

function normalizeSecrets(input: ProviderSecretMap): ProviderSecretMap {
  const next: ProviderSecretMap = {};
  for (const [provider, secret] of Object.entries(input)) {
    const normalizedProvider = provider.trim();
    const normalizedSecret = secret.trim();
    if (normalizedProvider && normalizedSecret) {
      next[normalizedProvider] = normalizedSecret;
    }
  }
  return next;
}

function emitProviderSecretChange() {
  window.dispatchEvent(new Event("entropic-auth-changed"));
}

export async function bootstrapProviderSecrets(): Promise<void> {
  const [vaultSecrets, backendSnapshot] = await Promise.all([
    listProviderSecrets().catch(() => ({})),
    invoke<ProviderSecretMap>("get_provider_secrets_snapshot").catch(() => ({})),
  ]);

  const normalizedVaultSecrets = normalizeSecrets(vaultSecrets);
  const normalizedBackendSnapshot = normalizeSecrets(backendSnapshot);

  for (const [provider, secret] of Object.entries(normalizedBackendSnapshot)) {
    if (!normalizedVaultSecrets[provider]) {
      await saveProviderSecretToVault(provider, secret);
      normalizedVaultSecrets[provider] = secret;
    }
  }

  if (Object.keys(normalizedBackendSnapshot).length > 0) {
    await invoke("clear_persisted_provider_secrets").catch((error) => {
      console.warn("[providerSecrets] Failed to clear persisted auth.json provider keys:", error);
    });
  }

  if (Object.keys(normalizedVaultSecrets).length > 0) {
    await invoke("hydrate_provider_secrets", {
      secrets: normalizedVaultSecrets,
    });
  }

  emitProviderSecretChange();
}

export async function saveProviderSecret(provider: string, secret: string): Promise<void> {
  await saveProviderSecretToVault(provider, secret);
  await invoke("set_api_key", {
    provider,
    key: secret,
  });
  emitProviderSecretChange();
}

export async function removeProviderSecret(provider: string): Promise<void> {
  await removeProviderSecretFromVault(provider);
  await invoke("set_api_key", {
    provider,
    key: "",
  });
  emitProviderSecretChange();
}
