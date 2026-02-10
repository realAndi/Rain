use serde::Serialize;

use crate::terminal::color::{Color, SerializableColor};
use crate::terminal::cursor::CellAttrs;

/// A complete render frame sent to the frontend via IPC.
#[derive(Debug, Clone, Serialize)]
pub struct RenderFrame {
    /// Dirty lines that need updating
    pub lines: Vec<RenderedLine>,
    /// Lines that scrolled off the top of the visible grid (into scrollback).
    /// These are captured so the frontend can build up complete command output
    /// even when it exceeds the visible grid height.
    pub scrolled_lines: Vec<RenderedLine>,
    /// Current cursor state
    pub cursor: CursorRender,
    /// Terminal events (block changes, title, mode switches)
    pub events: Vec<TerminalEvent>,
}

/// A single rendered line with pre-segmented styled spans.
#[derive(Debug, Clone, Serialize)]
pub struct RenderedLine {
    /// Screen-relative row index (0 = top of visible area)
    pub index: u32,
    /// Styled text segments
    pub spans: Vec<StyledSpan>,
}

/// A contiguous run of text sharing the same style.
#[derive(Debug, Clone, Serialize)]
pub struct StyledSpan {
    pub text: String,
    pub fg: SerializableColor,
    pub bg: SerializableColor,
    pub bold: bool,
    pub dim: bool,
    pub italic: bool,
    pub underline: bool,
    pub strikethrough: bool,
}

impl StyledSpan {
    pub fn new(text: &str, fg: Color, bg: Color, attrs: CellAttrs) -> Self {
        Self {
            text: text.to_string(),
            fg: fg.into(),
            bg: bg.into(),
            bold: attrs.contains(CellAttrs::BOLD),
            dim: attrs.contains(CellAttrs::DIM),
            italic: attrs.contains(CellAttrs::ITALIC),
            underline: attrs.contains(CellAttrs::UNDERLINE),
            strikethrough: attrs.contains(CellAttrs::STRIKETHROUGH),
        }
    }
}

/// Cursor rendering information for the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct CursorRender {
    pub row: u16,
    pub col: u16,
    pub visible: bool,
    pub shape: String,
}

/// Events emitted alongside render frames for state changes.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum TerminalEvent {
    /// A new command block has started (prompt is being shown)
    BlockStarted {
        id: String,
        cwd: String,
        /// Global cursor row at the time of the event
        global_row: u64,
    },
    /// The command within a block has been identified
    BlockCommand {
        id: String,
        command: String,
        /// Global cursor row at the time of the event
        global_row: u64,
    },
    /// A command block has completed execution
    BlockCompleted {
        id: String,
        exit_code: i32,
        /// Global cursor row at the time of the event
        global_row: u64,
    },
    /// Terminal title changed (via OSC 0 or OSC 2)
    TitleChanged {
        title: String,
    },
    /// Entered alternate screen buffer (e.g. vim, less)
    AltScreenEntered,
    /// Exited alternate screen buffer
    AltScreenExited,
    /// Bell character received
    Bell,
    /// Working directory changed
    CwdChanged {
        path: String,
    },
}
