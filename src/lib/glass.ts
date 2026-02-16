const MIN_BASE_OPACITY = 0;

const MIN_GLASS_SATURATION_PERCENT = 104;
const MAX_GLASS_SATURATION_PERCENT = 155;
const MIN_GLASS_CONTRAST_PERCENT = 100;
const MAX_GLASS_CONTRAST_PERCENT = 116;

export const GLASS_MAX_BLUR_PX = 64;
export const GLASS_BLUR_EASING_EXPONENT = 1.5;

type RgbColor = {
  r: number;
  g: number;
  b: number;
};

const HEX_COLOR_REGEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseHexColor(value: string): RgbColor | null {
  const normalized = value.trim();
  if (!HEX_COLOR_REGEX.test(normalized)) return null;

  if (normalized.length === 4) {
    return {
      r: parseInt(normalized[1] + normalized[1], 16),
      g: parseInt(normalized[2] + normalized[2], 16),
      b: parseInt(normalized[3] + normalized[3], 16),
    };
  }

  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16),
  };
}

function formatRgb(color: RgbColor): string {
  return `rgb(${color.r} ${color.g} ${color.b})`;
}

function formatRgba(color: RgbColor, alpha: number): string {
  const clampedAlpha = clamp(alpha, 0, 1);
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${clampedAlpha.toFixed(3)})`;
}

function toLinear(channel: number): number {
  const srgb = channel / 255;
  return srgb <= 0.04045
    ? srgb / 12.92
    : Math.pow((srgb + 0.055) / 1.055, 2.4);
}

function relativeLuminance(color: RgbColor): number {
  return (
    0.2126 * toLinear(color.r) +
    0.7152 * toLinear(color.g) +
    0.0722 * toLinear(color.b)
  );
}

function tint(color: RgbColor, amount: number): RgbColor {
  const ratio = clamp(Math.abs(amount), 0, 1);
  const target = amount >= 0 ? 255 : 0;
  return {
    r: Math.round(color.r + (target - color.r) * ratio),
    g: Math.round(color.g + (target - color.g) * ratio),
    b: Math.round(color.b + (target - color.b) * ratio),
  };
}

export function blurStrengthPercentToPixels(strength: number): number {
  const normalized = clamp(strength, 0, 100) / 100;
  const eased = 1 - Math.pow(1 - normalized, GLASS_BLUR_EASING_EXPONENT);
  return eased * GLASS_MAX_BLUR_PX;
}

function computeClarityFactor(windowOpacity: number, blurStrength: number): number {
  const blurNormalized = clamp(blurStrength, 0, 100) / 100;
  const baseOpacity = clamp(windowOpacity, MIN_BASE_OPACITY, 1);
  const transparency = 1 - baseOpacity;
  return clamp(transparency * 0.58 + blurNormalized * 0.42, 0, 1);
}

export interface BlurProfile {
  blurPx: number;
  overlayPercent: number;
  saturationPercent: number;
  contrastPercent: number;
  enabled: boolean;
}

export function computeBlurProfile(
  windowOpacity: number,
  blurStrength: number,
): BlurProfile {
  const blurPx = blurStrengthPercentToPixels(blurStrength);
  const clarityFactor = computeClarityFactor(windowOpacity, blurStrength);
  const saturationPercent = MIN_GLASS_SATURATION_PERCENT +
    (MAX_GLASS_SATURATION_PERCENT - MIN_GLASS_SATURATION_PERCENT) *
      clarityFactor;
  const contrastPercent = MIN_GLASS_CONTRAST_PERCENT +
    (MAX_GLASS_CONTRAST_PERCENT - MIN_GLASS_CONTRAST_PERCENT) *
      clarityFactor;

  if (blurPx <= 0.01) {
    return {
      blurPx: 0,
      overlayPercent: 0,
      saturationPercent,
      contrastPercent,
      enabled: false,
    };
  }

  const blurNormalized = clamp(blurStrength, 0, 100) / 100;
  const baseOpacity = clamp(windowOpacity, MIN_BASE_OPACITY, 1);
  const transparency = 1 - baseOpacity;

  const overlayPercent = clamp(
    0.35 + blurNormalized * 0.85 + baseOpacity * 0.35 - transparency * 0.12,
    0.1,
    1.75,
  );

  return {
    blurPx,
    overlayPercent,
    saturationPercent,
    contrastPercent,
    enabled: true,
  };
}

export function computeGlassSurfaceOpacities(
  windowOpacity: number,
  _blurStrength = 0,
): {
  body: number;
  chrome: number;
  input: number;
} {
  const body = clamp(windowOpacity, MIN_BASE_OPACITY, 1);
  // All surfaces use the same opacity now (unified glass)
  return { body, chrome: body, input: body };
}

export interface GlassBackgroundPalette {
  bgRaised: string;
  bgHover: string;
  bgBlock: string;
  bgInput: string;
  border: string;
  borderBlock: string;
  scrollbarThumb: string;
  scrollbarThumbHover: string;
  selectionBg: string;
  shadowBlock: string;
  shadowInput: string;
}

export function deriveBackgroundPalette(
  baseColor: string,
  accentColor?: string,
): GlassBackgroundPalette | null {
  const base = parseHexColor(baseColor);
  if (!base) return null;

  const accent = parseHexColor(accentColor ?? "") ?? { r: 1, g: 193, b: 162 };
  const isLight = relativeLuminance(base) >= 0.56;

  const bgRaised = tint(base, isLight ? -0.045 : 0.085);
  const bgHover = tint(base, isLight ? -0.09 : 0.145);
  const bgBlock = tint(base, isLight ? -0.065 : 0.055);
  const bgInput = tint(base, isLight ? 0.035 : 0.11);
  const border = tint(base, isLight ? -0.165 : 0.2);
  const borderBlock = tint(base, isLight ? -0.11 : 0.145);

  return {
    bgRaised: formatRgb(bgRaised),
    bgHover: formatRgb(bgHover),
    bgBlock: formatRgb(bgBlock),
    bgInput: formatRgb(bgInput),
    border: formatRgb(border),
    borderBlock: formatRgb(borderBlock),
    scrollbarThumb: isLight
      ? "rgba(0, 0, 0, 0.14)"
      : "rgba(255, 255, 255, 0.14)",
    scrollbarThumbHover: isLight
      ? "rgba(0, 0, 0, 0.24)"
      : "rgba(255, 255, 255, 0.24)",
    selectionBg: formatRgba(accent, isLight ? 0.2 : 0.24),
    shadowBlock: isLight
      ? "0 1px 2px rgba(0, 0, 0, 0.08), 0 1px 4px rgba(0, 0, 0, 0.06)"
      : "0 1px 3px rgba(0, 0, 0, 0.34), 0 1px 6px rgba(0, 0, 0, 0.2)",
    shadowInput: isLight
      ? "0 -1px 6px rgba(0, 0, 0, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.75)"
      : "0 -2px 14px rgba(0, 0, 0, 0.38), inset 0 1px 0 rgba(255, 255, 255, 0.05)",
  };
}

export function opacityUnitToPercent(value: number): string {
  const percent = Math.round(clamp(value, 0, 1) * 1000) / 10;
  return `${percent}%`;
}
