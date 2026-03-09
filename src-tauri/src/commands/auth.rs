use super::*;

#[tauri::command]
pub async fn get_provider_secrets_snapshot(
    state: State<'_, AppState>,
) -> Result<HashMap<String, String>, String> {
    let keys = state.api_keys.lock().map_err(|e| e.to_string())?;
    Ok(keys.clone())
}

#[tauri::command]
pub async fn hydrate_provider_secrets(
    app: AppHandle,
    state: State<'_, AppState>,
    secrets: HashMap<String, String>,
) -> Result<(), String> {
    let normalized = secrets
        .into_iter()
        .filter_map(|(provider, secret)| {
            let provider = provider.trim().to_string();
            let secret = secret.trim().to_string();
            if provider.is_empty() || secret.is_empty() {
                None
            } else {
                Some((provider, secret))
            }
        })
        .collect::<HashMap<_, _>>();

    {
        let mut keys = state.api_keys.lock().map_err(|e| e.to_string())?;
        *keys = normalized.clone();
    }

    let mut active = state.active_provider.lock().map_err(|e| e.to_string())?;
    let active_missing = active
        .as_ref()
        .map(|provider| !normalized.contains_key(provider))
        .unwrap_or(true);
    if active_missing {
        *active = normalized.keys().next().cloned();
    }

    let mut stored = load_auth(&app);
    stored.keys.clear();
    stored.active_provider = active.clone();
    save_auth(&app, &stored)?;
    Ok(())
}

#[tauri::command]
pub async fn clear_persisted_provider_secrets(app: AppHandle) -> Result<(), String> {
    let mut stored = load_auth(&app);
    if stored.keys.is_empty() {
        return Ok(());
    }
    stored.keys.clear();
    save_auth(&app, &stored)
}

#[tauri::command]
pub async fn set_api_key(
    app: AppHandle,
    state: State<'_, AppState>,
    provider: String,
    key: String,
) -> Result<(), String> {
    let is_empty = key.is_empty();
    let mut keys = state.api_keys.lock().map_err(|e| e.to_string())?;
    if is_empty {
        keys.remove(&provider);
    } else {
        keys.insert(provider.clone(), key);
    }
    let mut active = state.active_provider.lock().map_err(|e| e.to_string())?;
    if !is_empty {
        *active = Some(provider.clone());
    } else if active.as_deref() == Some(provider.as_str()) {
        *active = keys.keys().next().cloned();
    }
    let mut stored = load_auth(&app);
    stored.keys.remove(&provider);
    stored.active_provider = active.clone();
    if is_empty {
        stored.oauth_metadata.remove(&provider);
    }
    save_auth(&app, &stored)?;
    Ok(())
}

#[tauri::command]
pub async fn set_active_provider(
    app: AppHandle,
    state: State<'_, AppState>,
    provider: String,
) -> Result<(), String> {
    let keys = state.api_keys.lock().map_err(|e| e.to_string())?;
    if !keys.contains_key(&provider) {
        return Err("No API key stored for selected provider".to_string());
    }
    drop(keys);
    let mut active = state.active_provider.lock().map_err(|e| e.to_string())?;
    *active = Some(provider.clone());
    let mut stored = load_auth(&app);
    stored.keys.remove(&provider);
    stored.active_provider = active.clone();
    save_auth(&app, &stored)?;
    Ok(())
}

#[tauri::command]
pub async fn get_auth_state(state: State<'_, AppState>) -> Result<AuthState, String> {
    let keys = state.api_keys.lock().map_err(|e| e.to_string())?;
    let active = state.active_provider.lock().map_err(|e| e.to_string())?;
    let providers = ["anthropic", "openai", "google"]
        .into_iter()
        .map(|id| {
            let last4 = keys.get(id).and_then(|k| {
                if k.len() >= 4 {
                    Some(k[k.len() - 4..].to_string())
                } else {
                    None
                }
            });
            AuthProviderStatus {
                id: id.to_string(),
                has_key: keys.contains_key(id),
                last4,
            }
        })
        .collect();
    Ok(AuthState {
        active_provider: active.clone(),
        providers,
    })
}
