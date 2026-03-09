use super::*;

#[tauri::command]
pub async fn upload_attachment(
    file_name: String,
    mime_type: String,
    base64: String,
    state: State<'_, AppState>,
) -> Result<AttachmentInfo, String> {
    let sanitized = sanitize_filename(&file_name);
    let id = {
        let mut pending = state
            .pending_attachments
            .lock()
            .map_err(|e| e.to_string())?;
        prune_pending_attachments(&mut pending);
        let mut generated = None;
        for _ in 0..16 {
            let candidate = generate_attachment_id();
            if !pending.contains_key(&candidate) {
                generated = Some(candidate);
                break;
            }
        }
        generated.ok_or_else(|| "Failed to allocate attachment id".to_string())?
    };
    let temp_path = format!("{}/{}_{}", ATTACHMENT_TMP_ROOT, id, sanitized);
    let size_estimate = (base64.len() as u64 * 3) / 4;
    if size_estimate > 25 * 1024 * 1024 {
        return Err("Attachment too large (max 25MB)".to_string());
    }
    docker_exec_output(&[
        "exec",
        OPENCLAW_CONTAINER,
        "mkdir",
        "-p",
        "--",
        ATTACHMENT_TMP_ROOT,
    ])?;
    let decoded = decode_base64_payload(&base64)?;
    let size_bytes = decoded.len() as u64;
    if size_bytes > 25 * 1024 * 1024 {
        return Err("Attachment too large (max 25MB)".to_string());
    }
    let mut child = docker_command()
        .args(["exec", "-i", OPENCLAW_CONTAINER, "tee", "--", &temp_path])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to upload file: {}", e))?;
    if let Some(stdin) = child.stdin.as_mut() {
        use std::io::Write;
        stdin
            .write_all(&decoded)
            .map_err(|e| format!("Failed to upload file: {}", e))?;
    }
    let status = child
        .wait()
        .map_err(|e| format!("Failed to finalize upload: {}", e))?;
    if !status.success() {
        return Err("Failed to upload file in container".to_string());
    }
    {
        let mut pending = state
            .pending_attachments
            .lock()
            .map_err(|e| e.to_string())?;
        prune_pending_attachments(&mut pending);
        if pending.contains_key(&id) {
            let _ = docker_exec_output(&["exec", OPENCLAW_CONTAINER, "rm", "-f", "--", &temp_path]);
            return Err("Failed to store attachment metadata; retry upload".to_string());
        }
        pending.insert(
            id.clone(),
            PendingAttachmentRecord {
                file_name: sanitized.clone(),
                temp_path: temp_path.clone(),
                created_at_ms: now_ms_u64(),
            },
        );
    }
    let is_image = mime_type.starts_with("image/");
    Ok(AttachmentInfo {
        id,
        file_name: sanitized,
        mime_type,
        size_bytes,
        is_image,
    })
}

#[tauri::command]
pub async fn save_attachment(
    attachment_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let attachment_id = normalize_attachment_id(&attachment_id)?;
    let pending = {
        let mut attachments = state
            .pending_attachments
            .lock()
            .map_err(|e| e.to_string())?;
        prune_pending_attachments(&mut attachments);
        attachments
            .get(&attachment_id)
            .cloned()
            .ok_or_else(|| "Attachment not found or expired".to_string())?
    };
    validate_attachment_temp_path(&attachment_id, &pending.temp_path)?;

    let file_name = sanitize_filename(&pending.file_name);
    let mut dest_path = format!("{}/{}", ATTACHMENT_SAVE_ROOT, file_name);
    docker_exec_output(&[
        "exec",
        OPENCLAW_CONTAINER,
        "mkdir",
        "-p",
        "--",
        ATTACHMENT_SAVE_ROOT,
    ])?;
    // Avoid overwrite: add suffix if exists
    if docker_exec_output(&["exec", OPENCLAW_CONTAINER, "test", "-e", &dest_path]).is_ok() {
        let ts = unique_id();
        dest_path = format!("{}/{}_{}", ATTACHMENT_SAVE_ROOT, ts, file_name);
    }
    docker_exec_output(&[
        "exec",
        OPENCLAW_CONTAINER,
        "mv",
        "--",
        &pending.temp_path,
        &dest_path,
    ])?;
    {
        let mut attachments = state
            .pending_attachments
            .lock()
            .map_err(|e| e.to_string())?;
        attachments.remove(&attachment_id);
    }
    Ok(dest_path)
}

#[tauri::command]
pub async fn delete_attachment(
    attachment_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let attachment_id = normalize_attachment_id(&attachment_id)?;
    let pending = {
        let mut attachments = state
            .pending_attachments
            .lock()
            .map_err(|e| e.to_string())?;
        prune_pending_attachments(&mut attachments);
        attachments
            .get(&attachment_id)
            .cloned()
            .ok_or_else(|| "Attachment not found or expired".to_string())?
    };
    validate_attachment_temp_path(&attachment_id, &pending.temp_path)?;
    docker_exec_output(&[
        "exec",
        OPENCLAW_CONTAINER,
        "rm",
        "-f",
        "--",
        &pending.temp_path,
    ])?;
    {
        let mut attachments = state
            .pending_attachments
            .lock()
            .map_err(|e| e.to_string())?;
        attachments.remove(&attachment_id);
    }
    Ok(())
}
