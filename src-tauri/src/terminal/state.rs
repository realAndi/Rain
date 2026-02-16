use unicode_width::UnicodeWidthChar;

use super::color::Color;
use super::cursor::{CellAttrs, CursorShape, CursorState};
use super::grid::{Cell, CellFlags, Grid};
use super::modes::TerminalModes;
use crate::render::frame::{CursorRender, RenderFrame, RenderedLine, TerminalEvent};
use crate::shell::ShellIntegration;

/// Full terminal state. Implements `vte::Perform` to process escape sequences.
pub struct TerminalState {
    pub grid: Grid,
    pub alt_grid: Option<Grid>,
    pub using_alt: bool,
    pub cursor: CursorState,
    pub modes: TerminalModes,
    pub scroll_top: u16,
    pub scroll_bottom: u16,
    pub tab_stops: Vec<bool>,
    pub title: String,
    pub title_changed: bool,
    pub shell: ShellIntegration,
    cols: u16,
    rows: u16,
    dcs_buffer: Vec<u8>,
    /// Lines that scrolled off the top of the visible grid. Captured so the
    /// frontend can accumulate full command output even for long outputs.
    scrolled_off_buffer: Vec<RenderedLine>,
    /// Monotonic counter of lines scrolled off (global line index base).
    scrollback_seq: u64,
    /// Terminal-level events (alt screen, etc.) to include in the next frame.
    pending_terminal_events: Vec<TerminalEvent>,
    /// Response bytes queued by CSI 6n (DSR) or CSI c (DA) that the reader
    /// thread should write back to the PTY after processing a chunk.
    pending_responses: Vec<Vec<u8>>,
    /// Monotonic sequence assigned to emitted render frames.
    frame_seq: u64,
    /// Monotonic resize generation. Incremented on every resize.
    resize_epoch: u64,
    /// Active hyperlink URL from OSC 8 (None when no hyperlink is active)
    active_hyperlink: Option<String>,
    /// Inline image counter for generating unique IDs
    image_counter: u64,
    /// DEC Special Graphics charset active (ESC ( 0)
    charset_g0_drawing: bool,
}

/// Snapshot of terminal render data extracted under lock.
/// This can be converted into an IPC render frame outside the lock.
pub struct RenderSnapshot {
    pub frame_seq: u64,
    pub resize_epoch: u64,
    pub lines: Vec<RenderedLine>,
    pub scrolled_lines: Vec<RenderedLine>,
    pub visible_base_global: u64,
    pub visible_rows: u16,
    pub visible_cols: u16,
    pub cursor: CursorRender,
    pub events: Vec<TerminalEvent>,
}

impl RenderSnapshot {
    pub fn into_frame(self) -> RenderFrame {
        RenderFrame {
            frame_seq: self.frame_seq,
            resize_epoch: self.resize_epoch,
            lines: self.lines,
            scrolled_lines: self.scrolled_lines,
            visible_base_global: self.visible_base_global,
            visible_rows: self.visible_rows,
            visible_cols: self.visible_cols,
            cursor: self.cursor,
            events: self.events,
        }
    }
}

impl TerminalState {
    pub fn new(rows: u16, cols: u16) -> Self {
        let mut tab_stops = vec![false; cols as usize];
        for i in (0..cols as usize).step_by(8) {
            tab_stops[i] = true;
        }

        Self {
            grid: Grid::new(rows, cols),
            alt_grid: None,
            using_alt: false,
            cursor: CursorState::new(),
            modes: TerminalModes::default(),
            scroll_top: 0,
            scroll_bottom: rows.saturating_sub(1),
            tab_stops,
            title: String::new(),
            title_changed: false,
            shell: ShellIntegration::new(),
            cols,
            rows,
            dcs_buffer: Vec::new(),
            scrolled_off_buffer: Vec::new(),
            scrollback_seq: 0,
            pending_terminal_events: Vec::new(),
            pending_responses: Vec::new(),
            frame_seq: 0,
            resize_epoch: 0,
            active_hyperlink: None,
            image_counter: 0,
            charset_g0_drawing: false,
        }
    }

    /// Drain any queued response bytes (DSR, DA) that should be written back
    /// to the PTY. The reader thread calls this after processing a chunk.
    pub fn take_pending_responses(&mut self) -> Vec<Vec<u8>> {
        std::mem::take(&mut self.pending_responses)
    }

    /// Current frame sequence number.
    pub fn frame_seq(&self) -> u64 {
        self.frame_seq
    }

    /// Current resize generation.
    pub fn resize_epoch(&self) -> u64 {
        self.resize_epoch
    }

    pub fn resize(&mut self, rows: u16, cols: u16) {
        // Main grid shrink moves top visible rows into scrollback. Capture those
        // rows explicitly so the frontend scrollback stays in sync with global
        // row accounting used for block slicing.
        if !self.using_alt && rows < self.rows {
            let lost_rows = (self.rows - rows) as usize;
            let visible_offset = self
                .grid
                .rows
                .len()
                .saturating_sub(self.grid.visible_rows as usize);

            for i in 0..lost_rows {
                let idx = visible_offset + i;
                if idx < self.grid.rows.len() {
                    let spans = self.grid.rows[idx].to_styled_spans();
                    self.scrolled_off_buffer.push(RenderedLine { index: 0, spans });
                    self.scrollback_seq = self.scrollback_seq.saturating_add(1);
                }
            }
        }

        self.grid.resize(rows, cols);
        if let Some(ref mut alt) = self.alt_grid {
            // Alt screen has no scrollback; discard excess rows when shrinking
            alt.resize_no_scrollback(rows, cols);
        }
        self.rows = rows;
        self.cols = cols;
        self.scroll_top = 0;
        self.scroll_bottom = rows.saturating_sub(1);
        self.tab_stops = vec![false; cols as usize];
        for i in (0..cols as usize).step_by(8) {
            self.tab_stops[i] = true;
        }
        self.cursor.row = self.cursor.row.min(rows.saturating_sub(1));
        self.cursor.col = self.cursor.col.min(cols.saturating_sub(1));
        self.resize_epoch = self.resize_epoch.saturating_add(1);
    }

