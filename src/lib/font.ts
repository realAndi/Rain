// Font metrics measurement for the terminal grid.
// Measures a monospace font to determine cell dimensions.

export interface FontMetrics {
  charWidth: number;
  charHeight: number;
  lineHeight: number;
  baseline: number;
  fontFamily: string;
  fontSize: number;
}

let cachedMetrics: FontMetrics | null = null;

/**
 * Measure the dimensions of a monospace font.
 * Results are cached since font metrics don't change during a session
 * (unless the user changes the font, in which case call invalidate()).
 */
export function measureFontMetrics(
  fontFamily: string = "JetBrains Mono, Menlo, Monaco, Courier New, monospace",
  fontSize: number = 14,
  lineHeightMultiplier: number = 1.4,
): FontMetrics {
  if (
    cachedMetrics &&
    cachedMetrics.fontFamily === fontFamily &&
    cachedMetrics.fontSize === fontSize
  ) {
    return cachedMetrics;
  }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${fontSize}px ${fontFamily}`;

  // Measure a representative character
  const metrics = ctx.measureText("M");

  // charWidth: use the advance width of a single character
  const charWidth = metrics.width;

  // charHeight: font bounding box height or fallback to fontSize
  const ascent = metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent ?? fontSize * 0.8;
  const descent =
    metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent ?? fontSize * 0.2;
  const charHeight = ascent + descent;

  const lineHeight = Math.ceil(fontSize * lineHeightMultiplier);

  const result: FontMetrics = {
    charWidth,
    charHeight,
    lineHeight,
    baseline: ascent,
    fontFamily,
    fontSize,
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
