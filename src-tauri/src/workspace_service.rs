use std::path::{Component, Path};

#[derive(Debug, Clone, serde::Serialize)]
pub struct WorkspaceFileEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub size: u64,
    pub modified_at: u64,
}

pub trait WorkspaceRunner {
    fn exec_output(&self, args: &[&str]) -> Result<String, String>;
    fn write_file(&self, path: &str, bytes: &[u8]) -> Result<(), String>;
}

pub struct WorkspaceService<R> {
    runner: R,
    container: &'static str,
    root: &'static str,
}

const FIELD_SEPARATOR: char = '\u{1f}';
const RECORD_SEPARATOR: char = '\u{1e}';

impl<R: WorkspaceRunner> WorkspaceService<R> {
    pub fn new(runner: R, container: &'static str, root: &'static str) -> Self {
        Self {
            runner,
            container,
            root,
        }
    }

    pub fn list_files(&self, path: &str) -> Result<Vec<WorkspaceFileEntry>, String> {
        let sanitized = sanitize_workspace_path(path)?;
        let full_path = self.full_path(&sanitized);
        self.ensure_directory(&full_path)?;
        let format_arg = format!(
            "%f{field}%y{field}%s{field}%T@{record}",
            field = FIELD_SEPARATOR,
            record = RECORD_SEPARATOR
        );
        let output = self.runner.exec_output(&[
            "exec",
            self.container,
            "find",
            &full_path,
            "-mindepth",
            "1",
            "-maxdepth",
            "1",
            "-printf",
            &format_arg,
        ])?;
        Ok(parse_listing_output(&sanitized, &output))
    }

    pub fn create_directory(
        &self,
        parent_path: &str,
        name: &str,
    ) -> Result<WorkspaceFileEntry, String> {
        let sanitized_parent = sanitize_workspace_path(parent_path)?;
        let sanitized_name = sanitize_directory_name(name)?;
        let relative_path = if sanitized_parent.is_empty() {
            sanitized_name.clone()
        } else {
            format!("{}/{}", sanitized_parent, sanitized_name)
        };
        let full_path = self.full_path(&relative_path);
        self.runner
            .exec_output(&["exec", self.container, "mkdir", "-p", "--", &full_path])?;
        Ok(WorkspaceFileEntry {
            name: sanitized_name,
            path: relative_path,
            is_directory: true,
            size: 0,
            modified_at: 0,
        })
    }

    pub fn read_text_file(&self, path: &str) -> Result<String, String> {
        let sanitized = sanitize_workspace_path(path)?;
        if sanitized.is_empty() {
            return Err("Invalid path".to_string());
        }
        let full_path = self.full_path(&sanitized);
        self.runner
            .exec_output(&["exec", self.container, "cat", "--", &full_path])
            .map_err(|_| "File not found or unreadable".to_string())
    }

    pub fn read_file_base64(&self, path: &str) -> Result<String, String> {
        let sanitized = sanitize_workspace_path(path)?;
        if sanitized.is_empty() {
            return Err("Invalid path".to_string());
        }
        let full_path = self.full_path(&sanitized);
        let raw = self
            .runner
            .exec_output(&["exec", self.container, "base64", "--", &full_path])
            .map_err(|_| "File not found or unreadable".to_string())?;
        Ok(raw.chars().filter(|c| *c != '\n' && *c != '\r').collect())
    }

    pub fn delete_file(&self, path: &str) -> Result<(), String> {
        let sanitized = sanitize_workspace_path(path)?;
        if sanitized.is_empty() {
            return Err("Cannot delete workspace root".to_string());
        }
        let full_path = self.full_path(&sanitized);
        self.runner
            .exec_output(&["exec", self.container, "rm", "-rf", "--", &full_path])?;
        Ok(())
    }

    pub fn upload_file(
        &self,
        file_name: &str,
        bytes: &[u8],
        dest_path: &str,
    ) -> Result<(), String> {
        let sanitized_name = sanitize_filename(file_name);
        let sanitized_dest = sanitize_workspace_path(dest_path)?;
        let dir = if sanitized_dest.is_empty() {
            self.root.to_string()
        } else {
            self.full_path(&sanitized_dest)
        };
        let full_path = format!("{}/{}", dir, sanitized_name);
        self.ensure_directory(&dir)?;
        self.runner.write_file(&full_path, bytes)
    }

    fn ensure_directory(&self, full_path: &str) -> Result<(), String> {
        self.runner
            .exec_output(&["exec", self.container, "mkdir", "-p", "--", full_path])?;
        Ok(())
    }

    fn full_path(&self, relative_path: &str) -> String {
        if relative_path.is_empty() {
            self.root.to_string()
        } else {
            format!("{}/{}", self.root.trim_end_matches('/'), relative_path)
        }
    }
}

pub fn sanitize_filename(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return "file".to_string();
    }
    let mut out = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
            out.push(ch);
        } else if ch.is_whitespace() {
            out.push('_');
        }
    }
    if out.is_empty() {
        "file".to_string()
    } else {
        out
    }
}

