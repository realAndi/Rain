use std::path::PathBuf;

use tauri::{AppHandle, Manager};

/// Session restore: save workspace state to disk.
#[tauri::command]
pub fn save_workspace(app: AppHandle, workspace: String) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("App data dir error: {}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir error: {}", e))?;
    let path = dir.join("workspace.json");
    std::fs::write(&path, workspace).map_err(|e| format!("write error: {}", e))?;
    tracing::info!("Workspace saved to {:?}", path);
    Ok(())
}

/// Session restore: load workspace state from disk.
#[tauri::command]
pub fn load_workspace(app: AppHandle) -> Result<Option<String>, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("App data dir error: {}", e))?;
    let path = dir.join("workspace.json");
    if !path.exists() {
        return Ok(None);
    }
    let data = std::fs::read_to_string(&path).map_err(|e| format!("read error: {}", e))?;
    tracing::info!("Workspace loaded from {:?}", path);
    Ok(Some(data))
}

fn config_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("App config dir error: {}", e))?;
    Ok(dir.join("config.json"))
}

/// Read the user config file from the app config directory.
#[tauri::command]
pub fn read_config_file(app: AppHandle) -> Result<Option<String>, String> {
    let path = config_file_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(&path).map(Some).map_err(|e| format!("Failed to read config: {}", e))
}

/// Write the user config file to the app config directory.
#[tauri::command]
pub fn write_config_file(app: AppHandle, contents: String) -> Result<(), String> {
    let path = config_file_path(&app)?;
    let dir = path
        .parent()
        .ok_or("Config directory parent not found".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
    std::fs::write(&path, contents).map_err(|e| format!("Failed to write config: {}", e))?;
    tracing::info!("Config written to {:?}", path);
    Ok(())
}

/// Save text content to a file chosen by the user.
#[tauri::command]
pub fn save_text_to_file(_app: AppHandle, content: String, default_name: String) -> Result<bool, String> {
    let selected = rfd::FileDialog::new()
        .set_file_name(&default_name)
        .save_file();
    let Some(path) = selected else {
        return Ok(false);
    };
    std::fs::write(&path, content).map_err(|e| format!("Write error: {}", e))?;
    tracing::info!("Saved text to {:?}", path);
    Ok(true)
}

/// Get the current app version.
#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
