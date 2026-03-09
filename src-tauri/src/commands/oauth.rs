use super::*;

#[tauri::command]
pub async fn start_auth_localhost(app: AppHandle) -> Result<LocalhostAuthStart, String> {
    let port = std::env::var(AUTH_LOCALHOST_PORT_ENV)
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(AUTH_LOCALHOST_DEFAULT_PORT);
    let addr = format!("127.0.0.1:{}", port);
    let listener = TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("Failed to bind localhost OAuth server on {}: {}", addr, e))?;

    let redirect_url = format!("http://{}/auth/callback", addr);
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = wait_for_localhost_auth_callback(listener, app_handle, port).await {
            eprintln!("[Entropic] Localhost OAuth error: {}", err);
        }
    });

    Ok(LocalhostAuthStart { redirect_url })
}

#[tauri::command]
pub async fn start_google_oauth(
    app: AppHandle,
    provider: String,
) -> Result<OAuthTokenBundle, String> {
    let scopes = oauth_scopes(&provider)?;
    let (verifier, challenge) = generate_pkce();
    let state = URL_SAFE_NO_PAD.encode({
        let mut bytes = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut bytes);
        bytes
    });

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind OAuth callback server: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to read OAuth callback port: {}", e))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{}/oauth/callback", port);

    let mut auth_url =
        Url::parse(GOOGLE_AUTH_URL).map_err(|_| "Failed to build OAuth URL".to_string())?;
    auth_url
        .query_pairs_mut()
        .append_pair("client_id", &google_client_id()?)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", &scopes.join(" "))
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state)
        .append_pair("access_type", "offline")
        .append_pair("include_granted_scopes", "true")
        .append_pair("prompt", "consent");

    app.opener()
        .open_url(auth_url.as_str(), None::<&str>)
        .map_err(|e| format!("Failed to open browser: {}", e))?;

    let code = wait_for_oauth_callback(listener, &state).await?;
    let token_response = exchange_code_for_tokens(code, verifier, redirect_uri).await?;
    let refresh_token = token_response
        .refresh_token
        .ok_or_else(|| "OAuth did not return a refresh token. Re-consent required.".to_string())?;
    let expires_in = token_response.expires_in.unwrap_or(3600);
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Clock error".to_string())?
        .as_millis() as u64;
    let expires_at = now_ms.saturating_add(expires_in * 1000);
    let user_info = fetch_google_user(&token_response.access_token)
        .await
        .unwrap_or(GoogleUserInfo {
            email: None,
            id: None,
        });

    let mut scopes_list = token_response
        .scope
        .as_deref()
        .map(parse_scope_list)
        .unwrap_or_default();
    if scopes_list.is_empty() {
        scopes_list = fetch_google_token_scopes(&token_response.access_token)
            .await
            .unwrap_or_default();
    }
    if scopes_list.is_empty() {
        return Err(
            "Google OAuth succeeded but no granted scopes were returned. Disconnect and reconnect the integration."
                .to_string(),
        );
    }
    validate_granted_scopes(&provider, &scopes_list)?;

    Ok(OAuthTokenBundle {
        access_token: token_response.access_token,
        refresh_token,
        token_type: token_response.token_type,
        expires_at,
        scopes: scopes_list,
        email: user_info.email,
        provider_user_id: user_info.id,
        metadata: serde_json::json!({}),
    })
}

