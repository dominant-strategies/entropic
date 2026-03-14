fn main() {
    // Forward selected env vars from .env files so option_env! picks them up at compile time.
    const COMPILE_TIME_ENV_KEYS: &[&str] = &[
        "ENTROPIC_BUILD_PROFILE",
        "OPENCLAW_RUNTIME_RELEASE_REPO",
        "OPENCLAW_RUNTIME_RELEASE_TAG",
        "OPENCLAW_APP_MANIFEST_URL",
        "OPENCLAW_RUNTIME_MANIFEST_URL",
    ];

    for env_name in ["../.env", "../.env.development"] {
        let path = std::path::Path::new(env_name);
        if path.exists() {
            if let Ok(contents) = std::fs::read_to_string(path) {
                for line in contents.lines() {
                    let line = line.trim();
                    if line.is_empty() || line.starts_with('#') {
                        continue;
                    }
                    if let Some((key, value)) = line.split_once('=') {
                        let key = key.trim();
                        let value = value.trim().trim_matches('"');
                        if key.starts_with("ENTROPIC_GOOGLE_")
                            || COMPILE_TIME_ENV_KEYS.contains(&key)
                        {
                            println!("cargo:rustc-env={}={}", key, value);
                        }
                    }
                }
            }
        }
    }
    println!("cargo:rerun-if-changed=../.env");
    println!("cargo:rerun-if-changed=../.env.development");
    println!("cargo:rerun-if-env-changed=ENTROPIC_BUILD_PROFILE");
    println!("cargo:rerun-if-env-changed=OPENCLAW_RUNTIME_RELEASE_REPO");
    println!("cargo:rerun-if-env-changed=OPENCLAW_RUNTIME_RELEASE_TAG");
    println!("cargo:rerun-if-env-changed=OPENCLAW_APP_MANIFEST_URL");
    println!("cargo:rerun-if-env-changed=OPENCLAW_RUNTIME_MANIFEST_URL");

    tauri_build::build()
}
