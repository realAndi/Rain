use std::io::{Read, Write};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tauri::AppHandle;
use tauri::Emitter;

use crate::render::RenderFrame;
use crate::terminal::TerminalState;

use super::session::SharedWriter;

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

/// Handles for the parser and render-pump threads.
pub struct PtyThreadHandles {
    pub parser: std::thread::JoinHandle<()>,
    pub render_pump: std::thread::JoinHandle<()>,
    pub render_waker: SyncSender<()>,
}

/// Spawn PTY parser and render-pump threads.
///
/// - Parser thread: reads PTY bytes and mutates terminal state.
/// - Render-pump thread: emits at most one frame per tick from accumulated damage.
pub fn spawn_pty_threads(
    mut reader: Box<dyn Read + Send>,
    state: Arc<Mutex<TerminalState>>,
    writer: SharedWriter,
    app_handle: AppHandle,
    session_id: String,
    running: Arc<AtomicBool>,
) -> PtyThreadHandles {
    fn notify_render(waker: &SyncSender<()>) {
        let _ = waker.try_send(());
    }

    let (render_waker, render_rx) = sync_channel::<()>(1);
    let parser_state = Arc::clone(&state);
    let parser_writer = Arc::clone(&writer);
    let parser_session = session_id.clone();
    let parser_running = Arc::clone(&running);
    let parser_waker = render_waker.clone();

    let parser = std::thread::Builder::new()
        .name(format!("pty-parser-{}", &session_id[..8]))
        .spawn(move || {
            let mut parser = vte::Parser::new();
            let mut buf = [0u8; 4096];

            while parser_running.load(Ordering::Acquire) {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        // EOF: shell exited
                        tracing::info!("PTY reader EOF for session {}", &parser_session[..8]);
                        parser_running.store(false, Ordering::Release);
                        notify_render(&parser_waker);
                        break;
                    }
                    Ok(n) => {
                        let mut state = parser_state.lock();
                        for &byte in &buf[..n] {
                            parser.advance(&mut *state, byte);
                        }

                        // Flush any DSR/DA response bytes back to the PTY
                        let responses = state.take_pending_responses();
                        if !responses.is_empty() {
                            let mut w = parser_writer.lock();
                            for resp in &responses {
                                let _ = w.write_all(resp);
                            }
                            let _ = w.flush();
                        }
                        notify_render(&parser_waker);
                    }
                    Err(e) => {
                        if parser_running.load(Ordering::Acquire) {
                            tracing::error!(
                                "PTY read error for session {}: {}",
                                &parser_session[..8],
                                e
                            );
                        }
                        parser_running.store(false, Ordering::Release);
                        notify_render(&parser_waker);
                        break;
                    }
                }
            }
        })
        .expect("Failed to spawn PTY parser thread");

    let render_state = Arc::clone(&state);
    let render_app = app_handle;
    let render_session = session_id;
    let render_running = Arc::clone(&running);
    let render_retry_waker = render_waker.clone();

    let render_pump = std::thread::Builder::new()
        .name(format!("pty-render-{}", &render_session[..8]))
        .spawn(move || {
            const FRAME_TICK: Duration = Duration::from_millis(16);
            let mut last_emit = Instant::now() - FRAME_TICK;

            while render_running.load(Ordering::Acquire) {
                if render_rx.recv().is_err() {
                    break;
                }
                if !render_running.load(Ordering::Acquire) {
                    break;
                }

                let elapsed = last_emit.elapsed();
                if elapsed < FRAME_TICK {
                    std::thread::sleep(FRAME_TICK - elapsed);
                }

                // Coalesce bursty parser notifications into one frame build.
                while render_rx.try_recv().is_ok() {}

                let mut emitted = false;
                if let Some(mut state) = render_state.try_lock() {
                    let snapshot = state.take_render_snapshot();
                    drop(state); // keep parser lock hold minimal
                    if let Some(snapshot) = snapshot {
                        let frame = snapshot.into_frame();
                        tracing::debug!(
                            session = %&render_session[..8],
                            frame_seq = frame.frame_seq,
                            resize_epoch = frame.resize_epoch,
                            lines = frame.lines.len(),
                            scrolled = frame.scrolled_lines.len(),
                            events = frame.events.len(),
                            rows = frame.visible_rows,
                            cols = frame.visible_cols,
                            "Emitting render frame"
                        );
                        let payload = RenderFramePayload {
                            session_id: render_session.clone(),
                            frame,
                        };
                        let _ = render_app.emit("render-frame", &payload);
                        emitted = true;
                    }
                } else {
                    // Parser owns the lock; retry soon without spinning.
                    notify_render(&render_retry_waker);
                    continue;
                }

                if emitted {
                    last_emit = Instant::now();
                }
            }

            // Final drain for any remaining dirty state after shutdown.
            let mut state = render_state.lock();
            let snapshot = state.take_render_snapshot();
            drop(state);
            if let Some(snapshot) = snapshot {
                let frame = snapshot.into_frame();
                tracing::debug!(
                    session = %&render_session[..8],
                    frame_seq = frame.frame_seq,
                    resize_epoch = frame.resize_epoch,
                    lines = frame.lines.len(),
                    scrolled = frame.scrolled_lines.len(),
                    events = frame.events.len(),
                    rows = frame.visible_rows,
                    cols = frame.visible_cols,
                    "Emitting final drained render frame"
                );
                let payload = RenderFramePayload {
                    session_id: render_session.clone(),
                    frame,
                };
                let _ = render_app.emit("render-frame", &payload);
            }

            let _ = render_app.emit(
                "session-ended",
                &SessionEndPayload {
                    session_id: render_session,
                    exit_code: None,
                },
            );
        })
        .expect("Failed to spawn PTY render thread");

    PtyThreadHandles {
        parser,
        render_pump,
        render_waker,
    }
}