pub fn sanitize_directory_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Folder name is required".to_string());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("Invalid folder name".to_string());
    }
    if trimmed.chars().any(char::is_control) {
        return Err("Folder name contains invalid characters".to_string());
    }

    let mut out = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' || ch == ' ' {
            out.push(ch);
        }
    }

    let normalized = out.trim();
    if normalized.is_empty() {
        return Err("Folder name contains no valid characters".to_string());
    }

    Ok(normalized.to_string())
}

pub fn sanitize_workspace_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }

    let mut parts = Vec::new();
    for component in Path::new(trimmed).components() {
        match component {
            Component::Normal(os) => {
                let part = os.to_string_lossy();
                if part.is_empty() {
                    continue;
                }
                if part.chars().any(char::is_control) {
                    return Err("Invalid path".to_string());
                }
                parts.push(part.to_string());
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("Invalid path".to_string());
            }
        }
    }

    Ok(parts.join("/"))
}

fn parse_listing_output(parent_path: &str, raw: &str) -> Vec<WorkspaceFileEntry> {
    raw.split(RECORD_SEPARATOR)
        .filter_map(|record| {
            let trimmed = record.trim_end_matches('\n');
            if trimmed.is_empty() {
                return None;
            }

            let mut fields = trimmed.split(FIELD_SEPARATOR);
            let name = fields.next()?.to_string();
            if name.is_empty() {
                return None;
            }
            let kind = fields.next().unwrap_or("-");
            let size = fields
                .next()
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(0);
            let modified_at = fields
                .next()
                .and_then(|value| value.parse::<f64>().ok())
                .map(|value| value.floor() as u64)
                .unwrap_or(0);
            let path = if parent_path.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", parent_path, name)
            };

            Some(WorkspaceFileEntry {
                name,
                path,
                is_directory: kind == "d",
                size,
                modified_at,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeRunner {
        outputs: Mutex<VecDeque<Result<String, String>>>,
        commands: Mutex<Vec<Vec<String>>>,
        writes: Mutex<Vec<(String, Vec<u8>)>>,
    }

    impl FakeRunner {
        fn with_outputs(outputs: Vec<Result<String, String>>) -> Self {
            Self {
                outputs: Mutex::new(outputs.into()),
                commands: Mutex::new(Vec::new()),
                writes: Mutex::new(Vec::new()),
            }
        }
    }

    impl WorkspaceRunner for FakeRunner {
        fn exec_output(&self, args: &[&str]) -> Result<String, String> {
            self.commands.lock().unwrap().push(
                args.iter()
                    .map(|value| value.to_string())
                    .collect::<Vec<String>>(),
            );
            self.outputs
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Ok(String::new()))
        }

        fn write_file(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
            self.writes
                .lock()
                .unwrap()
                .push((path.to_string(), bytes.to_vec()));
            Ok(())
        }
    }

    #[test]
    fn sanitize_workspace_path_normalizes_current_dir() {
        let sanitized = sanitize_workspace_path("./notes/./daily").unwrap();
        assert_eq!(sanitized, "notes/daily");
    }

    #[test]
    fn sanitize_workspace_path_rejects_parent_dirs() {
        assert!(sanitize_workspace_path("../secrets").is_err());
        assert!(sanitize_workspace_path("notes/../../secrets").is_err());
    }

    #[test]
    fn sanitize_directory_name_rejects_control_chars() {
        assert!(sanitize_directory_name("bad\tname").is_err());
    }

    #[test]
    fn sanitize_filename_replaces_whitespace_and_drops_symbols() {
        assert_eq!(sanitize_filename(" daily notes?.md "), "daily_notes.md");
    }

    #[test]
    fn list_files_parses_find_output() {
        let runner = FakeRunner::with_outputs(vec![
            Ok(String::new()),
            Ok(format!(
                "alpha.txt{field}f{field}12{field}1712345678.4{record}notes{field}d{field}0{field}1712345000.0{record}",
                field = FIELD_SEPARATOR,
                record = RECORD_SEPARATOR
            )),
        ]);
        let service = WorkspaceService::new(runner, "openclaw", "/data/workspace");

        let entries = service.list_files("journal").unwrap();

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "journal/alpha.txt");
        assert!(!entries[0].is_directory);
        assert_eq!(entries[0].size, 12);
        assert_eq!(entries[0].modified_at, 1712345678);
        assert_eq!(entries[1].path, "journal/notes");
        assert!(entries[1].is_directory);
    }

    #[test]
    fn upload_file_writes_bytes_under_workspace_root() {
        let runner = FakeRunner::with_outputs(vec![Ok(String::new())]);
        let service = WorkspaceService::new(runner, "openclaw", "/data/workspace");

        service
            .upload_file("draft 1.md", b"hello", "notes")
            .unwrap();

        let writes = service.runner.writes.lock().unwrap();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].0, "/data/workspace/notes/draft_1.md");
        assert_eq!(writes[0].1, b"hello");
    }
}
