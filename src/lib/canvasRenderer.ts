// Canvas-based terminal renderer for high-performance output.
// This provides a Canvas2D alternative to the DOM-based TerminalLine rendering.
// It can be used for alt-screen applications or high-throughput output.

export interface CanvasRendererConfig {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  cols: number;
  rows: number;
  devicePixelRatio: number;
  defaultFg: string;
  defaultBg: string;
}

export interface CanvasCell {
  char: string;
  fg: string;
  bg: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  dim: boolean;
}

export function canUseCanvasRenderer(): boolean {
  if (typeof document === "undefined") return false;
  const canvas = document.createElement("canvas");
  return canvas.getContext("2d") !== null;
}

export class CanvasTerminalRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: CanvasRendererConfig;
  private charWidth: number = 0;
  private charHeight: number = 0;
  private viewportWidth: number = 0;
  private viewportHeight: number = 0;
  private grid: CanvasCell[][] = [];
  private dirty: boolean = true;
  private rafId: number | null = null;

  constructor(canvas: HTMLCanvasElement, config: CanvasRendererConfig) {
    this.canvas = canvas;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error("Canvas 2D context unavailable");
    }
    this.ctx = context;
    this.config = config;
    this.measureFont();
    this.resize(config.cols, config.rows);
  }

  private measureFont(): void {
    const dpr = Math.max(1, this.config.devicePixelRatio || 1);
    this.config.devicePixelRatio = dpr;
    this.ctx.font = this.buildFont(false, false);
    const metrics = this.ctx.measureText("M");
    this.charWidth = Math.ceil(metrics.width + this.config.letterSpacing);
    this.charHeight = Math.ceil(this.config.fontSize * this.config.lineHeight);

    // Scale canvas for retina displays
    const width = Math.max(1, this.charWidth * this.config.cols);
    const height = Math.max(1, this.charHeight * this.config.rows);
    this.viewportWidth = width;
    this.viewportHeight = height;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);
    this.ctx.textBaseline = "alphabetic";
  }

  private buildFont(bold: boolean, italic: boolean): string {
    const weight = bold ? "bold" : "normal";
    const style = italic ? "italic" : "normal";
    return `${style} ${weight} ${this.config.fontSize}px "${this.config.fontFamily}", "Rain Symbols Fallback", monospace`;
  }

  resize(cols: number, rows: number): void {
    this.config.cols = cols;
    this.config.rows = rows;

    // Rebuild grid
    this.grid = [];
    for (let r = 0; r < rows; r++) {
      const row: CanvasCell[] = [];
      for (let c = 0; c < cols; c++) {
        row.push({
          char: " ",
          fg: this.config.defaultFg,
          bg: this.config.defaultBg,
          bold: false,
          italic: false,
          underline: false,
          strikethrough: false,
          dim: false,
        });
      }
      this.grid.push(row);
    }

    this.measureFont();
    this.dirty = true;
  }

  setDevicePixelRatio(devicePixelRatio: number): void {
    const next = Math.max(1, devicePixelRatio || 1);
    if (Math.abs(next - this.config.devicePixelRatio) < 0.01) return;
    this.config.devicePixelRatio = next;
    this.measureFont();
    this.dirty = true;
  }

  updateCell(row: number, col: number, cell: CanvasCell): void {
    if (row < 0 || row >= this.config.rows || col < 0 || col >= this.config.cols) return;
    this.grid[row][col] = cell;
    this.dirty = true;
  }

  updateLine(
    row: number,
    spans: Array<{
      text: string;
      fg: string;
      bg: string;
      bold: boolean;
      italic: boolean;
      underline: boolean;
      strikethrough: boolean;
      dim: boolean;
    }>,
  ): void {
    if (row < 0 || row >= this.config.rows) return;
    let col = 0;
    for (const span of spans) {
      for (const char of span.text) {
        if (col >= this.config.cols) break;
        this.grid[row][col] = {
          char,
          fg: span.fg,
          bg: span.bg,
          bold: span.bold,
          italic: span.italic,
          underline: span.underline,
          strikethrough: span.strikethrough,
          dim: span.dim,
        };
        col++;
      }
    }
    // Clear remaining cells in the row
    while (col < this.config.cols) {
      this.grid[row][col] = {
        char: " ",
        fg: this.config.defaultFg,
        bg: this.config.defaultBg,
        bold: false,
        italic: false,
        underline: false,
        strikethrough: false,
        dim: false,
      };
      col++;
    }
    this.dirty = true;
  }

  render(): void {
    if (!this.dirty) return;
    this.dirty = false;

    const ctx = this.ctx;
    const cw = this.charWidth;
    const ch = this.charHeight;
    const baselineOffset = this.config.fontSize * 0.85;

    // Clear entire canvas
    ctx.fillStyle = this.config.defaultBg;
    ctx.fillRect(0, 0, this.viewportWidth, this.viewportHeight);

    for (let r = 0; r < this.config.rows; r++) {
      const y = r * ch;
      const row = this.grid[r];
      if (!row) continue;

      // First pass: backgrounds
      let runStart = 0;
      let runBg = row[0]?.bg ?? this.config.defaultBg;

      for (let c = 0; c <= this.config.cols; c++) {
        const cellBg = c < this.config.cols ? (row[c]?.bg ?? this.config.defaultBg) : null;
        if (cellBg !== runBg || c === this.config.cols) {
          if (runBg !== this.config.defaultBg) {
            ctx.fillStyle = runBg;
            ctx.fillRect(runStart * cw, y, (c - runStart) * cw, ch);
          }
          runStart = c;
          runBg = cellBg ?? this.config.defaultBg;
        }
      }

      // Second pass: text
      for (let c = 0; c < this.config.cols; c++) {
        const cell = row[c];
        if (!cell || cell.char === " " || cell.char === "") continue;

        ctx.font = this.buildFont(cell.bold, cell.italic);
        ctx.fillStyle = cell.dim ? this.dimColor(cell.fg) : cell.fg;
        ctx.fillText(cell.char, c * cw, y + baselineOffset);

        if (cell.underline) {
          ctx.strokeStyle = ctx.fillStyle;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(c * cw, y + ch - 2);
          ctx.lineTo((c + 1) * cw, y + ch - 2);
          ctx.stroke();
        }

        if (cell.strikethrough) {
          ctx.strokeStyle = ctx.fillStyle;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(c * cw, y + ch / 2);
          ctx.lineTo((c + 1) * cw, y + ch / 2);
          ctx.stroke();
        }
      }
    }
  }

  private dimColor(color: string): string {
    if (color.startsWith("#")) {
      return color + "9E";
    }
    return color;
  }

  renderCursor(
    row: number,
    col: number,
    shape: "block" | "underline" | "bar",
    color: string,
  ): void {
    const ctx = this.ctx;
    const cw = this.charWidth;
    const ch = this.charHeight;
    const x = col * cw;
    const y = row * ch;

    ctx.fillStyle = color;

    switch (shape) {
      case "block":
        ctx.globalAlpha = 0.5;
        ctx.fillRect(x, y, cw, ch);
        ctx.globalAlpha = 1.0;
        break;
      case "underline":
        ctx.fillRect(x, y + ch - 3, cw, 3);
        break;
      case "bar":
        ctx.fillRect(x, y, 2, ch);
        break;
    }
  }

  startRenderLoop(): void {
    const loop = () => {
      this.render();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stopRenderLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  destroy(): void {
    this.stopRenderLoop();
  }

  getCharWidth(): number {
    return this.charWidth;
  }

  getCharHeight(): number {
    return this.charHeight;
  }
}
