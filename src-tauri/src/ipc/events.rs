/// Event names used for Tauri IPC communication.
/// Backend -> Frontend events.

/// Render frame containing dirty lines, cursor state, and terminal events.
/// Payload: RenderFramePayload { session_id, frame }
#[allow(dead_code)]
pub const RENDER_FRAME: &str = "render-frame";

/// Session has ended (shell exited).
/// Payload: SessionEndPayload { session_id, exit_code }
#[allow(dead_code)]
pub const SESSION_ENDED: &str = "session-ended";
