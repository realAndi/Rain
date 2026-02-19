import { describe, it, expect } from "vitest";
import {
  blurStrengthPercentToPixels,
  computeBlurProfile,
  computeGlassSurfaceOpacities,
  deriveBackgroundPalette,
  opacityUnitToPercent,
  GLASS_MAX_BLUR_PX,
} from "../glass";

describe("blurStrengthPercentToPixels", () => {
  it("returns 0 for 0% strength", () => {
    expect(blurStrengthPercentToPixels(0)).toBe(0);
  });

  it("returns GLASS_MAX_BLUR_PX for 100% strength", () => {
    expect(blurStrengthPercentToPixels(100)).toBe(GLASS_MAX_BLUR_PX);
  });

  it("clamps negative values to 0", () => {
    expect(blurStrengthPercentToPixels(-10)).toBe(0);
  });

  it("clamps values above 100 to max", () => {
    expect(blurStrengthPercentToPixels(200)).toBe(GLASS_MAX_BLUR_PX);
  });

  it("returns intermediate value for 50%", () => {
    const result = blurStrengthPercentToPixels(50);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(GLASS_MAX_BLUR_PX);
  });

  it("easing curve makes 50% more than half of max", () => {
    const result = blurStrengthPercentToPixels(50);
    expect(result).toBeGreaterThan(GLASS_MAX_BLUR_PX / 2);
  });
});

describe("computeBlurProfile", () => {
  it("returns disabled profile when blur strength is 0", () => {
    const profile = computeBlurProfile(0.8, 0);
    expect(profile.enabled).toBe(false);
    expect(profile.blurPx).toBe(0);
    expect(profile.overlayPercent).toBe(0);
  });

  it("returns enabled profile for positive blur", () => {
    const profile = computeBlurProfile(0.8, 50);
    expect(profile.enabled).toBe(true);
    expect(profile.blurPx).toBeGreaterThan(0);
    expect(profile.overlayPercent).toBeGreaterThan(0);
  });

  it("includes saturation and contrast regardless of blur", () => {
    const disabled = computeBlurProfile(0.5, 0);
    expect(disabled.saturationPercent).toBeGreaterThanOrEqual(104);
    expect(disabled.contrastPercent).toBeGreaterThanOrEqual(100);

    const enabled = computeBlurProfile(0.5, 50);
    expect(enabled.saturationPercent).toBeGreaterThanOrEqual(104);
    expect(enabled.contrastPercent).toBeGreaterThanOrEqual(100);
  });

  it("clamps overlay within expected bounds", () => {
    const profile = computeBlurProfile(1, 100);
    expect(profile.overlayPercent).toBeGreaterThanOrEqual(0.1);
    expect(profile.overlayPercent).toBeLessThanOrEqual(1.75);
  });
});

describe("computeGlassSurfaceOpacities", () => {
  it("returns unified opacity for all surfaces", () => {
    const result = computeGlassSurfaceOpacities(0.7);
    expect(result.body).toBe(0.7);
    expect(result.chrome).toBe(0.7);
    expect(result.input).toBe(0.7);
  });

  it("clamps opacity to [0, 1]", () => {
    const low = computeGlassSurfaceOpacities(-0.5);
    expect(low.body).toBe(0);

    const high = computeGlassSurfaceOpacities(1.5);
    expect(high.body).toBe(1);
  });
});

describe("deriveBackgroundPalette", () => {
  it("returns null for invalid hex color", () => {
    expect(deriveBackgroundPalette("invalid")).toBeNull();
    expect(deriveBackgroundPalette("")).toBeNull();
    expect(deriveBackgroundPalette("#gggggg")).toBeNull();
  });

  it("returns palette for valid 6-digit hex", () => {
    const palette = deriveBackgroundPalette("#1e1e2e");
    expect(palette).not.toBeNull();
    expect(palette!.bgRaised).toMatch(/^rgb\(/);
    expect(palette!.bgHover).toMatch(/^rgb\(/);
    expect(palette!.border).toMatch(/^rgb\(/);
  });

  it("returns palette for valid 3-digit hex", () => {
    const palette = deriveBackgroundPalette("#fff");
    expect(palette).not.toBeNull();
  });

  it("produces dark-theme palette for dark base color", () => {
    const palette = deriveBackgroundPalette("#000000");
    expect(palette).not.toBeNull();
    expect(palette!.scrollbarThumb).toContain("255, 255, 255");
  });

  it("produces light-theme palette for light base color", () => {
    const palette = deriveBackgroundPalette("#ffffff");
    expect(palette).not.toBeNull();
    expect(palette!.scrollbarThumb).toContain("0, 0, 0");
  });

  it("uses custom accent color when provided", () => {
    const withAccent = deriveBackgroundPalette("#1e1e2e", "#ff0000");
    const withDefault = deriveBackgroundPalette("#1e1e2e");
    expect(withAccent).not.toBeNull();
    expect(withDefault).not.toBeNull();
    expect(withAccent!.selectionBg).not.toBe(withDefault!.selectionBg);
  });

  it("falls back to default accent for invalid accent", () => {
    const palette = deriveBackgroundPalette("#1e1e2e", "not-a-color");
    expect(palette).not.toBeNull();
    expect(palette!.selectionBg).toMatch(/^rgba\(/);
  });
});

describe("opacityUnitToPercent", () => {
  it("converts 0 to 0%", () => {
    expect(opacityUnitToPercent(0)).toBe("0%");
  });

  it("converts 1 to 100%", () => {
    expect(opacityUnitToPercent(1)).toBe("100%");
  });

  it("converts 0.5 to 50%", () => {
    expect(opacityUnitToPercent(0.5)).toBe("50%");
  });

  it("clamps negative to 0%", () => {
    expect(opacityUnitToPercent(-0.5)).toBe("0%");
  });

  it("clamps above 1 to 100%", () => {
    expect(opacityUnitToPercent(1.5)).toBe("100%");
  });

  it("handles fractional percentages", () => {
    expect(opacityUnitToPercent(0.755)).toBe("75.5%");
  });
});
