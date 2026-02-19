/// Parse tmux control mode notifications from stdout lines.
///
/// Control mode emits lines prefixed with `%`. Each notification type has a
/// specific format documented in tmux(1) § CONTROL MODE.

/// A parsed tmux control mode notification.
#[derive(Debug, Clone)]
pub enum TmuxNotification {
    /// `%output %<pane_id> <data>` — pane produced output.
    /// The data uses octal escapes for non-printable bytes.
    Output { pane_id: u32, data: Vec<u8> },

    /// `%layout-change @<window_id> <layout_string>` — pane geometry changed.
    LayoutChange {
        window_id: u32,
        layout: String,
    },

    /// `%window-add @<window_id>`
    WindowAdd { window_id: u32 },

    /// `%window-close @<window_id>`
    WindowClose { window_id: u32 },

    /// `%window-renamed @<window_id> <name>`
    WindowRenamed { window_id: u32, name: String },

    /// `%session-changed $<session_id> <name>`
    SessionChanged { session_id: u32, name: String },

    /// `%sessions-changed`
    SessionsChanged,

    /// `%begin <time> <number> <flags>` — start of a command response block.
    Begin { number: u64 },

    /// `%end <time> <number> <flags>` — end of a command response block.
    End { number: u64 },

    /// `%error <time> <number> <flags>` — command error.
    Error { number: u64, message: String },

    /// `%exit [<reason>]` — control mode ended.
    Exit { reason: String },

    /// `%pane-mode-changed %<pane_id>`
    PaneModeChanged { pane_id: u32 },

    /// A line that doesn't match any known notification (data within a
    /// %begin/%end block, or something we don't handle yet).
    Unknown(String),
}

/// Parse a single line of control mode output into a `TmuxNotification`.
pub fn parse_notification(line: &str) -> TmuxNotification {
    if !line.starts_with('%') {
        return TmuxNotification::Unknown(line.to_string());
    }

    // Split on first space to get the notification type
    let (tag, rest) = match line.find(' ') {
        Some(idx) => (&line[..idx], line[idx + 1..].trim_end()),
        None => (line, ""),
    };

    match tag {
        "%output" => parse_output(rest),
        "%layout-change" => parse_layout_change(rest),
        "%window-add" => TmuxNotification::WindowAdd { window_id: parse_window_id_raw(rest) },
        "%window-close" => TmuxNotification::WindowClose { window_id: parse_window_id_raw(rest) },
        "%window-renamed" => parse_window_renamed(rest),
        "%session-changed" => parse_session_changed(rest),
        "%sessions-changed" => TmuxNotification::SessionsChanged,
        "%begin" => parse_begin_end(rest, true),
        "%end" => parse_begin_end(rest, false),
        "%error" => parse_error(rest),
        "%exit" => TmuxNotification::Exit {
            reason: rest.to_string(),
        },
        "%pane-mode-changed" => {
            let pane_id = rest
                .trim_start_matches('%')
                .parse::<u32>()
                .unwrap_or(0);
            TmuxNotification::PaneModeChanged { pane_id }
        }
        _ => TmuxNotification::Unknown(line.to_string()),
    }
}

fn parse_output(rest: &str) -> TmuxNotification {
    // Format: %<pane_id> <data>
    let (pane_part, data_part) = match rest.find(' ') {
        Some(idx) => (&rest[..idx], &rest[idx + 1..]),
        None => (rest, ""),
    };

    let pane_id = pane_part
        .trim_start_matches('%')
        .parse::<u32>()
        .unwrap_or(0);

    let data = decode_octal_escapes(data_part);

    TmuxNotification::Output { pane_id, data }
}

fn parse_layout_change(rest: &str) -> TmuxNotification {
    // Format: @<window_id> <layout_string>
    let (win_part, layout_part) = match rest.find(' ') {
        Some(idx) => (&rest[..idx], rest[idx + 1..].to_string()),
        None => (rest, String::new()),
    };

    let window_id = win_part
        .trim_start_matches('@')
        .parse::<u32>()
        .unwrap_or(0);

    TmuxNotification::LayoutChange {
        window_id,
        layout: layout_part,
    }
}

fn parse_window_id_raw(rest: &str) -> u32 {
    rest.trim()
        .trim_start_matches('@')
        .parse::<u32>()
        .unwrap_or(0)
}

fn parse_window_renamed(rest: &str) -> TmuxNotification {
    // Format: @<window_id> <name>
    let (win_part, name) = match rest.find(' ') {
        Some(idx) => (&rest[..idx], rest[idx + 1..].to_string()),
        None => (rest, String::new()),
    };

    let window_id = win_part
        .trim_start_matches('@')
        .parse::<u32>()
        .unwrap_or(0);

    TmuxNotification::WindowRenamed { window_id, name }
}

