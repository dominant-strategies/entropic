fn main() {
    // Forward NOVA_GOOGLE_* from .env files so option_env! picks them up at compile time.
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
                        if key.starts_with("NOVA_GOOGLE_") {
                            println!("cargo:rustc-env={}={}", key, value);
                        }
                    }
                }
            }
        }
    }
    println!("cargo:rerun-if-changed=../.env");
    println!("cargo:rerun-if-changed=../.env.development");

    tauri_build::build()
}
