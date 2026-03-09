use super::*;

#[tauri::command]
pub async fn list_workspace_files(path: String) -> Result<Vec<WorkspaceFileEntry>, String> {
    workspace_service().list_files(&path)
}

#[tauri::command]
pub async fn create_workspace_directory(
    parent_path: String,
    name: String,
) -> Result<WorkspaceFileEntry, String> {
    workspace_service().create_directory(&parent_path, &name)
}

#[tauri::command]
pub async fn read_workspace_file(path: String) -> Result<String, String> {
    workspace_service().read_text_file(&path)
}

#[tauri::command]
pub async fn read_workspace_file_base64(path: String) -> Result<String, String> {
    workspace_service().read_file_base64(&path)
}

#[tauri::command]
pub async fn delete_workspace_file(path: String) -> Result<(), String> {
    workspace_service().delete_file(&path)
}

#[tauri::command]
pub async fn upload_workspace_file(
    file_name: String,
    base64: String,
    dest_path: String,
) -> Result<(), String> {
    let decoded = decode_base64_payload(&base64)?;
    workspace_service().upload_file(&file_name, &decoded, &dest_path)
}