fn parse_session_changed(rest: &str) -> TmuxNotification {
    // Format: $<session_id> <name>
    let (sid_part, name) = match rest.find(' ') {
        Some(idx) => (&rest[..idx], rest[idx + 1..].to_string()),
        None => (rest, String::new()),
    };

    let session_id = sid_part
        .trim_start_matches('$')
        .parse::<u32>()
        .unwrap_or(0);

    TmuxNotification::SessionChanged { session_id, name }
}

fn parse_begin_end(rest: &str, is_begin: bool) -> TmuxNotification {
    // Format: <time> <number> <flags>
    let parts: Vec<&str> = rest.splitn(3, ' ').collect();
    let number = parts.get(1).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);

    if is_begin {
        TmuxNotification::Begin { number }
    } else {
        TmuxNotification::End { number }
    }
}

fn parse_error(rest: &str) -> TmuxNotification {
    // Format: <time> <number> <flags>
    // Followed by error message lines until %end
    let parts: Vec<&str> = rest.splitn(3, ' ').collect();
    let number = parts.get(1).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);

    TmuxNotification::Error {
        number,
        message: String::new(),
    }
}

/// Decode tmux's octal-escaped output data.
///
/// tmux control mode encodes non-printable bytes as `\ooo` (3-digit octal).
/// Backslash itself is encoded as `\\`.
pub fn decode_octal_escapes(input: &str) -> Vec<u8> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            if bytes[i + 1] == b'\\' {
                out.push(b'\\');
                i += 2;
            } else if i + 3 < bytes.len()
                && bytes[i + 1].is_ascii_digit()
                && bytes[i + 2].is_ascii_digit()
                && bytes[i + 3].is_ascii_digit()
            {
                let val = (bytes[i + 1] - b'0') as u16 * 64
                    + (bytes[i + 2] - b'0') as u16 * 8
                    + (bytes[i + 3] - b'0') as u16;
                out.push(val as u8);
                i += 4;
            } else {
                out.push(bytes[i]);
                i += 1;
            }
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }

    out
}

/// Parse a tmux layout string into a flat list of pane geometries.
///
/// tmux layout format: `<checksum>,<width>x<height>,<x>,<y>[{<children>}|[<children>]]`
/// Curly braces `{}` indicate horizontal split, square brackets `[]` indicate vertical split.
#[derive(Debug, Clone)]
pub struct PaneGeometry {
    pub pane_id: Option<u32>,
    pub width: u16,
    pub height: u16,
    pub x: u16,
    pub y: u16,
}

/// Layout tree node produced by parsing tmux layout strings.
#[derive(Debug, Clone)]
pub enum LayoutNode {
    Leaf(PaneGeometry),
    HSplit {
        width: u16,
        height: u16,
        children: Vec<LayoutNode>,
    },
    VSplit {
        width: u16,
        height: u16,
        children: Vec<LayoutNode>,
    },
}

/// Parse a complete tmux layout string (including the checksum prefix).
pub fn parse_layout(input: &str) -> Option<LayoutNode> {
    // Strip the checksum: "xxxx,<rest>"
    let rest = input.find(',').map(|i| &input[i + 1..])?;
    let (node, _) = parse_layout_node(rest)?;
    Some(node)
}

fn parse_layout_node(input: &str) -> Option<(LayoutNode, &str)> {
    // Parse: <width>x<height>,<x>,<y>[,<pane_id>][{<children>}|[<children>]]
    let (width, rest) = parse_u16_until(input, 'x')?;
    let (height, rest) = parse_u16_until(rest, ',')?;
    let (x, rest) = parse_u16_until(rest, ',')?;

    // y might be followed by comma (pane_id), open brace, or end
    let (y, rest) = parse_u16_terminated(rest)?;

    if rest.starts_with(',') {
        let rest = &rest[1..];
        // Could be a pane_id followed by optional children, or just children
        if let Some((pane_id, remaining)) = parse_u16_terminated(rest) {
            // Check for children after the pane_id
            if remaining.starts_with('{') || remaining.starts_with('[') {
                return parse_children(remaining, width, height);
            }
            return Some((
                LayoutNode::Leaf(PaneGeometry {
                    pane_id: Some(pane_id as u32),
                    width,
                    height,
                    x,
                    y,
                }),
                remaining,
            ));
        }
    }

    if rest.starts_with('{') || rest.starts_with('[') {
        return parse_children(rest, width, height);
    }

    Some((
        LayoutNode::Leaf(PaneGeometry {
            pane_id: None,
            width,
            height,
            x,
            y,
        }),
        rest,
    ))
}

