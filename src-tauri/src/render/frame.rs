use serde::Serialize;

use crate::terminal::color::{Color, SerializableColor};
use crate::terminal::cursor::CellAttrs;

/// A complete render frame sent to the frontend via IPC.
#[derive(Debug, Clone, Serialize)]
pub struct RenderFrame {
    /// Monotonic sequence for frame ordering (newer frames have larger values).
    pub frame_seq: u64,
    /// Monotonic resize generation. Increments on each terminal resize.
    pub resize_epoch: u64,
    /// Dirty lines that need updating
    pub lines: Vec<RenderedLine>,
    /// Lines that scrolled off the top of the visible grid (into scrollback).
    /// These are captured so the frontend can build up complete command output
    /// even when it exceeds the visible grid height.
    pub scrolled_lines: Vec<RenderedLine>,
    /// Global row index represented by visible row 0 in this frame.
    pub visible_base_global: u64,
    /// Canonical visible row count for this frame.
    pub visible_rows: u16,
    /// Canonical visible column count for this frame.
    pub visible_cols: u16,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

impl StyledSpan {
    pub fn new(text: &str, fg: Color, bg: Color, attrs: CellAttrs) -> Self {
        // SGR 7 (REVERSE): swap foreground and background colors
        let (fg, bg) = if attrs.contains(CellAttrs::REVERSE) {
            (bg, fg)
        } else {
            (fg, bg)
        };

        // SGR 8 (HIDDEN): make text invisible by matching fg to bg
        let fg = if attrs.contains(CellAttrs::HIDDEN) {
            bg
        } else {
            fg
        };

        Self {
            text: text.to_string(),
            fg: fg.into(),
            bg: bg.into(),
            bold: attrs.contains(CellAttrs::BOLD),
            dim: attrs.contains(CellAttrs::DIM),
            italic: attrs.contains(CellAttrs::ITALIC),
            underline: attrs.contains(CellAttrs::UNDERLINE),
            strikethrough: attrs.contains(CellAttrs::STRIKETHROUGH),
            url: None,
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
    TitleChanged { title: String },
    /// Entered alternate screen buffer (e.g. vim, less)
    AltScreenEntered,
    /// Exited alternate screen buffer
    AltScreenExited,
    /// Bell character received
    Bell,
    /// Working directory changed
    CwdChanged { path: String },
    /// Mouse mode flags changed
    MouseModeChanged {
        tracking: bool,
        motion: bool,
        all_motion: bool,
        sgr: bool,
        utf8: bool,
        focus: bool,
        alt_scroll: bool,
        synchronized_output: bool,
        bracketed_paste: bool,
        cursor_keys_application: bool,
    },
    /// Scrollback buffer was cleared (CSI 3J)
    ScrollbackCleared,
    /// Inline image data (iTerm2 OSC 1337 protocol)
    InlineImage {
        id: String,
        data_base64: String,
        width: u16,
        height: u16,
        row: u16,
        col: u16,
    },
    /// Sixel image data (experimental; only emitted when
    /// RAIN_ENABLE_EXPERIMENTAL_IMAGE_PROTOCOLS=1).
    SixelImage {
        id: String,
        data_base64: String,
        width: u32,
        height: u32,
        row: u16,
        col: u16,
    },
    /// Kitty graphics protocol image (experimental scaffold).
    KittyImage {
        id: String,
        action: String,
        data_base64: String,
        width: u32,
        height: u32,
        row: u16,
        col: u16,
        image_id: u32,
        placement_id: u32,
    },
    /// The shell hook intercepted a `tmux` command and requests Rain handle it
    /// via control mode. `args` contains the raw arguments (e.g. "attach -t main").
    TmuxRequested { args: String },
}
