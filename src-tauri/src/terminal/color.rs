use serde::Serialize;

/// Terminal color representation supporting 16-color, 256-color, and truecolor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Color {
    Default,
    Indexed(u8),
    Rgb(u8, u8, u8),
}

impl Default for Color {
    fn default() -> Self {
        Color::Default
    }
}

/// Serializable color for IPC transport to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum SerializableColor {
    Default,
    Indexed { index: u8 },
    Rgb { r: u8, g: u8, b: u8 },
}

impl From<Color> for SerializableColor {
    fn from(c: Color) -> Self {
        match c {
            Color::Default => SerializableColor::Default,
            Color::Indexed(i) => SerializableColor::Indexed { index: i },
            Color::Rgb(r, g, b) => SerializableColor::Rgb { r, g, b },
        }
    }
}

/// Convert a 256-color index to an RGB tuple for the frontend.
/// The first 16 are the standard ANSI colors (theme-dependent),
/// 16-231 are a 6x6x6 color cube, 232-255 are a grayscale ramp.
#[allow(dead_code)]
pub fn indexed_to_rgb(index: u8) -> (u8, u8, u8) {
    match index {
        // Standard ANSI colors (Tokyo Night — matches frontend ANSI_COLORS)
        0 => (0x15, 0x16, 0x1e),   // black
        1 => (0xf7, 0x76, 0x8e),   // red
        2 => (0x9e, 0xce, 0x6a),   // green
        3 => (0xe0, 0xaf, 0x68),   // yellow
        4 => (0x7a, 0xa2, 0xf7),   // blue
        5 => (0xbb, 0x9a, 0xf7),   // magenta
        6 => (0x7d, 0xcf, 0xff),   // cyan
        7 => (0xa9, 0xb1, 0xd6),   // white
        8 => (0x41, 0x48, 0x68),   // bright black
        9 => (0xff, 0x9e, 0x9e),   // bright red
        10 => (0xb9, 0xf2, 0x7c),  // bright green
        11 => (0xff, 0x9e, 0x64),  // bright yellow
        12 => (0x82, 0xaa, 0xff),  // bright blue
        13 => (0xd4, 0xb0, 0xff),  // bright magenta
        14 => (0xa9, 0xe1, 0xff),  // bright cyan
        15 => (0xc0, 0xca, 0xf5),  // bright white
        // 6x6x6 color cube
        16..=231 => {
            let idx = index - 16;
            let r = idx / 36;
            let g = (idx % 36) / 6;
            let b = idx % 6;
            let to_val = |v: u8| if v == 0 { 0 } else { 55 + 40 * v };
            (to_val(r), to_val(g), to_val(b))
        }
        // Grayscale ramp
        232..=255 => {
            let v = 8 + 10 * (index - 232);
            (v, v, v)
        }
    }
}
