import { Component } from "solid-js";
import type { CursorRender } from "../lib/types";

export const Cursor: Component<{
  cursor: CursorRender;
  letterSpacing?: number;
  leftPx?: number;
  topPx?: number;
  blinking?: boolean;
}> = (props) => {
  const style = () => {
    const col = props.cursor.col;
    const row = props.cursor.row;
    const ls = props.letterSpacing ?? 0;
    const hasPixelPosition = props.leftPx !== undefined && props.topPx !== undefined;
    // CSS letter-spacing applies between characters, not before the first one.
    // So cursor X offset at column N is:
    //   N * 1ch + max(0, N - 1) * letterSpacing
    const spacingOffset = col > 0 ? (col - 1) * ls : 0;
    const left = hasPixelPosition
      ? `${props.leftPx}px`
      : (spacingOffset !== 0 ? `calc(${col}ch + ${spacingOffset}px)` : `${col}ch`);
    const top = hasPixelPosition ? `${props.topPx}px` : `calc(${row} * 1lh)`;

    const base: Record<string, string> = {
      position: "absolute",
      left,
      top,
      width: "1ch",
      height: "1lh",
      "pointer-events": "none",
      "z-index": "10",
    };

    if (!props.cursor.visible) {
      base.opacity = "0";
    }

    switch (props.cursor.shape) {
      case "block":
        base["background-color"] = "var(--cursor-color)";
        base["mix-blend-mode"] = "difference";
        break;
      case "underline":
        base["background-color"] = "transparent";
        base["border-bottom"] = "2px solid var(--cursor-color)";
        break;
      case "bar":
        base.width = "2px";
        base["background-color"] = "var(--cursor-color)";
        break;
    }

    return base;
  };

  return (
    <div
      class={`terminal-cursor${props.blinking !== false ? " cursor-blinking" : ""}`}
      style={style()}
    />
  );
};
