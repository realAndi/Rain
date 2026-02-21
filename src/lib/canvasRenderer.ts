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

type GlyphKey = string;

function makeGlyphKey(
  char: string,
  fg: string,
  bold: boolean,
  italic: boolean,
  dim: boolean,
): GlyphKey {
  return `${char}\x00${fg}\x00${bold ? 1 : 0}${italic ? 1 : 0}${dim ? 1 : 0}`;
}

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;

interface UrlRange {
  startCol: number;
  endCol: number;
  url: string;
}

class GlyphCache {
  private atlas: OffscreenCanvas | HTMLCanvasElement;
  private ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  private map = new Map<GlyphKey, { x: number; y: number }>();
  private nextX = 0;
  private nextY = 0;
  private cellWidth: number;
  private cellHeight: number;
  private atlasWidth: number;
  private atlasHeight: number;
  private initialAtlasHeight: number;
  private maxAtlasHeight: number;

  constructor(cellWidth: number, cellHeight: number, dpr: number) {
    this.cellWidth = Math.ceil(cellWidth * dpr);
    this.cellHeight = Math.ceil(cellHeight * dpr);
    this.atlasWidth = this.cellWidth * 64;
    this.atlasHeight = this.cellHeight * 64;
    this.initialAtlasHeight = this.atlasHeight;
    this.maxAtlasHeight = this.cellHeight * 512;

    if (typeof OffscreenCanvas !== "undefined") {
      this.atlas = new OffscreenCanvas(this.atlasWidth, this.atlasHeight);
      this.ctx = this.atlas.getContext("2d")!;
    } else {
      this.atlas = document.createElement("canvas");
      this.atlas.width = this.atlasWidth;
      this.atlas.height = this.atlasHeight;
      this.ctx = this.atlas.getContext("2d")!;
    }
  }

  get(key: GlyphKey): { x: number; y: number } | undefined {
    return this.map.get(key);
  }

  put(
    key: GlyphKey,
    drawFn: (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number) => void,
  ): { x: number; y: number } {
    const pos = { x: this.nextX, y: this.nextY };
    drawFn(this.ctx, pos.x, pos.y, this.cellWidth, this.cellHeight);
    this.map.set(key, pos);

    this.nextX += this.cellWidth;
    if (this.nextX + this.cellWidth > this.atlasWidth) {
      this.nextX = 0;
      this.nextY += this.cellHeight;
    }

    if (this.nextY + this.cellHeight > this.atlasHeight) {
      this.grow();
    }

    return pos;
  }

  private grow() {
    if (this.atlasHeight >= this.maxAtlasHeight) {
      this.clear();
      return;
    }
    const newHeight = Math.min(this.atlasHeight * 2, this.maxAtlasHeight);
    if (typeof OffscreenCanvas !== "undefined") {
      const newAtlas = new OffscreenCanvas(this.atlasWidth, newHeight);
      const newCtx = newAtlas.getContext("2d")!;
      newCtx.drawImage(this.atlas, 0, 0);
      this.atlas = newAtlas;
      this.ctx = newCtx;
    } else {
      const newAtlas = document.createElement("canvas");
      newAtlas.width = this.atlasWidth;
      newAtlas.height = newHeight;
      const newCtx = newAtlas.getContext("2d")!;
      newCtx.drawImage(this.atlas, 0, 0);
      this.atlas = newAtlas;
      this.ctx = newCtx;
    }
    this.atlasHeight = newHeight;
  }

  stampTo(
    targetCtx: CanvasRenderingContext2D,
    pos: { x: number; y: number },
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ) {
    targetCtx.drawImage(
      this.atlas as CanvasImageSource,
      pos.x, pos.y, this.cellWidth, this.cellHeight,
      dx, dy, dw, dh,
    );
  }

  clear() {
    this.map.clear();
    this.nextX = 0;
    this.nextY = 0;
    if (this.atlasHeight > this.initialAtlasHeight) {
      this.atlasHeight = this.initialAtlasHeight;
      if (typeof OffscreenCanvas !== "undefined") {
        this.atlas = new OffscreenCanvas(this.atlasWidth, this.atlasHeight);
        this.ctx = this.atlas.getContext("2d")!;
      } else {
        (this.atlas as HTMLCanvasElement).width = this.atlasWidth;
        (this.atlas as HTMLCanvasElement).height = this.atlasHeight;
      }
    } else {
      this.ctx.clearRect(0, 0, this.atlasWidth, this.atlasHeight);
    }
  }

