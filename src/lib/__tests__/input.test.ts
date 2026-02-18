import { describe, it, expect } from "vitest";
import { keyEventToBytes } from "../input";

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

describe("keyEventToBytes", () => {
  it("encodes regular printable characters", () => {
    const e = makeKeyEvent({ key: "a" });
    const bytes = keyEventToBytes(e);
    expect(Array.from(bytes)).toEqual([97]);
  });

  it("returns empty for Cmd+C (macOS copy)", () => {
    const e = makeKeyEvent({ key: "c", metaKey: true });
    const bytes = keyEventToBytes(e);
    expect(bytes.length).toBe(0);
  });

  it("returns empty for Cmd+V (macOS paste)", () => {
    const e = makeKeyEvent({ key: "v", metaKey: true });
    const bytes = keyEventToBytes(e);
    expect(bytes.length).toBe(0);
  });

  it("encodes Ctrl+A as 0x01", () => {
    const e = makeKeyEvent({ key: "a", ctrlKey: true });
    const bytes = keyEventToBytes(e);
    expect(Array.from(bytes)).toEqual([0x01]);
  });

  it("encodes Ctrl+C as 0x03", () => {
    const e = makeKeyEvent({ key: "c", ctrlKey: true });
    const bytes = keyEventToBytes(e);
    expect(Array.from(bytes)).toEqual([0x03]);
  });

  it("encodes Ctrl+Z as 0x1A", () => {
    const e = makeKeyEvent({ key: "z", ctrlKey: true });
    const bytes = keyEventToBytes(e);
    expect(Array.from(bytes)).toEqual([0x1a]);
  });

  it("encodes Ctrl+[ as ESC", () => {
    const e = makeKeyEvent({ key: "[", ctrlKey: true });
    const bytes = keyEventToBytes(e);
    expect(Array.from(bytes)).toEqual([0x1b]);
  });

  it("encodes Enter as CR", () => {
    const e = makeKeyEvent({ key: "Enter" });
    const bytes = keyEventToBytes(e);
    expect(Array.from(bytes)).toEqual([0x0d]);
  });

  it("encodes Shift+Enter as LF", () => {
    const e = makeKeyEvent({ key: "Enter", shiftKey: true });
    const bytes = keyEventToBytes(e);
    expect(Array.from(bytes)).toEqual([0x0a]);
  });

  it("encodes Tab as 0x09", () => {
    const e = makeKeyEvent({ key: "Tab" });
    const bytes = keyEventToBytes(e);
    expect(Array.from(bytes)).toEqual([0x09]);
  });

  it("returns empty for Ctrl+Tab (tab switching)", () => {
    const e = makeKeyEvent({ key: "Tab", ctrlKey: true });
    const bytes = keyEventToBytes(e);
    expect(bytes.length).toBe(0);
  });

  it("encodes Shift+Tab as back-tab (ESC[Z)", () => {
    const e = makeKeyEvent({ key: "Tab", shiftKey: true });
    const bytes = keyEventToBytes(e);
    expect(Array.from(bytes)).toEqual([0x1b, 0x5b, 0x5a]);
  });

  it("encodes Backspace as 0x7F (DEL)", () => {
    const e = makeKeyEvent({ key: "Backspace" });
    const bytes = keyEventToBytes(e);
    expect(Array.from(bytes)).toEqual([0x7f]);
  });

  it("encodes Escape as 0x1B", () => {
    const e = makeKeyEvent({ key: "Escape" });
    const bytes = keyEventToBytes(e);
    expect(Array.from(bytes)).toEqual([0x1b]);
  });

  it("encodes Delete as ESC[3~", () => {
    const e = makeKeyEvent({ key: "Delete" });
    const bytes = keyEventToBytes(e);
    expect(Array.from(bytes)).toEqual([0x1b, 0x5b, 0x33, 0x7e]);
  });

  it("encodes ArrowUp as ESC[A in normal mode", () => {
    const e = makeKeyEvent({ key: "ArrowUp" });
    const bytes = keyEventToBytes(e, true, false);
    expect(Array.from(bytes)).toEqual([0x1b, 0x5b, 0x41]);
  });

  it("encodes ArrowUp as ESC O A in application mode", () => {
    const e = makeKeyEvent({ key: "ArrowUp" });
    const bytes = keyEventToBytes(e, true, true);
    expect(Array.from(bytes)).toEqual([0x1b, 0x4f, 0x41]);
  });

  it("encodes ArrowDown as ESC[B", () => {
    const e = makeKeyEvent({ key: "ArrowDown" });
    const bytes = keyEventToBytes(e);
    expect(Array.from(bytes)).toEqual([0x1b, 0x5b, 0x42]);
  });

  it("encodes Alt+key as ESC prefix when optionAsMeta is true", () => {
    const e = makeKeyEvent({ key: "f", altKey: true });
    const bytes = keyEventToBytes(e, true);
    expect(Array.from(bytes)).toEqual([0x1b, 102]);
  });

  it("encodes F1 as ESC O P", () => {
    const e = makeKeyEvent({ key: "F1" });
    const bytes = keyEventToBytes(e);
    expect(Array.from(bytes)).toEqual([0x1b, 0x4f, 0x50]);
  });

  it("encodes F5 as ESC[15~", () => {
    const e = makeKeyEvent({ key: "F5" });
    const bytes = keyEventToBytes(e);
    expect(Array.from(bytes)).toEqual([0x1b, 0x5b, 0x31, 0x35, 0x7e]);
  });

  it("encodes Shift+ArrowUp with modifier code", () => {
    const e = makeKeyEvent({ key: "ArrowUp", shiftKey: true });
    const bytes = keyEventToBytes(e);
    // ESC[1;2A (modifier 2 = shift)
    expect(Array.from(bytes)).toEqual([0x1b, 0x5b, 0x31, 0x3b, 0x32, 0x41]);
  });
});
