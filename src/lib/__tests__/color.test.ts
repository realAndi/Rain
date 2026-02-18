import { describe, it, expect } from "vitest";
import { colorToCSS } from "../color";
import type { SerializableColor } from "../types";

const MOCK_ANSI_PALETTE = [
  "#000000", "#cc0000", "#00cc00", "#cccc00",
  "#0000cc", "#cc00cc", "#00cccc", "#cccccc",
  "#555555", "#ff0000", "#00ff00", "#ffff00",
  "#5555ff", "#ff00ff", "#00ffff", "#ffffff",
];

describe("colorToCSS", () => {
  it("returns null for Default color", () => {
    const color: SerializableColor = { type: "Default" };
    expect(colorToCSS(color, MOCK_ANSI_PALETTE)).toBeNull();
  });

  it("returns palette color for Indexed < 16", () => {
    const color: SerializableColor = { type: "Indexed", index: 1 };
    expect(colorToCSS(color, MOCK_ANSI_PALETTE)).toBe("#cc0000");
  });

  it("returns palette color for Indexed 0", () => {
    const color: SerializableColor = { type: "Indexed", index: 0 };
    expect(colorToCSS(color, MOCK_ANSI_PALETTE)).toBe("#000000");
  });

  it("returns palette color for Indexed 15", () => {
    const color: SerializableColor = { type: "Indexed", index: 15 };
    expect(colorToCSS(color, MOCK_ANSI_PALETTE)).toBe("#ffffff");
  });

  it("returns 6x6x6 cube color for Indexed 16-231", () => {
    // Index 16 = rgb(0,0,0) in the color cube
    const color16: SerializableColor = { type: "Indexed", index: 16 };
    expect(colorToCSS(color16, MOCK_ANSI_PALETTE)).toBe("rgb(0,0,0)");

    // Index 196 = bright red in the cube (r=5, g=0, b=0)
    const color196: SerializableColor = { type: "Indexed", index: 196 };
    expect(colorToCSS(color196, MOCK_ANSI_PALETTE)).toBe("rgb(255,0,0)");

    // Index 231 = white in the cube (r=5, g=5, b=5)
    const color231: SerializableColor = { type: "Indexed", index: 231 };
    expect(colorToCSS(color231, MOCK_ANSI_PALETTE)).toBe("rgb(255,255,255)");
  });

  it("returns grayscale for Indexed 232-255", () => {
    // Index 232 = darkest gray (8 + 10 * 0 = 8)
    const color232: SerializableColor = { type: "Indexed", index: 232 };
    expect(colorToCSS(color232, MOCK_ANSI_PALETTE)).toBe("rgb(8,8,8)");

    // Index 255 = lightest gray (8 + 10 * 23 = 238)
    const color255: SerializableColor = { type: "Indexed", index: 255 };
    expect(colorToCSS(color255, MOCK_ANSI_PALETTE)).toBe("rgb(238,238,238)");
  });

  it("returns rgb() for Rgb color", () => {
    const color: SerializableColor = { type: "Rgb", r: 128, g: 64, b: 32 };
    expect(colorToCSS(color, MOCK_ANSI_PALETTE)).toBe("rgb(128,64,32)");
  });
});
