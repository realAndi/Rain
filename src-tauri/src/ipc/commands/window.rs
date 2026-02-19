use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::ipc::AppState;

/// Set the native window background blur radius on macOS via CoreGraphics SPI.
/// This directly controls the gaussian blur applied to desktop content behind the
/// window, giving pixel-level control over blur intensity. Radius 0 = no blur.
/// Operates on the calling window (works for both main and child windows).
#[tauri::command]
pub fn set_window_blur_radius(webview: WebviewWindow, radius: u32) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        webview
            .with_webview(move |wv| unsafe {
                use objc2_app_kit::NSWindow;

                extern "C" {
                    fn CGSDefaultConnectionForThread() -> i32;
                    fn CGSSetWindowBackgroundBlurRadius(cid: i32, wid: i32, radius: i32) -> i32;
                }

                let ns_window_ptr: *mut NSWindow = wv.ns_window().cast();
                if !ns_window_ptr.is_null() {
                    let ns_window = &*ns_window_ptr;
                    let wid = ns_window.windowNumber() as i32;
                    let cid = CGSDefaultConnectionForThread();
                    CGSSetWindowBackgroundBlurRadius(cid, wid, radius as i32);
                }
            })
            .map_err(|e| format!("Failed to set blur radius: {}", e))?;

        tracing::info!("Window blur radius set to {}px", radius);
    }

    #[cfg(target_os = "windows")]
    {
        #[link(name = "dwmapi")]
        extern "system" {
            fn DwmSetWindowAttribute(
                hwnd: isize,
                attr: u32,
                value: *const std::ffi::c_void,
                size: u32,
            ) -> i32;
        }

        let hwnd = webview
            .hwnd()
            .map_err(|e| format!("Failed to get HWND: {}", e))?
            .0 as isize;

        // DWM has no variable blur radius; map to backdrop type:
        // radius 0 → disabled, radius > 0 → Acrylic (system blur)
        let backdrop_type: i32 = if radius > 0 { 3 } else { 1 };
        unsafe {
            DwmSetWindowAttribute(
                hwnd,
                38, // DWMWA_SYSTEMBACKDROP_TYPE (1=Disable, 2=Mica, 3=Acrylic)
                &backdrop_type as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<i32>() as u32,
            );
        }

        tracing::info!(
            "Window backdrop set to {} (requested radius {}px)",
            if radius > 0 { "Acrylic" } else { "disabled" },
            radius
        );
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (webview, radius);
    }

    Ok(())
}

/// Set the native window opacity (alpha value) on macOS.
/// This controls the entire window's transparency at the OS level,
/// making everything (text, UI, background) fade together.
/// Operates on the calling window (works for both main and child windows).
#[tauri::command]
pub fn set_window_opacity(webview: WebviewWindow, opacity: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let alpha = opacity.clamp(0.0, 1.0);

        webview
            .with_webview(move |wv| unsafe {
                use objc2_app_kit::NSWindow;

                let ns_window_ptr: *mut NSWindow = wv.ns_window().cast();
                if !ns_window_ptr.is_null() {
                    let ns_window = &*ns_window_ptr;
                    ns_window.setAlphaValue(alpha);
                }
            })
            .map_err(|e| format!("Failed to set opacity: {}", e))?;

        tracing::info!("Window opacity set to {:.0}%", alpha * 100.0);
    }

    #[cfg(target_os = "windows")]
    {
        #[link(name = "user32")]
        extern "system" {
            fn GetWindowLongW(hwnd: isize, index: i32) -> i32;
            fn SetWindowLongW(hwnd: isize, index: i32, value: i32) -> i32;
            fn SetLayeredWindowAttributes(hwnd: isize, key: u32, alpha: u8, flags: u32) -> i32;
        }

        let alpha = opacity.clamp(0.0, 1.0);
        let hwnd = webview
            .hwnd()
            .map_err(|e| format!("Failed to get HWND: {}", e))?
            .0 as isize;

        unsafe {
            const GWL_EXSTYLE: i32 = -20;
            const WS_EX_LAYERED: i32 = 0x0008_0000;
            const LWA_ALPHA: u32 = 0x0000_0002;

            let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
            SetWindowLongW(hwnd, GWL_EXSTYLE, ex_style | WS_EX_LAYERED);
            SetLayeredWindowAttributes(hwnd, 0, (alpha * 255.0) as u8, LWA_ALPHA);
        }

        tracing::info!("Window opacity set to {:.0}%", alpha * 100.0);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (webview, opacity);
    }

    Ok(())
}

