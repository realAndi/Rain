import type { CanvasRendererConfig, CanvasCell } from "./canvasRenderer";

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;

interface UrlRange {
  startCol: number;
  endCol: number;
  url: string;
}

type GlyphKey = string;
type Rgba = [number, number, number, number];

interface GlyphPixelPos {
  x: number;
  y: number;
}

interface GlyphUvRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

const GLYPH_ATLAS_COLUMNS = 64;
const GLYPH_ATLAS_INITIAL_ROWS = 16;
const GLYPH_ATLAS_MAX_ROWS = 512;
const BG_INSTANCE_STRIDE_FLOATS = 8;
const GLYPH_INSTANCE_STRIDE_FLOATS = 10;
const BYTES_PER_FLOAT = 4;

// --- Shader sources ---

const BG_VERTEX_SRC = `#version 300 es
in vec2 a_unitQuad;
in vec2 a_position;
in vec2 a_size;
in vec4 a_color;
uniform vec2 u_cellSize;
uniform mat4 u_projection;
out vec4 v_color;
void main() {
  vec2 pixelPos = (a_position + (a_unitQuad * a_size)) * u_cellSize;
  gl_Position = u_projection * vec4(pixelPos, 0.0, 1.0);
  v_color = a_color;
}
`;

const BG_FRAGMENT_SRC = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 fragColor;
void main() {
  if (v_color.a < 0.01) discard;
  fragColor = v_color;
}
`;

const GLYPH_VERTEX_SRC = `#version 300 es
in vec2 a_unitQuad;
in vec2 a_position;
in vec4 a_texCoord;
in vec4 a_fgColor;
uniform vec2 u_cellSize;
uniform mat4 u_projection;
out vec2 v_uv;
out vec4 v_color;
void main() {
  vec2 pixelPos = (a_position + a_unitQuad) * u_cellSize;
  gl_Position = u_projection * vec4(pixelPos, 0.0, 1.0);
  v_uv = mix(a_texCoord.xy, a_texCoord.zw, a_unitQuad);
  v_color = a_fgColor;
}
`;

const GLYPH_FRAGMENT_SRC = `#version 300 es
precision mediump float;
uniform sampler2D u_atlas;
in vec2 v_uv;
in vec4 v_color;
out vec4 fragColor;
void main() {
  float alpha = texture(u_atlas, v_uv).r;
  if (alpha < 0.01) discard;
  fragColor = vec4(v_color.rgb, v_color.a * alpha);
}
`;

// --- Helpers ---

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Failed to create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "";
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${log}`);
  }
  return shader;
}

function linkProgram(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error("Failed to create program");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "";
    gl.deleteProgram(program);
    throw new Error(`Program link error: ${log}`);
  }
  return program;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function parseHexColor(hex: string): Rgba {
  const h = hex.replace("#", "");
  if (h.length === 3) {
    const r = parseInt(h[0] + h[0], 16) / 255;
    const g = parseInt(h[1] + h[1], 16) / 255;
    const b = parseInt(h[2] + h[2], 16) / 255;
    return [clamp01(r), clamp01(g), clamp01(b), 1.0];
  }
  if (h.length === 4) {
    const r = parseInt(h[0] + h[0], 16) / 255;
    const g = parseInt(h[1] + h[1], 16) / 255;
    const b = parseInt(h[2] + h[2], 16) / 255;
    const a = parseInt(h[3] + h[3], 16) / 255;
    return [clamp01(r), clamp01(g), clamp01(b), clamp01(a)];
  }
  if (h.length === 6) {
    const r = parseInt(h.substring(0, 2), 16) / 255;
    const g = parseInt(h.substring(2, 4), 16) / 255;
    const b = parseInt(h.substring(4, 6), 16) / 255;
    return [clamp01(r), clamp01(g), clamp01(b), 1.0];
  }
  if (h.length === 8) {
    const r = parseInt(h.substring(0, 2), 16) / 255;
    const g = parseInt(h.substring(2, 4), 16) / 255;
    const b = parseInt(h.substring(4, 6), 16) / 255;
    const a = parseInt(h.substring(6, 8), 16) / 255;
    return [clamp01(r), clamp01(g), clamp01(b), clamp01(a)];
  }
  return [1, 1, 1, 1];
}

function parseCssColor(color: string): Rgba {
  const input = color.trim();
  if (!input) return [1, 1, 1, 1];
  const lower = input.toLowerCase();
  if (lower === "transparent") return [0, 0, 0, 0];
  if (input.startsWith("#")) return parseHexColor(input);

  const varMatch = input.match(/^var\(\s*(--[^,\s)]+)\s*(?:,\s*([^)]+))?\)$/i);
  if (varMatch) {
    const varName = varMatch[1];
    const fallback = varMatch[2]?.trim();
    if (typeof document !== "undefined") {
      const resolved = getComputedStyle(document.documentElement)
        .getPropertyValue(varName)
        .trim();
      if (resolved) return parseCssColor(resolved);
    }
    if (fallback) return parseCssColor(fallback);
    return [1, 1, 1, 1];
  }

  const match = input.match(/^rgba?\(([^)]+)\)$/i);
  if (!match) return [1, 1, 1, 1];
  const parts = match[1].split(",").map((part) => part.trim());
  if (parts.length !== 3 && parts.length !== 4) return [1, 1, 1, 1];

  const r = Number(parts[0]);
  const g = Number(parts[1]);
  const b = Number(parts[2]);
  const a = parts.length === 4 ? Number(parts[3]) : 1;
  if (![r, g, b, a].every((value) => Number.isFinite(value))) {
    return [1, 1, 1, 1];
  }

  return [clamp01(r / 255), clamp01(g / 255), clamp01(b / 255), clamp01(a)];
}

