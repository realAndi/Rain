use tauri::{AppHandle, State};

use crate::ipc::AppState;

/// Start a tmux control mode session.
#[tauri::command]
pub fn tmux_start(
    app: AppHandle,
    state: State<'_, AppState>,
    args: Option<String>,
) -> Result<(), String> {
    let mut ctrl = state.tmux_controller.lock();
    if ctrl.is_some() {
        return Err("tmux session already active".to_string());
    }

    let controller =
        crate::tmux::TmuxController::start(app, args.as_deref().unwrap_or(""))?;
    *ctrl = Some(controller);

    tracing::info!("tmux control mode started");
    Ok(())
}

/// Send input bytes to a tmux pane.
#[tauri::command]
pub fn tmux_send_keys(
    state: State<'_, AppState>,
    pane_id: u32,
    data: Vec<u8>,
) -> Result<(), String> {
    let mut ctrl = state.tmux_controller.lock();
    let controller = ctrl
        .as_mut()
        .ok_or("No tmux session active")?;

    controller.send_keys(pane_id, &data)
}

/// Create a new tmux window.
#[tauri::command]
pub fn tmux_new_window(state: State<'_, AppState>) -> Result<(), String> {
    let mut ctrl = state.tmux_controller.lock();
    let controller = ctrl
        .as_mut()
        .ok_or("No tmux session active")?;

    controller.new_window()
}

/// Split the active tmux pane.
#[tauri::command]
pub fn tmux_split_pane(
    state: State<'_, AppState>,
    direction: String,
    pane_id: Option<u32>,
) -> Result<(), String> {
    let mut ctrl = state.tmux_controller.lock();
    let controller = ctrl
        .as_mut()
        .ok_or("No tmux session active")?;

    let horizontal = direction == "horizontal" || direction == "h";
    controller.split_pane(horizontal, pane_id)
}

/// Close a tmux pane.
#[tauri::command]
pub fn tmux_close_pane(
    state: State<'_, AppState>,
    pane_id: u32,
) -> Result<(), String> {
    let mut ctrl = state.tmux_controller.lock();
    let controller = ctrl
        .as_mut()
        .ok_or("No tmux session active")?;

    controller.close_pane(pane_id)
}

/// Resize a tmux pane.
#[tauri::command]
pub fn tmux_resize_pane(
    state: State<'_, AppState>,
    pane_id: u32,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let mut ctrl = state.tmux_controller.lock();
    let controller = ctrl
        .as_mut()
        .ok_or("No tmux session active")?;

    controller.resize_pane(pane_id, cols, rows)
}

/// Select (focus) a tmux pane.
#[tauri::command]
pub fn tmux_select_pane(
    state: State<'_, AppState>,
    pane_id: u32,
) -> Result<(), String> {
    let mut ctrl = state.tmux_controller.lock();
    let controller = ctrl
        .as_mut()
        .ok_or("No tmux session active")?;

    controller.select_pane(pane_id)
}

/// Detach from the tmux session.
#[tauri::command]
pub fn tmux_detach(state: State<'_, AppState>) -> Result<(), String> {
    let mut ctrl = state.tmux_controller.lock();
    if let Some(ref mut controller) = *ctrl {
        controller.detach()?;
        *ctrl = None;
        tracing::info!("tmux session detached");
        Ok(())
    } else {
        Err("No tmux session active".to_string())
    }
}

/// List available tmux sessions.
#[tauri::command]
pub fn tmux_list_sessions() -> Result<Vec<crate::tmux::controller::TmuxSessionListing>, String> {
    crate::tmux::controller::list_tmux_sessions()
}

/// Send a raw tmux command.
#[tauri::command]
pub fn tmux_send_command(
    state: State<'_, AppState>,
    command: String,
) -> Result<(), String> {
    let mut ctrl = state.tmux_controller.lock();
    let controller = ctrl
        .as_mut()
        .ok_or("No tmux session active")?;

    controller.send_command(&command)
}