/// Set the app icon at runtime from a bundled resource.
/// On macOS this changes the dock icon via NSApplication; on other platforms
/// it updates every window's icon using Tauri's cross-platform API.
#[tauri::command]
pub fn set_app_icon(app: AppHandle, icon_name: String) -> Result<(), String> {
    let filename = match icon_name.as_str() {
        "default" => "icons/default-icon.png",
        "simple" => "icons/simple-icon.png",
        _ => return Err(format!("Unknown icon: {}", icon_name)),
    };

    let resource_path = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Resource dir error: {}", e))?
        .join(filename);

    #[cfg(target_os = "macos")]
    {
        use objc2::AnyThread;
        use objc2_app_kit::{NSApplication, NSImage};
        use objc2_foundation::{MainThreadMarker, NSString};

        unsafe {
            let mtm = MainThreadMarker::new_unchecked();
            let ns_path = NSString::from_str(resource_path.to_str().unwrap());
            let image = NSImage::initByReferencingFile(NSImage::alloc(), &ns_path);
            NSApplication::sharedApplication(mtm).setApplicationIconImage(image.as_deref());
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let png_data = std::fs::read(&resource_path)
            .map_err(|e| format!("Failed to read icon '{}': {}", filename, e))?;
        let icon = tauri::image::Image::from_bytes(&png_data)
            .map_err(|e| format!("Failed to decode icon '{}': {}", filename, e))?;

        for (_label, window) in app.webview_windows() {
            if let Err(e) = window.set_icon(icon.clone()) {
                tracing::warn!("Failed to set icon on window: {}", e);
            }
        }
    }

    tracing::info!("App icon set to '{}'", icon_name);
    Ok(())
}

/// Get the system hostname.
#[tauri::command]
pub fn get_hostname() -> String {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "localhost".to_string())
}

/// Minimal percent-encoding for URL parameter values.
fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{:02X}", b));
            }
        }
    }
    out
}

/// Create a new child window for a detached tab.
/// The new window loads the frontend with URL params so it adopts an existing session.
#[tauri::command]
pub fn create_child_window(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    cwd: Option<String>,
    transfer_id: Option<String>,
) -> Result<String, String> {
    let n = state.window_counter.fetch_add(1, Ordering::Relaxed);
    let window_label = format!("rain-{}", n);

    let mut params = vec![
        format!("adopt={}", urlencoding_encode(&session_id)),
        format!("label={}", urlencoding_encode(&label)),
    ];
    if let Some(cwd) = cwd.as_ref() {
        params.push(format!("cwd={}", urlencoding_encode(cwd)));
    }
    if let Some(transfer_id) = transfer_id.as_ref() {
        params.push(format!(
            "adoptTransfer={}",
            urlencoding_encode(transfer_id),
        ));
    }
    let url_params = format!("?{}", params.join("&"));

    let url = tauri::WebviewUrl::App(format!("index.html{}", url_params).into());

    let mut builder = tauri::WebviewWindowBuilder::new(&app, &window_label, url)
        .title("")
        .inner_size(width, height)
        .position(x, y)
        .resizable(true)
        .decorations(true)
        .transparent(true)
        .min_inner_size(400.0, 300.0);

    #[cfg(target_os = "macos")]
    {
        builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay);
    }

    let child = builder
        .build()
        .map_err(|e| format!("Failed to create child window: {}", e))?;

    #[cfg(target_os = "macos")]
    crate::configure_macos_window(&child);

    #[cfg(target_os = "windows")]
    crate::configure_windows_window(&child);

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    crate::configure_linux_window(&child);

    tracing::info!(
        "Created child window '{}' for session {}",
        window_label,
        &session_id[..8.min(session_id.len())]
    );

    Ok(window_label)
}