function buildOrthoProjection(width: number, height: number): Float32Array {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  return new Float32Array([
    2 / w, 0, 0, 0,
    0, -2 / h, 0, 0,
    0, 0, 1, 0,
    -1, 1, 0, 1,
  ]);
}

function makeGlyphKey(char: string, bold: boolean, italic: boolean): GlyphKey {
  return `${char}\x00${bold ? 1 : 0}${italic ? 1 : 0}`;
}

function createAtlasSurface(
  width: number,
  height: number,
): {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
} {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to create 2D context for glyph atlas");
    return { canvas, ctx };
  }
  if (typeof document === "undefined") {
    throw new Error("document is unavailable for glyph atlas canvas fallback");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to create 2D context for glyph atlas fallback");
  return { canvas, ctx };
}

class WebGLGlyphAtlas {
  private gl: WebGL2RenderingContext;
  private dpr: number;
  private fontFamily: string;
  private fontSize: number;
  private cellWidth: number;
  private cellHeight: number;
  private atlasWidth: number;
  private atlasHeight: number;
  private atlasRows: number;
  private atlas: OffscreenCanvas | HTMLCanvasElement;
  private ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  private texture: WebGLTexture;
  private map = new Map<GlyphKey, GlyphPixelPos>();
  private nextX = 0;
  private nextY = 0;
  private dirty = true;
  private needsTextureRecreate = false;
  private baselinePx: number;

  constructor(
    gl: WebGL2RenderingContext,
    cellWidth: number,
    cellHeight: number,
    dpr: number,
    fontFamily: string,
    fontSize: number,
  ) {
    this.gl = gl;
    this.dpr = Math.max(1, dpr || 1);
    this.fontFamily = fontFamily;
    this.fontSize = fontSize;
    this.cellWidth = Math.max(1, Math.ceil(cellWidth * this.dpr));
    this.cellHeight = Math.max(1, Math.ceil(cellHeight * this.dpr));
    this.atlasWidth = this.cellWidth * GLYPH_ATLAS_COLUMNS;
    this.atlasRows = GLYPH_ATLAS_INITIAL_ROWS;
    this.atlasHeight = this.cellHeight * this.atlasRows;
    this.baselinePx = this.fontSize * 0.85 * this.dpr;

    const { canvas, ctx } = createAtlasSurface(this.atlasWidth, this.atlasHeight);
    this.atlas = canvas;
    this.ctx = ctx;
    this.ctx.textBaseline = "alphabetic";

    this.texture = this.createTexture();
    this.needsTextureRecreate = true;
    this.dirty = true;
  }

  private buildFont(bold: boolean, italic: boolean): string {
    const weight = bold ? "bold" : "normal";
    const style = italic ? "italic" : "normal";
    return `${style} ${weight} ${this.fontSize}px "${this.fontFamily}", "Rain Symbols Fallback", monospace`;
  }

  private createTexture(): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error("Failed to create glyph atlas texture");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const filter = this.dpr >= 2 ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  private ensureWritePosition(): void {
    if (this.nextX + this.cellWidth > this.atlasWidth) {
      this.nextX = 0;
      this.nextY += this.cellHeight;
    }
    if (this.nextY + this.cellHeight <= this.atlasHeight) return;

    if (this.atlasRows >= GLYPH_ATLAS_MAX_ROWS) {
      this.clear();
      return;
    }

    const nextRows = Math.min(this.atlasRows * 2, GLYPH_ATLAS_MAX_ROWS);
    this.grow(nextRows * this.cellHeight);
  }

  private grow(newHeight: number): void {
    const oldAtlas = this.atlas;
    const { canvas: nextAtlas, ctx: nextCtx } = createAtlasSurface(this.atlasWidth, newHeight);
    nextCtx.drawImage(oldAtlas as CanvasImageSource, 0, 0);
    nextCtx.textBaseline = "alphabetic";
    this.atlas = nextAtlas;
    this.ctx = nextCtx;
    this.atlasHeight = newHeight;
    this.atlasRows = Math.max(1, Math.floor(newHeight / this.cellHeight));
    this.needsTextureRecreate = true;
    this.dirty = true;
  }

  private toUv(pos: GlyphPixelPos): GlyphUvRect {
    return {
      u0: pos.x / this.atlasWidth,
      v0: pos.y / this.atlasHeight,
      u1: (pos.x + this.cellWidth) / this.atlasWidth,
      v1: (pos.y + this.cellHeight) / this.atlasHeight,
    };
  }