    /// Extract a render snapshot from current terminal state.
    /// Returns None if there are no dirty lines/events/scrolled lines.
    pub fn take_render_snapshot(&mut self) -> Option<RenderSnapshot> {
        let grid = if self.using_alt {
            self.alt_grid.as_mut()?
        } else {
            &mut self.grid
        };

        let visible_rows = grid.visible_rows;
        let visible_cols = grid.cols;
        let dirty_lines: Vec<RenderedLine> = grid.collect_dirty_lines();
        let scrolled_lines = std::mem::take(&mut self.scrolled_off_buffer);
        let events = self.shell.take_pending_events();

        let mut all_events = events;
        all_events.append(&mut self.pending_terminal_events);
        if self.title_changed {
            all_events.push(TerminalEvent::TitleChanged {
                title: self.title.clone(),
            });
            self.title_changed = false;
        }

        if dirty_lines.is_empty() && all_events.is_empty() && scrolled_lines.is_empty() {
            return None;
        }

        let shape_str = match self.cursor.shape {
            CursorShape::Block => "block",
            CursorShape::Underline => "underline",
            CursorShape::Bar => "bar",
        };

        let visible_base_global = if self.using_alt { 0 } else { self.scrollback_seq };
        self.frame_seq = self.frame_seq.saturating_add(1);
        let frame_seq = self.frame_seq;

        Some(RenderSnapshot {
            frame_seq,
            resize_epoch: self.resize_epoch,
            lines: dirty_lines,
            scrolled_lines,
            visible_base_global,
            visible_rows,
            visible_cols,
            cursor: CursorRender {
                row: self.cursor.row,
                col: self.cursor.col,
                visible: self.cursor.visible && self.modes.cursor_visible,
                shape: shape_str.to_string(),
            },
            events: all_events,
        })
    }

    // Helper: get the active grid mutably. Callers must copy any self.* values
    // they need BEFORE calling this, because it borrows &mut self.
    fn active_grid_mut(&mut self) -> &mut Grid {
        if self.using_alt {
            self.alt_grid.as_mut().unwrap()
        } else {
            &mut self.grid
        }
    }

    fn linefeed(&mut self) {
        if self.cursor.row == self.scroll_bottom {
            let top = self.scroll_top;
            let bottom = self.scroll_bottom;
            if let Some(scrolled) = self.active_grid_mut().scroll_up(top, bottom) {
                // Don't capture scrolled lines in alt screen mode (vim, less, etc.)
                if !self.using_alt {
                    self.scrolled_off_buffer.push(scrolled);
                    self.scrollback_seq = self.scrollback_seq.saturating_add(1);
                }
            }
        } else if self.cursor.row < self.rows.saturating_sub(1) {
            self.cursor.row += 1;
        }
    }

    fn global_row(&self) -> u64 {
        self.scrollback_seq + self.cursor.row as u64
    }

    fn reverse_index(&mut self) {
        if self.cursor.row == self.scroll_top {
            let top = self.scroll_top;
            let bottom = self.scroll_bottom;
            self.active_grid_mut().scroll_down(top, bottom);
        } else if self.cursor.row > 0 {
            self.cursor.row -= 1;
        }
    }

    fn carriage_return(&mut self) {
        self.cursor.col = 0;
    }

    fn backspace(&mut self) {
        if self.cursor.col > 0 {
            self.cursor.col -= 1;
        }
    }

    fn tab(&mut self) {
        let col = self.cursor.col as usize + 1;
        for i in col..self.cols as usize {
            if self.tab_stops.get(i).copied().unwrap_or(false) {
                self.cursor.col = i as u16;
                return;
            }
        }
        self.cursor.col = self.cols.saturating_sub(1);
    }

    fn cursor_up(&mut self, n: u16) {
        let min_row = if self.cursor.row >= self.scroll_top && self.cursor.row <= self.scroll_bottom {
            self.scroll_top
        } else {
            0
        };
        self.cursor.row = self.cursor.row.saturating_sub(n).max(min_row);
    }

    fn cursor_down(&mut self, n: u16) {
        let max_row = if self.cursor.row >= self.scroll_top && self.cursor.row <= self.scroll_bottom {
            self.scroll_bottom
        } else {
            self.rows.saturating_sub(1)
        };
        self.cursor.row = (self.cursor.row + n).min(max_row);
    }

    fn cursor_forward(&mut self, n: u16) {
        self.cursor.col = (self.cursor.col + n).min(self.cols.saturating_sub(1));
    }

    fn cursor_backward(&mut self, n: u16) {
        self.cursor.col = self.cursor.col.saturating_sub(n);
    }