/// Ghost window label used for the drag-out pill overlay.
const GHOST_LABEL: &str = "ghost-drag";

/// Create a small, transparent, always-on-top window that renders a floating
/// tab pill. Used during tab-detach drag so the pill can follow the cursor
/// outside the source window's bounds.
#[tauri::command]
pub fn create_drag_ghost(
    app: AppHandle,
    label: String,
    pane_count: u32,
    split_direction: Option<String>,
    x: f64,
    y: f64,
    width: f64,
) -> Result<(), String> {
    // Close any lingering ghost from a previous drag.
    if let Some(existing) = app.get_webview_window(GHOST_LABEL) {
        let _ = existing.close();
    }

    let badge_html = if pane_count > 1 {
        let dir_label = match split_direction.as_deref() {
            Some("vertical") => "TB",
            Some("horizontal") => "LR",
            _ => "SP",
        };
        format!(
            r#"<span class="badge">{} {}</span>"#,
            dir_label, pane_count
        )
    } else {
        String::new()
    };

    let escaped_label = label
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;");

    let html = format!(
        r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{{margin:0;padding:0;box-sizing:border-box}}
html,body{{background:transparent;overflow:hidden;
  -webkit-user-select:none;user-select:none;pointer-events:none;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}}
.pill{{
  height:28px;display:inline-flex;align-items:center;justify-content:center;
  padding:0 12px;border-radius:6px;
  background:rgba(30,30,30,0.82);
  border:1px solid rgba(255,255,255,0.14);
  box-shadow:0 8px 24px rgba(0,0,0,0.32),0 2px 8px rgba(0,0,0,0.18);
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
  white-space:nowrap;
}}
.label{{font-size:12px;font-weight:500;color:rgba(255,255,255,0.88);
  overflow:hidden;text-overflow:ellipsis;max-width:180px}}
.badge{{margin-left:8px;padding:2px 6px;border-radius:999px;
  font-size:10px;line-height:1;color:rgba(100,170,255,0.95);
  border:1px solid rgba(100,170,255,0.45);
  background:rgba(100,170,255,0.12)}}
</style></head>
<body><div class="pill"><span class="label">{}</span>{}</div></body></html>"#,
        escaped_label, badge_html
    );

    let data_url = format!(
        "data:text/html;charset=utf-8,{}",
        urlencoding_encode(&html)
    );
    let url = tauri::WebviewUrl::External(
        data_url.parse().map_err(|e| format!("Bad data URL: {}", e))?,
    );

    let ghost_height = 34.0;
    let ghost = tauri::WebviewWindowBuilder::new(&app, GHOST_LABEL, url)
        .title("")
        .inner_size(width, ghost_height)
        .position(x - width / 2.0, y - ghost_height / 2.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .shadow(false)
        .build()
        .map_err(|e| format!("Failed to create ghost window: {}", e))?;

    // Make the ghost window transparent on macOS.
    #[cfg(target_os = "macos")]
    {
        let _ = ghost.with_webview(|webview| unsafe {
            let wk: *mut objc2::runtime::AnyObject = webview.inner().cast();
            if !wk.is_null() {
                let no = objc2_foundation::NSNumber::new_bool(false);
                let key = objc2_foundation::NSString::from_str("drawsBackground");
                let _: () = objc2::msg_send![&*wk, setValue: &*no, forKey: &*key];
            }
        });
        let _ = ghost.with_webview(|webview| unsafe {
            use objc2_app_kit::{NSColor, NSWindow};

            let ns_window_ptr: *mut NSWindow = webview.ns_window().cast();
            if !ns_window_ptr.is_null() {
                let ns_window = &*ns_window_ptr;
                let bg = NSColor::colorWithSRGBRed_green_blue_alpha(0.0, 0.0, 0.0, 0.001);
                ns_window.setBackgroundColor(Some(&bg));
                ns_window.setOpaque(false);
                ns_window.setIgnoresMouseEvents(true);
            }
        });
    }

    #[cfg(target_os = "windows")]
    {
        #[link(name = "user32")]
        extern "system" {
            fn GetWindowLongW(hwnd: isize, index: i32) -> i32;
            fn SetWindowLongW(hwnd: isize, index: i32, value: i32) -> i32;
        }

        if let Ok(hwnd) = ghost.hwnd() {
            let hwnd = hwnd.0 as isize;
            unsafe {
                const GWL_EXSTYLE: i32 = -20;
                const WS_EX_TRANSPARENT: i32 = 0x0000_0020;
                const WS_EX_LAYERED: i32 = 0x0008_0000;
                let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
                SetWindowLongW(
                    hwnd,
                    GWL_EXSTYLE,
                    ex_style | WS_EX_TRANSPARENT | WS_EX_LAYERED,
                );
            }
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = ghost;
    }

    Ok(())
}

/// Close the drag ghost window if it exists.
#[tauri::command]
pub fn close_drag_ghost(app: AppHandle) -> Result<(), String> {
    if let Some(ghost) = app.get_webview_window(GHOST_LABEL) {
        ghost.close().map_err(|e| format!("Failed to close ghost: {}", e))?;
    }
    Ok(())
}

/// Exit the entire application process.
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Toggle the main window visibility (for global hotkey).
fn toggle_main_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            window.hide().map_err(|e| format!("Hide error: {}", e))?;
        } else {
            window.show().map_err(|e| format!("Show error: {}", e))?;
            window.set_focus().map_err(|e| format!("Focus error: {}", e))?;
        }
        Ok(())
    } else {
        Err("Main window not found".to_string())
    }
}

