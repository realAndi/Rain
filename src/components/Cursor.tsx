import { Component } from "solid-js";
import type { CursorRender } from "../lib/types";

export const Cursor: Component<{
  cursor: CursorRender;
  charWidth?: number;
  lineHeight?: number;
  letterSpacing?: number;
  leftPx?: number;
  topPx?: number;
  blinking?: boolean;
}> = (props) => {
  const style = () => {
    const col = props.cursor.col;
    const row = props.cursor.row;
    const ls = props.letterSpacing ?? 0;
    const cw = props.charWidth;
    const lh = props.lineHeight;
    const hasPixelPosition = props.leftPx !== undefined && props.topPx !== undefined;

    // Position the cursor on the character grid.
    // When charWidth is provided, use pixel-precise positioning to avoid
    // subpixel drift between the CSS `ch` unit and the actual rendered
    // character advance width. This keeps the cursor aligned with the
    // text even at high column numbers.
    let left: string;
    let top: string;
    let width: string;
    let height: string;

    if (hasPixelPosition) {
      left = `${props.leftPx}px`;
      top = `${props.topPx}px`;
    } else if (cw !== undefined) {
      // Pixel-precise: col * (charWidth + letterSpacing)
      // charWidth already includes the font's advance; letterSpacing
      // is added per-character by the browser's text layout engine.
      left = `${col * (cw + ls)}px`;
      top = lh !== undefined ? `${row * lh}px` : `calc(${row} * 1lh)`;
    } else {
      // Fallback to ch units
      const spacingOffset = col * ls;
      left = spacingOffset !== 0 ? `calc(${col}ch + ${spacingOffset}px)` : `${col}ch`;
      top = `calc(${row} * 1lh)`;
    }

    width = cw !== undefined ? `${cw}px` : "1ch";
    height = lh !== undefined ? `${lh}px` : "1lh";

    const base: Record<string, string> = {
      position: "absolute",
      left,
      top,
      width,
      height,
      "pointer-events": "none",
    };

    // Use display:none when hidden so CSS blink animation can't override it
    if (!props.cursor.visible) {
      base.display = "none";
    }

    switch (props.cursor.shape) {
      case "block":
        // Render behind the text (z-index:0) so the character is visible
        // on top of the solid cursor block. Term-lines have z-index:1.
        base["z-index"] = "0";
        base["background-color"] = "var(--cursor-color)";
        break;
      case "underline":
        // Underline/bar render above text so they're always visible
        base["z-index"] = "10";
        base["background-color"] = "transparent";
        base["border-bottom"] = "2px solid var(--cursor-color)";
        break;
      case "bar":
        base["z-index"] = "10";
        base.width = "2px";
        base["background-color"] = "var(--cursor-color)";
        break;
    }

    return base;
  };

  // Don't apply blink animation when cursor is hidden — prevents the
  // CSS animation from overriding the hidden state (animations take
  // priority over inline styles in the CSS cascade).
  const shouldBlink = () => props.blinking !== false && props.cursor.visible;

  return (
    <div
      class={`terminal-cursor${shouldBlink() ? " cursor-blinking" : ""}`}
      style={style()}
    />
  );
};