    fn erase_display(&mut self, mode: u16) {
        let crow = self.cursor.row;
        let ccol = self.cursor.col;
        let cols = self.cols;
        let rows = self.rows;
        let bg = self.cursor.bg;
        let grid = self.active_grid_mut();
        match mode {
            0 => {
                grid.erase_cells(crow, ccol, cols, bg);
                for r in (crow + 1)..rows {
                    grid.visible_row_mut(r).erase_with_bg(bg);
                }
            }
            1 => {
                for r in 0..crow {
                    grid.visible_row_mut(r).erase_with_bg(bg);
                }
                grid.erase_cells(crow, 0, ccol + 1, bg);
            }
            2 => {
                for r in 0..rows {
                    grid.visible_row_mut(r).erase_with_bg(bg);
                }
            }
            3 => {
                // ED 3 (xterm extension): erase scrollback buffer.
                // Does not affect visible content — only clears history.
                self.scrolled_off_buffer.clear();
                self.pending_terminal_events
                    .push(TerminalEvent::ScrollbackCleared);
            }
            _ => {}
        }
    }

    fn erase_line(&mut self, mode: u16) {
        let crow = self.cursor.row;
        let ccol = self.cursor.col;
        let cols = self.cols;
        let bg = self.cursor.bg;
        let grid = self.active_grid_mut();
        match mode {
            0 => grid.erase_cells(crow, ccol, cols, bg),
            1 => grid.erase_cells(crow, 0, ccol + 1, bg),
            2 => grid.visible_row_mut(crow).erase_with_bg(bg),
            _ => {}
        }
    }

    fn insert_lines(&mut self, n: u16) {
        if self.cursor.row >= self.scroll_top && self.cursor.row <= self.scroll_bottom {
            let crow = self.cursor.row;
            let bottom = self.scroll_bottom;
            for _ in 0..n {
                self.active_grid_mut().scroll_down(crow, bottom);
            }
            self.cursor.col = 0;
        }
    }

    fn delete_lines(&mut self, n: u16) {
        if self.cursor.row >= self.scroll_top && self.cursor.row <= self.scroll_bottom {
            let crow = self.cursor.row;
            let bottom = self.scroll_bottom;
            for _ in 0..n {
                if let Some(scrolled) = self.active_grid_mut().scroll_up(crow, bottom) {
                    if !self.using_alt {
                        self.scrolled_off_buffer.push(scrolled);
                        self.scrollback_seq = self.scrollback_seq.saturating_add(1);
                    }
                }
            }
            self.cursor.col = 0;
        }
    }

    fn erase_chars(&mut self, n: u16) {
        let end = (self.cursor.col + n).min(self.cols);
        let crow = self.cursor.row;
        let ccol = self.cursor.col;
        let bg = self.cursor.bg;
        self.active_grid_mut().erase_cells(crow, ccol, end, bg);
    }

    fn insert_chars(&mut self, n: u16) {
        let crow = self.cursor.row;
        let ccol = self.cursor.col;
        self.active_grid_mut().insert_cells(crow, ccol, n);
    }

    fn delete_chars(&mut self, n: u16) {
        let crow = self.cursor.row;
        let ccol = self.cursor.col;
        self.active_grid_mut().delete_cells(crow, ccol, n);
    }

    fn scroll_up_n(&mut self, n: u16) {
        let top = self.scroll_top;
        let bottom = self.scroll_bottom;
        for _ in 0..n {
            if let Some(scrolled) = self.active_grid_mut().scroll_up(top, bottom) {
                if !self.using_alt {
                    self.scrolled_off_buffer.push(scrolled);
                    self.scrollback_seq = self.scrollback_seq.saturating_add(1);
                }
            }
        }
    }

    fn scroll_down_n(&mut self, n: u16) {
        let top = self.scroll_top;
        let bottom = self.scroll_bottom;
        for _ in 0..n {
            self.active_grid_mut().scroll_down(top, bottom);
        }
    }

    fn save_cursor(&mut self) {
        self.cursor.save();
    }

    fn restore_cursor(&mut self) {
        self.cursor.restore();
    }

    fn enter_alt_screen(&mut self) {
        if !self.using_alt {
            self.alt_grid = Some(Grid::new(self.rows, self.cols));
            self.using_alt = true;
            self.modes.alt_screen = true;
            self.pending_terminal_events.push(TerminalEvent::AltScreenEntered);
        }
    }

    fn exit_alt_screen(&mut self) {
        if self.using_alt {
            self.using_alt = false;
            self.modes.alt_screen = false;
            self.alt_grid = None;
            self.grid.mark_all_dirty();
            self.pending_terminal_events.push(TerminalEvent::AltScreenExited);
        }
    }

    fn clear_screen(&mut self) {
        let rows = self.rows;
        let grid = self.active_grid_mut();
        for r in 0..rows {
            grid.visible_row_mut(r).clear();
        }
        self.cursor.row = 0;
        self.cursor.col = 0;
    }

