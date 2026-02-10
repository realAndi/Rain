use super::color::Color;
use bitflags::bitflags;

bitflags! {
    /// Cell text attributes as a compact bitflag set.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Hash)]
    pub struct CellAttrs: u16 {
        const BOLD          = 1 << 0;
        const DIM           = 1 << 1;
        const ITALIC        = 1 << 2;
        const UNDERLINE     = 1 << 3;
        const BLINK         = 1 << 4;
        const REVERSE       = 1 << 5;
        const HIDDEN        = 1 << 6;
        const STRIKETHROUGH = 1 << 7;
    }
}

/// Cursor shape for rendering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CursorShape {
    Block,
    Underline,
    Bar,
}

impl Default for CursorShape {
    fn default() -> Self {
        CursorShape::Block
    }
}

/// Full cursor state including position, colors, attributes, and saved state.
#[derive(Debug, Clone)]
pub struct CursorState {
    pub row: u16,
    pub col: u16,
    pub fg: Color,
    pub bg: Color,
    pub attrs: CellAttrs,
    pub shape: CursorShape,
    pub visible: bool,
    /// Saved cursor for DECSC/DECRC
    saved: Option<SavedCursor>,
}

#[derive(Debug, Clone)]
struct SavedCursor {
    row: u16,
    col: u16,
    fg: Color,
    bg: Color,
    attrs: CellAttrs,
}

impl Default for CursorState {
    fn default() -> Self {
        Self {
            row: 0,
            col: 0,
            fg: Color::Default,
            bg: Color::Default,
            attrs: CellAttrs::empty(),
            shape: CursorShape::Block,
            visible: true,
            saved: None,
        }
    }
}

impl CursorState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn save(&mut self) {
        self.saved = Some(SavedCursor {
            row: self.row,
            col: self.col,
            fg: self.fg,
            bg: self.bg,
            attrs: self.attrs,
        });
    }

    pub fn restore(&mut self) {
        if let Some(saved) = self.saved.take() {
            self.row = saved.row;
            self.col = saved.col;
            self.fg = saved.fg;
            self.bg = saved.bg;
            self.attrs = saved.attrs;
        }
    }
}