  getGlyph(char: string, bold: boolean, italic: boolean): GlyphUvRect {
    const key = makeGlyphKey(char, bold, italic);
    const existing = this.map.get(key);
    if (existing) return this.toUv(existing);

    this.ensureWritePosition();

    const pos: GlyphPixelPos = { x: this.nextX, y: this.nextY };
    this.ctx.clearRect(pos.x, pos.y, this.cellWidth, this.cellHeight);
    this.ctx.font = this.buildFont(bold, italic);
    this.ctx.fillStyle = "#ffffff";
    this.ctx.textBaseline = "alphabetic";
    this.ctx.fillText(char, pos.x, pos.y + this.baselinePx);

    this.map.set(key, pos);
    this.nextX += this.cellWidth;
    this.dirty = true;
    return this.toUv(pos);
  }

  uploadIfDirty(): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);

    if (this.needsTextureRecreate) {
      const oldTexture = this.texture;
      this.texture = this.createTexture();
      gl.deleteTexture(oldTexture);
      this.needsTextureRecreate = false;
      this.dirty = true;
    }

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (!this.dirty) return;

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.atlas as TexImageSource,
    );
    this.dirty = false;
  }

  getTexture(): WebGLTexture {
    return this.texture;
  }

  matches(
    cellWidth: number,
    cellHeight: number,
    dpr: number,
    fontFamily: string,
    fontSize: number,
  ): boolean {
    const nextDpr = Math.max(1, dpr || 1);
    const nextCellWidth = Math.max(1, Math.ceil(cellWidth * nextDpr));
    const nextCellHeight = Math.max(1, Math.ceil(cellHeight * nextDpr));
    return (
      this.cellWidth === nextCellWidth &&
      this.cellHeight === nextCellHeight &&
      Math.abs(this.dpr - nextDpr) < 0.01 &&
      this.fontFamily === fontFamily &&
      Math.abs(this.fontSize - fontSize) < 0.01
    );
  }

  clear(): void {
    this.map.clear();
    this.nextX = 0;
    this.nextY = 0;

    const initialHeight = this.cellHeight * GLYPH_ATLAS_INITIAL_ROWS;
    if (this.atlasHeight !== initialHeight) {
      const { canvas, ctx } = createAtlasSurface(this.atlasWidth, initialHeight);
      this.atlas = canvas;
      this.ctx = ctx;
      this.atlasHeight = initialHeight;
      this.atlasRows = GLYPH_ATLAS_INITIAL_ROWS;
      this.ctx.textBaseline = "alphabetic";
      this.needsTextureRecreate = true;
    } else {
      this.ctx.clearRect(0, 0, this.atlasWidth, this.atlasHeight);
    }

    this.dirty = true;
  }

  destroy(): void {
    this.map.clear();
    this.gl.deleteTexture(this.texture);
  }
}

// --- Detection ---

export function canUseWebGLRenderer(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    return gl !== null;
  } catch {
    return false;
  }
}

// --- Renderer ---