#[tauri::command]
pub fn toggle_window_visibility(app: AppHandle) -> Result<(), String> {
    toggle_main_window(&app)
}

/// Register a global shortcut to toggle the window.
#[tauri::command]
pub fn register_global_hotkey(app: AppHandle, accelerator: String) -> Result<(), String> {
    let shortcut_manager = app.global_shortcut();
    shortcut_manager
        .unregister_all()
        .map_err(|e| format!("Failed to clear previous global hotkeys: {}", e))?;

    let normalized = accelerator
        .trim()
        .replace("CmdOrCtrl", "CommandOrControl");
    if normalized.is_empty() {
        tracing::info!("Global hotkey cleared");
        return Ok(());
    }

    shortcut_manager
        .on_shortcut(normalized.as_str(), move |app_handle, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                if let Err(error) = toggle_main_window(app_handle) {
                    tracing::warn!("Global hotkey toggle failed: {}", error);
                }
            }
        })
        .map_err(|e| format!("Failed to register global hotkey '{}': {}", normalized, e))?;

    tracing::info!("Global hotkey registered: {}", normalized);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencoding_encode_preserves_unreserved_chars() {
        assert_eq!(urlencoding_encode("hello"), "hello");
        assert_eq!(urlencoding_encode("ABC-xyz_0.9~"), "ABC-xyz_0.9~");
    }

    #[test]
    fn urlencoding_encode_encodes_spaces() {
        assert_eq!(urlencoding_encode("hello world"), "hello%20world");
    }

    #[test]
    fn urlencoding_encode_encodes_special_chars() {
        assert_eq!(urlencoding_encode("a=b&c"), "a%3Db%26c");
        assert_eq!(urlencoding_encode("100%"), "100%25");
    }

    #[test]
    fn urlencoding_encode_handles_empty_string() {
        assert_eq!(urlencoding_encode(""), "");
    }

    #[test]
    fn urlencoding_encode_handles_unicode() {
        let encoded = urlencoding_encode("café");
        assert!(encoded.starts_with("caf"));
        assert!(encoded.contains('%'));
    }

    #[test]
    fn urlencoding_encode_handles_path_chars() {
        assert_eq!(urlencoding_encode("/Users/test"), "%2FUsers%2Ftest");
        assert_eq!(
            urlencoding_encode("C:\\Users\\test"),
            "C%3A%5CUsers%5Ctest"
        );
    }

    #[test]
    fn urlencoding_encode_roundtrip_with_query_params() {
        let session_id = "550e8400-e29b-41d4-a716-446655440000";
        let encoded = urlencoding_encode(session_id);
        assert_eq!(encoded, session_id, "UUIDs should pass through unchanged");
    }
}