#[tauri::command]
pub async fn refresh_google_token(
    provider: String,
    refresh_token: String,
) -> Result<RefreshTokenResponse, String> {
    oauth_scopes(&provider)?;
    let client_id = google_client_id()?;
    let client = reqwest::Client::new();
    let mut params = vec![
        ("client_id", client_id),
        ("refresh_token", refresh_token),
        ("grant_type", "refresh_token".to_string()),
    ];
    if let Some(secret) = google_client_secret() {
        params.push(("client_secret", secret));
    }
    let resp = client
        .post(GOOGLE_TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token refresh failed: {}", e))?;

    if !resp.status().is_success() {
        let text = resp
            .text()
            .await
            .unwrap_or_else(|_| "unknown error".to_string());
        return Err(format!("Token refresh failed: {}", text));
    }

    let data = resp
        .json::<OAuthTokenResponse>()
        .await
        .map_err(|e| format!("Failed to parse refresh response: {}", e))?;

    let expires_in = data.expires_in.unwrap_or(3600);
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Clock error".to_string())?
        .as_millis() as u64;
    let expires_at = now_ms.saturating_add(expires_in * 1000);

    Ok(RefreshTokenResponse {
        access_token: data.access_token,
        token_type: data.token_type,
        expires_at,
    })
}

#[tauri::command]
pub async fn start_anthropic_oauth(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (verifier, challenge) = generate_pkce();

    // Store verifier for the completion step
    {
        let mut v = state
            .anthropic_oauth_verifier
            .lock()
            .map_err(|e| e.to_string())?;
        *v = Some(verifier.clone());
    }

    // Build authorize URL — state IS the verifier (matches Claude Code / OpenClaw convention)
    let mut url =
        Url::parse(ANTHROPIC_AUTH_URL).map_err(|_| "Failed to build OAuth URL".to_string())?;
    url.query_pairs_mut()
        .append_pair("code", "true")
        .append_pair("client_id", ANTHROPIC_OAUTH_CLIENT_ID)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", ANTHROPIC_OAUTH_REDIRECT_URI)
        .append_pair("scope", ANTHROPIC_OAUTH_SCOPES)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &verifier);

    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| format!("Failed to open browser: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn complete_anthropic_oauth(
    app: AppHandle,
    state: State<'_, AppState>,
    code_state: String,
) -> Result<ProviderOAuthResult, String> {
    let (code, returned_state) = parse_anthropic_code_state(&code_state)?;

    // Retrieve and consume the stored verifier
    let verifier = {
        let mut v = state
            .anthropic_oauth_verifier
            .lock()
            .map_err(|e| e.to_string())?;
        v.take()
            .ok_or("No pending Anthropic OAuth flow. Please click Sign In first.")?
    };

    // Validate state matches verifier (state == verifier in this flow)
    if returned_state != verifier {
        return Err(
            "OAuth state mismatch — the code may have expired. Please try again.".to_string(),
        );
    }

    // Exchange code for tokens using JSON body (matching Claude Code / OpenClaw)
    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "grant_type": "authorization_code",
        "client_id": ANTHROPIC_OAUTH_CLIENT_ID,
        "code": code,
        "state": returned_state,
        "redirect_uri": ANTHROPIC_OAUTH_REDIRECT_URI,
        "code_verifier": verifier,
    });

    let resp = client
        .post(ANTHROPIC_TOKEN_URL)
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Token exchange failed: {}", e))?;

    if !resp.status().is_success() {
        let text = resp
            .text()
            .await
            .unwrap_or_else(|_| "unknown error".to_string());
        return Err(format!("Token exchange failed: {}", text));
    }

    let token_data = resp
        .json::<OAuthTokenResponse>()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))?;

    let refresh_token = token_data.refresh_token.unwrap_or_default();
    let expires_in = token_data.expires_in.unwrap_or(3600);
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Clock error".to_string())?
        .as_millis() as u64;
    // Subtract 5 minutes as buffer (matches OpenClaw convention)
    let expires_at = now_ms
        .saturating_add(expires_in * 1000)
        .saturating_sub(5 * 60 * 1000);

    let provider = "anthropic".to_string();

    // Keep the token in memory; only OAuth metadata persists on disk.
    {
        let mut keys = state.api_keys.lock().map_err(|e| e.to_string())?;
        keys.insert(provider.clone(), token_data.access_token.clone());
        let mut active = state.active_provider.lock().map_err(|e| e.to_string())?;
        *active = Some(provider.clone());
        let mut stored = load_auth(&app);
        stored.keys.remove(&provider);
        stored.active_provider = active.clone();
        stored.oauth_metadata.insert(
            provider.clone(),
            OAuthKeyMeta {
                refresh_token: refresh_token.clone(),
                expires_at,
                source: "claude_code".to_string(),
            },
        );
        save_auth(&app, &stored)?;
    }

    Ok(ProviderOAuthResult {
        access_token: token_data.access_token,
        refresh_token,
        expires_at,
        provider,
    })
}

#[tauri::command]
pub async fn start_openai_oauth(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ProviderOAuthResult, String> {
    let (verifier, challenge) = generate_pkce();
    let oauth_state = URL_SAFE_NO_PAD.encode({
        let mut bytes = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut bytes);
        bytes
    });

    // OpenAI requires the exact registered redirect URI on port 1455
    let redirect_uri = "http://localhost:1455/auth/callback".to_string();
    let listener = TcpListener::bind("127.0.0.1:1455").await.map_err(|e| {
        format!(
            "Failed to bind OAuth callback server on port 1455 (is another app using it?): {}",
            e
        )
    })?;

    let mut url =
        Url::parse(OPENAI_AUTH_URL).map_err(|_| "Failed to build OAuth URL".to_string())?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", OPENAI_OAUTH_CLIENT_ID)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", OPENAI_OAUTH_SCOPES)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &oauth_state)
        .append_pair("id_token_add_organizations", "true")
        .append_pair("codex_cli_simplified_flow", "true")
        .append_pair("originator", "pi");

    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| format!("Failed to open browser: {}", e))?;

    let code = wait_for_openai_oauth_callback(listener, &oauth_state).await?;

    // Exchange code for tokens (form-encoded for OpenAI)
    let client = reqwest::Client::new();
    let params = vec![
        ("client_id", OPENAI_OAUTH_CLIENT_ID.to_string()),
        ("code", code),
        ("grant_type", "authorization_code".to_string()),
        ("redirect_uri", redirect_uri),
        ("code_verifier", verifier),
    ];
    let resp = client
        .post(OPENAI_TOKEN_URL)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token exchange failed: {}", e))?;

    if !resp.status().is_success() {
        let text = resp
            .text()
            .await
            .unwrap_or_else(|_| "unknown error".to_string());
        return Err(format!("Token exchange failed: {}", text));
    }

    let token_data = resp
        .json::<OAuthTokenResponse>()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))?;

    let refresh_token = token_data.refresh_token.unwrap_or_default();
    let expires_in = token_data.expires_in.unwrap_or(3600);
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Clock error".to_string())?
        .as_millis() as u64;
    let expires_at = now_ms.saturating_add(expires_in * 1000);

    let provider = "openai".to_string();

    // Keep the token in memory; only OAuth metadata persists on disk.
    {
        let mut keys = state.api_keys.lock().map_err(|e| e.to_string())?;
        keys.insert(provider.clone(), token_data.access_token.clone());
        let mut active = state.active_provider.lock().map_err(|e| e.to_string())?;
        *active = Some(provider.clone());
        let mut stored = load_auth(&app);
        stored.keys.remove(&provider);
        stored.active_provider = active.clone();
        stored.oauth_metadata.insert(
            provider.clone(),
            OAuthKeyMeta {
                refresh_token: refresh_token.clone(),
                expires_at,
                source: "openai_codex".to_string(),
            },
        );
        save_auth(&app, &stored)?;
    }

    Ok(ProviderOAuthResult {
        access_token: token_data.access_token,
        refresh_token,
        expires_at,
        provider,
    })
}

