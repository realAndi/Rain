use std::collections::VecDeque;

use bitflags::bitflags;

use super::color::Color;
use super::cursor::CellAttrs;
use crate::render::frame::{RenderedLine, StyledSpan};

bitflags! {
    /// Per-cell flags for wide character tracking and line wrapping.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Hash)]
    pub struct CellFlags: u8 {
        /// This cell holds a wide (2-column) character
        const WIDE_CHAR   = 1 << 0;
        /// This cell is the trailing spacer of a wide character
        const WIDE_SPACER = 1 << 1;
        /// Line wrapped at this position
        const WRAP        = 1 << 2;
    }
}

/// A single terminal cell.
#[derive(Debug, Clone, PartialEq)]
pub struct Cell {
    pub c: char,
    pub fg: Color,
    pub bg: Color,
    pub attrs: CellAttrs,
    pub flags: CellFlags,
}

impl Default for Cell {
    fn default() -> Self {
        Self {
            c: ' ',
            fg: Color::Default,
            bg: Color::Default,
            attrs: CellAttrs::empty(),
            flags: CellFlags::empty(),
        }
    }
}

impl Cell {
    /// Create a spacer cell for the trailing half of a wide character.
    pub fn wide_spacer() -> Self {
        Self {
            c: ' ',
            flags: CellFlags::WIDE_SPACER,
            ..Default::default()
        }
    }

    /// Reset cell to default blank state.
    pub fn clear(&mut self) {
        self.c = ' ';
        self.fg = Color::Default;
        self.bg = Color::Default;
        self.attrs = CellAttrs::empty();
        self.flags = CellFlags::empty();
    }

    /// Erase cell using the cursor's current background color (per ECMA-48).
    pub fn erase(&mut self, bg: Color) {
        self.c = ' ';
        self.fg = Color::Default;
        self.bg = bg;
        self.attrs = CellAttrs::empty();
        self.flags = CellFlags::empty();
    }
}

/// A single row in the terminal grid.
#[derive(Debug, Clone)]
pub struct Row {
    pub cells: Vec<Cell>,
    pub dirty: bool,
}

impl Row {
    pub fn new(cols: u16) -> Self {
        Self {
            cells: vec![Cell::default(); cols as usize],
            dirty: true,
        }
    }

    pub fn clear(&mut self) {
        for cell in &mut self.cells {
            cell.clear();
        }
        self.dirty = true;
    }

    /// Erase all cells using the given background color (per ECMA-48).
    pub fn erase_with_bg(&mut self, bg: Color) {
        for cell in &mut self.cells {
            cell.erase(bg);
        }
        self.dirty = true;
    }

    pub fn resize(&mut self, cols: u16) {
        let new_len = cols as usize;
        if self.cells.len() != new_len {
            self.cells.resize(new_len, Cell::default());
            self.dirty = true;
        }
    }

    /// Convert this row into styled spans for the render pipeline.
    /// Adjacent cells with matching styles are coalesced into a single span.
    pub fn to_styled_spans(&self) -> Vec<StyledSpan> {
        if self.cells.is_empty() {
            return vec![];
        }

        let mut spans = Vec::new();
        let mut text = String::new();
        let mut cur_fg = Color::Default;
        let mut cur_bg = Color::Default;
        let mut cur_attrs = CellAttrs::empty();
        let mut initialized = false;

        for cell in &self.cells {
            // Skip spacer cells for wide characters
            if cell.flags.contains(CellFlags::WIDE_SPACER) {
                continue;
            }

            if !initialized {
                // Initialize style from the first non-spacer cell
                cur_fg = cell.fg;
                cur_bg = cell.bg;
                cur_attrs = cell.attrs;
                initialized = true;
            } else if cell.fg != cur_fg || cell.bg != cur_bg || cell.attrs != cur_attrs {
                // Style changed, flush current span
                if !text.is_empty() {
                    spans.push(StyledSpan::new(&text, cur_fg, cur_bg, cur_attrs));
                    text.clear();
                }
                cur_fg = cell.fg;
                cur_bg = cell.bg;
                cur_attrs = cell.attrs;
            }

            text.push(cell.c);
        }

        if !text.is_empty() {
            spans.push(StyledSpan::new(&text, cur_fg, cur_bg, cur_attrs));
        }

        spans
    }
}

