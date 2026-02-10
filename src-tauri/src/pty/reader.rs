use std::io::Read;
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::AppHandle;
use tauri::Emitter;

use crate::render::RenderFrame;
use crate::terminal::TerminalState;

/// Payload sent to the frontend for each render frame.
#[derive(serde::Serialize, Clone)]
pub struct RenderFramePayload {
    pub session_id: String,
    pub frame: RenderFrame,
}

/// Payload sent when a session ends.
#[derive(serde::Serialize, Clone)]
pub struct SessionEndPayload {
    pub session_id: String,
    pub exit_code: Option<i32>,
}

/// Run the PTY reader loop on a dedicated OS thread.
/// Reads from the PTY, feeds bytes through the VTE parser, and emits render frames.
pub fn spawn_reader_thread(
    mut reader: Box<dyn Read + Send>,
    state: Arc<Mutex<TerminalState>>,
    app_handle: AppHandle,
    session_id: String,
) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name(format!("pty-reader-{}", &session_id[..8]))
        .spawn(move || {
            let mut parser = vte::Parser::new();
            let mut buf = [0u8; 4096];

            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        // EOF: shell exited
                        tracing::info!("PTY reader EOF for session {}", &session_id[..8]);
                        break;
                    }
                    Ok(n) => {
                        let mut state = state.lock();
                        for &byte in &buf[..n] {
                            parser.advance(&mut *state, byte);
                        }

                        // Generate and emit render frame
                        if let Some(frame) = state.generate_render_frame() {
                            drop(state); // release lock before IPC
                            let payload = RenderFramePayload {
                                session_id: session_id.clone(),
                                frame,
                            };
                            let _ = app_handle.emit("render-frame", &payload);
                        }
                    }
                    Err(e) => {
                        tracing::error!(
                            "PTY read error for session {}: {}",
                            &session_id[..8],
                            e
                        );
                        break;
                    }
                }
            }

            // Notify frontend
            let _ = app_handle.emit(
                "session-ended",
                &SessionEndPayload {
                    session_id,
                    exit_code: None,
                },
            );
        })
        .expect("Failed to spawn PTY reader thread")
}