#[tauri::command]
pub async fn get_device_fingerprint_hash() -> Result<String, String> {
    let raw = resolve_raw_device_identifier();
    let mut hasher = Sha256::new();
    hasher.update("entropic-device-fingerprint-v1:");
    hasher.update(raw.as_bytes());
    Ok(format!("{:x}", hasher.finalize()))
}

#[tauri::command]
pub async fn refresh_provider_token(
    app: AppHandle,
    state: State<'_, AppState>,
    provider: String,
) -> Result<ProviderOAuthResult, String> {
    let token_url = match provider.as_str() {
        "anthropic" => ANTHROPIC_TOKEN_URL,
        "openai" => OPENAI_TOKEN_URL,
        _ => return Err(format!("Unsupported OAuth provider: {}", provider)),
    };
    let client_id = match provider.as_str() {
        "anthropic" => ANTHROPIC_OAUTH_CLIENT_ID,
        "openai" => OPENAI_OAUTH_CLIENT_ID,
        _ => unreachable!(),
    };

    let stored = load_auth(&app);
    let meta = stored
        .oauth_metadata
        .get(&provider)
        .ok_or_else(|| format!("No OAuth metadata for provider: {}", provider))?;

    if meta.refresh_token.is_empty() {
        return Err("No refresh token available. Please sign in again.".to_string());
    }

    let client = reqwest::Client::new();

    // Anthropic uses JSON body; OpenAI uses form-encoded
    let resp = if provider == "anthropic" {
        let payload = serde_json::json!({
            "grant_type": "refresh_token",
            "client_id": client_id,
            "refresh_token": meta.refresh_token,
        });
        client
            .post(token_url)
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("Token refresh failed: {}", e))?
    } else {
        let params = vec![
            ("client_id", client_id.to_string()),
            ("refresh_token", meta.refresh_token.clone()),
            ("grant_type", "refresh_token".to_string()),
        ];
        client
            .post(token_url)
            .form(&params)
            .send()
            .await
            .map_err(|e| format!("Token refresh failed: {}", e))?
    };

    if !resp.status().is_success() {
        let text = resp
            .text()
            .await
            .unwrap_or_else(|_| "unknown error".to_string());
        return Err(format!("Token refresh failed: {}", text));
    }

    let data = resp
        .json::<OAuthTokenResponse>()
        .await
        .map_err(|e| format!("Failed to parse refresh response: {}", e))?;

    let new_refresh = data
        .refresh_token
        .unwrap_or_else(|| meta.refresh_token.clone());
    let expires_in = data.expires_in.unwrap_or(3600);
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Clock error".to_string())?
        .as_millis() as u64;
    let expires_at = now_ms.saturating_add(expires_in * 1000);

    // Keep the refreshed token in memory; only OAuth metadata persists on disk.
    {
        let mut keys = state.api_keys.lock().map_err(|e| e.to_string())?;
        keys.insert(provider.clone(), data.access_token.clone());
        let mut stored = load_auth(&app);
        stored.keys.remove(&provider);
        stored.oauth_metadata.insert(
            provider.clone(),
            OAuthKeyMeta {
                refresh_token: new_refresh.clone(),
                expires_at,
                source: meta.source.clone(),
            },
        );
        save_auth(&app, &stored)?;
    }

    Ok(ProviderOAuthResult {
        access_token: data.access_token,
        refresh_token: new_refresh,
        expires_at,
        provider,
    })
}

#[tauri::command]
pub async fn get_oauth_status(app: AppHandle) -> Result<HashMap<String, String>, String> {
    let stored = load_auth(&app);
    let mut result = HashMap::new();
    for (provider, meta) in &stored.oauth_metadata {
        result.insert(provider.clone(), meta.source.clone());
    }
    Ok(result)
}
