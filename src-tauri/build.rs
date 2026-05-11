use std::collections::HashMap;

fn normalize_env_value(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_matches('"');
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

fn normalize_build_profile(raw: &str, source: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "local" => "local".to_string(),
        "managed" => "managed".to_string(),
        other => panic!(
            "Unsupported build profile '{other}' from {source}; expected 'local' or 'managed'"
        ),
    }
}

fn read_dotenv_values() -> HashMap<String, String> {
    let mut values = HashMap::new();
    for env_name in ["../.env", "../.env.development"] {
        let path = std::path::Path::new(env_name);
        if !path.exists() {
            continue;
        }
        if let Ok(contents) = std::fs::read_to_string(path) {
            for line in contents.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                if let Some((key, value)) = line.split_once('=') {
                    if let Some(value) = normalize_env_value(value) {
                        values.insert(key.trim().to_string(), value);
                    }
                }
            }
        }
    }
    values
}

fn env_or_dotenv(key: &str, dotenv_values: &HashMap<String, String>) -> Option<String> {
    std::env::var(key)
        .ok()
        .and_then(|raw| normalize_env_value(&raw))
        .or_else(|| dotenv_values.get(key).cloned())
}

fn emit_build_profile(dotenv_values: &HashMap<String, String>) {
    let entropic_profile = env_or_dotenv("ENTROPIC_BUILD_PROFILE", dotenv_values)
        .map(|raw| normalize_build_profile(&raw, "ENTROPIC_BUILD_PROFILE"));
    let vite_profile = env_or_dotenv("VITE_ENTROPIC_BUILD_PROFILE", dotenv_values)
        .map(|raw| normalize_build_profile(&raw, "VITE_ENTROPIC_BUILD_PROFILE"));

    if let (Some(entropic_profile), Some(vite_profile)) = (&entropic_profile, &vite_profile) {
        if entropic_profile != vite_profile {
            panic!(
                "ENTROPIC_BUILD_PROFILE ({entropic_profile}) does not match VITE_ENTROPIC_BUILD_PROFILE ({vite_profile})"
            );
        }
    }

    if let Some(profile) = entropic_profile.or(vite_profile) {
        println!("cargo:rustc-env=ENTROPIC_BUILD_PROFILE={profile}");
    }
}

fn main() {
    // Forward selected env vars from .env files so option_env! picks them up at compile time.
    const COMPILE_TIME_ENV_KEYS: &[&str] = &[
        "OPENCLAW_RUNTIME_RELEASE_REPO",
        "OPENCLAW_RUNTIME_RELEASE_TAG",
        "OPENCLAW_APP_MANIFEST_URL",
        "OPENCLAW_RUNTIME_MANIFEST_URL",
    ];

    let dotenv_values = read_dotenv_values();

    for (key, value) in &dotenv_values {
        if key.starts_with("ENTROPIC_GOOGLE_") || COMPILE_TIME_ENV_KEYS.contains(&key.as_str()) {
            println!("cargo:rustc-env={}={}", key, value);
        }
    }

    // Keep the frontend and Rust build profiles aligned. Release workflows set both
    // explicitly, and this fallback prevents VITE-only builds from silently compiling
    // out the updater plugin.
    emit_build_profile(&dotenv_values);

    println!("cargo:rerun-if-changed=../.env");
    println!("cargo:rerun-if-changed=../.env.development");
    println!("cargo:rerun-if-env-changed=ENTROPIC_BUILD_PROFILE");
    println!("cargo:rerun-if-env-changed=VITE_ENTROPIC_BUILD_PROFILE");
    println!("cargo:rerun-if-env-changed=OPENCLAW_RUNTIME_RELEASE_REPO");
    println!("cargo:rerun-if-env-changed=OPENCLAW_RUNTIME_RELEASE_TAG");
    println!("cargo:rerun-if-env-changed=OPENCLAW_APP_MANIFEST_URL");
    println!("cargo:rerun-if-env-changed=OPENCLAW_RUNTIME_MANIFEST_URL");

    tauri_build::build()
}