fn parse_children(input: &str, width: u16, height: u16) -> Option<(LayoutNode, &str)> {
    let (is_hsplit, close_char) = if input.starts_with('{') {
        (true, '}')
    } else {
        (false, ']')
    };

    let mut rest = &input[1..];
    let mut children = Vec::new();

    loop {
        if rest.starts_with(close_char) {
            rest = &rest[1..];
            break;
        }
        if rest.starts_with(',') {
            rest = &rest[1..];
        }
        if rest.is_empty() {
            break;
        }
        let (child, remaining) = parse_layout_node(rest)?;
        children.push(child);
        rest = remaining;
    }

    let node = if is_hsplit {
        LayoutNode::HSplit {
            width,
            height,
            children,
        }
    } else {
        LayoutNode::VSplit {
            width,
            height,
            children,
        }
    };

    Some((node, rest))
}

fn parse_u16_until(input: &str, delim: char) -> Option<(u16, &str)> {
    let idx = input.find(delim)?;
    let val = input[..idx].parse::<u16>().ok()?;
    Some((val, &input[idx + 1..]))
}

fn parse_u16_terminated(input: &str) -> Option<(u16, &str)> {
    let end = input
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(input.len());
    if end == 0 {
        return None;
    }
    let val = input[..end].parse::<u16>().ok()?;
    Some((val, &input[end..]))
}

/// Collect all leaf panes from a layout tree in order.
pub fn collect_leaf_panes(node: &LayoutNode) -> Vec<PaneGeometry> {
    let mut panes = Vec::new();
    collect_leaves_recursive(node, &mut panes);
    panes
}