/// The terminal grid holding visible rows and scrollback history.
pub struct Grid {
    /// All rows: scrollback + visible. The visible area is the last `visible_rows` entries.
    pub rows: VecDeque<Row>,
    pub cols: u16,
    pub visible_rows: u16,
    pub scrollback_limit: usize,
}

impl Grid {
    pub fn new(visible_rows: u16, cols: u16) -> Self {
        let mut rows = VecDeque::with_capacity(visible_rows as usize);
        for _ in 0..visible_rows {
            rows.push_back(Row::new(cols));
        }
        Self {
            rows,
            cols,
            visible_rows,
            scrollback_limit: 10_000,
        }
    }

    /// Get the offset where the visible area starts.
    fn visible_offset(&self) -> usize {
        self.rows.len().saturating_sub(self.visible_rows as usize)
    }

    /// Get a reference to a visible row by its screen-relative index (0 = top of screen).
    #[allow(dead_code)]
    pub fn visible_row(&self, row: u16) -> &Row {
        let idx = self.visible_offset() + row as usize;
        &self.rows[idx]
    }

    /// Get a mutable reference to a visible row.
    pub fn visible_row_mut(&mut self, row: u16) -> &mut Row {
        let idx = self.visible_offset() + row as usize;
        &mut self.rows[idx]
    }

    /// Write a cell at the given screen-relative position.
    pub fn set_cell(&mut self, row: u16, col: u16, cell: Cell) {
        if col < self.cols && row < self.visible_rows {
            let r = self.visible_row_mut(row);
            r.cells[col as usize] = cell;
            r.dirty = true;
        }
    }

    /// Clear a cell to default at the given screen-relative position.
    #[allow(dead_code)]
    pub fn clear_cell(&mut self, row: u16, col: u16) {
        if col < self.cols && row < self.visible_rows {
            let r = self.visible_row_mut(row);
            r.cells[col as usize].clear();
            r.dirty = true;
        }
    }

    /// Scroll the region [top, bottom] up by one line.
    /// The top line moves into scrollback (if top == 0), and a blank line is inserted at bottom.
    /// Returns the rendered content of the scrolled-off line if top == 0 (for capture by frontend).
    pub fn scroll_up(&mut self, top: u16, bottom: u16) -> Option<RenderedLine> {
        let offset = self.visible_offset();
        let top_idx = offset + top as usize;
        let bottom_idx = offset + bottom as usize;

        if top_idx > bottom_idx || bottom_idx >= self.rows.len() {
            return None;
        }

        let mut scrolled_line = None;

        if top == 0 {
            // Capture the line being pushed off the visible area before it moves to scrollback
            let spans = self.rows[top_idx].to_styled_spans();
            scrolled_line = Some(RenderedLine {
                index: 0, // index doesn't matter for scrolled-off lines
                spans,
            });

            // Top line goes into scrollback; insert a new blank at the bottom position
            self.rows.insert(bottom_idx + 1, Row::new(self.cols));

            // Trim scrollback if over limit
            while self.rows.len() > self.visible_rows as usize + self.scrollback_limit {
                self.rows.pop_front();
            }
        } else {
            // Remove the top line of the scroll region and insert blank at bottom
            self.rows.remove(top_idx);
            self.rows.insert(bottom_idx, Row::new(self.cols));
        }

        // Mark visible rows as dirty
        for i in top..=bottom {
            self.visible_row_mut(i).dirty = true;
        }

        scrolled_line
    }

    /// Scroll the region [top, bottom] down by one line.
    /// The bottom line is discarded and a blank line is inserted at top.
    pub fn scroll_down(&mut self, top: u16, bottom: u16) {
        let offset = self.visible_offset();
        let top_idx = offset + top as usize;
        let bottom_idx = offset + bottom as usize;

        if top_idx > bottom_idx || bottom_idx >= self.rows.len() {
            return;
        }

        self.rows.remove(bottom_idx);
        self.rows.insert(top_idx, Row::new(self.cols));

        for i in top..=bottom {
            self.visible_row_mut(i).dirty = true;
        }
    }

