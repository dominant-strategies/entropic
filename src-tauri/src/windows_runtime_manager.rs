#[cfg(target_os = "windows")]
pub(crate) const RUNTIME_MANAGER_DISPATCH_FLAG: &str = "--entropic-runtime-manager-dispatch";
#[cfg(target_os = "windows")]
pub(crate) const RUNTIME_MANAGER_SERVER_FLAG: &str = "--entropic-runtime-manager-server";

pub fn maybe_handle_runtime_manager_cli() -> Option<i32> {
    #[cfg(target_os = "windows")]
    {
        return windows::maybe_handle_runtime_manager_cli();
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

#[cfg(target_os = "windows")]
fn normalize_mode(mode: &str) -> &'static str {
    if mode.eq_ignore_ascii_case("dev") {
        "dev"
    } else {
        "prod"
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::{normalize_mode, RUNTIME_MANAGER_DISPATCH_FLAG, RUNTIME_MANAGER_SERVER_FLAG};
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use rand::RngCore;
    use serde::{Deserialize, Serialize};
    use std::collections::HashSet;
    use std::io::{ErrorKind, Read, Write};
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::time::Duration;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions};

    const MODE_FLAG: &str = "--mode";
    const ARG_SEPARATOR: &str = "--";
    const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

    #[derive(Debug, Serialize, Deserialize)]
    struct RuntimeManagerRequest {
        token: String,
        docker_args: Vec<String>,
        #[serde(default)]
        stdin_b64: Option<String>,
    }

    #[derive(Debug, Serialize, Deserialize)]
    struct RuntimeManagerResponse {
        exit_code: i32,
        stdout_b64: String,
        stderr_b64: String,
        #[serde(default)]
        error: Option<String>,
    }

    pub(crate) fn maybe_handle_runtime_manager_cli() -> Option<i32> {
        let mut args = std::env::args().skip(1);
        let flag = args.next()?;
        if flag == RUNTIME_MANAGER_DISPATCH_FLAG {
            return Some(run_dispatch(args.collect()));
        }
        if flag == RUNTIME_MANAGER_SERVER_FLAG {
            return Some(run_server(args.collect()));
        }
        None
    }

    fn run_dispatch(raw_args: Vec<String>) -> i32 {
        let (mode, docker_args) = match parse_dispatch_args(raw_args) {
            Ok(value) => value,
            Err(err) => {
                eprintln!("[Entropic] runtime-manager dispatch parse failed: {}", err);
                return 2;
            }
        };

        if docker_args.is_empty() {
            eprintln!("[Entropic] runtime-manager dispatch missing docker args");
            return 2;
        }

        let token = match load_or_create_manager_token(&mode) {
            Ok(value) => value,
            Err(err) => {
                eprintln!("[Entropic] runtime-manager token load failed: {}", err);
                return 1;
            }
        };
        let pipe = manager_pipe_name(&mode, &token);
        let needs_stdin = docker_args
            .iter()
            .any(|arg| arg == "-i" || arg == "--interactive");
        let stdin_payload = if needs_stdin {
            let mut bytes = Vec::new();
            if let Err(err) = std::io::stdin().read_to_end(&mut bytes) {
                eprintln!(
                    "[Entropic] runtime-manager dispatch stdin read failed: {}",
                    err
                );
                return 1;
            }
            Some(STANDARD.encode(bytes))
        } else {
            None
        };

        let request = RuntimeManagerRequest {
            token: token.clone(),
            docker_args,
            stdin_b64: stdin_payload,
        };

        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(value) => value,
            Err(err) => {
                eprintln!(
                    "[Entropic] runtime-manager dispatch runtime init failed: {}",
                    err
                );
                return 1;
            }
        };

        let response = rt.block_on(async {
            let mut first_connect_attempt = true;
            let mut last_error = String::new();
            for _ in 0..24 {
                match send_request(&pipe, &request).await {
                    Ok(response) => return Ok(response),
                    Err(err) => {
                        last_error = err.to_string();
                        if first_connect_attempt {
                            first_connect_attempt = false;
                            if err.raw_os_error() != Some(231) {
                                if let Err(spawn_err) = spawn_manager_for_mode(&mode) {
                                    last_error =
                                        format!("{} | spawn failed: {}", last_error, spawn_err);
                                }
                            }
                        }
                        tokio::time::sleep(Duration::from_millis(150)).await;
                    }
                }
            }
            Err(last_error)
        });

        let response = match response {
            Ok(value) => value,
            Err(err) => {
                eprintln!("[Entropic] runtime-manager dispatch failed: {}", err);
                return 1;
            }
        };

        if let Some(error) = response.error.as_deref() {
            eprintln!("[Entropic] runtime-manager error: {}", error);
        }
        if let Ok(stdout) = STANDARD.decode(response.stdout_b64.as_bytes()) {
            let _ = std::io::stdout().write_all(&stdout);
        }
        if let Ok(stderr) = STANDARD.decode(response.stderr_b64.as_bytes()) {
            let _ = std::io::stderr().write_all(&stderr);
        }
        response.exit_code
    }

    fn run_server(raw_args: Vec<String>) -> i32 {
        let mode = match parse_server_mode(raw_args) {
            Ok(value) => value,
            Err(err) => {
                eprintln!("[Entropic] runtime-manager server parse failed: {}", err);
                return 2;
            }
        };

        let token = match load_or_create_manager_token(&mode) {
            Ok(value) => value,
            Err(err) => {
                eprintln!("[Entropic] runtime-manager token load failed: {}", err);
                return 1;
            }
        };
        let pipe = manager_pipe_name(&mode, &token);
        let distro = mode_to_distro(&mode);

        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(value) => value,
            Err(err) => {
                eprintln!(
                    "[Entropic] runtime-manager server runtime init failed: {}",
                    err
                );
                return 1;
            }
        };

        match rt.block_on(async { serve(pipe, token, distro).await }) {
            Ok(()) => 0,
            Err(err) => {
                eprintln!("[Entropic] runtime-manager server failed: {}", err);
                1
            }
        }
    }

    fn parse_dispatch_args(raw_args: Vec<String>) -> Result<(String, Vec<String>), String> {
        let mut mode = if cfg!(debug_assertions) {
            "dev".to_string()
        } else {
            "prod".to_string()
        };
        let mut docker_args = Vec::new();

        let mut i = 0usize;
        while i < raw_args.len() {
            let value = &raw_args[i];
            if value == MODE_FLAG {
                i += 1;
                let Some(next) = raw_args.get(i) else {
                    return Err("missing mode value".to_string());
                };
                mode = normalize_mode(next).to_string();
            } else if value == ARG_SEPARATOR {
                docker_args.extend(raw_args.into_iter().skip(i + 1));
                break;
            } else {
                docker_args.push(value.clone());
            }
            i += 1;
        }

        Ok((mode, docker_args))
    }

    fn parse_server_mode(raw_args: Vec<String>) -> Result<String, String> {
        let mut mode = None::<String>;
        let mut i = 0usize;
        while i < raw_args.len() {
            let value = &raw_args[i];
            if value == MODE_FLAG {
                i += 1;
                let Some(next) = raw_args.get(i) else {
                    return Err("missing mode value".to_string());
                };
                mode = Some(normalize_mode(next).to_string());
            }
            i += 1;
        }

        Ok(mode.unwrap_or_else(|| {
            if cfg!(debug_assertions) {
                "dev".to_string()
            } else {
                "prod".to_string()
            }
        }))
    }

    fn runtime_root_dir() -> PathBuf {
        let base = std::env::var("LOCALAPPDATA")
            .ok()
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        base.join("Entropic").join("runtime").join("manager")
    }

    fn append_runtime_manager_audit_line(message: &str) {
        let log_path = runtime_root_dir().join("manager-audit.log");
        if let Some(parent) = log_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
        {
            let _ = writeln!(file, "[{}] {}", timestamp, message);
        }
    }

    fn redact_sensitive_arg(arg: &str) -> String {
        let lowered = arg.to_ascii_lowercase();
        if let Some((key, _)) = arg.split_once('=') {
            let key_lc = key.to_ascii_lowercase();
            if key_lc.contains("token")
                || key_lc.contains("password")
                || key_lc.contains("secret")
                || key_lc.contains("api_key")
                || key_lc.contains("apikey")
            {
                return format!("{}=<redacted>", key);
            }
        }
        if lowered.contains("token=")
            || lowered.contains("password=")
            || lowered.contains("secret=")
            || lowered.contains("api_key=")
            || lowered.contains("apikey=")
        {
            return "<redacted-arg>".to_string();
        }
        arg.to_string()
    }

    fn redacted_docker_args(args: &[String]) -> Vec<String> {
        let mut out = Vec::with_capacity(args.len());
        let mut redact_next_value = false;
        for arg in args {
            if redact_next_value {
                out.push("<redacted>".to_string());
                redact_next_value = false;
                continue;
            }

            let lowered = arg.to_ascii_lowercase();
            if matches!(
                lowered.as_str(),
                "--password"
                    | "--passwd"
                    | "--token"
                    | "--api-key"
                    | "--apikey"
                    | "--secret"
                    | "-p"
            ) {
                out.push(arg.clone());
                redact_next_value = true;
                continue;
            }

            out.push(redact_sensitive_arg(arg));
        }
        out
    }

    fn audit_wsl_docker_invocation(distro: &str, docker_args: &[String]) {
        let redacted = redacted_docker_args(docker_args);
        let rendered = redacted.join(" ");
        append_runtime_manager_audit_line(&format!(
            "allowlisted invoke: wsl.exe --distribution {} --user root --exec env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock docker {}",
            distro, rendered
        ));
    }

    fn manager_token_path(mode: &str) -> PathBuf {
        runtime_root_dir().join(format!("{}.token", normalize_mode(mode)))
    }

    fn load_or_create_manager_token(mode: &str) -> Result<String, String> {
        let path = manager_token_path(mode);
        if let Ok(existing) = std::fs::read_to_string(&path) {
            let trimmed = existing.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
        }

        let parent = path
            .parent()
            .ok_or_else(|| "invalid token path".to_string())?;
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create runtime manager dir: {}", e))?;

        let mut raw = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut raw);
        let token = STANDARD.encode(raw).replace(['/', '+', '='], "");
        std::fs::write(&path, &token)
            .map_err(|e| format!("failed to write runtime manager token: {}", e))?;
        Ok(token)
    }

    fn manager_pipe_name(mode: &str, token: &str) -> String {
        let prefix: String = token.chars().take(12).collect();
        format!(
            r"\\.\pipe\entropic-runtime-manager-{}-{}",
            normalize_mode(mode),
            prefix
        )
    }

    fn mode_to_distro(mode: &str) -> &'static str {
        if normalize_mode(mode) == "dev" {
            "entropic-dev"
        } else {
            "entropic-prod"
        }
    }

    fn spawn_manager_for_mode(mode: &str) -> Result<(), String> {
        let exe =
            std::env::current_exe().map_err(|e| format!("failed to locate current exe: {}", e))?;
        let mut cmd = Command::new(exe);
        cmd.arg(RUNTIME_MANAGER_SERVER_FLAG);
        cmd.arg(MODE_FLAG);
        cmd.arg(normalize_mode(mode));
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());

        #[allow(unused_mut)]
        let mut cmd = cmd;
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            const DETACHED_PROCESS: u32 = 0x0000_0008;
            cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
        }

        cmd.spawn()
            .map_err(|e| format!("failed to spawn runtime manager: {}", e))?;
        Ok(())
    }

    async fn serve(pipe: String, token: String, distro: &'static str) -> Result<(), String> {
        let mut server = create_server(&pipe, true).map_err(|e| e.to_string())?;
        loop {
            server.connect().await.map_err(|e| e.to_string())?;
            let connection = server;
            server = create_server(&pipe, false).map_err(|e| e.to_string())?;
            let token_for_task = token.clone();
            let distro_for_task = distro.to_string();
            tokio::spawn(async move {
                let _ = handle_client(connection, token_for_task, distro_for_task).await;
            });
        }
    }

    fn create_server(pipe: &str, first_instance: bool) -> std::io::Result<NamedPipeServer> {
        let mut options = ServerOptions::new();
        if first_instance {
            options.first_pipe_instance(true);
        }
        options.create(pipe)
    }

    async fn send_request(
        pipe: &str,
        request: &RuntimeManagerRequest,
    ) -> std::io::Result<RuntimeManagerResponse> {
        let mut connect_attempts = 0usize;

        loop {
            match ClientOptions::new().open(pipe) {
                Ok(mut client) => {
                    write_frame_json(&mut client, request).await?;
                    return read_frame_json(&mut client).await;
                }
                Err(err)
                    if err.raw_os_error() == Some(231)
                        || err.kind() == ErrorKind::NotFound
                        || err.kind() == ErrorKind::ConnectionRefused =>
                {
                    connect_attempts += 1;
                    if connect_attempts >= 40 {
                        return Err(err);
                    }
                    tokio::time::sleep(Duration::from_millis(75)).await;
                }
                Err(err) => return Err(err),
            }
        }
    }

    async fn handle_client(
        mut connection: NamedPipeServer,
        token: String,
        distro: String,
    ) -> Result<(), String> {
        let request: RuntimeManagerRequest = read_frame_json(&mut connection)
            .await
            .map_err(|e| format!("failed to read request frame: {}", e))?;

        let response = if request.token != token {
            RuntimeManagerResponse {
                exit_code: 1,
                stdout_b64: String::new(),
                stderr_b64: String::new(),
                error: Some("unauthorized runtime-manager request".to_string()),
            }
        } else {
            execute_request(&request, &distro)
        };

        write_frame_json(&mut connection, &response)
            .await
            .map_err(|e| format!("failed to write response frame: {}", e))?;
        let _ = connection.flush().await;
        Ok(())
    }

    fn execute_request(request: &RuntimeManagerRequest, distro: &str) -> RuntimeManagerResponse {
        if !is_allowlisted_docker_args(&request.docker_args) {
            append_runtime_manager_audit_line("blocked docker command by allowlist");
            return RuntimeManagerResponse {
                exit_code: 126,
                stdout_b64: String::new(),
                stderr_b64: String::new(),
                error: Some("docker command blocked by runtime-manager allowlist".to_string()),
            };
        }

        let stdin = request
            .stdin_b64
            .as_deref()
            .and_then(|encoded| STANDARD.decode(encoded.as_bytes()).ok());

        let output = run_wsl_docker_command(distro, &request.docker_args, stdin.as_deref());
        match output {
            Ok(out) => RuntimeManagerResponse {
                exit_code: out.status.code().unwrap_or(1),
                stdout_b64: STANDARD.encode(out.stdout),
                stderr_b64: STANDARD.encode(out.stderr),
                error: None,
            },
            Err(err) => RuntimeManagerResponse {
                exit_code: 1,
                stdout_b64: String::new(),
                stderr_b64: String::new(),
                error: Some(err),
            },
        }
    }

    fn run_wsl_docker_command(
        distro: &str,
        docker_args: &[String],
        stdin: Option<&[u8]>,
    ) -> Result<std::process::Output, String> {
        audit_wsl_docker_invocation(distro, docker_args);
        let mut cmd = Command::new("wsl.exe");
        cmd.arg("--distribution")
            .arg(distro)
            .arg("--user")
            .arg("root")
            .arg("--exec")
            .arg("env")
            .arg("-u")
            .arg("DOCKER_CONTEXT")
            .arg("DOCKER_HOST=unix:///var/run/docker.sock")
            .arg("docker");
        cmd.args(docker_args);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        if stdin.is_some() {
            cmd.stdin(Stdio::piped());
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn wsl docker command: {}", e))?;
        if let Some(bytes) = stdin {
            if let Some(mut writer) = child.stdin.take() {
                writer
                    .write_all(bytes)
                    .map_err(|e| format!("failed to write command stdin: {}", e))?;
            }
        }

        child
            .wait_with_output()
            .map_err(|e| format!("failed waiting for command: {}", e))
    }

    fn is_allowlisted_docker_args(args: &[String]) -> bool {
        if args.is_empty() {
            return false;
        }
        if args
            .iter()
            .any(|arg| arg.contains('\n') || arg.contains('\r'))
        {
            return false;
        }

        let blocked_flags = ["-H", "--host", "--context"];
        for (idx, arg) in args.iter().enumerate() {
            if blocked_flags.contains(&arg.as_str()) {
                return false;
            }
            if idx > 0
                && (args[idx - 1] == "-H"
                    || args[idx - 1] == "--host"
                    || args[idx - 1] == "--context")
            {
                return false;
            }
        }

        let verb = args[0].to_ascii_lowercase();
        let allowed: HashSet<&'static str> = [
            "build", "cp", "exec", "image", "images", "info", "inspect", "load", "logs", "network",
            "ps", "pull", "restart", "rm", "run", "start", "stop", "system", "tag", "version",
            "volume",
        ]
        .into_iter()
        .collect();

        allowed.contains(verb.as_str())
    }

    async fn write_frame_json<W, T>(writer: &mut W, value: &T) -> std::io::Result<()>
    where
        W: AsyncWrite + Unpin,
        T: serde::Serialize,
    {
        let bytes = serde_json::to_vec(value)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
        if bytes.len() > MAX_FRAME_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "frame too large",
            ));
        }
        writer.write_u32_le(bytes.len() as u32).await?;
        writer.write_all(&bytes).await?;
        writer.flush().await?;
        Ok(())
    }

    async fn read_frame_json<R, T>(reader: &mut R) -> std::io::Result<T>
    where
        R: AsyncRead + Unpin,
        T: serde::de::DeserializeOwned,
    {
        let frame_len = reader.read_u32_le().await? as usize;
        if frame_len == 0 || frame_len > MAX_FRAME_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid frame size",
            ));
        }
        let mut bytes = vec![0u8; frame_len];
        reader.read_exact(&mut bytes).await?;
        serde_json::from_slice(&bytes)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))
    }
}
