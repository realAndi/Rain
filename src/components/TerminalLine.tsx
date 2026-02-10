import { Component, For } from "solid-js";
import type { RenderedLine, StyledSpan, SerializableColor } from "../lib/types";

export const TerminalLine: Component<{ line: RenderedLine; charWidth: number }> = (props) => {
  return (
    <div class="term-line" data-row={props.line.index}>
      <For each={props.line.spans}>{(span) => <SpanElement span={span} />}</For>
    </div>
  );
};

const SpanElement: Component<{ span: StyledSpan }> = (props) => {
  const style = () => {
    const s: Record<string, string> = {};
    const fg = colorToCSS(props.span.fg, true);
    const bg = colorToCSS(props.span.bg, false);

    if (fg) s.color = fg;
    if (bg) s["background-color"] = bg;
    if (props.span.bold) s["font-weight"] = "bold";
    if (props.span.dim) s.opacity = "0.5";
    if (props.span.italic) s["font-style"] = "italic";

    const decorations: string[] = [];
    if (props.span.underline) decorations.push("underline");
    if (props.span.strikethrough) decorations.push("line-through");
    if (decorations.length > 0) {
      s["text-decoration"] = decorations.join(" ");
    }

    return s;
  };

  return (
    <span class="term-span" style={style()}>
      {props.span.text}
    </span>
  );
};

// ANSI 16-color palette (Warp-style warm charcoal)
const ANSI_COLORS = [
  "#191a1f", // 0 black
  "#f85149", // 1 red
  "#01c1a2", // 2 green
  "#e3b341", // 3 yellow
  "#6fb3f2", // 4 blue
  "#d2a8ff", // 5 magenta
  "#56d4dd", // 6 cyan
  "#b1b5c3", // 7 white
  "#4e5163", // 8 bright black
  "#ff7b72", // 9 bright red
  "#3bdfbe", // 10 bright green
  "#f0d16e", // 11 bright yellow
  "#8ecbff", // 12 bright blue
  "#e2c5ff", // 13 bright magenta
  "#7ee8ed", // 14 bright cyan
  "#e0e0e0", // 15 bright white
];

function colorToCSS(color: SerializableColor, isForeground: boolean): string | null {
  switch (color.type) {
    case "Default":
      return null; // use CSS variable default
    case "Indexed": {
      const idx = color.index;
      if (idx < 16) {
        return ANSI_COLORS[idx];
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