fn collect_leaves_recursive(node: &LayoutNode, panes: &mut Vec<PaneGeometry>) {
    match node {
        LayoutNode::Leaf(geo) => panes.push(geo.clone()),
        LayoutNode::HSplit { children, .. } | LayoutNode::VSplit { children, .. } => {
            for child in children {
                collect_leaves_recursive(child, panes);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_simple_text() {
        let input = "hello world";
        assert_eq!(decode_octal_escapes(input), b"hello world");
    }

    #[test]
    fn decode_octal_escapes_for_escape_char() {
        // \033 = ESC (0x1b)
        let input = r"\033[31m";
        assert_eq!(decode_octal_escapes(input), b"\x1b[31m");
    }

    #[test]
    fn decode_escaped_backslash() {
        let input = r"foo\\bar";
        assert_eq!(decode_octal_escapes(input), b"foo\\bar");
    }

    #[test]
    fn decode_carriage_return_and_newline() {
        let input = r"line1\015\012line2";
        assert_eq!(decode_octal_escapes(input), b"line1\r\nline2");
    }

    #[test]
    fn parse_output_notification() {
        let line = r"%output %0 hello\033[0m";
        match parse_notification(line) {
            TmuxNotification::Output { pane_id, data } => {
                assert_eq!(pane_id, 0);
                assert_eq!(data, b"hello\x1b[0m");
            }
            other => panic!("expected Output, got {:?}", other),
        }
    }

    #[test]
    fn parse_window_add_notification() {
        let line = "%window-add @1";
        match parse_notification(line) {
            TmuxNotification::WindowAdd { window_id } => assert_eq!(window_id, 1),
            other => panic!("expected WindowAdd, got {:?}", other),
        }
    }

    #[test]
    fn parse_layout_single_pane() {
        // Single pane: checksum,80x24,0,0,0
        let layout = "ab12,80x24,0,0,0";
        let node = parse_layout(layout).expect("should parse single pane");
        match node {
            LayoutNode::Leaf(geo) => {
                assert_eq!(geo.width, 80);
                assert_eq!(geo.height, 24);
                assert_eq!(geo.pane_id, Some(0));
            }
            _ => panic!("expected Leaf"),
        }
    }

    #[test]
    fn parse_exit_notification() {
        let line = "%exit client detached";
        match parse_notification(line) {
            TmuxNotification::Exit { reason } => assert_eq!(reason, "client detached"),
            other => panic!("expected Exit, got {:?}", other),
        }
    }

    #[test]
    fn parse_layout_horizontal_split() {
        // Two panes side by side: {left,right}
        let layout = "ab12,160x48,0,0{80x48,0,0,0,80x48,80,0,1}";
        let node = parse_layout(layout).expect("should parse hsplit");
        match node {
            LayoutNode::HSplit { width, height, children } => {
                assert_eq!(width, 160);
                assert_eq!(height, 48);
                assert_eq!(children.len(), 2);
                match &children[0] {
                    LayoutNode::Leaf(geo) => {
                        assert_eq!(geo.width, 80);
                        assert_eq!(geo.pane_id, Some(0));
                    }
                    _ => panic!("expected first child to be Leaf"),
                }
                match &children[1] {
                    LayoutNode::Leaf(geo) => {
                        assert_eq!(geo.width, 80);
                        assert_eq!(geo.pane_id, Some(1));
                    }
                    _ => panic!("expected second child to be Leaf"),
                }
            }
            _ => panic!("expected HSplit"),
        }
    }

    #[test]
    fn parse_layout_vertical_split() {
        // Two panes stacked: [top,bottom]
        let layout = "ab12,80x48,0,0[80x24,0,0,0,80x24,0,24,1]";
        let node = parse_layout(layout).expect("should parse vsplit");
        match node {
            LayoutNode::VSplit { width, height, children } => {
                assert_eq!(width, 80);
                assert_eq!(height, 48);
                assert_eq!(children.len(), 2);
                match &children[0] {
                    LayoutNode::Leaf(geo) => {
                        assert_eq!(geo.height, 24);
                        assert_eq!(geo.pane_id, Some(0));
                    }
                    _ => panic!("expected top child to be Leaf"),
                }
                match &children[1] {
                    LayoutNode::Leaf(geo) => {
                        assert_eq!(geo.height, 24);
                        assert_eq!(geo.y, 24);
                        assert_eq!(geo.pane_id, Some(1));
                    }
                    _ => panic!("expected bottom child to be Leaf"),
                }
            }
            _ => panic!("expected VSplit"),
        }
    }

    #[test]
    fn parse_layout_nested_split() {
        // Left pane + right column split vertically
        let layout = "ab12,160x48,0,0{80x48,0,0,0,80x48,80,0[80x24,80,0,1,80x24,80,24,2]}";
        let node = parse_layout(layout).expect("should parse nested");
        match node {
            LayoutNode::HSplit { children, .. } => {
                assert_eq!(children.len(), 2);
                assert!(matches!(children[0], LayoutNode::Leaf(_)));
                match &children[1] {
                    LayoutNode::VSplit { children: inner, .. } => {
                        assert_eq!(inner.len(), 2);
                    }
                    _ => panic!("expected nested VSplit"),
                }
            }
            _ => panic!("expected HSplit at root"),
        }
    }

    #[test]
    fn collect_leaf_panes_from_nested_layout() {
        let layout = "ab12,160x48,0,0{80x48,0,0,0,80x48,80,0[80x24,80,0,1,80x24,80,24,2]}";
        let node = parse_layout(layout).expect("should parse");
        let leaves = collect_leaf_panes(&node);
        assert_eq!(leaves.len(), 3);
        assert_eq!(leaves[0].pane_id, Some(0));
        assert_eq!(leaves[1].pane_id, Some(1));
        assert_eq!(leaves[2].pane_id, Some(2));
    }

    #[test]
    fn parse_layout_change_notification() {
        let line = "%layout-change @1 ab12,80x24,0,0,0";
        match parse_notification(line) {
            TmuxNotification::LayoutChange { window_id, layout } => {
                assert_eq!(window_id, 1);
                assert_eq!(layout, "ab12,80x24,0,0,0");
            }
            other => panic!("expected LayoutChange, got {:?}", other),
        }
    }

    #[test]
    fn parse_window_renamed_notification() {
        let line = "%window-renamed @3 my-project";
        match parse_notification(line) {
            TmuxNotification::WindowRenamed { window_id, name } => {
                assert_eq!(window_id, 3);
                assert_eq!(name, "my-project");
            }
            other => panic!("expected WindowRenamed, got {:?}", other),
        }
    }

    #[test]
    fn parse_session_changed_notification() {
        let line = "%session-changed $2 dev";
        match parse_notification(line) {
            TmuxNotification::SessionChanged { session_id, name } => {
                assert_eq!(session_id, 2);
                assert_eq!(name, "dev");
            }
            other => panic!("expected SessionChanged, got {:?}", other),
        }
    }

    #[test]
    fn parse_begin_end_notifications() {
        let begin = "%begin 1234567890 42 0";
        match parse_notification(begin) {
            TmuxNotification::Begin { number } => assert_eq!(number, 42),
            other => panic!("expected Begin, got {:?}", other),
        }

        let end = "%end 1234567890 42 0";
        match parse_notification(end) {
            TmuxNotification::End { number } => assert_eq!(number, 42),
            other => panic!("expected End, got {:?}", other),
        }
    }

    #[test]
    fn parse_unknown_line() {
        let line = "some random output";
        match parse_notification(line) {
            TmuxNotification::Unknown(s) => assert_eq!(s, "some random output"),
            other => panic!("expected Unknown, got {:?}", other),
        }
    }

    #[test]
    fn parse_window_close_notification() {
        let line = "%window-close @5";
        match parse_notification(line) {
            TmuxNotification::WindowClose { window_id } => assert_eq!(window_id, 5),
            other => panic!("expected WindowClose, got {:?}", other),
        }
    }
}
