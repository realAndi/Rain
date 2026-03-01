// Font metrics measurement for the terminal grid.
// Uses DOM-based measurement to match the browser's actual text layout,
// the same approach used by xterm.js and other web-based terminal emulators.

export interface FontMetrics {
  charWidth: number;
  charHeight: number;
  lineHeight: number;
  baseline: number;
  fontFamily: string;
  adjustedFontFamily: string;
  fontSize: number;
  letterSpacing: number;
}

let cachedMetrics: FontMetrics | null = null;

const METRIC_OVERRIDE_ID = "rain-font-metric-override";

/**
 * Install a @font-face rule that overrides the font's vertical metrics so
 * that ascent + descent = 100% of the em-square. This makes block/box-drawing
 * characters fill the full line height with no subpixel gaps between lines.
 */
function installMetricOverride(fontFamily: string, ascent: number, descent: number): string {
  const total = ascent + descent;
  if (total <= 0) return fontFamily;

  const ascentPct = (ascent / total * 100).toFixed(4);
  const descentPct = (descent / total * 100).toFixed(4);
  const wrapperName = `__Rain_${fontFamily}`;

  let styleEl = document.getElementById(METRIC_OVERRIDE_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = METRIC_OVERRIDE_ID;
    document.head.appendChild(styleEl);
  }

  const escaped = fontFamily.replace(/"/g, '\\"');
  const escapedWrapper = wrapperName.replace(/"/g, '\\"');

  styleEl.textContent = [
    ["normal", "normal", `local("${escaped}")`],
    ["bold", "normal", `local("${escaped} Bold"), local("${escaped}")`],
    ["normal", "italic", `local("${escaped} Italic"), local("${escaped}")`],
    ["bold", "italic", `local("${escaped} Bold Italic"), local("${escaped}")`],
  ].map(([weight, style, src]) => `@font-face {
  font-family: "${escapedWrapper}";
  src: ${src};
  font-weight: ${weight};
  font-style: ${style};
  ascent-override: ${ascentPct}%;
  descent-override: ${descentPct}%;
  line-gap-override: 0%;
}`).join("\n");

  return wrapperName;
}

/**
 * Measure the dimensions of a monospace font using the DOM.
 *
 * Instead of canvas-based measurement, we create a hidden element styled
 * identically to the terminal container and measure its rendered width.
 * This is correct by definition because it uses the same rendering engine
 * that lays out the actual terminal text, accounting for letter-spacing,
 * font fallback, subpixel rendering, and any other browser quirks.
 *
 * Results are cached until invalidated (e.g. when font settings change).
 */
export function measureFontMetrics(
  fontFamily: string = "JetBrains Mono, Menlo, Monaco, Courier New, monospace",
  fontSize: number = 14,
  lineHeightMultiplier: number = 1.0,
  letterSpacing: number = 0,
): FontMetrics {
  if (
    cachedMetrics &&
    cachedMetrics.fontFamily === fontFamily &&
    cachedMetrics.fontSize === fontSize &&
    cachedMetrics.letterSpacing === letterSpacing
  ) {
    return cachedMetrics;
  }

  const lineHeight = Math.ceil(fontSize * lineHeightMultiplier);

  // Create a hidden probe element with the exact same styles as the terminal.
  // white-space: pre matches .term-span / .term-line so layout is identical.
  const probe = document.createElement("span");
  probe.style.cssText = [
    `font-family: "${fontFamily}", "Rain Symbols Fallback", monospace`,
    `font-size: ${fontSize}px`,
    `line-height: ${lineHeight}px`,
    `letter-spacing: ${letterSpacing}px`,
    `font-variant-ligatures: contextual`,
    `font-kerning: none`,
    `text-rendering: optimizeSpeed`,
    `-webkit-font-smoothing: antialiased`,
    `white-space: pre`,
    `position: absolute`,
    `visibility: hidden`,
    `top: -9999px`,
    `left: -9999px`,
  ].join(";");

  // Use repeated characters and divide to smooth out sub-pixel rounding.
  const testStr = "X".repeat(10);
  probe.textContent = testStr;
  document.body.appendChild(probe);

  const charWidth = probe.getBoundingClientRect().width / testStr.length;

  // Measure height from the same probe for consistency
  const probeHeight = probe.getBoundingClientRect().height;

  document.body.removeChild(probe);

  // For baseline/ascent we still use canvas since the DOM doesn't expose it.
  // Vertical metrics are less sensitive to canvas vs DOM differences.
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${fontSize}px "${fontFamily}", monospace`;
  const tm = ctx.measureText("M");
  const ascent = tm.fontBoundingBoxAscent ?? tm.actualBoundingBoxAscent ?? fontSize * 0.8;
  const descent = tm.fontBoundingBoxDescent ?? tm.actualBoundingBoxDescent ?? fontSize * 0.2;
  const charHeight = ascent + descent;

  const adjustedFontFamily = installMetricOverride(fontFamily, ascent, descent);

  const result: FontMetrics = {
    charWidth,
    charHeight: Math.max(charHeight, probeHeight),
    lineHeight,
    baseline: ascent,
    fontFamily,
    adjustedFontFamily,
    fontSize,
    letterSpacing,
  };

  cachedMetrics = result;
  return result;
}

/**
 * Calculate terminal dimensions from container size and font metrics.
 */
export function calculateTerminalSize(
  containerWidth: number,
  containerHeight: number,
  metrics: FontMetrics,
): { rows: number; cols: number } {
  const cols = Math.floor(containerWidth / metrics.charWidth);
  const rows = Math.floor(containerHeight / metrics.lineHeight);
  return {
    rows: Math.max(1, rows),
    cols: Math.max(1, cols),
  };
}

/**
 * Invalidate the cached metrics (call when font changes).
 */
export function invalidateFontMetrics(): void {
  cachedMetrics = null;
}
