import { Component, onMount, onCleanup, createEffect } from "solid-js";
import {
  CanvasTerminalRenderer,
  canUseCanvasRenderer,
  type CanvasRendererConfig,
} from "../lib/canvasRenderer";
import type { TerminalStore } from "../stores/terminal";
import { useConfig } from "../stores/config";
import { useTheme, THEME_LIST, THEME_ANSI_PALETTES } from "../stores/theme";
import { colorToCSS } from "../lib/color";

/**
 * Canvas-based terminal renderer component.
 * This is an alternative to the DOM-based Terminal component for scenarios
 * requiring higher rendering performance (alt-screen apps, high throughput).
 *
 * To use: replace <Terminal> with <CanvasTerminal> for specific panes.
 * Currently provided as a foundation for future optimization.
 */
export const CanvasTerminal: Component<{
  store: TerminalStore;
  active: boolean;
}> = (props) => {
  let canvasRef!: HTMLCanvasElement;
  let renderer: CanvasTerminalRenderer | null = null;
  const { config } = useConfig();
  const { theme } = useTheme();

  onMount(() => {
    if (!canUseCanvasRenderer()) {
      console.warn("[Rain] Canvas renderer unavailable; falling back to DOM renderer.");
      return;
    }
    const cfg = config();
    const themeEntry = THEME_LIST.find((t) => t.name === theme());
    const rendererConfig: CanvasRendererConfig = {
      fontFamily: cfg.fontFamily,
      fontSize: cfg.fontSize,
      lineHeight: cfg.lineHeight,
      letterSpacing: cfg.letterSpacing,
      cols: props.store.state.cols || 80,
      rows: props.store.state.rows || 24,
      devicePixelRatio: window.devicePixelRatio || 1,
      defaultFg: themeEntry?.accent ?? "#e0e0e0",
      defaultBg: themeEntry?.bg ?? "#0e0e0e",
    };

    try {
      renderer = new CanvasTerminalRenderer(canvasRef, rendererConfig);
      renderer.startRenderLoop();
    } catch (error) {
      renderer = null;
      console.warn("[Rain] Failed to initialize canvas renderer:", error);
      return;
    }

    const onWindowResize = () => {
      renderer?.setDevicePixelRatio(window.devicePixelRatio || 1);
    };
    window.addEventListener("resize", onWindowResize);
    onCleanup(() => {
      window.removeEventListener("resize", onWindowResize);
    });
  });

  // Update canvas when terminal state changes
  createEffect(() => {
    if (!renderer) return;
    const lines = props.store.state.altScreen
      ? props.store.state.altScreenLines
      : props.store.state.fallbackLines;

    const palette =
      THEME_ANSI_PALETTES[theme()] ?? THEME_ANSI_PALETTES["dark"];

    for (const line of lines) {
      const spans = line.spans.map((s) => ({
        text: s.text,
        fg: colorToCSS(s.fg, palette) ?? "#e0e0e0",
        bg: colorToCSS(s.bg, palette) ?? "transparent",
        bold: s.bold,
        italic: s.italic,
        underline: s.underline,
        strikethrough: s.strikethrough,
        dim: s.dim,
      }));
      renderer!.updateLine(line.index, spans);
    }

    // Render cursor
    const cursor = props.store.state.cursor;
    if (cursor.visible) {
      renderer!.renderCursor(
        cursor.row,
        cursor.col,
        cursor.shape,
        config().customCursorColor ?? "#e0e0e0",
      );
    }
  });

  // Handle resize
  createEffect(() => {
    const rows = props.store.state.rows;
    const cols = props.store.state.cols;
    if (renderer && rows > 0 && cols > 0) {
      renderer.resize(cols, rows);
    }
  });

  onCleanup(() => {
    renderer?.destroy();
    renderer = null;
  });

  return (
    <canvas
      ref={canvasRef}
      class="canvas-terminal"
      style={{
        display: "block",
        width: "100%",
        height: "100%",
      }}
    />
  );
};
