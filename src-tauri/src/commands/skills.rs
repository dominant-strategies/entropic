use super::*;

#[tauri::command]
pub async fn get_plugin_store() -> Result<Vec<PluginInfo>, String> {
    let cfg = read_openclaw_config();
    let manifests = list_extension_manifests()?;

    let slot_memory = cfg
        .get("plugins")
        .and_then(|v| v.get("slots"))
        .and_then(|v| v.get("memory"))
        .and_then(|v| v.as_str())
        .unwrap_or("memory-core");

    let mut out = Vec::new();
    for m in manifests {
        let id = m
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        if !config_allows_plugin(&cfg, &id) {
            continue;
        }
        let kind = m
            .get("kind")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let channels = m
            .get("channels")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let entry_enabled = cfg
            .get("plugins")
            .and_then(|v| v.get("entries"))
            .and_then(|v| v.get(&id))
            .and_then(|v| v.get("enabled"))
            .and_then(|v| v.as_bool());

        let enabled = if id == slot_memory {
            true
        } else {
            entry_enabled.unwrap_or(false)
        };

        let managed =
            kind.as_deref() == Some("memory") || MANAGED_PLUGIN_IDS.contains(&id.as_str());

        out.push(PluginInfo {
            id,
            kind,
            channels,
            installed: true,
            enabled,
            managed,
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn set_plugin_enabled(id: String, enabled: bool) -> Result<(), String> {
    if MANAGED_PLUGIN_IDS.contains(&id.as_str()) {
        return Err("Plugin is managed by Entropic".to_string());
    }
    let mut cfg = read_openclaw_config();
    normalize_openclaw_config(&mut cfg);
    set_openclaw_config_value(
        &mut cfg,
        &["plugins", "entries", &id, "enabled"],
        serde_json::json!(enabled),
    );
    write_openclaw_config(&cfg)
}

#[tauri::command]
pub async fn get_skill_store() -> Result<Vec<SkillInfo>, String> {
    let listing = collect_skill_ids()?;
    let mut out = Vec::new();

    for id in listing {
        let full_path = match resolve_installed_skill_dir(&id)? {
            Some(path) => path,
            None => continue,
        };
        let skill_md_path = format!("{}/SKILL.md", full_path);
        let raw = read_container_file(&skill_md_path).unwrap_or_default();
        let (name, description) = parse_skill_frontmatter(&raw);

        out.push(SkillInfo {
            id: id.clone(),
            name: name.unwrap_or_else(|| id.clone()),
            description: description.unwrap_or_else(|| "Workspace skill".to_string()),
            path: full_path,
            source: "User Skills".to_string(),
            scan: read_skill_scan_from_manifest(&id),
        });
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

#[tauri::command]
pub async fn remove_workspace_skill(id: String) -> Result<(), String> {
    let skill_id = id.trim().to_string();
    if !is_safe_component(&skill_id) {
        return Err("Invalid skill id".to_string());
    }
    if skill_id == "entropic-x" {
        return Err("Entropic-managed skills cannot be removed".to_string());
    }

    let mut config_removal_paths: Vec<String> = Vec::new();
    if let Ok(Some(path)) = resolve_installed_skill_dir(&skill_id) {
        config_removal_paths.push(path);
    }

    let observed_skill = collect_skill_ids()?.iter().any(|value| value == &skill_id)
        || container_dir_exists(&format!("{}/{}", SKILL_MANIFESTS_ROOT, skill_id)).unwrap_or(false)
        || container_path_exists_checked(&format!("{}/{}.json", SKILL_MANIFESTS_ROOT, skill_id))
            .unwrap_or(false);

    let mut remove_paths = vec![format!("{}/{}", SKILLS_ROOT, skill_id)];
    for legacy_root in LEGACY_SKILLS_ROOTS {
        remove_paths.push(format!(
            "{}/{}",
            legacy_root.trim_end_matches('/'),
            skill_id
        ));
    }
    remove_paths.push(format!("{}/{}", SKILL_MANIFESTS_ROOT, skill_id));
    remove_paths.push(format!("{}/{}.json", SKILL_MANIFESTS_ROOT, skill_id));

    let mut removed_any = false;
    for full_path in remove_paths {
        if container_path_exists_checked(&full_path).unwrap_or(false) {
            removed_any = true;
        }
        docker_exec_output(&["exec", OPENCLAW_CONTAINER, "rm", "-rf", "--", &full_path])?;
        if !config_removal_paths.contains(&full_path) {
            config_removal_paths.push(full_path);
        }
    }

    let mut cfg = read_openclaw_config();
    normalize_openclaw_config(&mut cfg);
    let mut config_updated = false;
    if cfg
        .pointer(&format!("/plugins/entries/{}", skill_id))
        .is_some()
    {
        remove_openclaw_config_value(&mut cfg, &["plugins", "entries", &skill_id]);
        config_updated = true;
    }
    if let Some(load_paths) = cfg
        .pointer_mut("/plugins/load/paths")
        .and_then(|v| v.as_array_mut())
    {
        let before_len = load_paths.len();
        load_paths.retain(|path| {
            let path_value = path.as_str().unwrap_or("");
            if path_value.is_empty() {
                return true;
            }

            !config_removal_paths.iter().any(|prefix| {
                let normalized_prefix = prefix.trim_end_matches('/');
                path_value == normalized_prefix
                    || path_value.starts_with(&format!("{}/", normalized_prefix))
            })
        });
        if load_paths.len() != before_len {
            config_updated = true;
        }
    }
    if config_updated {
        write_openclaw_config(&cfg)?;
    }

    if !observed_skill && !removed_any && !config_updated {
        return Err("Skill not found".to_string());
    }

    Ok(())
}

#[tauri::command]
pub async fn get_clawhub_catalog(
    query: Option<String>,
    limit: Option<u32>,
    sort: Option<String>,
) -> Result<Vec<ClawhubCatalogSkill>, String> {
    let query = query.unwrap_or_default().trim().to_string();
    let query_lower = query.to_lowercase();
    let max_results = limit.unwrap_or(40).clamp(1, 200);

    // When a search query is present, use `clawhub search` (vector search) which
    // finds skills by semantic relevance regardless of popularity ranking.
    // `clawhub explore` only returns popular/trending skills, so low-star skills
    // like newly published ones are invisible when using explore + local filter.
    if !query_lower.is_empty() {
        let search_limit = max_results.to_string();
        let raw = match clawhub_exec_output(&[
            "search",
            query.as_str(),
            "--limit",
            search_limit.as_str(),
        ]) {
            Ok(r) => r,
            Err(e) => {
                if e.to_lowercase().contains("rate limit") {
                    let cache = CLAWHUB_CATALOG_CACHE
                        .get_or_init(|| Mutex::new(None))
                        .lock()
                        .unwrap();
                    if let Some((cached, ts)) = cache.as_ref() {
                        if ts.elapsed() < Duration::from_secs(300) {
                            return Ok(cached.clone());
                        }
                    }
                    return Ok(featured_clawhub_skills());
                }
                return Err(e);
            }
        };

        // `clawhub search` output is plain text: one result per line in the form
        //   <slug>  <displayName>  (<score>)
        // with a leading spinner line "- Searching" that we skip.
        let mut out = Vec::new();
        for line in raw.lines() {
            let line = line.trim();
            // Skip spinner / status lines
            if line.is_empty()
                || line.starts_with('-')
                || line.starts_with('✔')
                || line.starts_with('✖')
            {
                continue;
            }
            // Split on two-or-more spaces to separate columns
            let cols: Vec<&str> = line.splitn(3, "  ").collect();
            let slug = cols.first().unwrap_or(&"").trim().to_string();
            if slug.is_empty() || !is_safe_slug(&slug) {
                continue;
            }
            let display_name = cols.get(1).unwrap_or(&slug.as_str()).trim().to_string();
            // Hydrate with full metadata via inspect so we have summary, version, stats
            let (summary, latest_version, downloads, installs_all_time, stars, updated_at) =
                match clawhub_exec_output(&["inspect", slug.as_str(), "--json"]) {
                    Ok(inspect_raw) => {
                        if let Ok(payload) = parse_clawhub_json::<serde_json::Value>(&inspect_raw) {
                            let skill = payload
                                .get("skill")
                                .cloned()
                                .unwrap_or(serde_json::Value::Null);
                            let lv = payload
                                .get("latestVersion")
                                .cloned()
                                .unwrap_or(serde_json::Value::Null);
                            let summary = skill
                                .get("summary")
                                .and_then(|v| v.as_str())
                                .unwrap_or("ClawHub skill")
                                .trim()
                                .to_string();
                            let latest_version = lv
                                .get("version")
                                .and_then(|v| v.as_str())
                                .or_else(|| {
                                    skill
                                        .get("tags")
                                        .and_then(|v| v.get("latest"))
                                        .and_then(|v| v.as_str())
                                })
                                .map(|v| v.to_string());
                            let stats = skill
                                .get("stats")
                                .cloned()
                                .unwrap_or(serde_json::Value::Null);
                            let downloads =
                                stats.get("downloads").and_then(|v| v.as_u64()).unwrap_or(0);
                            let installs_all_time = stats
                                .get("installsAllTime")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);
                            let stars = stats.get("stars").and_then(|v| v.as_u64()).unwrap_or(0);
                            let updated_at = skill.get("updatedAt").and_then(|v| v.as_u64());
                            (
                                summary,
                                latest_version,
                                downloads,
                                installs_all_time,
                                stars,
                                updated_at,
                            )
                        } else {
                            (display_name.clone(), None, 0u64, 0u64, 0u64, None)
                        }
                    }
                    Err(_) => (display_name.clone(), None, 0u64, 0u64, 0u64, None),
                };
            out.push(ClawhubCatalogSkill {
                slug,
                display_name,
                summary,
                latest_version,
                downloads,
                installs_all_time,
                stars,
                updated_at,
                is_fallback: false,
            });
        }
        return Ok(out);
    }

    // No query — browse via explore (trending/popular listing)
    let fetch_limit_str = max_results.to_string();
    let normalized_sort = match sort.as_deref().map(|v| v.trim()).unwrap_or("trending") {
        "newest" => "newest".to_string(),
        "downloads" => "downloads".to_string(),
        "rating" => "rating".to_string(),
        "installs" => "installs".to_string(),
        "installsAllTime" => "installsAllTime".to_string(),
        _ => "trending".to_string(),
    };

    let raw = match clawhub_exec_output(&[
        "explore",
        "--json",
        "--limit",
        fetch_limit_str.as_str(),
        "--sort",
        normalized_sort.as_str(),
    ]) {
        Ok(r) => r,
        Err(e) => {
            if e.to_lowercase().contains("rate limit") {
                let cache = CLAWHUB_CATALOG_CACHE
                    .get_or_init(|| Mutex::new(None))
                    .lock()
                    .unwrap();
                if let Some((cached, ts)) = cache.as_ref() {
                    if ts.elapsed() < Duration::from_secs(300) {
                        return Ok(cached.clone());
                    }
                }
                return Ok(featured_clawhub_skills());
            }
            return Err(e);
        }
    };
    let payload: serde_json::Value = parse_clawhub_json(&raw)?;
    let items = payload
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut out = Vec::new();
    for item in items {
        let slug = item
            .get("slug")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if !is_safe_slug(&slug) {
            continue;
        }
        let display_name = item
            .get("displayName")
            .and_then(|v| v.as_str())
            .unwrap_or(&slug)
            .trim()
            .to_string();
        let summary = item
            .get("summary")
            .and_then(|v| v.as_str())
            .unwrap_or("ClawHub skill")
            .trim()
            .to_string();
        let latest_version = item
            .get("latestVersion")
            .and_then(|v| v.get("version"))
            .and_then(|v| v.as_str())
            .or_else(|| {
                item.get("tags")
                    .and_then(|v| v.get("latest"))
                    .and_then(|v| v.as_str())
            })
            .map(|v| v.to_string());
        let downloads = item
            .get("stats")
            .and_then(|v| v.get("downloads"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let installs_all_time = item
            .get("stats")
            .and_then(|v| v.get("installsAllTime"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let stars = item
            .get("stats")
            .and_then(|v| v.get("stars"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let updated_at = item.get("updatedAt").and_then(|v| v.as_u64());

        out.push(ClawhubCatalogSkill {
            slug,
            display_name,
            summary,
            latest_version,
            downloads,
            installs_all_time,
            stars,
            updated_at,
            is_fallback: false,
        });
    }

    if out.len() > max_results as usize {
        out.truncate(max_results as usize);
    }

    // Cache successful results for rate-limit fallback
    {
        let mut cache = CLAWHUB_CATALOG_CACHE
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap();
        *cache = Some((out.clone(), Instant::now()));
    }

    Ok(out)
}

#[tauri::command]
pub async fn get_clawhub_skill_details(slug: String) -> Result<ClawhubSkillDetails, String> {
    let skill_slug = slug.trim().to_string();
    if !is_safe_slug(&skill_slug) {
        return Err("Invalid skill slug".to_string());
    }

    let raw = clawhub_exec_output(&["inspect", skill_slug.as_str(), "--json"])?;
    let payload: serde_json::Value = parse_clawhub_json(&raw)?;
    let skill = payload
        .get("skill")
        .ok_or_else(|| "Malformed ClawHub inspect response: missing skill".to_string())?;

    let display_name = skill
        .get("displayName")
        .and_then(|v| v.as_str())
        .unwrap_or(skill_slug.as_str())
        .trim()
        .to_string();
    let summary = skill
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("ClawHub skill")
        .trim()
        .to_string();
    let latest_version = payload
        .get("latestVersion")
        .and_then(|v| v.get("version"))
        .and_then(|v| v.as_str())
        .or_else(|| {
            skill
                .get("tags")
                .and_then(|v| v.get("latest"))
                .and_then(|v| v.as_str())
        })
        .map(|v| v.to_string());
    let changelog = payload
        .get("latestVersion")
        .and_then(|v| v.get("changelog"))
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());
    let owner_handle = payload
        .get("owner")
        .and_then(|v| v.get("handle"))
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());
    let owner_display_name = payload
        .get("owner")
        .and_then(|v| v.get("displayName"))
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());
    let downloads = skill
        .get("stats")
        .and_then(|v| v.get("downloads"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let installs_all_time = skill
        .get("stats")
        .and_then(|v| v.get("installsAllTime"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let stars = skill
        .get("stats")
        .and_then(|v| v.get("stars"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let updated_at = skill.get("updatedAt").and_then(|v| v.as_u64());

    Ok(ClawhubSkillDetails {
        slug: skill_slug,
        display_name,
        summary,
        latest_version,
        changelog,
        owner_handle,
        owner_display_name,
        downloads,
        installs_all_time,
        stars,
        updated_at,
    })
}

#[tauri::command]
pub async fn scan_plugin(id: String) -> Result<PluginScanResult, String> {
    let plugin_id = id.trim().to_string();
    if !is_safe_component(&plugin_id) {
        return Err("Invalid plugin id".to_string());
    }

    start_scanner_sidecar();
    if !scanner_running()? {
        return Ok(scanner_unavailable_result());
    }

    let scan_result = async {
        let mut source_dir = format!("/app/extensions/{}", plugin_id);
        let mut exists = docker_command()
            .args(["exec", OPENCLAW_CONTAINER, "test", "-d", &source_dir])
            .output()
            .map_err(|e| format!("Failed to inspect plugin directory: {}", e))?
            .status
            .success();

        if !exists {
            if let Some(skills_root) = read_container_env("ENTROPIC_SKILLS_PATH") {
                let base = format!("{}/{}", skills_root.trim_end_matches('/'), plugin_id);
                let current = format!("{}/current", base);
                let candidate = if container_path_exists(&current) {
                    current
                } else {
                    base
                };
                let candidate_exists = docker_command()
                    .args(["exec", OPENCLAW_CONTAINER, "test", "-d", &candidate])
                    .output()
                    .map_err(|e| format!("Failed to inspect plugin directory: {}", e))?
                    .status
                    .success();
                if candidate_exists {
                    source_dir = candidate;
                    exists = true;
                }
            }
        }

        if !exists {
            return Err("Plugin directory not found".to_string());
        }

        let scanner_dir = format!("/tmp/entropic-scan/plugins/{}", plugin_id);
        clone_dir_from_openclaw_to_scanner(&source_dir, &scanner_dir)?;
        scan_directory_with_scanner(&scanner_dir).await
    }
    .await;

    stop_scanner_sidecar();
    scan_result
}

#[tauri::command]
pub async fn scan_workspace_skill(id: String) -> Result<PluginScanResult, String> {
    let skill_id = id.trim().to_string();
    if !is_safe_component(&skill_id) {
        return Err("Invalid skill id".to_string());
    }

    start_scanner_sidecar();
    if !scanner_running()? {
        return Ok(scanner_unavailable_result());
    }

    let scan_result = async {
        let source_dir = resolve_installed_skill_dir(&skill_id)?
            .ok_or_else(|| "Skill directory not found".to_string())?;

        let scanner_dir = format!("/tmp/entropic-scan/workspace-skills/{}", skill_id);
        clone_dir_from_openclaw_to_scanner(&source_dir, &scanner_dir)?;
        scan_directory_with_scanner(&scanner_dir).await
    }
    .await;

    stop_scanner_sidecar();
    scan_result
}

#[tauri::command]
pub async fn scan_and_install_clawhub_skill(
    app: AppHandle,
    state: State<'_, AppState>,
    slug: String,
    allow_unsafe: bool,
) -> Result<ClawhubInstallResult, String> {
    let trimmed_slug = slug.trim().to_string();
    if !is_safe_slug(&trimmed_slug) {
        return Err("Invalid skill slug".to_string());
    }

    start_scanner_sidecar();
    if !scanner_running()? {
        return Ok(ClawhubInstallResult {
            scan: scanner_unavailable_result(),
            installed: false,
            blocked: false,
            message: Some("Scanner unavailable".to_string()),
            installed_skill_id: None,
        });
    }

    let install_result = async {
        let temp_root = format!("/tmp/entropic-clawhub-scan-{}", unique_id());
        docker_exec_output(&[
            "exec",
            OPENCLAW_CONTAINER,
            "mkdir",
            "-p",
            "--",
            &format!("{}/skills", temp_root),
        ])?;

        let cleanup = |root: &str| {
            let _ = docker_exec_output(&["exec", OPENCLAW_CONTAINER, "rm", "-rf", "--", root]);
        };

        let fetch_result = clawhub_exec_with_retry(
            &[
                "install",
                &trimmed_slug,
                "--workdir",
                &temp_root,
                "--dir",
                "skills",
                "--no-input",
                "--force",
            ],
            3,
        )
        .map_err(|e| format!("Failed to run ClawHub install: {}", e))?;

        if !fetch_result.status.success() {
            cleanup(&temp_root);
            return Err(format!(
                "ClawHub install failed: {}",
                command_output_error(&fetch_result)
            ));
        }

        let (downloaded_path, detected_skill_id) =
            match resolve_downloaded_skill_path(&temp_root, &trimmed_slug) {
                Ok(value) => value,
                Err(err) => {
                    cleanup(&temp_root);
                    return Err(err);
                }
            };
        let scanner_dir = format!("/tmp/entropic-scan/clawhub/{}", detected_skill_id);
        if let Err(err) = clone_dir_from_openclaw_to_scanner(&downloaded_path, &scanner_dir) {
            cleanup(&temp_root);
            return Err(err);
        }
        let scan = match scan_directory_with_scanner(&scanner_dir).await {
            Ok(value) => value,
            Err(err) => {
                cleanup(&temp_root);
                return Err(err);
            }
        };

        if !scan.is_safe
            && scan.scanner_available
            && (scan.max_severity == "CRITICAL" || scan.max_severity == "HIGH")
            && !allow_unsafe
        {
            cleanup(&temp_root);
            return Ok(ClawhubInstallResult {
                scan,
                installed: false,
                blocked: true,
                message: Some("Installation blocked due to high-severity findings".to_string()),
                installed_skill_id: Some(detected_skill_id),
            });
        }

        // Resolve version — try the API but fall back to "latest" on rate-limit.
        let skill_version = clawhub_latest_version(&trimmed_slug)
            .ok()
            .flatten()
            .unwrap_or_else(|| "latest".to_string());

        // Copy the already-downloaded skill from the temp scan dir to the final
        // location instead of re-downloading from ClawHub (avoids a second API
        // call and the rate-limit that comes with it).
        let final_skill_dir = format!("{}/{}/{}", SKILLS_ROOT, detected_skill_id, skill_version);
        let copy_script = format!(
            "mkdir -p {} && cp -a {}/. {}",
            sh_single_quote(&final_skill_dir),
            sh_single_quote(downloaded_path.trim_end_matches('/')),
            sh_single_quote(&final_skill_dir),
        );
        if let Err(err) =
            docker_exec_output(&["exec", OPENCLAW_CONTAINER, "sh", "-c", &copy_script])
        {
            cleanup(&temp_root);
            return Err(format!("Failed to install skill from scan cache: {}", err));
        }

        cleanup(&temp_root);

        let skill_family_root = format!("{}/{}", SKILLS_ROOT, detected_skill_id);
        let current_link = format!("{}/current", skill_family_root);
        let _ = docker_exec_output(&[
            "exec",
            OPENCLAW_CONTAINER,
            "sh",
            "-c",
            &format!(
                "mkdir -p -- {} && ln -sfn {} {}",
                sh_single_quote(&skill_family_root),
                sh_single_quote(&skill_version),
                sh_single_quote(&current_link)
            ),
        ]);

        let installed_version_root =
            format!("{}/{}/{}", SKILLS_ROOT, detected_skill_id, skill_version);
        let installed_skill_path = match resolve_skill_root_in_container(
            OPENCLAW_CONTAINER,
            &installed_version_root,
            Some(&detected_skill_id),
        ) {
            Ok(Some(path)) => path,
            Ok(None) => installed_version_root.clone(),
            Err(err) => {
                eprintln!(
                    "[Entropic] Failed to resolve installed skill root for {}: {}",
                    detected_skill_id, err
                );
                installed_version_root.clone()
            }
        };
        let installed_skill_md =
            read_container_file(&format!("{}/SKILL.md", installed_skill_path)).unwrap_or_default();

        // Mirror the active skill into workspace/skills so OpenClaw's native skills
        // loader can discover it for chat runs.
        let workspace_skills_root = format!("{}/skills", WORKSPACE_ROOT);
        let workspace_skill_path = format!("{}/{}", workspace_skills_root, detected_skill_id);
        let source_contents = format!("{}/.", installed_skill_path.trim_end_matches('/'));
        docker_exec_output(&[
            "exec",
            OPENCLAW_CONTAINER,
            "mkdir",
            "-p",
            "--",
            &workspace_skills_root,
        ])
        .map_err(|e| format!("Failed to prepare workspace skills directory: {}", e))?;
        docker_exec_output(&[
            "exec",
            OPENCLAW_CONTAINER,
            "rm",
            "-rf",
            "--",
            &workspace_skill_path,
        ])
        .map_err(|e| format!("Failed to remove previous workspace skill copy: {}", e))?;
        docker_exec_output(&[
            "exec",
            OPENCLAW_CONTAINER,
            "mkdir",
            "-p",
            "--",
            &workspace_skill_path,
        ])
        .map_err(|e| format!("Failed to create workspace skill directory: {}", e))?;
        docker_exec_output(&[
            "exec",
            OPENCLAW_CONTAINER,
            "cp",
            "-a",
            "--",
            &source_contents,
            &workspace_skill_path,
        ])
        .map_err(|e| format!("Failed to sync installed skill into workspace: {}", e))?;

        let manifest_path = format!(
            "{}/{}/{}.json",
            SKILL_MANIFESTS_ROOT, detected_skill_id, skill_version
        );
        let tree_hash = compute_skill_tree_hash(&installed_skill_path);
        let scope_flags = infer_skill_scope_flags(&installed_skill_md);
        let manifest_skill_id = detected_skill_id.clone();
        let manifest_source_slug = trimmed_slug.clone();
        let manifest_version = skill_version.clone();
        let manifest_path_value = installed_skill_path.clone();
        let manifest = serde_json::json!({
            "schema": "entropic-skill-manifest/v1",
            "skill_id": manifest_skill_id,
            "source_slug": manifest_source_slug,
            "version": manifest_version,
            "installed_at_ms": current_millis(),
            "path": manifest_path_value,
            "scan_id": scan.scan_id,
            "integrity": {
                "sha256_tree": tree_hash,
                "signature": serde_json::Value::Null
            },
            "scopes": scope_flags,
            "scan": {
                "is_safe": scan.is_safe,
                "max_severity": scan.max_severity,
                "findings_count": scan.findings_count,
            }
        });
        write_container_file(
            &manifest_path,
            &serde_json::to_string_pretty(&manifest)
                .map_err(|e| format!("Failed to serialize skill manifest: {}", e))?,
        )?;

        // Hot-register the new skill in the runtime config so the chat agent
        // can discover it immediately without a full gateway restart.
        if let Err(e) = apply_agent_settings(&app, &state) {
            eprintln!(
                "[Entropic] Failed to apply agent settings after skill install: {}",
                e
            );
        }
        // OpenClaw can cache plugin/tool registry at process start. If the
        // gateway is running in local-keys mode, recreate it so newly installed
        // skills are loaded. Proxy-mode containers cannot be restarted this way
        // (no local keys available); apply_agent_settings above already
        // hot-registered the skill into the workspace config.
        let is_proxy_mode = read_container_env("ENTROPIC_PROXY_MODE").is_some();
        if container_running() && !is_proxy_mode {
            println!("[Entropic] Restarting gateway to load newly installed skill...");
            let _ = app.emit("gateway-restarting", ());
            if let Err(e) = restart_gateway(app.clone(), state, None).await {
                eprintln!(
                    "[Entropic] Failed to restart gateway after skill install: {}",
                    e
                );
            }
        }

        Ok(ClawhubInstallResult {
            scan,
            installed: true,
            blocked: false,
            message: None,
            installed_skill_id: Some(detected_skill_id),
        })
    }
    .await;

    stop_scanner_sidecar();
    install_result
}
