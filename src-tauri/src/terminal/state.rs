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
        }
    }

    pub fn resize(&mut self, rows: u16, cols: u16) {
        self.grid.resize(rows, cols);
        if let Some(ref mut alt) = self.alt_grid {
            alt.resize(rows, cols);
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
    }

    pub fn generate_render_frame(&mut self) -> Option<RenderFrame> {
        let grid = if self.using_alt {
            self.alt_grid.as_mut()?
        } else {
            &mut self.grid
        };

        let dirty_lines: Vec<RenderedLine> = grid.collect_dirty_lines();
        let scrolled_lines = std::mem::take(&mut self.scrolled_off_buffer);
        let events = self.shell.take_pending_events();

        let mut all_events = events;
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

        Some(RenderFrame {
            lines: dirty_lines,
            scrolled_lines,
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
        self.cursor.row = self.cursor.row.saturating_sub(n);
    }

    fn cursor_down(&mut self, n: u16) {
        self.cursor.row = (self.cursor.row + n).min(self.rows.saturating_sub(1));
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
        let grid = self.active_grid_mut();
        match mode {
            0 => {
                grid.erase_cells(crow, ccol, cols);
                for r in (crow + 1)..rows {
                    grid.visible_row_mut(r).clear();
                }
            }
            1 => {
                for r in 0..crow {
                    grid.visible_row_mut(r).clear();
                }
                grid.erase_cells(crow, 0, ccol + 1);
            }
            2 | 3 => {
                for r in 0..rows {
                    grid.visible_row_mut(r).clear();
                }
            }
            _ => {}
        }
    }

    fn erase_line(&mut self, mode: u16) {
        let crow = self.cursor.row;
        let ccol = self.cursor.col;
        let cols = self.cols;
        let grid = self.active_grid_mut();
        match mode {
            0 => grid.erase_cells(crow, ccol, cols),
            1 => grid.erase_cells(crow, 0, ccol + 1),
            2 => grid.visible_row_mut(crow).clear(),
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
        self.active_grid_mut().erase_cells(crow, ccol, end);
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
        }
    }

    fn exit_alt_screen(&mut self) {
        if self.using_alt {
            self.using_alt = false;
            self.modes.alt_screen = false;
            self.alt_grid = None;
            self.grid.mark_all_dirty();
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
                6 => self.modes.origin = enable,
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
                1000 => self.modes.mouse_tracking = enable,
                1002 => self.modes.mouse_motion = enable,
                1004 => self.modes.focus_events = enable,
                1006 => self.modes.sgr_mouse = enable,
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

impl vte::Perform for TerminalState {
    fn print(&mut self, c: char) {
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
                self.cursor.row = (param(&raw, 0, 1) - 1).min(self.rows.saturating_sub(1));
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
                self.cursor.row = (param(&raw, 0, 1) - 1).min(self.rows.saturating_sub(1));
            }
            ('m', false) => self.handle_sgr(&raw),
            ('r', false) => {
                let top = param(&raw, 0, 1).saturating_sub(1);
                let bottom = param(&raw, 1, self.rows).saturating_sub(1);
                self.scroll_top = top;
                self.scroll_bottom = bottom.min(self.rows.saturating_sub(1));
                self.cursor.row = 0;
                self.cursor.col = 0;
            }
            ('h', true) => self.set_dec_mode(&raw, true),
            ('l', true) => self.set_dec_mode(&raw, false),
            ('h', false) => self.set_mode(&raw, true),
            ('l', false) => self.set_mode(&raw, false),
            ('n', false) => {}
            ('c', false) => {}
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
                *self = TerminalState::new(rows, cols);
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
