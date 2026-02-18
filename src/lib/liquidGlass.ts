import {
  GlassMaterialVariant,
  isGlassSupported,
  setLiquidGlassEffect,
  type LiquidGlassConfig,
} from "tauri-plugin-liquid-glass-api";

type VariantLabel = {
  value: number;
  label: string;
};

export const LIQUID_GLASS_VARIANTS: readonly VariantLabel[] = [
  { value: GlassMaterialVariant.Regular, label: "Regular" },
  { value: GlassMaterialVariant.Clear, label: "Clear" },
  { value: GlassMaterialVariant.Dock, label: "Dock" },
  { value: GlassMaterialVariant.AppIcons, label: "AppIcons" },
  { value: GlassMaterialVariant.Widgets, label: "Widgets" },
  { value: GlassMaterialVariant.Text, label: "Text" },
  { value: GlassMaterialVariant.Avplayer, label: "Avplayer" },
  { value: GlassMaterialVariant.Facetime, label: "Facetime" },
  { value: GlassMaterialVariant.ControlCenter, label: "ControlCenter" },
  { value: GlassMaterialVariant.NotificationCenter, label: "NotificationCenter" },
  { value: GlassMaterialVariant.Monogram, label: "Monogram" },
  { value: GlassMaterialVariant.Bubbles, label: "Bubbles" },
  { value: GlassMaterialVariant.Identity, label: "Identity" },
  { value: GlassMaterialVariant.FocusBorder, label: "FocusBorder" },
  { value: GlassMaterialVariant.FocusPlatter, label: "FocusPlatter" },
  { value: GlassMaterialVariant.Keyboard, label: "Keyboard" },
  { value: GlassMaterialVariant.Sidebar, label: "Sidebar" },
  { value: GlassMaterialVariant.AbuttedSidebar, label: "AbuttedSidebar" },
  { value: GlassMaterialVariant.Inspector, label: "Inspector" },
  { value: GlassMaterialVariant.Control, label: "Control" },
  { value: GlassMaterialVariant.Loupe, label: "Loupe" },
  { value: GlassMaterialVariant.Slider, label: "Slider" },
  { value: GlassMaterialVariant.Camera, label: "Camera" },
  { value: GlassMaterialVariant.CartouchePopover, label: "CartouchePopover" },
] as const;

export interface LiquidGlassApplyResult {
  ok: boolean;
  noOp: boolean;
  error?: unknown;
}

function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
}

export async function isLiquidGlassSupported(): Promise<boolean> {
  if (!isMacPlatform()) return false;
  try {
    return await isGlassSupported();
  } catch (error) {
    console.warn("[Rain] Failed to check Liquid Glass support:", error);
    return false;
  }
}

export async function setLiquidGlassEffectSafe(
  config: LiquidGlassConfig = {},
): Promise<LiquidGlassApplyResult> {
  if (!isMacPlatform()) {
    return { ok: true, noOp: true };
  }

  try {
    await setLiquidGlassEffect(config);
    return { ok: true, noOp: false };
  } catch (error) {
    console.warn("[Rain] Failed to apply Liquid Glass effect:", error);
    return { ok: false, noOp: false, error };
  }
}

export async function disableLiquidGlassEffect(): Promise<void> {
  if (!isMacPlatform()) return;
  const result = await setLiquidGlassEffectSafe({ enabled: false });
  if (!result.ok) {
    console.warn("[Rain] Failed to disable Liquid Glass effect:", result.error);
  }
}
