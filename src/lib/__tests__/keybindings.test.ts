import { describe, it, expect } from "vitest";
import {
  matchesKeybinding,
  formatKeybinding,
  DEFAULT_KEYBINDINGS,
  type Keybinding,
} from "../keybindings";

function makeKeyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "",
    code: "",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  } as KeyboardEvent;
}

describe("matchesKeybinding", () => {
  // In Node test env, isMac = false, so defaults use ctrl instead of meta

  it("matches default new-tab binding (Ctrl+T)", () => {
    const e = makeKeyEvent({ key: "t", ctrlKey: true });
    expect(matchesKeybinding(e, "new-tab")).toBe(true);
  });

  it("rejects when wrong modifier is used", () => {
    const e = makeKeyEvent({ key: "t", metaKey: true });
    expect(matchesKeybinding(e, "new-tab")).toBe(false);
  });

  it("rejects when extra modifier is pressed", () => {
    const e = makeKeyEvent({ key: "t", ctrlKey: true, shiftKey: true });
    expect(matchesKeybinding(e, "new-tab")).toBe(false);
  });

  it("matches case-insensitively", () => {
    const e = makeKeyEvent({ key: "T", ctrlKey: true });
    expect(matchesKeybinding(e, "new-tab")).toBe(true);
  });

  it("matches next-tab binding (Ctrl+Tab)", () => {
    const e = makeKeyEvent({ key: "Tab", ctrlKey: true });
    expect(matchesKeybinding(e, "next-tab")).toBe(true);
  });

  it("matches prev-tab binding (Ctrl+Shift+Tab)", () => {
    const e = makeKeyEvent({ key: "Tab", ctrlKey: true, shiftKey: true });
    expect(matchesKeybinding(e, "prev-tab")).toBe(true);
  });

  it("returns false for unknown action", () => {
    const e = makeKeyEvent({ key: "z", ctrlKey: true });
    expect(matchesKeybinding(e, "nonexistent-action")).toBe(false);
  });

  it("rejects when no modifiers but binding requires them", () => {
    const e = makeKeyEvent({ key: "t" });
    expect(matchesKeybinding(e, "new-tab")).toBe(false);
  });
});

describe("formatKeybinding", () => {
  // In Node test env, isMac = false, so separator is "+"

  it("formats single key with ctrl", () => {
    const binding: Keybinding = { key: "t", ctrl: true };
    expect(formatKeybinding(binding)).toBe("Ctrl+T");
  });

  it("formats key with shift", () => {
    const binding: Keybinding = { key: "d", shift: true };
    expect(formatKeybinding(binding)).toBe("\u21E7+D");
  });

  it("formats key with ctrl and shift", () => {
    const binding: Keybinding = { key: "p", ctrl: true, shift: true };
    expect(formatKeybinding(binding)).toBe("Ctrl+\u21E7+P");
  });

  it("formats multi-character key names as-is", () => {
    const binding: Keybinding = { key: "Tab", ctrl: true };
    expect(formatKeybinding(binding)).toBe("Ctrl+Tab");
  });

  it("formats meta as Win on non-Mac", () => {
    const binding: Keybinding = { key: "n", meta: true };
    expect(formatKeybinding(binding)).toBe("Win+N");
  });

  it("formats alt as Alt on non-Mac", () => {
    const binding: Keybinding = { key: "f", alt: true };
    expect(formatKeybinding(binding)).toBe("Alt+F");
  });

  it("formats plain key with no modifiers", () => {
    const binding: Keybinding = { key: "Escape" };
    expect(formatKeybinding(binding)).toBe("Escape");
  });
});