export class WebGLTerminalRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private config: CanvasRendererConfig;
  private charWidth: number = 0;
  private charHeight: number = 0;
  private viewportWidth: number = 0;
  private viewportHeight: number = 0;

  private bgProgram: WebGLProgram;
  private glyphProgram: WebGLProgram;
  private unitQuadVBO: WebGLBuffer;
  private unitQuadEBO: WebGLBuffer;
  private bgInstanceVBO: WebGLBuffer;
  private glyphInstanceVBO: WebGLBuffer;
  private bgVAO: WebGLVertexArrayObject;
  private glyphVAO: WebGLVertexArrayObject;
  private bgInstanceData = new Float32Array(0);
  private glyphInstanceData = new Float32Array(0);
  private colorCache = new Map<string, Rgba>();

  private bgLocations: {
    a_unitQuad: number;
    a_position: number;
    a_size: number;
    a_color: number;
    u_cellSize: WebGLUniformLocation | null;
    u_projection: WebGLUniformLocation | null;
  };
  private glyphLocations: {
    a_unitQuad: number;
    a_position: number;
    a_texCoord: number;
    a_fgColor: number;
    u_cellSize: WebGLUniformLocation | null;
    u_projection: WebGLUniformLocation | null;
    u_atlas: WebGLUniformLocation | null;
  };

  private grid: CanvasCell[][] = [];
  private fullDirty: boolean = true;
  private dirtyRows = new Set<number>();
  private rafId: number | null = null;
  private contextLost: boolean = false;
  private urlRanges = new Map<number, UrlRange[]>();
  private defaultBgColor: Rgba = [0, 0, 0, 1];
  private projectionMatrix = new Float32Array(16);
  private glyphAtlas: WebGLGlyphAtlas | null = null;

  private overlayDirty = false;
  private cursorState: { row: number; col: number; shape: "block" | "underline" | "bar"; color: string } | null = null;
  private selectionState: { startRow: number; startCol: number; endRow: number; endCol: number; color: string } | null = null;
  private searchState: { matches: Array<{ row: number; startCol: number; endCol: number; isCurrent: boolean }>; matchColor: string; currentColor: string } | null = null;

  private handleContextLost: (e: Event) => void;
  private handleContextRestored: (e: Event) => void;

  constructor(canvas: HTMLCanvasElement, config: CanvasRendererConfig) {
    this.canvas = canvas;
    this.config = { ...config };

    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;

    this.handleContextLost = (e: Event) => {
      e.preventDefault();
      this.contextLost = true;
      this.stopRenderLoop();
    };
    this.handleContextRestored = (_e: Event) => {
      this.contextLost = false;
      this.initGL();
      this.updateProjectionUniforms();
      this.fullDirty = true;
      this.scheduleRender();
    };
    canvas.addEventListener("webglcontextlost", this.handleContextLost);
    canvas.addEventListener("webglcontextrestored", this.handleContextRestored);

    this.bgProgram = null!;
    this.glyphProgram = null!;
    this.unitQuadVBO = null!;
    this.unitQuadEBO = null!;
    this.bgInstanceVBO = null!;
    this.glyphInstanceVBO = null!;
    this.bgVAO = null!;
    this.glyphVAO = null!;
    this.bgLocations = null!;
    this.glyphLocations = null!;

    this.initGL();
    this.measureFont();
    this.resize(config.cols, config.rows);
  }

  private initGL(): void {
    const gl = this.gl;

    // Compile shaders and link programs
    const bgVS = compileShader(gl, gl.VERTEX_SHADER, BG_VERTEX_SRC);
    const bgFS = compileShader(gl, gl.FRAGMENT_SHADER, BG_FRAGMENT_SRC);
    this.bgProgram = linkProgram(gl, bgVS, bgFS);
    gl.deleteShader(bgVS);
    gl.deleteShader(bgFS);

    const glyphVS = compileShader(gl, gl.VERTEX_SHADER, GLYPH_VERTEX_SRC);
    const glyphFS = compileShader(gl, gl.FRAGMENT_SHADER, GLYPH_FRAGMENT_SRC);
    this.glyphProgram = linkProgram(gl, glyphVS, glyphFS);
    gl.deleteShader(glyphVS);
    gl.deleteShader(glyphFS);

    // Cache attribute and uniform locations
    this.bgLocations = {
      a_unitQuad: gl.getAttribLocation(this.bgProgram, "a_unitQuad"),
      a_position: gl.getAttribLocation(this.bgProgram, "a_position"),
      a_size: gl.getAttribLocation(this.bgProgram, "a_size"),
      a_color: gl.getAttribLocation(this.bgProgram, "a_color"),
      u_cellSize: gl.getUniformLocation(this.bgProgram, "u_cellSize"),
      u_projection: gl.getUniformLocation(this.bgProgram, "u_projection"),
    };
    this.glyphLocations = {
      a_unitQuad: gl.getAttribLocation(this.glyphProgram, "a_unitQuad"),
      a_position: gl.getAttribLocation(this.glyphProgram, "a_position"),
      a_texCoord: gl.getAttribLocation(this.glyphProgram, "a_texCoord"),
      a_fgColor: gl.getAttribLocation(this.glyphProgram, "a_fgColor"),
      u_cellSize: gl.getUniformLocation(this.glyphProgram, "u_cellSize"),
      u_projection: gl.getUniformLocation(this.glyphProgram, "u_projection"),
      u_atlas: gl.getUniformLocation(this.glyphProgram, "u_atlas"),
    };

    // Create shared unit quad geometry
    // Two triangles forming a 1x1 quad: (0,0), (1,0), (0,1), (1,1)
    const quadVerts = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    const quadIndices = new Uint16Array([0, 1, 2, 2, 1, 3]);

    this.unitQuadVBO = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitQuadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

    this.unitQuadEBO = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.unitQuadEBO);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, quadIndices, gl.STATIC_DRAW);

    this.allocateInstanceArrays();
    this.bgInstanceVBO = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bgInstanceVBO);
    gl.bufferData(gl.ARRAY_BUFFER, this.bgInstanceData, gl.DYNAMIC_DRAW);

    this.glyphInstanceVBO = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphInstanceVBO);
    gl.bufferData(gl.ARRAY_BUFFER, this.glyphInstanceData, gl.DYNAMIC_DRAW);

    this.bgVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.bgVAO);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.unitQuadEBO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitQuadVBO);
    gl.enableVertexAttribArray(this.bgLocations.a_unitQuad);
    gl.vertexAttribPointer(this.bgLocations.a_unitQuad, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(this.bgLocations.a_unitQuad, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bgInstanceVBO);
    gl.enableVertexAttribArray(this.bgLocations.a_position);
    gl.vertexAttribPointer(
      this.bgLocations.a_position,
      2,
      gl.FLOAT,
      false,
      BG_INSTANCE_STRIDE_FLOATS * BYTES_PER_FLOAT,
      0,
    );
    gl.vertexAttribDivisor(this.bgLocations.a_position, 1);
    gl.enableVertexAttribArray(this.bgLocations.a_size);
    gl.vertexAttribPointer(
      this.bgLocations.a_size,
      2,
      gl.FLOAT,
      false,
      BG_INSTANCE_STRIDE_FLOATS * BYTES_PER_FLOAT,
      2 * BYTES_PER_FLOAT,
    );
    gl.vertexAttribDivisor(this.bgLocations.a_size, 1);
    gl.enableVertexAttribArray(this.bgLocations.a_color);
    gl.vertexAttribPointer(
      this.bgLocations.a_color,
      4,
      gl.FLOAT,
      false,
      BG_INSTANCE_STRIDE_FLOATS * BYTES_PER_FLOAT,
      4 * BYTES_PER_FLOAT,
    );
    gl.vertexAttribDivisor(this.bgLocations.a_color, 1);

    this.glyphVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.glyphVAO);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.unitQuadEBO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitQuadVBO);
    gl.enableVertexAttribArray(this.glyphLocations.a_unitQuad);
    gl.vertexAttribPointer(this.glyphLocations.a_unitQuad, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(this.glyphLocations.a_unitQuad, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphInstanceVBO);
    gl.enableVertexAttribArray(this.glyphLocations.a_position);
    gl.vertexAttribPointer(
      this.glyphLocations.a_position,
      2,
      gl.FLOAT,
      false,
      GLYPH_INSTANCE_STRIDE_FLOATS * BYTES_PER_FLOAT,
      0,
    );
    gl.vertexAttribDivisor(this.glyphLocations.a_position, 1);
    gl.enableVertexAttribArray(this.glyphLocations.a_texCoord);
    gl.vertexAttribPointer(
      this.glyphLocations.a_texCoord,
      4,
      gl.FLOAT,
      false,
      GLYPH_INSTANCE_STRIDE_FLOATS * BYTES_PER_FLOAT,
      2 * BYTES_PER_FLOAT,
    );
    gl.vertexAttribDivisor(this.glyphLocations.a_texCoord, 1);
    gl.enableVertexAttribArray(this.glyphLocations.a_fgColor);
    gl.vertexAttribPointer(
      this.glyphLocations.a_fgColor,
      4,
      gl.FLOAT,
      false,
      GLYPH_INSTANCE_STRIDE_FLOATS * BYTES_PER_FLOAT,
      6 * BYTES_PER_FLOAT,
    );
    gl.vertexAttribDivisor(this.glyphLocations.a_fgColor, 1);
    gl.bindVertexArray(null);

    // GL state
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    this.defaultBgColor = parseHexColor(this.config.defaultBg);
    this.syncGlyphAtlas(true);
  }

  private allocateInstanceArrays(): void {
    const cellCount = Math.max(1, this.config.rows * this.config.cols);
    this.bgInstanceData = new Float32Array(cellCount * BG_INSTANCE_STRIDE_FLOATS);
    this.glyphInstanceData = new Float32Array(cellCount * GLYPH_INSTANCE_STRIDE_FLOATS);
  }

  private colorToRgba(color: string): Rgba {
    const cached = this.colorCache.get(color);
    if (cached) return cached;
    const parsed = parseCssColor(color);
    this.colorCache.set(color, parsed);
    return parsed;
  }

  private drawOverlayQuad(col: number, row: number, width: number, height: number, rgba: Rgba): void {
    if (this.contextLost) return;
    if (width <= 0 || height <= 0) return;
    const gl = this.gl;
    const [r, g, b, a] = rgba;
    if (a <= 0) return;

    gl.useProgram(this.bgProgram);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitQuadVBO);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.unitQuadEBO);

    gl.enableVertexAttribArray(this.bgLocations.a_unitQuad);
    gl.vertexAttribPointer(this.bgLocations.a_unitQuad, 2, gl.FLOAT, false, 0, 0);

    gl.disableVertexAttribArray(this.bgLocations.a_position);
    gl.disableVertexAttribArray(this.bgLocations.a_size);
    gl.disableVertexAttribArray(this.bgLocations.a_color);
    gl.vertexAttrib2f(this.bgLocations.a_position, col, row);
    gl.vertexAttrib2f(this.bgLocations.a_size, width, height);
    gl.vertexAttrib4f(this.bgLocations.a_color, r, g, b, a);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  private rebuildRowInstances(row: number): void {
    if (row < 0 || row >= this.config.rows) return;

    const cols = this.config.cols;
    const rowCells = this.grid[row];
    const bgBase = row * cols * BG_INSTANCE_STRIDE_FLOATS;
    const glyphBase = row * cols * GLYPH_INSTANCE_STRIDE_FLOATS;
    const atlas = this.glyphAtlas;

    for (let col = 0; col < cols; col++) {
      const cell = rowCells[col];
      const char = cell?.char ?? " ";
      const fg = cell?.fg ?? this.config.defaultFg;
      const bg = cell?.bg ?? this.config.defaultBg;
      const bold = cell?.bold ?? false;
      const italic = cell?.italic ?? false;
      const dim = cell?.dim ?? false;

      const bgOffset = bgBase + col * BG_INSTANCE_STRIDE_FLOATS;
      this.bgInstanceData[bgOffset] = col;
      this.bgInstanceData[bgOffset + 1] = row;
      this.bgInstanceData[bgOffset + 2] = 1;
      this.bgInstanceData[bgOffset + 3] = 1;

      const hasCustomBg = bg !== "transparent" && bg !== this.config.defaultBg;
      if (hasCustomBg) {
        const [r, g, b, a] = this.colorToRgba(bg);
        this.bgInstanceData[bgOffset + 4] = r;
        this.bgInstanceData[bgOffset + 5] = g;
        this.bgInstanceData[bgOffset + 6] = b;
        this.bgInstanceData[bgOffset + 7] = a;
      } else {
        this.bgInstanceData[bgOffset + 4] = 0;
        this.bgInstanceData[bgOffset + 5] = 0;
        this.bgInstanceData[bgOffset + 6] = 0;
        this.bgInstanceData[bgOffset + 7] = 0;
      }

      const glyphOffset = glyphBase + col * GLYPH_INSTANCE_STRIDE_FLOATS;
      this.glyphInstanceData[glyphOffset] = col;
      this.glyphInstanceData[glyphOffset + 1] = row;

      if (!atlas || char === " " || char === "") {
        this.glyphInstanceData[glyphOffset + 2] = 0;
        this.glyphInstanceData[glyphOffset + 3] = 0;
        this.glyphInstanceData[glyphOffset + 4] = 0;
        this.glyphInstanceData[glyphOffset + 5] = 0;
        this.glyphInstanceData[glyphOffset + 6] = 0;
        this.glyphInstanceData[glyphOffset + 7] = 0;
        this.glyphInstanceData[glyphOffset + 8] = 0;
        this.glyphInstanceData[glyphOffset + 9] = 0;
        continue;
      }

      const uv = atlas.getGlyph(char, bold, italic);
      this.glyphInstanceData[glyphOffset + 2] = uv.u0;
      this.glyphInstanceData[glyphOffset + 3] = uv.v0;
      this.glyphInstanceData[glyphOffset + 4] = uv.u1;
      this.glyphInstanceData[glyphOffset + 5] = uv.v1;

      const [fr, fgColor, fb, fa] = this.colorToRgba(fg);
      const dimScale = dim ? 0.5 : 1;
      this.glyphInstanceData[glyphOffset + 6] = fr * dimScale;
      this.glyphInstanceData[glyphOffset + 7] = fgColor * dimScale;
      this.glyphInstanceData[glyphOffset + 8] = fb * dimScale;
      this.glyphInstanceData[glyphOffset + 9] = fa;
    }
  }

  private syncGlyphAtlas(forceRecreate: boolean): void {
    if (this.charWidth <= 0 || this.charHeight <= 0) return;
    if (
      !forceRecreate &&
      this.glyphAtlas &&
      this.glyphAtlas.matches(
        this.charWidth,
        this.charHeight,
        this.config.devicePixelRatio,
        this.config.fontFamily,
        this.config.fontSize,
      )
    ) {
      return;
    }
    this.glyphAtlas?.destroy();
    this.glyphAtlas = new WebGLGlyphAtlas(
      this.gl,
      this.charWidth,
      this.charHeight,
      this.config.devicePixelRatio,
      this.config.fontFamily,
      this.config.fontSize,
    );
  }

  private measureFont(): void {
    const dpr = Math.max(1, this.config.devicePixelRatio || 1);
    this.config.devicePixelRatio = dpr;

    const measureCanvas = document.createElement("canvas");
    const measureCtx = measureCanvas.getContext("2d")!;
    measureCtx.font = this.buildFont(false, false);
    const metrics = measureCtx.measureText("M");
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

    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  private buildFont(bold: boolean, italic: boolean): string {
    const weight = bold ? "bold" : "normal";
    const style = italic ? "italic" : "normal";
    return `${style} ${weight} ${this.config.fontSize}px "${this.config.fontFamily}", "Rain Symbols Fallback", monospace`;
  }

  private updateProjectionUniforms(): void {
    const gl = this.gl;
    const dpr = this.config.devicePixelRatio;
    const widthPx = this.viewportWidth * dpr;
    const heightPx = this.viewportHeight * dpr;
    const cellW = this.charWidth * dpr;
    const cellH = this.charHeight * dpr;
    this.projectionMatrix.set(buildOrthoProjection(widthPx, heightPx));

    gl.useProgram(this.bgProgram);
    gl.uniform2f(this.bgLocations.u_cellSize, cellW, cellH);
    gl.uniformMatrix4fv(this.bgLocations.u_projection, false, this.projectionMatrix);

    gl.useProgram(this.glyphProgram);
    gl.uniform2f(this.glyphLocations.u_cellSize, cellW, cellH);
    gl.uniformMatrix4fv(this.glyphLocations.u_projection, false, this.projectionMatrix);
  }

  // --- Public API (matches CanvasTerminalRenderer) ---

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
    this.syncGlyphAtlas(false);
    this.allocateInstanceArrays();
    this.colorCache.clear();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.bgInstanceVBO);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, this.bgInstanceData, this.gl.DYNAMIC_DRAW);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.glyphInstanceVBO);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, this.glyphInstanceData, this.gl.DYNAMIC_DRAW);
    this.updateProjectionUniforms();
    this.fullDirty = true;
    this.scheduleRender();
  }

  setDevicePixelRatio(devicePixelRatio: number): void {
    const next = Math.max(1, devicePixelRatio || 1);
    if (Math.abs(next - this.config.devicePixelRatio) < 0.01) return;
    this.config.devicePixelRatio = next;
    this.measureFont();
    this.syncGlyphAtlas(true);
    this.updateProjectionUniforms();
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
    if (this.contextLost) return;
    if (!this.fullDirty && this.dirtyRows.size === 0 && !this.overlayDirty) return;

    const gl = this.gl;
    const [clearR, clearG, clearB, clearA] = this.defaultBgColor;
    gl.clearColor(clearR, clearG, clearB, clearA);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const rows = this.config.rows;
    const cols = this.config.cols;
    const bgRowFloats = cols * BG_INSTANCE_STRIDE_FLOATS;
    const glyphRowFloats = cols * GLYPH_INSTANCE_STRIDE_FLOATS;

    if (this.fullDirty) {
      for (let row = 0; row < rows; row++) {
        this.rebuildRowInstances(row);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bgInstanceVBO);
      gl.bufferData(gl.ARRAY_BUFFER, this.bgInstanceData, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphInstanceVBO);
      gl.bufferData(gl.ARRAY_BUFFER, this.glyphInstanceData, gl.DYNAMIC_DRAW);
    } else if (this.dirtyRows.size > 0) {
      const dirtyRows = Array.from(this.dirtyRows.values());
      for (const row of dirtyRows) {
        this.rebuildRowInstances(row);
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, this.bgInstanceVBO);
      for (const row of dirtyRows) {
        const start = row * bgRowFloats;
        gl.bufferSubData(
          gl.ARRAY_BUFFER,
          start * BYTES_PER_FLOAT,
          this.bgInstanceData.subarray(start, start + bgRowFloats),
        );
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphInstanceVBO);
      for (const row of dirtyRows) {
        const start = row * glyphRowFloats;
        gl.bufferSubData(
          gl.ARRAY_BUFFER,
          start * BYTES_PER_FLOAT,
          this.glyphInstanceData.subarray(start, start + glyphRowFloats),
        );
      }
    }

    const atlas = this.glyphAtlas;
    atlas?.uploadIfDirty();

    const instanceCount = rows * cols;
    if (instanceCount <= 0) {
      this.fullDirty = false;
      this.dirtyRows.clear();
      this.overlayDirty = false;
      return;
    }
    gl.useProgram(this.bgProgram);
    gl.bindVertexArray(this.bgVAO);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, instanceCount);

    if (atlas) {
      gl.useProgram(this.glyphProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, atlas.getTexture());
      gl.uniform1i(this.glyphLocations.u_atlas, 0);
      gl.bindVertexArray(this.glyphVAO);
      gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, instanceCount);
    }
    gl.bindVertexArray(null);

    this.drawDecorations(rows, cols);
    this.drawUrlUnderlines(rows, cols);
    this.drawStoredSelection();
    this.drawStoredSearchMatches();
    this.drawStoredCursor();

    this.fullDirty = false;
    this.dirtyRows.clear();
    this.overlayDirty = false;
  }

  private drawDecorations(rows: number, cols: number): void {
    const lineThickness = 1 / Math.max(1, this.charHeight);
    const strikeOffset = 0.5;
    const underlineOffset = Math.max(0, this.charHeight - 2) / Math.max(1, this.charHeight);
    for (let row = 0; row < rows; row++) {
      const rowCells = this.grid[row];
      for (let col = 0; col < cols; col++) {
        const cell = rowCells[col];
        if (!cell || (!cell.underline && !cell.strikethrough)) continue;

        const [fr, fg, fb, fa] = this.colorToRgba(cell.fg ?? this.config.defaultFg);
        const dimScale = cell.dim ? 0.5 : 1;
        const color: Rgba = [fr * dimScale, fg * dimScale, fb * dimScale, fa];

        if (cell.underline) {
          this.drawOverlayQuad(col, row + underlineOffset, 1, lineThickness, color);
        }
        if (cell.strikethrough) {
          this.drawOverlayQuad(col, row + strikeOffset, 1, lineThickness, color);
        }
      }
    }
  }

  private drawUrlUnderlines(rows: number, cols: number): void {
    const lineThickness = 1 / Math.max(1, this.charHeight);
    const urlOffset = Math.max(0, this.charHeight - 1) / Math.max(1, this.charHeight);
    const urlColor: Rgba = [0x58 / 255, 0xa6 / 255, 0xff / 255, 0.6];
    for (const [row, urls] of this.urlRanges) {
      if (row < 0 || row >= rows || urls.length === 0) continue;
      for (const url of urls) {
        const startCol = Math.max(0, Math.min(cols - 1, url.startCol));
        const endCol = Math.max(0, Math.min(cols - 1, url.endCol));
        if (endCol < startCol) continue;
        this.drawOverlayQuad(startCol, row + urlOffset, endCol - startCol + 1, lineThickness, urlColor);
      }
    }
  }

  private drawStoredCursor(): void {
    const c = this.cursorState;
    if (!c) return;
    if (c.row < 0 || c.row >= this.config.rows || c.col < 0 || c.col >= this.config.cols) return;
    const [r, g, b, a] = this.colorToRgba(c.color);
    const ch = Math.max(1, this.charHeight);
    const cw = Math.max(1, this.charWidth);

    switch (c.shape) {
      case "block":
        this.drawOverlayQuad(c.col, c.row, 1, 1, [r, g, b, a * 0.5]);
        break;
      case "underline": {
        const height = Math.max(3 / ch, 1 / ch);
        this.drawOverlayQuad(c.col, c.row + 1 - height, 1, height, [r, g, b, a]);
        break;
      }
      case "bar": {
        const width = Math.max(2 / cw, 1 / cw);
        this.drawOverlayQuad(c.col, c.row, width, 1, [r, g, b, a]);
        break;
      }
    }
  }

  private drawStoredSelection(): void {
    const s = this.selectionState;
    if (!s) return;
    if (this.config.rows <= 0 || this.config.cols <= 0) return;

    let sRow = s.startRow;
    let sCol = s.startCol;
    let eRow = s.endRow;
    let eCol = s.endCol;

    if (sRow > eRow || (sRow === eRow && sCol > eCol)) {
      sRow = s.endRow;
      sCol = s.endCol;
      eRow = s.startRow;
      eCol = s.startCol;
    }

    if (eRow < 0 || sRow >= this.config.rows) return;
    sRow = Math.max(0, Math.min(this.config.rows - 1, sRow));
    eRow = Math.max(0, Math.min(this.config.rows - 1, eRow));
    sCol = Math.max(0, Math.min(this.config.cols - 1, sCol));
    eCol = Math.max(0, Math.min(this.config.cols - 1, eCol));

    const [r, g, b, a] = this.colorToRgba(s.color);
    const overlayColor: Rgba = [r, g, b, a * 0.3];

    if (sRow === eRow) {
      const width = eCol - sCol + 1;
      if (width > 0) this.drawOverlayQuad(sCol, sRow, width, 1, overlayColor);
      return;
    }

    const firstWidth = this.config.cols - sCol;
    if (firstWidth > 0) this.drawOverlayQuad(sCol, sRow, firstWidth, 1, overlayColor);
    for (let row = sRow + 1; row < eRow; row++) {
      this.drawOverlayQuad(0, row, this.config.cols, 1, overlayColor);
    }
    const lastWidth = eCol + 1;
    if (lastWidth > 0) this.drawOverlayQuad(0, eRow, lastWidth, 1, overlayColor);
  }

  private drawStoredSearchMatches(): void {
    const s = this.searchState;
    if (!s || s.matches.length === 0) return;
    const matchRgba = this.colorToRgba(s.matchColor);
    const currentRgba = this.colorToRgba(s.currentColor);

    for (const match of s.matches) {
      if (match.row < 0 || match.row >= this.config.rows) continue;
      const startCol = Math.max(0, Math.min(this.config.cols - 1, match.startCol));
      const endCol = Math.max(0, Math.min(this.config.cols - 1, match.endCol));
      if (endCol < startCol) continue;

      const width = endCol - startCol + 1;
      const color = match.isCurrent ? currentRgba : matchRgba;
      const alphaScale = match.isCurrent ? 0.5 : 0.25;
      this.drawOverlayQuad(startCol, match.row, width, 1, [
        color[0], color[1], color[2], color[3] * alphaScale,
      ]);
    }
  }

  renderCursor(
    row: number,
    col: number,
    shape: "block" | "underline" | "bar",
    color: string,
  ): void {
    this.cursorState = { row, col, shape, color };
    this.overlayDirty = true;
    this.scheduleRender();
  }

  renderSelection(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    color: string,
  ): void {
    this.selectionState = { startRow, startCol, endRow, endCol, color };
    this.overlayDirty = true;
    this.scheduleRender();
  }

  renderSearchMatches(
    matches: Array<{ row: number; startCol: number; endCol: number; isCurrent: boolean }>,
    matchColor: string,
    currentColor: string,
  ): void {
    this.searchState = matches.length > 0 ? { matches, matchColor, currentColor } : null;
    this.overlayDirty = true;
    this.scheduleRender();
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

    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.handleContextRestored);

    if (!this.contextLost) {
      this.glyphAtlas?.destroy();
    }
    this.glyphAtlas = null;

    if (!this.contextLost) {
      const gl = this.gl;
      gl.deleteVertexArray(this.bgVAO);
      gl.deleteVertexArray(this.glyphVAO);
      gl.deleteBuffer(this.unitQuadVBO);
      gl.deleteBuffer(this.unitQuadEBO);
      gl.deleteBuffer(this.bgInstanceVBO);
      gl.deleteBuffer(this.glyphInstanceVBO);
      gl.deleteProgram(this.bgProgram);
      gl.deleteProgram(this.glyphProgram);
    }

    this.urlRanges.clear();
    this.grid = [];
    this.colorCache.clear();
  }

  getCharWidth(): number {
    return this.charWidth;
  }

  getCharHeight(): number {
    return this.charHeight;
  }

  clearGlyphCache(): void {
    this.glyphAtlas?.clear();
    this.colorCache.clear();
    this.fullDirty = true;
    this.scheduleRender();
  }
}

export const _testHelpers = { parseHexColor, parseCssColor, clamp01, buildOrthoProjection, makeGlyphKey };