    /// Resize the grid to new dimensions. Existing content is preserved where possible.
    /// When shrinking, excess rows become scrollback (appropriate for the main grid).
    /// After the resize commit, mark the full visible viewport dirty so the
    /// first post-resize frame is coherent.
    pub fn resize(&mut self, new_rows: u16, new_cols: u16) {
        // Resize all existing rows to new column count.
        // Row::resize() only marks dirty when the column count actually changed.
        for row in self.rows.iter_mut() {
            row.resize(new_cols);
        }

        let current_visible = self.visible_rows as usize;
        let new_visible = new_rows as usize;

        if new_visible > current_visible {
            // Need more visible rows. Pull from scrollback or create new blank rows.
            // New rows are created with dirty=true by Row::new().
            let needed = new_visible - current_visible;
            for _ in 0..needed {
                self.rows.push_back(Row::new(new_cols));
            }
        }
        // If shrinking, we don't remove rows - they become scrollback

        self.visible_rows = new_rows;
        self.cols = new_cols;
        self.mark_all_dirty();
    }

    /// Resize for the alternate screen buffer.
    /// Alt-screen content is disposable: TUIs always repaint from scratch on
    /// SIGWINCH. We clear the grid entirely and let the child redraw into a
    /// fresh buffer at the new dimensions, matching xterm/Alacritty behavior.
    pub fn resize_no_scrollback(&mut self, new_rows: u16, new_cols: u16) {
        self.rows.clear();
        for _ in 0..new_rows as usize {
            self.rows.push_back(Row::new(new_cols));
        }
        self.visible_rows = new_rows;
        self.cols = new_cols;
        self.mark_all_dirty();
    }

    /// Collect all dirty visible lines as RenderedLine structs, clearing dirty flags.
    pub fn collect_dirty_lines(&mut self) -> Vec<RenderedLine> {
        let mut result = Vec::new();
        let offset = self.visible_offset();

        for i in 0..self.visible_rows {
            let idx = offset + i as usize;
            if idx < self.rows.len() && self.rows[idx].dirty {
                let spans = self.rows[idx].to_styled_spans();
                result.push(RenderedLine {
                    index: i as u32,
                    spans,
                });
                self.rows[idx].dirty = false;
            }
        }

        result
    }

    /// Mark all visible rows as dirty (for full redraws).
    pub fn mark_all_dirty(&mut self) {
        let offset = self.visible_offset();
        for i in 0..self.visible_rows as usize {
            if offset + i < self.rows.len() {
                self.rows[offset + i].dirty = true;
            }
        }
    }

    /// Get the total number of lines including scrollback.
    #[allow(dead_code)]
    pub fn total_lines(&self) -> usize {
        self.rows.len()
    }

    /// Get the number of scrollback lines above the visible area.
    #[allow(dead_code)]
    pub fn scrollback_len(&self) -> usize {
        self.visible_offset()
    }

    /// Erase cells in a row from start_col to end_col (exclusive),
    /// filling with the given background color (per ECMA-48).
    pub fn erase_cells(&mut self, row: u16, start_col: u16, end_col: u16, bg: Color) {
        if row >= self.visible_rows {
            return;
        }
        let r = self.visible_row_mut(row);
        let start = start_col as usize;
        let end = (end_col as usize).min(r.cells.len());
        for i in start..end {
            r.cells[i].erase(bg);
        }
        r.dirty = true;
    }

    /// Insert blank cells at position, shifting existing cells right.
    pub fn insert_cells(&mut self, row: u16, col: u16, count: u16) {
        if row >= self.visible_rows {
            return;
        }
        let r = self.visible_row_mut(row);
        let col = col as usize;
        let count = count as usize;
        let len = r.cells.len();

        for _ in 0..count.min(len - col) {
            r.cells.pop();
            r.cells.insert(col, Cell::default());
        }
        r.dirty = true;
    }

    /// Delete cells at position, shifting remaining cells left.
    pub fn delete_cells(&mut self, row: u16, col: u16, count: u16) {
        if row >= self.visible_rows {
            return;
        }
        let r = self.visible_row_mut(row);
        let col = col as usize;
        let count = count as usize;

        let to_remove = count.min(r.cells.len().saturating_sub(col));
        for _ in 0..to_remove {
            if col < r.cells.len() {
                r.cells.remove(col);
                r.cells.push(Cell::default());
            }
        }
        r.dirty = true;
    }
}
