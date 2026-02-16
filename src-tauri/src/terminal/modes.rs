/// Terminal mode flags tracking various DEC and ANSI modes.
#[derive(Debug, Clone)]
pub struct TerminalModes {
    /// DECCKM: cursor key mode (application vs normal)
    pub cursor_keys_application: bool,
    /// DECOM: origin mode
    pub origin: bool,
    /// DECAWM: auto-wrap mode
    pub autowrap: bool,
    /// DECTCEM: text cursor visible
    pub cursor_visible: bool,
    /// Mouse tracking (mode 1000)
    pub mouse_tracking: bool,
    /// Mouse motion tracking (mode 1002)
    pub mouse_motion: bool,
    /// SGR mouse reporting (mode 1006)
    pub sgr_mouse: bool,
    /// Bracketed paste mode (mode 2004)
    pub bracketed_paste: bool,
    /// Focus events (mode 1004)
    pub focus_events: bool,
    /// Alternate screen active
    pub alt_screen: bool,
    /// Insert mode (IRM)
    pub insert: bool,
    /// Line feed / new line mode (LNM)
    pub linefeed_newline: bool,
}

impl Default for TerminalModes {
    fn default() -> Self {
        Self {
            cursor_keys_application: false,
            origin: false,
            autowrap: true,
            cursor_visible: true,
            mouse_tracking: false,
            mouse_motion: false,
            sgr_mouse: false,
            bracketed_paste: false,
            focus_events: false,
            alt_screen: false,
            insert: false,
            linefeed_newline: false,
        }
    }
}
