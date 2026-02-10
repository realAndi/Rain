// Keyboard event to terminal byte sequence encoder.
// Converts DOM KeyboardEvents into the byte sequences terminals expect.

const encoder = new TextEncoder();

export function keyEventToBytes(e: KeyboardEvent, optionAsMeta: boolean = true): Uint8Array {
  // Cmd+C / Cmd+V should be handled by the OS, not sent to terminal
  if (e.metaKey && (e.key === "c" || e.key === "v" || e.key === "a" || e.key === "x")) {
    return new Uint8Array([]);
  }

  // Ctrl+key combinations (C0 control codes)
  if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
    const code = e.key.toLowerCase().charCodeAt(0);
    if (code >= 97 && code <= 122) {
      // Ctrl+A = 0x01, Ctrl+B = 0x02, ..., Ctrl+Z = 0x1A
      return new Uint8Array([code - 96]);
    }
    // Special ctrl combos
    switch (e.key) {
      case "[":
        return new Uint8Array([0x1b]); // ESC
      case "\\":
        return new Uint8Array([0x1c]); // FS
      case "]":
        return new Uint8Array([0x1d]); // GS
      case "^":
        return new Uint8Array([0x1e]); // RS
      case "_":
        return new Uint8Array([0x1f]); // US
      case " ":
        return new Uint8Array([0x00]); // NUL
    }
  }

  // Alt/Option key as Meta (sends ESC prefix)
  if (e.altKey && optionAsMeta && !e.ctrlKey && !e.metaKey && e.key.length === 1) {
    const charBytes = encoder.encode(e.key);
    const result = new Uint8Array(1 + charBytes.length);
    result[0] = 0x1b; // ESC prefix for Meta
    result.set(charBytes, 1);
    return result;
  }

  // Special keys
  switch (e.key) {
    case "Enter":
      // Shift+Enter inserts a literal newline instead of submitting
      if (e.shiftKey) return new Uint8Array([0x0a]);
      return new Uint8Array([0x0d]);
    case "Tab":
      return e.shiftKey
        ? new Uint8Array([0x1b, 0x5b, 0x5a]) // ESC[Z (back-tab)
        : new Uint8Array([0x09]);
    case "Backspace":
      return new Uint8Array([0x7f]);
    case "Escape":
      return new Uint8Array([0x1b]);
    case "Delete":
      return new Uint8Array([0x1b, 0x5b, 0x33, 0x7e]); // ESC[3~

    // Arrow keys
    case "ArrowUp":
      return modifiedKey(e, 0x41);
    case "ArrowDown":
      return modifiedKey(e, 0x42);
    case "ArrowRight":
      return modifiedKey(e, 0x43);
    case "ArrowLeft":
      return modifiedKey(e, 0x44);

    // Navigation
    case "Home":
      return new Uint8Array([0x1b, 0x5b, 0x48]);
    case "End":
      return new Uint8Array([0x1b, 0x5b, 0x46]);
    case "PageUp":
      return new Uint8Array([0x1b, 0x5b, 0x35, 0x7e]);
    case "PageDown":
      return new Uint8Array([0x1b, 0x5b, 0x36, 0x7e]);
    case "Insert":
      return new Uint8Array([0x1b, 0x5b, 0x32, 0x7e]);

    // Function keys
    case "F1":
      return new Uint8Array([0x1b, 0x4f, 0x50]);
    case "F2":
      return new Uint8Array([0x1b, 0x4f, 0x51]);
    case "F3":
      return new Uint8Array([0x1b, 0x4f, 0x52]);
    case "F4":
      return new Uint8Array([0x1b, 0x4f, 0x53]);
    case "F5":
      return new Uint8Array([0x1b, 0x5b, 0x31, 0x35, 0x7e]);
    case "F6":
      return new Uint8Array([0x1b, 0x5b, 0x31, 0x37, 0x7e]);
    case "F7":
      return new Uint8Array([0x1b, 0x5b, 0x31, 0x38, 0x7e]);
    case "F8":
      return new Uint8Array([0x1b, 0x5b, 0x31, 0x39, 0x7e]);
    case "F9":
      return new Uint8Array([0x1b, 0x5b, 0x32, 0x30, 0x7e]);
    case "F10":
      return new Uint8Array([0x1b, 0x5b, 0x32, 0x31, 0x7e]);
    case "F11":
      return new Uint8Array([0x1b, 0x5b, 0x32, 0x33, 0x7e]);
    case "F12":
      return new Uint8Array([0x1b, 0x5b, 0x32, 0x34, 0x7e]);

    default:
      // Regular printable characters
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        return encoder.encode(e.key);
      }
      return new Uint8Array([]);
  }
}

// Build a modified arrow/cursor key sequence with shift/alt/ctrl modifiers
function modifiedKey(e: KeyboardEvent, finalByte: number): Uint8Array {
  const mod_ = modifierCode(e);
  if (mod_ > 1) {
    // ESC[1;<mod><final>
    const modStr = mod_.toString();
    const bytes = [0x1b, 0x5b, 0x31, 0x3b];
    for (const ch of modStr) {
      bytes.push(ch.charCodeAt(0));
    }
    bytes.push(finalByte);
    return new Uint8Array(bytes);
  }
  return new Uint8Array([0x1b, 0x5b, finalByte]);
}

function modifierCode(e: KeyboardEvent): number {
  let code = 1;
  if (e.shiftKey) code += 1;
  if (e.altKey) code += 2;
  if (e.ctrlKey) code += 4;
  return code;
}