  get size() { return this.map.size; }
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
  private fullDirty: boolean = true;
  private dirtyRows = new Set<number>();
  private rafId: number | null = null;
  private glyphCache: GlyphCache | null = null;
  private urlRanges = new Map<number, UrlRange[]>();

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

    if (this.glyphCache) this.glyphCache.clear();
    this.glyphCache = new GlyphCache(this.charWidth, this.charHeight, dpr);
  }

  private buildFont(bold: boolean, italic: boolean): string {
    const weight = bold ? "bold" : "normal";
    const style = italic ? "italic" : "normal";
    return `${style} ${weight} ${this.config.fontSize}px "${this.config.fontFamily}", "Rain Symbols Fallback", monospace`;
  }

  resize(cols: number, rows: number): void {
    this.config.cols = cols;
    this.config.rows = rows;

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

    this.urlRanges.clear();
    this.measureFont();
    this.fullDirty = true;
    this.scheduleRender();
  }

  setDevicePixelRatio(devicePixelRatio: number): void {
    const next = Math.max(1, devicePixelRatio || 1);
    if (Math.abs(next - this.config.devicePixelRatio) < 0.01) return;
    this.config.devicePixelRatio = next;
    this.measureFont();
    this.fullDirty = true;
    this.scheduleRender();
  }

  updateCell(row: number, col: number, cell: CanvasCell): void {
    if (row < 0 || row >= this.config.rows || col < 0 || col >= this.config.cols) return;
    this.grid[row][col] = cell;
    this.dirtyRows.add(row);
    this.scheduleRender();
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
    let lineText = "";
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
      lineText += span.text;
    }
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

    if (lineText.length >= 8 && lineText.includes("://")) {
      const urls: UrlRange[] = [];
      const regex = new RegExp(URL_REGEX.source, "g");
      let match: RegExpExecArray | null;
      while ((match = regex.exec(lineText)) !== null) {
        urls.push({
          startCol: match.index,
          endCol: match.index + match[0].length - 1,
          url: match[0],
        });
      }
      if (urls.length > 0) {
        this.urlRanges.set(row, urls);
      } else {
        this.urlRanges.delete(row);
      }
    } else {
      this.urlRanges.delete(row);
    }

    this.dirtyRows.add(row);
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.render();
    });
  }

  render(): void {
    if (!this.fullDirty && this.dirtyRows.size === 0) return;

    const ctx = this.ctx;
    const cw = this.charWidth;
    const ch = this.charHeight;
    const dpr = this.config.devicePixelRatio;
    const baselineOffset = this.config.fontSize * 0.85;
    const cache = this.glyphCache;

    if (this.fullDirty) {
      this.fullDirty = false;
      this.dirtyRows.clear();
      ctx.fillStyle = this.config.defaultBg;
      ctx.fillRect(0, 0, this.viewportWidth, this.viewportHeight);
      for (let r = 0; r < this.config.rows; r++) {
        this.renderRow(r, ctx, cw, ch, dpr, baselineOffset, cache);
      }
    } else {
      const rows = this.dirtyRows;
      this.dirtyRows = new Set();
      for (const r of rows) {
        ctx.fillStyle = this.config.defaultBg;
        ctx.fillRect(0, r * ch, this.viewportWidth, ch);
        this.renderRow(r, ctx, cw, ch, dpr, baselineOffset, cache);
      }
    }
  }

  private renderRow(
    r: number,
    ctx: CanvasRenderingContext2D,
    cw: number,
    ch: number,
    dpr: number,
    baselineOffset: number,
    cache: GlyphCache | null,
  ): void {
    const y = r * ch;
    const row = this.grid[r];
    if (!row) return;

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

    for (let c = 0; c < this.config.cols; c++) {
      const cell = row[c];
      if (!cell || cell.char === " " || cell.char === "") continue;

      if (cache) {
        const key = makeGlyphKey(cell.char, cell.fg, cell.bold, cell.italic, cell.dim);
        let cached = cache.get(key);
        if (!cached) {
          cached = cache.put(key, (atlasCtx, ax, ay, _aw, _ah) => {
            atlasCtx.clearRect(ax, ay, _aw, _ah);
            atlasCtx.font = this.buildFont(cell.bold, cell.italic);
            atlasCtx.fillStyle = cell.dim ? this.dimColor(cell.fg) : cell.fg;
            atlasCtx.textBaseline = "alphabetic";
            const atlasBaseline = this.config.fontSize * 0.85 * dpr;
            atlasCtx.fillText(cell.char, ax, ay + atlasBaseline);
          });
        }
        cache.stampTo(ctx, cached, c * cw, y, cw, ch);
      } else {
        ctx.font = this.buildFont(cell.bold, cell.italic);
        ctx.fillStyle = cell.dim ? this.dimColor(cell.fg) : cell.fg;
        ctx.fillText(cell.char, c * cw, y + baselineOffset);
      }

      if (cell.underline) {
        ctx.strokeStyle = cell.dim ? this.dimColor(cell.fg) : cell.fg;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(c * cw, y + ch - 2);
        ctx.lineTo((c + 1) * cw, y + ch - 2);
        ctx.stroke();
      }

      if (cell.strikethrough) {
        ctx.strokeStyle = cell.dim ? this.dimColor(cell.fg) : cell.fg;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(c * cw, y + ch / 2);
        ctx.lineTo((c + 1) * cw, y + ch / 2);
        ctx.stroke();
      }
    }

    const urls = this.urlRanges.get(r);
    if (urls) {
      ctx.strokeStyle = "#58a6ff";
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.6;
      for (const u of urls) {
        const sx = u.startCol * cw;
        const ex = (u.endCol + 1) * cw;
        ctx.beginPath();
        ctx.moveTo(sx, y + ch - 1);
        ctx.lineTo(ex, y + ch - 1);
        ctx.stroke();
      }
      ctx.globalAlpha = 1.0;
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

  renderSelection(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    color: string,
  ): void {
    const ctx = this.ctx;
    const cw = this.charWidth;
    const ch = this.charHeight;

    ctx.fillStyle = color;
    ctx.globalAlpha = 0.3;

    if (startRow === endRow) {
      ctx.fillRect(startCol * cw, startRow * ch, (endCol - startCol + 1) * cw, ch);
    } else {
      ctx.fillRect(startCol * cw, startRow * ch, (this.config.cols - startCol) * cw, ch);
      for (let r = startRow + 1; r < endRow; r++) {
        ctx.fillRect(0, r * ch, this.config.cols * cw, ch);
      }
      ctx.fillRect(0, endRow * ch, (endCol + 1) * cw, ch);
    }

    ctx.globalAlpha = 1.0;
  }

  renderSearchMatches(
    matches: Array<{ row: number; startCol: number; endCol: number; isCurrent: boolean }>,
    matchColor: string,
    currentColor: string,
  ): void {
    if (matches.length === 0) return;
    const ctx = this.ctx;
    const cw = this.charWidth;
    const ch = this.charHeight;

    for (const m of matches) {
      if (m.row < 0 || m.row >= this.config.rows) continue;
      ctx.fillStyle = m.isCurrent ? currentColor : matchColor;
      ctx.globalAlpha = m.isCurrent ? 0.5 : 0.25;
      const width = Math.max(1, m.endCol - m.startCol + 1);
      ctx.fillRect(m.startCol * cw, m.row * ch, width * cw, ch);
    }
    ctx.globalAlpha = 1.0;
  }

  getUrlAt(row: number, col: number): string | null {
    const urls = this.urlRanges.get(row);
    if (!urls) return null;
    for (const u of urls) {
      if (col >= u.startCol && col <= u.endCol) return u.url;
    }
    return null;
  }

  startRenderLoop(): void {
    this.scheduleRender();
  }

  stopRenderLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  destroy(): void {
    this.stopRenderLoop();
    this.glyphCache?.clear();
    this.glyphCache = null;
    this.urlRanges.clear();
  }

  getCharWidth(): number {
    return this.charWidth;
  }

  getCharHeight(): number {
    return this.charHeight;
  }

  clearGlyphCache(): void {
    this.glyphCache?.clear();
    this.fullDirty = true;
    this.scheduleRender();
  }
}
