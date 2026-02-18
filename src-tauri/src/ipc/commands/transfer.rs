use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::ipc::{
    AppState,
    SessionTransferState,
    TabTransferEntry,
    TabTransferManifest,
    TabTransferStatus,
};

#[derive(serde::Serialize)]
pub struct WindowBounds {
    pub label: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[tauri::command]
pub fn list_rain_windows(app: AppHandle) -> Result<Vec<WindowBounds>, String> {
    let windows = app.webview_windows();
    let mut result = Vec::new();
    for (label, window) in &windows {
        if label.starts_with("ghost-") {
            continue;
        }
        if let (Ok(pos), Ok(size), Ok(scale_factor)) = (
            window.inner_position(),
            window.inner_size(),
            window.scale_factor(),
        ) {
            let scale = if scale_factor > 0.0 { scale_factor } else { 1.0 };
            result.push(WindowBounds {
                label: label.clone(),
                x: pos.x as f64 / scale,
                y: pos.y as f64 / scale,
                width: size.width as f64 / scale,
                height: size.height as f64 / scale,
            });
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn emit_cross_window(
    app: AppHandle,
    target_label: String,
    event_name: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    app.emit_to(&target_label, &event_name, payload)
        .map_err(|e| format!("Failed to emit to window '{}': {}", target_label, e))
}

#[tauri::command]
pub fn stage_session_transfer_state(
    state: State<'_, AppState>,
    session_id: String,
    transfer_state: SessionTransferState,
) -> Result<(), String> {
    state
        .session_transfer_state
        .lock()
        .insert(session_id, transfer_state);
    Ok(())
}

#[tauri::command]
pub fn take_session_transfer_state(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<SessionTransferState>, String> {
    Ok(state.session_transfer_state.lock().remove(&session_id))
}

const TAB_TRANSFER_TTL_MS: u64 = 45_000;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn cleanup_expired_transfers(entries: &mut std::collections::HashMap<String, TabTransferEntry>) {
    let now = now_ms();
    entries.retain(|_, entry| {
        if entry.expires_at_ms <= now {
            return false;
        }
        entry.status != TabTransferStatus::Committed
    });
}

#[derive(serde::Serialize, Clone)]
pub struct TabTransferPrepareResult {
    pub ok: bool,
    pub reason: Option<String>,
    pub ready_token: Option<String>,
    pub expires_at_ms: Option<u64>,
    pub session_ids: Vec<String>,
}

#[derive(serde::Serialize, Clone)]
pub struct TabTransferCommitResult {
    pub ok: bool,
    pub reason: Option<String>,
    pub manifest: Option<TabTransferManifest>,
}

#[tauri::command]
pub fn stage_tab_transfer_manifest(
    state: State<'_, AppState>,
    transfer_id: String,
    manifest: TabTransferManifest,
) -> Result<(), String> {
    if manifest.pane_sessions.is_empty() {
        return Err("Manifest must contain at least one pane session".to_string());
    }
    let now = now_ms();
    let mut manifests = state.tab_transfer_manifests.lock();
    cleanup_expired_transfers(&mut manifests);
    manifests.insert(
        transfer_id,
        TabTransferEntry {
            manifest,
            status: TabTransferStatus::Staged,
            created_at_ms: now,
            expires_at_ms: now + TAB_TRANSFER_TTL_MS,
            prepared_for: None,
            ready_token: None,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn take_tab_transfer_manifest(
    state: State<'_, AppState>,
    transfer_id: String,
) -> Result<Option<TabTransferManifest>, String> {
    let mut manifests = state.tab_transfer_manifests.lock();
    cleanup_expired_transfers(&mut manifests);
    Ok(manifests.remove(&transfer_id).map(|entry| entry.manifest))
}

#[tauri::command]
pub fn prepare_tab_transfer_adopt(
    state: State<'_, AppState>,
    transfer_id: String,
    target_label: String,
) -> Result<TabTransferPrepareResult, String> {
    let mut manifests = state.tab_transfer_manifests.lock();
    cleanup_expired_transfers(&mut manifests);
    let Some(entry) = manifests.get_mut(&transfer_id) else {
        return Ok(TabTransferPrepareResult {
            ok: false,
            reason: Some("expired_transfer".to_string()),
            ready_token: None,
            expires_at_ms: None,
            session_ids: Vec::new(),
        });
    };

    if entry.manifest.pane_sessions.is_empty() {
        return Ok(TabTransferPrepareResult {
            ok: false,
            reason: Some("invalid_manifest".to_string()),
            ready_token: None,
            expires_at_ms: Some(entry.expires_at_ms),
            session_ids: Vec::new(),
        });
    }
    let session_ids = entry
        .manifest
        .pane_sessions
        .iter()
        .map(|pane| pane.session_id.clone())
        .collect::<Vec<_>>();

    match entry.status {
        TabTransferStatus::Committed => Ok(TabTransferPrepareResult {
            ok: false,
            reason: Some("expired_transfer".to_string()),
            ready_token: None,
            expires_at_ms: Some(entry.expires_at_ms),
            session_ids,
        }),
        TabTransferStatus::Prepared => {
            if entry.prepared_for.as_deref() == Some(target_label.as_str()) {
                Ok(TabTransferPrepareResult {
                    ok: true,
                    reason: None,
                    ready_token: entry.ready_token.clone(),
                    expires_at_ms: Some(entry.expires_at_ms),
                    session_ids,
                })
            } else {
                Ok(TabTransferPrepareResult {
                    ok: false,
                    reason: Some("invalid_manifest".to_string()),
                    ready_token: None,
                    expires_at_ms: Some(entry.expires_at_ms),
                    session_ids,
                })
            }
        }
        TabTransferStatus::Staged => {
            let token = Uuid::new_v4().to_string();
            entry.status = TabTransferStatus::Prepared;
            entry.prepared_for = Some(target_label);
            entry.ready_token = Some(token.clone());
            Ok(TabTransferPrepareResult {
                ok: true,
                reason: None,
                ready_token: Some(token),
                expires_at_ms: Some(entry.expires_at_ms),
                session_ids,
            })
        }
    }
}

#[tauri::command]
pub fn release_tab_transfer_adopt(
    state: State<'_, AppState>,
    transfer_id: String,
    target_label: String,
    ready_token: String,
) -> Result<(), String> {
    let mut manifests = state.tab_transfer_manifests.lock();
    cleanup_expired_transfers(&mut manifests);
    if let Some(entry) = manifests.get_mut(&transfer_id) {
        if entry.status == TabTransferStatus::Prepared
            && entry.prepared_for.as_deref() == Some(target_label.as_str())
            && entry.ready_token.as_deref() == Some(ready_token.as_str())
        {
            entry.status = TabTransferStatus::Staged;
            entry.prepared_for = None;
            entry.ready_token = None;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn commit_tab_transfer_adopt(
    state: State<'_, AppState>,
    transfer_id: String,
    target_label: String,
    ready_token: String,
) -> Result<TabTransferCommitResult, String> {
    let mut manifests = state.tab_transfer_manifests.lock();
    cleanup_expired_transfers(&mut manifests);
    let Some(entry) = manifests.get(&transfer_id) else {
        return Ok(TabTransferCommitResult {
            ok: false,
            reason: Some("expired_transfer".to_string()),
            manifest: None,
        });
    };

    if entry.status != TabTransferStatus::Prepared {
        return Ok(TabTransferCommitResult {
            ok: false,
            reason: Some("not_prepared".to_string()),
            manifest: None,
        });
    }

    if entry.prepared_for.as_deref() != Some(target_label.as_str())
        || entry.ready_token.as_deref() != Some(ready_token.as_str())
    {
        return Ok(TabTransferCommitResult {
            ok: false,
            reason: Some("invalid_manifest".to_string()),
            manifest: None,
        });
    }

    let mut entry = manifests
        .remove(&transfer_id)
        .ok_or_else(|| "Transfer disappeared before commit".to_string())?;
    entry.status = TabTransferStatus::Committed;
    Ok(TabTransferCommitResult {
        ok: true,
        reason: None,
        manifest: Some(entry.manifest),
    })
}
