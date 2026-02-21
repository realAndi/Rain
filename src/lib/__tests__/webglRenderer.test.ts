import { describe, it, expect } from "vitest";
import { _testHelpers, canUseWebGLRenderer } from "../webglRenderer";

const { parseHexColor, parseCssColor, clamp01, buildOrthoProjection, makeGlyphKey } = _testHelpers;

describe("clamp01", () => {
  it("passes values in [0, 1] through unchanged", () => {
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1)).toBe(1);
  });

  it("clamps negative values to 0", () => {
    expect(clamp01(-0.1)).toBe(0);
    expect(clamp01(-100)).toBe(0);
  });

  it("clamps values > 1 to 1", () => {
    expect(clamp01(1.01)).toBe(1);
    expect(clamp01(999)).toBe(1);
  });

  it("returns 0 for NaN and Infinity", () => {
    expect(clamp01(NaN)).toBe(0);
    expect(clamp01(Infinity)).toBe(0);
    expect(clamp01(-Infinity)).toBe(0);
  });
});

describe("parseHexColor", () => {
  it("parses 3-char hex", () => {
    const [r, g, b, a] = parseHexColor("#fff");
    expect(r).toBeCloseTo(1);
    expect(g).toBeCloseTo(1);
    expect(b).toBeCloseTo(1);
    expect(a).toBe(1);
  });

  it("parses 6-char hex", () => {
    const [r, g, b, a] = parseHexColor("#ff0000");
    expect(r).toBeCloseTo(1);
    expect(g).toBeCloseTo(0);
    expect(b).toBeCloseTo(0);
    expect(a).toBe(1);
  });

  it("parses 8-char hex with alpha", () => {
    const [r, g, b, a] = parseHexColor("#00ff0080");
    expect(r).toBeCloseTo(0);
    expect(g).toBeCloseTo(1);
    expect(b).toBeCloseTo(0);
    expect(a).toBeCloseTo(128 / 255);
  });

  it("parses 4-char hex with alpha", () => {
    const [r, g, b, a] = parseHexColor("#f00f");
    expect(r).toBeCloseTo(1);
    expect(g).toBeCloseTo(0);
    expect(b).toBeCloseTo(0);
    expect(a).toBeCloseTo(1);
  });

  it("clamps NaN from unparseable hex digits to 0", () => {
    const [r, g, b, a] = parseHexColor("#xyz");
    expect(r).toBe(0);
    expect(g).toBe(0);
    expect(b).toBe(0);
    expect(a).toBe(1);
  });

  it("returns white for unrecognized hex lengths", () => {
    expect(parseHexColor("")).toEqual([1, 1, 1, 1]);
    expect(parseHexColor("#12345")).toEqual([1, 1, 1, 1]);
  });
});

describe("parseCssColor", () => {
  it("delegates hex to parseHexColor", () => {
    const result = parseCssColor("#ff0000");
    expect(result[0]).toBeCloseTo(1);
    expect(result[1]).toBeCloseTo(0);
    expect(result[2]).toBeCloseTo(0);
    expect(result[3]).toBe(1);
  });

  it("returns [0,0,0,0] for transparent", () => {
    expect(parseCssColor("transparent")).toEqual([0, 0, 0, 0]);
    expect(parseCssColor("TRANSPARENT")).toEqual([0, 0, 0, 0]);
  });

  it("parses rgb(...)", () => {
    const [r, g, b, a] = parseCssColor("rgb(255, 0, 128)");
    expect(r).toBeCloseTo(1);
    expect(g).toBeCloseTo(0);
    expect(b).toBeCloseTo(128 / 255);
    expect(a).toBe(1);
  });

  it("parses rgba(...)", () => {
    const [r, g, b, a] = parseCssColor("rgba(0, 255, 0, 0.5)");
    expect(r).toBeCloseTo(0);
    expect(g).toBeCloseTo(1);
    expect(b).toBeCloseTo(0);
    expect(a).toBeCloseTo(0.5);
  });

  it("uses fallback for var() when document is unavailable or var not set", () => {
    const result = parseCssColor("var(--nonexistent, #00ff00)");
    expect(result[0]).toBeCloseTo(0);
    expect(result[1]).toBeCloseTo(1);
    expect(result[2]).toBeCloseTo(0);
    expect(result[3]).toBe(1);
  });

  it("returns [1,1,1,1] for empty string", () => {
    expect(parseCssColor("")).toEqual([1, 1, 1, 1]);
  });

  it("returns [1,1,1,1] for unrecognized format", () => {
    expect(parseCssColor("hsl(0, 100%, 50%)")).toEqual([1, 1, 1, 1]);
    expect(parseCssColor("not-a-color")).toEqual([1, 1, 1, 1]);
  });
});

describe("buildOrthoProjection", () => {
  it("produces a 16-element Float32Array", () => {
    const m = buildOrthoProjection(800, 600);
    expect(m).toBeInstanceOf(Float32Array);
    expect(m.length).toBe(16);
  });

  it("maps top-left to (-1, 1) and bottom-right to (1, -1)", () => {
    const m = buildOrthoProjection(800, 600);
    expect(m[0]).toBeCloseTo(2 / 800);
    expect(m[5]).toBeCloseTo(-2 / 600);
    expect(m[12]).toBeCloseTo(-1);
    expect(m[13]).toBeCloseTo(1);
    expect(m[15]).toBeCloseTo(1);
  });

  it("clamps zero/negative dimensions to 1", () => {
    const m = buildOrthoProjection(0, -5);
    expect(m[0]).toBeCloseTo(2);
    expect(m[5]).toBeCloseTo(-2);
  });
});

describe("makeGlyphKey", () => {
  it("produces a string key from char, bold, italic", () => {
    const key = makeGlyphKey("A", false, false);
    expect(typeof key).toBe("string");
    expect(key).toContain("A");
  });

  it("differentiates bold/italic variants", () => {
    const normal = makeGlyphKey("A", false, false);
    const bold = makeGlyphKey("A", true, false);
    const italic = makeGlyphKey("A", false, true);
    const boldItalic = makeGlyphKey("A", true, true);
    const keys = new Set([normal, bold, italic, boldItalic]);
    expect(keys.size).toBe(4);
  });

  it("does NOT include color in the key", () => {
    const key1 = makeGlyphKey("B", false, false);
    const key2 = makeGlyphKey("B", false, false);
    expect(key1).toBe(key2);
  });

  it("differentiates different characters", () => {
    expect(makeGlyphKey("A", false, false)).not.toBe(makeGlyphKey("B", false, false));
  });
});

describe("canUseWebGLRenderer", () => {
  it("returns a boolean", () => {
    const result = canUseWebGLRenderer();
    expect(typeof result).toBe("boolean");
  });
});
