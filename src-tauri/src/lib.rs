mod config;
mod ipc;
mod pty;
mod render;
mod shell;
mod terminal;

use ipc::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "rain=info".into()),
        )
        .init();

    tracing::info!("Starting Rain terminal");

    tauri::Builder::default()
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            ipc::commands::create_session,
            ipc::commands::write_input,
            ipc::commands::resize_terminal,
            ipc::commands::destroy_session,
            ipc::commands::get_block_output,
            ipc::commands::request_full_redraw,
            ipc::commands::set_window_vibrancy,
            ipc::commands::set_background_blur,
            ipc::commands::set_window_opacity,
        ])
        .setup(|_app| {
            // Don't apply vibrancy by default. The frontend will request it
            // based on user config (backgroundBlur > 0 && windowOpacity < 1.0).
            tracing::info!("Rain setup complete. Waiting for frontend to create session.");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Failed to run Rain");
}
