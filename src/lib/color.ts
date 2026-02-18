import type { SerializableColor } from "./types";

/**
 * Convert a SerializableColor to a CSS color string.
 * Shared between the terminal renderer and canvas-based capture.
 */
export function colorToCSS(color: SerializableColor, ansiPalette: string[]): string | null {
  switch (color.type) {
    case "Default":
      return null; // use CSS variable default
    case "Indexed": {
      const idx = color.index;
      if (idx < 16) {
        return ansiPalette[idx];
      }
      if (idx < 232) {
        // 6x6x6 color cube
        const i = idx - 16;
        const r = Math.floor(i / 36);
        const g = Math.floor((i % 36) / 6);
        const b = i % 6;
        const toVal = (v: number) => (v === 0 ? 0 : 55 + 40 * v);
        return `rgb(${toVal(r)},${toVal(g)},${toVal(b)})`;
      }
      // Grayscale ramp
      const v = 8 + 10 * (idx - 232);
      return `rgb(${v},${v},${v})`;
    }
    case "Rgb":
      return `rgb(${color.r},${color.g},${color.b})`;
    default:
      return null;
  }
}
