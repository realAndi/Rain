mod config;
mod ipc;
mod pty;
mod render;
mod shell;
mod terminal;

use ipc::AppState;
use tauri::Manager;

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
            ipc::commands::set_window_blur_radius,
            ipc::commands::set_window_opacity,
            ipc::commands::set_app_icon,
            ipc::commands::get_hostname,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(err) = window.with_webview(|webview| unsafe {
                        let wk: *mut objc2::runtime::AnyObject = webview.inner().cast();
                        if !wk.is_null() {
                            let no = objc2_foundation::NSNumber::new_bool(false);
                            let key = objc2_foundation::NSString::from_str("drawsBackground");
                            let _: () = objc2::msg_send![&*wk, setValue: &*no, forKey: &*key];
                        }
                    }) {
                        tracing::warn!("Failed to set transparent webview background at startup: {}", err);
                    }

                    if let Err(err) = window.with_webview(|webview| unsafe {
                        use objc2_app_kit::{NSColor, NSWindow};

                        let ns_window_ptr: *mut NSWindow = webview.ns_window().cast();
                        if !ns_window_ptr.is_null() {
                            let ns_window = &*ns_window_ptr;
                            // Use near-transparent instead of fully clear so macOS keeps
                            // the window corner mask active. clearColor() disables corner
                            // masking, causing blur to render as sharp rectangles.
                            let bg = NSColor::colorWithSRGBRed_green_blue_alpha(
                                0.0, 0.0, 0.0, 0.001,
                            );
                            ns_window.setBackgroundColor(Some(&bg));
                            ns_window.setOpaque(false);
                        }
                    }) {
                        tracing::warn!("Failed to set transparent NSWindow background at startup: {}", err);
                    }
                    // Prevent WindowServer from flattening the layer tree during Space swipe
                    // transitions. Without this, backdrop-filter and vibrancy views flash
                    // during desktop switching. Uses private CoreGraphics SPI (stable across
                    // macOS versions, used by production apps).
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