    fn handle_sgr(&mut self, params: &[u16]) {
        let params = if params.is_empty() {
            &[0u16][..]
        } else {
            params
        };
        let mut i = 0;

        while i < params.len() {
            match params[i] {
                0 => {
                    self.cursor.attrs = CellAttrs::empty();
                    self.cursor.fg = Color::Default;
                    self.cursor.bg = Color::Default;
                }
                1 => self.cursor.attrs.insert(CellAttrs::BOLD),
                2 => self.cursor.attrs.insert(CellAttrs::DIM),
                3 => self.cursor.attrs.insert(CellAttrs::ITALIC),
                4 => self.cursor.attrs.insert(CellAttrs::UNDERLINE),
                5 => self.cursor.attrs.insert(CellAttrs::BLINK),
                7 => self.cursor.attrs.insert(CellAttrs::REVERSE),
                8 => self.cursor.attrs.insert(CellAttrs::HIDDEN),
                9 => self.cursor.attrs.insert(CellAttrs::STRIKETHROUGH),
                22 => {
                    self.cursor.attrs.remove(CellAttrs::BOLD);
                    self.cursor.attrs.remove(CellAttrs::DIM);
                }
                23 => self.cursor.attrs.remove(CellAttrs::ITALIC),
                24 => self.cursor.attrs.remove(CellAttrs::UNDERLINE),
                25 => self.cursor.attrs.remove(CellAttrs::BLINK),
                27 => self.cursor.attrs.remove(CellAttrs::REVERSE),
                28 => self.cursor.attrs.remove(CellAttrs::HIDDEN),
                29 => self.cursor.attrs.remove(CellAttrs::STRIKETHROUGH),
                30..=37 => self.cursor.fg = Color::Indexed(params[i] as u8 - 30),
                38 => {
                    i += 1;
                    if i < params.len() {
                        match params[i] {
                            2 if i + 3 < params.len() => {
                                self.cursor.fg = Color::Rgb(
                                    params[i + 1] as u8,
                                    params[i + 2] as u8,
                                    params[i + 3] as u8,
                                );
                                i += 3;
                            }
                            5 if i + 1 < params.len() => {
                                self.cursor.fg = Color::Indexed(params[i + 1] as u8);
                                i += 1;
                            }
                            _ => {}
                        }
                    }
                }
                39 => self.cursor.fg = Color::Default,
                40..=47 => self.cursor.bg = Color::Indexed(params[i] as u8 - 40),
                48 => {
                    i += 1;
                    if i < params.len() {
                        match params[i] {
                            2 if i + 3 < params.len() => {
                                self.cursor.bg = Color::Rgb(
                                    params[i + 1] as u8,
                                    params[i + 2] as u8,
                                    params[i + 3] as u8,
                                );
                                i += 3;
                            }
                            5 if i + 1 < params.len() => {
                                self.cursor.bg = Color::Indexed(params[i + 1] as u8);
                                i += 1;
                            }
                            _ => {}
                        }
                    }
                }
                49 => self.cursor.bg = Color::Default,
                90..=97 => self.cursor.fg = Color::Indexed(params[i] as u8 - 90 + 8),
                100..=107 => self.cursor.bg = Color::Indexed(params[i] as u8 - 100 + 8),
                _ => {}
            }
            i += 1;
        }
    }

    fn set_dec_mode(&mut self, params: &[u16], enable: bool) {
        for &p in params {
            match p {
                1 => self.modes.cursor_keys_application = enable,
                6 => {
                    self.modes.origin = enable;
                    // DECOM toggle homes cursor
                    if enable {
                        self.cursor.row = self.scroll_top;
                    } else {
                        self.cursor.row = 0;
                    }
                    self.cursor.col = 0;
                }
                7 => self.modes.autowrap = enable,
                12 => {}
                25 => self.modes.cursor_visible = enable,
                47 => {
                    if enable {
                        self.enter_alt_screen();
                    } else {
                        self.exit_alt_screen();
                    }
                }
                1047 => {
                    // Alt screen with clear on enter (no cursor save/restore)
                    if enable {
                        self.enter_alt_screen();
                        self.clear_screen();
                    } else {
                        self.exit_alt_screen();
                    }
                }
                1048 => {
                    // Save/restore cursor (used with mode 1047)
                    if enable {
                        self.save_cursor();
                    } else {
                        self.restore_cursor();
                    }
                }
                1000 => {
                    self.modes.mouse_tracking = enable;
                    self.pending_terminal_events.push(TerminalEvent::MouseModeChanged {
                        tracking: self.modes.mouse_tracking,
                        motion: self.modes.mouse_motion,
                        sgr: self.modes.sgr_mouse,
                        focus: self.modes.focus_events,
                    });
                }
                1002 => {
                    self.modes.mouse_motion = enable;
                    self.pending_terminal_events.push(TerminalEvent::MouseModeChanged {
                        tracking: self.modes.mouse_tracking,
                        motion: self.modes.mouse_motion,
                        sgr: self.modes.sgr_mouse,
                        focus: self.modes.focus_events,
                    });
                }
                1004 => {
                    self.modes.focus_events = enable;
                    self.pending_terminal_events.push(TerminalEvent::MouseModeChanged {
                        tracking: self.modes.mouse_tracking,
                        motion: self.modes.mouse_motion,
                        sgr: self.modes.sgr_mouse,
                        focus: self.modes.focus_events,
                    });
                }
                1006 => {
                    self.modes.sgr_mouse = enable;
                    self.pending_terminal_events.push(TerminalEvent::MouseModeChanged {
                        tracking: self.modes.mouse_tracking,
                        motion: self.modes.mouse_motion,
                        sgr: self.modes.sgr_mouse,
                        focus: self.modes.focus_events,
                    });
                }
                1049 => {
                    if enable {
                        self.save_cursor();
                        self.enter_alt_screen();
                        self.clear_screen();
                    } else {
                        self.exit_alt_screen();
                        self.restore_cursor();
                    }
                }
                2004 => self.modes.bracketed_paste = enable,
                _ => {}
            }
        }
    }

