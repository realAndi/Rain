mod ipc;
mod pty;
mod render;
mod shell;
mod terminal;
mod tmux;

use ipc::AppState;
use tauri::Manager;

/// Apply macOS-specific transparent window configuration.
/// Called for both the main window at startup and dynamically created child windows.
#[cfg(target_os = "macos")]
pub fn configure_macos_window(window: &tauri::WebviewWindow) {
    if let Err(err) = window.with_webview(|webview| unsafe {
        let wk: *mut objc2::runtime::AnyObject = webview.inner().cast();
        if !wk.is_null() {
            let no = objc2_foundation::NSNumber::new_bool(false);
            let key = objc2_foundation::NSString::from_str("drawsBackground");
            let _: () = objc2::msg_send![&*wk, setValue: &*no, forKey: &*key];
        }
    }) {
        tracing::warn!("Failed to set transparent webview background: {}", err);
    }

    if let Err(err) = window.with_webview(|webview| unsafe {
        use objc2_app_kit::{NSColor, NSWindow};

        let ns_window_ptr: *mut NSWindow = webview.ns_window().cast();
        if !ns_window_ptr.is_null() {
            let ns_window = &*ns_window_ptr;
            // Use near-transparent instead of fully clear so macOS keeps
            // the window corner mask active. clearColor() disables corner
            // masking, causing blur to render as sharp rectangles.
            let bg = NSColor::colorWithSRGBRed_green_blue_alpha(0.0, 0.0, 0.0, 0.001);
            ns_window.setBackgroundColor(Some(&bg));
            ns_window.setOpaque(false);
        }
    }) {
        tracing::warn!("Failed to set transparent NSWindow background: {}", err);
    }

    // Prevent WindowServer from flattening the layer tree during Space swipe
    // transitions. Without this, backdrop-filter and vibrancy views flash
    // during desktop switching.
    if let Err(err) = window.with_webview(|webview| unsafe {
        use objc2_app_kit::NSWindow;

        extern "C" {
            fn CGSMainConnectionID() -> i32;
            fn CGSSetWindowTags(
                cid: i32,
                wid: i32,
                tags: *const i32,
                max_tag_size: i32,
            ) -> i32;
        }

        let ns_window_ptr: *mut NSWindow = webview.ns_window().cast();
        if !ns_window_ptr.is_null() {
            let ns_window = &*ns_window_ptr;
            let wid = ns_window.windowNumber() as i32;
            let cid = CGSMainConnectionID();
            // Bit 23 = kCGSNeverFlattenSurfacesDuringSwipesTagBit
            let tags: [i32; 2] = [0, 1 << 23];
            CGSSetWindowTags(cid, wid, tags.as_ptr(), 0x40);
        }
    }) {
        tracing::warn!("Failed to set CGS window tags: {}", err);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn configure_platform_window(_window: &tauri::WebviewWindow) {
    // No-op on non-macOS platforms.
    // Future: add Windows DWM blur or Linux compositor effects.
}

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
        .plugin(tauri_plugin_liquid_glass::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            ipc::commands::session::create_session,
            ipc::commands::session::write_input,
            ipc::commands::session::resize_terminal,
            ipc::commands::session::destroy_session,
            ipc::commands::session::get_block_output,
            ipc::commands::session::request_full_redraw,
            ipc::commands::window::set_window_blur_radius,
            ipc::commands::window::set_window_opacity,
            ipc::commands::window::set_app_icon,
            ipc::commands::window::get_hostname,
            ipc::commands::window::create_child_window,
            ipc::commands::window::create_drag_ghost,
            ipc::commands::window::close_drag_ghost,
            ipc::commands::tmux::tmux_start,
            ipc::commands::tmux::tmux_send_keys,
            ipc::commands::tmux::tmux_new_window,
            ipc::commands::tmux::tmux_split_pane,
            ipc::commands::tmux::tmux_close_pane,
            ipc::commands::tmux::tmux_resize_pane,
            ipc::commands::tmux::tmux_select_pane,
            ipc::commands::tmux::tmux_detach,
            ipc::commands::tmux::tmux_list_sessions,
            ipc::commands::tmux::tmux_send_command,
            ipc::commands::transfer::list_rain_windows,
            ipc::commands::transfer::emit_cross_window,
            ipc::commands::transfer::stage_session_transfer_state,
            ipc::commands::transfer::take_session_transfer_state,
            ipc::commands::transfer::stage_tab_transfer_manifest,
            ipc::commands::transfer::take_tab_transfer_manifest,
            ipc::commands::transfer::prepare_tab_transfer_adopt,
            ipc::commands::transfer::release_tab_transfer_adopt,
            ipc::commands::transfer::commit_tab_transfer_adopt,
            ipc::commands::config::save_workspace,
            ipc::commands::config::load_workspace,
            ipc::commands::config::read_config_file,
            ipc::commands::config::write_config_file,
            ipc::commands::window::quit_app,
            ipc::commands::window::toggle_window_visibility,
            ipc::commands::window::register_global_hotkey,
            ipc::commands::config::save_text_to_file,
            ipc::commands::config::get_app_version,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    configure_macos_window(&window);
                } else {
                    tracing::warn!("Main window not found during setup; could not set transparent webview background");
                }
            }

            // Don't apply vibrancy by default. The frontend controls this
            // based on user appearance preferences.
            tracing::info!("Rain setup complete. Waiting for frontend to create session.");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Failed to run Rain");
}
