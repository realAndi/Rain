import { Component } from "solid-js";
import type { CursorRender } from "../lib/types";

export const Cursor: Component<{
  cursor: CursorRender;
  charWidth: number;
  lineHeight: number;
  blinking?: boolean;
}> = (props) => {
  const style = () => {
    const x = props.cursor.col * props.charWidth;
    const y = props.cursor.row * props.lineHeight;

    const base: Record<string, string> = {
      position: "absolute",
      left: `${x}px`,
      top: `${y}px`,
      width: `${props.charWidth}px`,
      height: `${props.lineHeight}px`,
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