    fn set_mode(&mut self, params: &[u16], enable: bool) {
        for &p in params {
            match p {
                4 => self.modes.insert = enable,
                20 => self.modes.linefeed_newline = enable,
                _ => {}
            }
        }
    }

    fn handle_osc(&mut self, params: &[&[u8]]) {
        if params.is_empty() {
            return;
        }

        let first = std::str::from_utf8(params[0]).unwrap_or("");

        match first {
            "0" | "2" => {
                if params.len() >= 2 {
                    self.title = String::from_utf8_lossy(params[1]).to_string();
                    self.title_changed = true;
                }
            }
            "7" => {
                if params.len() >= 2 {
                    let uri = String::from_utf8_lossy(params[1]);
                    if let Some(path) = uri.strip_prefix("file://") {
                        if let Some(slash_idx) = path.find('/') {
                            self.shell.set_cwd(path[slash_idx..].to_string());
                        }
                    } else {
                        self.shell.set_cwd(uri.to_string());
                    }
                }
            }
            "133" => {
                if params.len() >= 2 {
                    let marker = std::str::from_utf8(params[1]).unwrap_or("");
                    match marker {
                        "A" => {
                            let row = self.global_row();
                            self.shell.prompt_start(row);
                        }
                        "B" => {
                            let cmd: String = params[2..]
                                .iter()
                                .map(|p| String::from_utf8_lossy(p))
                                .collect::<Vec<_>>()
                                .join(";");
                            if !cmd.is_empty() {
                                let row = self.global_row();
                                self.shell.command_start(cmd, row);
                            }
                        }
                        "C" => {}
                        "D" => {
                            let exit_code = params
                                .get(2)
                                .and_then(|p| std::str::from_utf8(p).ok())
                                .and_then(|s| s.parse::<i32>().ok())
                                .unwrap_or(0);
                            let row = self.global_row();
                            self.shell.command_end(exit_code, row);
                        }
                        _ => {}
                    }
                }
            }
            "8" => {
                // OSC 8 - Hyperlink: \x1b]8;params;uri\x1b\\
                // Opening: params;uri (uri non-empty)
                // Closing: params; (uri empty, just ";")
                if params.len() >= 3 {
                    let uri = String::from_utf8_lossy(params[2]).to_string();
                    if uri.is_empty() {
                        self.active_hyperlink = None;
                    } else {
                        self.active_hyperlink = Some(uri);
                    }
                } else if params.len() >= 2 {
                    // Closing tag with just the params separator
                    self.active_hyperlink = None;
                }
            }
            "1337" => {
                // iTerm2 inline image protocol: OSC 1337 ; File=<params>:<base64data> ST
                if params.len() >= 2 {
                    let payload = String::from_utf8_lossy(params[1]).to_string();
                    if let Some(rest) = payload.strip_prefix("File=") {
                        // Parse key=value pairs before the colon
                        if let Some(colon_idx) = rest.find(':') {
                            let param_str = &rest[..colon_idx];
                            let base64_data = &rest[colon_idx + 1..];
                            let mut width: u16 = 0;
                            let mut height: u16 = 0;
                            let mut is_inline = false;

                            for part in param_str.split(';') {
                                if let Some((key, val)) = part.split_once('=') {
                                    match key {
                                        "width" => width = val.parse().unwrap_or(0),
                                        "height" => height = val.parse().unwrap_or(0),
                                        "inline" => is_inline = val == "1",
                                        _ => {}
                                    }
                                }
                            }

                            if is_inline && !base64_data.is_empty() {
                                self.image_counter += 1;
                                let id = format!("img-{}", self.image_counter);
                                self.pending_terminal_events.push(TerminalEvent::InlineImage {
                                    id,
                                    data_base64: base64_data.to_string(),
                                    width,
                                    height,
                                    row: self.cursor.row,
                                    col: self.cursor.col,
                                });
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    pub fn get_text_range(&self, start_row: usize, end_row: usize) -> String {
        let grid = if self.using_alt {
            self.alt_grid.as_ref().unwrap_or(&self.grid)
        } else {
            &self.grid
        };
        let mut lines = Vec::new();
        let offset = grid.rows.len().saturating_sub(grid.visible_rows as usize);

        for row_idx in start_row..end_row.min(grid.visible_rows as usize) {
            let row = &grid.rows[offset + row_idx];
            let line: String = row
                .cells
                .iter()
                .filter(|c| !c.flags.contains(CellFlags::WIDE_SPACER))
                .map(|c| c.c)
                .collect::<String>()
                .trim_end()
                .to_string();
            lines.push(line);
        }

        while lines.last().map_or(false, |l| l.is_empty()) {
            lines.pop();
        }

        lines.join("\n")
    }
}

fn extract_params(params: &vte::Params) -> Vec<u16> {
    params
        .iter()
        .flat_map(|subparams| subparams.iter().copied())
        .collect()
}

fn param(params: &[u16], idx: usize, default: u16) -> u16 {
    params
        .get(idx)
        .copied()
        .filter(|&v| v != 0)
        .unwrap_or(default)
}

/// Map ASCII to DEC Special Graphics (line-drawing) character.
fn dec_line_drawing_char(c: char) -> char {
    match c {
        '`' => '◆', // diamond
        'a' => '▒', // checkerboard
        'j' => '┘',
        'k' => '┐',
        'l' => '┌',
        'm' => '└',
        'n' => '┼',
        'o' => '⎺', // scan 1
        'p' => '⎻', // scan 3
        'q' => '─',
        'r' => '⎼', // scan 7
        's' => '⎽', // scan 9
        't' => '├',
        'u' => '┤',
        'v' => '┴',
        'w' => '┬',
        'x' => '│',
        'y' => '≤',
        'z' => '≥',
        '{' => 'π',
        '|' => '≠',
        '}' => '£',
        '~' => '·',
        _ => c,
    }
}

impl vte::Perform for TerminalState {
    fn print(&mut self, c: char) {
        // Apply DEC Special Graphics charset mapping
        let c = if self.charset_g0_drawing { dec_line_drawing_char(c) } else { c };
        let width = UnicodeWidthChar::width(c).unwrap_or(1) as u16;

        if self.cursor.col >= self.cols {
            if self.modes.autowrap {
                self.carriage_return();
                self.linefeed();
            } else {
                self.cursor.col = self.cols.saturating_sub(1);
            }
        }

        if self.modes.insert {
            let row = self.cursor.row;
            let col = self.cursor.col;
            self.active_grid_mut().insert_cells(row, col, width);
        }

        let row = self.cursor.row;
        let col = self.cursor.col;
        let fg = self.cursor.fg;
        let bg = self.cursor.bg;
        let attrs = self.cursor.attrs;
        let cols = self.cols;

        let cell = Cell {
            c,
            fg,
            bg,
            attrs,
            flags: if width == 2 {
                CellFlags::WIDE_CHAR
            } else {
                CellFlags::empty()
            },
        };

        let grid = self.active_grid_mut();
        grid.set_cell(row, col, cell);

        if width == 2 && col + 1 < cols {
            grid.set_cell(row, col + 1, Cell::wide_spacer());
        }

        self.cursor.col += width;
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            0x07 => {} // BEL
            0x08 => self.backspace(),
            0x09 => self.tab(),
            0x0A | 0x0B | 0x0C => {
                self.linefeed();
                if self.modes.linefeed_newline {
                    self.carriage_return();
                }
            }
            0x0D => self.carriage_return(),
            _ => {}
        }
    }

    fn csi_dispatch(
        &mut self,
        params: &vte::Params,
        intermediates: &[u8],
        _ignore: bool,
        action: char,
    ) {
        let raw = extract_params(params);
        let is_private = intermediates.first() == Some(&b'?');

        match (action, is_private) {
            ('A', false) => self.cursor_up(param(&raw, 0, 1)),
            ('B', false) => self.cursor_down(param(&raw, 0, 1)),
            ('C', false) => self.cursor_forward(param(&raw, 0, 1)),
            ('D', false) => self.cursor_backward(param(&raw, 0, 1)),
            ('E', false) => {
                self.cursor.col = 0;
                self.cursor_down(param(&raw, 0, 1));
            }
            ('F', false) => {
                self.cursor.col = 0;
                self.cursor_up(param(&raw, 0, 1));
            }
            ('G', false) => {
                self.cursor.col = (param(&raw, 0, 1) - 1).min(self.cols.saturating_sub(1));
            }
            ('H' | 'f', false) => {
                let row = param(&raw, 0, 1) - 1;
                if self.modes.origin {
                    self.cursor.row = (self.scroll_top + row).min(self.scroll_bottom);
                } else {
                    self.cursor.row = row.min(self.rows.saturating_sub(1));
                }
                self.cursor.col = (param(&raw, 1, 1) - 1).min(self.cols.saturating_sub(1));
            }
            ('J', false) => self.erase_display(param(&raw, 0, 0)),
            ('K', false) => self.erase_line(param(&raw, 0, 0)),
            ('L', false) => self.insert_lines(param(&raw, 0, 1)),
            ('M', false) => self.delete_lines(param(&raw, 0, 1)),
            ('P', false) => self.delete_chars(param(&raw, 0, 1)),
            ('S', false) => self.scroll_up_n(param(&raw, 0, 1)),
            ('T', false) => self.scroll_down_n(param(&raw, 0, 1)),
            ('X', false) => self.erase_chars(param(&raw, 0, 1)),
            ('@', false) => self.insert_chars(param(&raw, 0, 1)),
            ('d', false) => {
                let row = param(&raw, 0, 1) - 1;
                if self.modes.origin {
                    self.cursor.row = (self.scroll_top + row).min(self.scroll_bottom);
                } else {
                    self.cursor.row = row.min(self.rows.saturating_sub(1));
                }
            }
            ('m', false) => self.handle_sgr(&raw),
            ('r', false) => {
                let top = param(&raw, 0, 1).saturating_sub(1);
                let bottom = param(&raw, 1, self.rows).saturating_sub(1);
                self.scroll_top = top;
                self.scroll_bottom = bottom.min(self.rows.saturating_sub(1));
                self.cursor.row = if self.modes.origin { self.scroll_top } else { 0 };
                self.cursor.col = 0;
            }
            ('h', true) => self.set_dec_mode(&raw, true),
            ('l', true) => self.set_dec_mode(&raw, false),
            ('h', false) => self.set_mode(&raw, true),
            ('l', false) => self.set_mode(&raw, false),
            ('n', false) => {
                // Device Status Report
                match param(&raw, 0, 0) {
                    5 => {
                        // Report terminal status: "OK"
                        self.pending_responses.push(b"\x1b[0n".to_vec());
                    }
                    6 => {
                        // CPR: report cursor position as ESC [ row ; col R (1-based)
                        let response = format!(
                            "\x1b[{};{}R",
                            self.cursor.row + 1,
                            self.cursor.col + 1
                        );
                        self.pending_responses.push(response.into_bytes());
                    }
                    _ => {}
                }
            }
            ('c', false) => {
                // Primary Device Attributes - respond as VT220
                if param(&raw, 0, 0) == 0 {
                    self.pending_responses
                        .push(b"\x1b[?62;22c".to_vec());
                }
            }
            ('s', false) => self.save_cursor(),
            ('u', false) => self.restore_cursor(),
            ('q', false) if intermediates.contains(&b' ') => {
                match param(&raw, 0, 1) {
                    0 | 1 | 2 => self.cursor.shape = CursorShape::Block,
                    3 | 4 => self.cursor.shape = CursorShape::Underline,
                    5 | 6 => self.cursor.shape = CursorShape::Bar,
                    _ => {}
                }
            }
            _ => {}
        }
    }

    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        self.handle_osc(params);
    }

    fn esc_dispatch(&mut self, intermediates: &[u8], _ignore: bool, byte: u8) {
        match (byte, intermediates) {
            (b'c', []) => {
                let rows = self.rows;
                let cols = self.cols;
                let was_using_alt = self.using_alt;
                let frame_seq = self.frame_seq;
                *self = TerminalState::new(rows, cols);
                self.frame_seq = frame_seq;
                self.grid.mark_all_dirty();
                if was_using_alt {
                    self.pending_terminal_events.push(TerminalEvent::AltScreenExited);
                }
            }
            (b'D', []) => self.linefeed(),
            (b'E', []) => {
                self.carriage_return();
                self.linefeed();
            }
            (b'H', []) => {
                let col = self.cursor.col as usize;
                if col < self.tab_stops.len() {
                    self.tab_stops[col] = true;
                }
            }
            (b'M', []) => self.reverse_index(),
            (b'7', []) => self.save_cursor(),
            (b'8', []) => self.restore_cursor(),
            (b'=', []) => self.modes.cursor_keys_application = true,
            (b'>', []) => self.modes.cursor_keys_application = false,
            // SCS G0: DEC Special Graphics (line drawing)
            (b'0', [b'(']) => self.charset_g0_drawing = true,
            // SCS G0: ASCII
            (b'B', [b'(']) => self.charset_g0_drawing = false,
            _ => {}
        }
    }

    fn hook(&mut self, _params: &vte::Params, _intermediates: &[u8], _ignore: bool, _action: char) {
        self.dcs_buffer.clear();
    }

    fn put(&mut self, byte: u8) {
        self.dcs_buffer.push(byte);
    }

    fn unhook(&mut self) {
        self.dcs_buffer.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_bytes(state: &mut TerminalState, bytes: &[u8]) {
        let mut parser = vte::Parser::new();
        for &b in bytes {
            parser.advance(state, b);
        }
    }

    #[test]
    fn private_mode_1049_toggles_alt_screen() {
        let mut state = TerminalState::new(24, 80);
        assert!(!state.using_alt);

        feed_bytes(&mut state, b"\x1b[?1049h");
        assert!(state.using_alt, "expected ?1049h to enter alt screen");

        let enter_events = state
            .pending_terminal_events
            .iter()
            .filter(|e| matches!(e, TerminalEvent::AltScreenEntered))
            .count();
        assert_eq!(enter_events, 1, "expected one AltScreenEntered event");

        feed_bytes(&mut state, b"\x1b[?1049l");
        assert!(!state.using_alt, "expected ?1049l to exit alt screen");

        let exit_events = state
            .pending_terminal_events
            .iter()
            .filter(|e| matches!(e, TerminalEvent::AltScreenExited))
            .count();
        assert_eq!(exit_events, 1, "expected one AltScreenExited event");
    }

    #[test]
    fn cup_positions_to_correct_rows() {
        // Simulate a TUI drawing content at specific rows via CSI H
        let mut state = TerminalState::new(10, 40);
        // Enter alt screen + clear
        feed_bytes(&mut state, b"\x1b[?1049h\x1b[2J");

        // Position to row 3, col 1 and write "Hello"
        feed_bytes(&mut state, b"\x1b[3;1HHello");
        assert_eq!(state.cursor.row, 2, "row should be 2 (0-based) after CSI 3;1 H");

        // Position to row 5, col 1 and write "World"
        feed_bytes(&mut state, b"\x1b[5;1HWorld");
        assert_eq!(state.cursor.row, 4, "row should be 4 (0-based) after CSI 5;1 H");

        // Verify grid content: row 2 should have "Hello", row 4 should have "World"
        let grid = state.alt_grid.as_ref().unwrap();
        let row2_text: String = grid.visible_row(2).cells.iter().take(5).map(|c| c.c).collect();
        let row4_text: String = grid.visible_row(4).cells.iter().take(5).map(|c| c.c).collect();
        assert_eq!(row2_text, "Hello", "row 2 should contain Hello");
        assert_eq!(row4_text, "World", "row 4 should contain World");

        // Row 3 should be blank (spaces)
        let row3_text: String = grid.visible_row(3).cells.iter().take(5).map(|c| c.c).collect();
        assert_eq!(row3_text, "     ", "row 3 should be blank");
    }

    #[test]
    fn origin_mode_offsets_cup_by_scroll_region() {
        let mut state = TerminalState::new(24, 80);
        // Set scroll region to rows 5-20 (1-based: 6-21)
        feed_bytes(&mut state, b"\x1b[6;21r");
        assert_eq!(state.scroll_top, 5);
        assert_eq!(state.scroll_bottom, 20);

        // Enable origin mode
        feed_bytes(&mut state, b"\x1b[?6h");
        assert!(state.modes.origin);
        // Origin mode toggle homes cursor to scroll_top
        assert_eq!(state.cursor.row, 5);

        // CSI 1;1 H should go to scroll_top (row 5, 0-based)
        feed_bytes(&mut state, b"\x1b[1;1H");
        assert_eq!(state.cursor.row, 5, "origin mode: row 1 → scroll_top (5)");

        // CSI 3;1 H should go to scroll_top + 2 = row 7
        feed_bytes(&mut state, b"\x1b[3;1H");
        assert_eq!(state.cursor.row, 7, "origin mode: row 3 → scroll_top + 2 (7)");

        // Disable origin mode
        feed_bytes(&mut state, b"\x1b[?6l");
        assert!(!state.modes.origin);
        assert_eq!(state.cursor.row, 0, "disabling origin mode homes cursor to 0");

        // CSI 3;1 H should go to absolute row 2 (0-based)
        feed_bytes(&mut state, b"\x1b[3;1H");
        assert_eq!(state.cursor.row, 2, "no origin mode: row 3 → absolute 2");
    }

    #[test]
    fn cuu_cud_respect_scroll_region() {
        let mut state = TerminalState::new(24, 80);
        // Set scroll region to rows 5-15 (1-based: 6-16)
        feed_bytes(&mut state, b"\x1b[6;16r");

        // Place cursor at row 10 (inside region)
        feed_bytes(&mut state, b"\x1b[11;1H");
        assert_eq!(state.cursor.row, 10);

        // CUU 20: should stop at scroll_top (5), not 0
        feed_bytes(&mut state, b"\x1b[20A");
        assert_eq!(state.cursor.row, 5, "CUU inside region stops at scroll_top");

        // Place cursor at row 10 again
        feed_bytes(&mut state, b"\x1b[11;1H");

        // CUD 20: should stop at scroll_bottom (15), not 23
        feed_bytes(&mut state, b"\x1b[20B");
        assert_eq!(state.cursor.row, 15, "CUD inside region stops at scroll_bottom");

        // Place cursor outside region (row 2)
        feed_bytes(&mut state, b"\x1b[3;1H");
        assert_eq!(state.cursor.row, 2);

        // CUU 10: should stop at 0 (outside region)
        feed_bytes(&mut state, b"\x1b[10A");
        assert_eq!(state.cursor.row, 0, "CUU outside region stops at 0");

        // Place cursor below region (row 20)
        feed_bytes(&mut state, b"\x1b[21;1H");
        assert_eq!(state.cursor.row, 20);

        // CUD 10: should stop at rows-1=23 (outside region)
        feed_bytes(&mut state, b"\x1b[10B");
        assert_eq!(state.cursor.row, 23, "CUD outside region stops at rows-1");
    }

    #[test]
    fn dec_line_drawing_charset() {
        let mut state = TerminalState::new(4, 20);
        // Enter DEC line drawing mode
        feed_bytes(&mut state, b"\x1b(0");
        assert!(state.charset_g0_drawing);

        // Write 'q' which should become '─'
        feed_bytes(&mut state, b"q");
        let cell = &state.grid.visible_row(0).cells[0];
        assert_eq!(cell.c, '─', "DEC line drawing: 'q' should map to '─'");

        // Write 'x' which should become '│'
        feed_bytes(&mut state, b"x");
        let cell = &state.grid.visible_row(0).cells[1];
        assert_eq!(cell.c, '│', "DEC line drawing: 'x' should map to '│'");

        // Exit DEC line drawing mode
        feed_bytes(&mut state, b"\x1b(B");
        assert!(!state.charset_g0_drawing);

        // Now 'q' should be literal 'q'
        feed_bytes(&mut state, b"q");
        let cell = &state.grid.visible_row(0).cells[2];
        assert_eq!(cell.c, 'q', "ASCII mode: 'q' should be literal 'q'");
    }

    #[test]
    fn collect_dirty_lines_has_correct_indices() {
        let mut state = TerminalState::new(10, 20);
        // Enter alt screen, clear, and draw at specific rows
        feed_bytes(&mut state, b"\x1b[?1049h\x1b[2J");

        // Collect the initial "all dirty" set and discard
        let _ = state.take_render_snapshot();

        // Write to specific rows
        feed_bytes(&mut state, b"\x1b[3;1HAAA\x1b[7;1HBBB");

        let snapshot = state.take_render_snapshot().expect("should have dirty lines");
        // Should have exactly 2 dirty lines (rows 2 and 6, 0-based)
        assert_eq!(snapshot.lines.len(), 2, "should have 2 dirty lines");
        assert_eq!(snapshot.lines[0].index, 2, "first dirty line should be row 2");
        assert_eq!(snapshot.lines[1].index, 6, "second dirty line should be row 6");
    }
}
