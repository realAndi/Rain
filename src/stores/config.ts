import { createSignal } from "solid-js";
import { readConfigFile, writeConfigFile } from "../lib/ipc";

export type MacosGlassEngine = "liquid" | "cgs" | "cssSafe";

export interface RainConfig {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  windowOpacity: number;
  backgroundBlurStrength: number;
  macosGlassEngine: MacosGlassEngine;
  liquidVariant: number;
  liquidCornerRadius: number;
  liquidTintColor: string | null;
  cursorBlink: boolean;
  cursorShape: "block" | "underline" | "bar";
  optionAsMeta: boolean;
  scrollbackLines: number;
  customBgColor: string | null;
  customFgColor: string | null;
  customAccentColor: string | null;
  customCursorColor: string | null;
  customTabBarColor: string | null;
  customInputBarColor: string | null;
  customShellBgColor: string | null;
  customErrorColor: string | null;
  customSuccessColor: string | null;
  customBorderColor: string | null;
  customSelectionColor: string | null;
  letterSpacing: number;
  promptStyle: "default" | "simplified" | "blank";
  terminalStyle: "chat" | "traditional";
  tmuxMode: "integrated" | "native";
  showStatusBar: boolean;
  statusBarShowPath: boolean;
  statusBarShowDimensions: boolean;
  statusBarShowActiveProcess: boolean;
  statusBarShowConnection: boolean;
  clearHistoryForTuis: boolean;
  enableLigatures: boolean;
  appIcon: "default" | "simple";
  globalHotkey: string | null;
  renderer: "dom" | "canvas";
}

const STORAGE_KEY = "rain-config";
const LEGACY_MAX_BLUR_PX = 40;
const LIQUID_VARIANT_MIN = 0;
const LIQUID_VARIANT_MAX = 23;
const LIQUID_CORNER_RADIUS_MIN = 0;
const LIQUID_CORNER_RADIUS_MAX = 64;
const LIQUID_TINT_REGEX = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const defaultConfig: RainConfig = {
  fontFamily: "JetBrains Mono",
  fontSize: 14,
  lineHeight: 1.2,
  windowOpacity: 0.68,
  backgroundBlurStrength: 40,
  macosGlassEngine: "cgs",
  liquidVariant: 0,
  liquidCornerRadius: 16,
  liquidTintColor: null,
  cursorBlink: true,
  cursorShape: "block",
  optionAsMeta: true,
  scrollbackLines: 10_000,
  customBgColor: null,
  customFgColor: null,
  customAccentColor: null,
  customCursorColor: null,
  customTabBarColor: null,
  customInputBarColor: null,
  customShellBgColor: null,
  customErrorColor: null,
  customSuccessColor: null,
  customBorderColor: null,
  customSelectionColor: null,
  letterSpacing: 0,
  promptStyle: "simplified",
  terminalStyle: "chat",
  tmuxMode: "integrated",
  showStatusBar: true,
  statusBarShowPath: true,
  statusBarShowDimensions: true,
  statusBarShowActiveProcess: true,
  statusBarShowConnection: true,
  clearHistoryForTuis: false,
  enableLigatures: true,
  appIcon: "default",
  globalHotkey: null,
  renderer: "dom",
};

function clampOpacity(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampBlurStrength(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function clampLiquidVariant(value: number): number {
  return Math.min(
    LIQUID_VARIANT_MAX,
    Math.max(LIQUID_VARIANT_MIN, Math.round(value)),
  );
}

function clampLiquidCornerRadius(value: number): number {
  return Math.min(
    LIQUID_CORNER_RADIUS_MAX,
    Math.max(LIQUID_CORNER_RADIUS_MIN, Math.round(value)),
  );
}

function normalizeMacosGlassEngine(value: unknown): MacosGlassEngine {
  if (value === "liquid" || value === "cgs" || value === "cssSafe") {
    return value;
  }
  return defaultConfig.macosGlassEngine;
}

function normalizeLiquidTintColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!LIQUID_TINT_REGEX.test(trimmed)) return null;
  return trimmed;
}

function toBlurStrengthPercent(legacyBlurPx: number): number {
  return (legacyBlurPx / LEGACY_MAX_BLUR_PX) * 100;
}

type SavedConfig = Partial<RainConfig> & {
  backgroundBlur?: number;
  useNativeVibrancy?: boolean;
};

function normalizeConfig(saved: SavedConfig): RainConfig {
  const {
    backgroundBlur,
    useNativeVibrancy: _legacyVibrancy,
    ...rest
  } = saved;
  void _legacyVibrancy;
  const blurStrength = typeof saved.backgroundBlurStrength === "number"
    ? clampBlurStrength(saved.backgroundBlurStrength)
    : typeof backgroundBlur === "number"
      ? clampBlurStrength(toBlurStrengthPercent(backgroundBlur))
      : defaultConfig.backgroundBlurStrength;

  const opacity = typeof saved.windowOpacity === "number"
    ? clampOpacity(saved.windowOpacity)
    : defaultConfig.windowOpacity;
  const macosGlassEngine = normalizeMacosGlassEngine(saved.macosGlassEngine);
  const liquidVariant = typeof saved.liquidVariant === "number"
    ? clampLiquidVariant(saved.liquidVariant)
    : defaultConfig.liquidVariant;
  const liquidCornerRadius = typeof saved.liquidCornerRadius === "number"
    ? clampLiquidCornerRadius(saved.liquidCornerRadius)
    : defaultConfig.liquidCornerRadius;
  const liquidTintColor = normalizeLiquidTintColor(saved.liquidTintColor);

  return {
    ...defaultConfig,
    ...rest,
    backgroundBlurStrength: blurStrength,
    windowOpacity: opacity,
    macosGlassEngine,
    liquidVariant,
    liquidCornerRadius,
    liquidTintColor,
  };
}

function sanitizeConfig(cfg: RainConfig): RainConfig {
  return {
    ...cfg,
    windowOpacity: clampOpacity(cfg.windowOpacity),
    backgroundBlurStrength: clampBlurStrength(cfg.backgroundBlurStrength),
    macosGlassEngine: normalizeMacosGlassEngine(cfg.macosGlassEngine),
    liquidVariant: clampLiquidVariant(cfg.liquidVariant),
    liquidCornerRadius: clampLiquidCornerRadius(cfg.liquidCornerRadius),
    liquidTintColor: normalizeLiquidTintColor(cfg.liquidTintColor),
  };
}

function loadConfig(): RainConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultConfig;
    const saved = JSON.parse(raw) as SavedConfig;
    return normalizeConfig(saved);
  } catch {
    return defaultConfig;
  }
}

const [config, setConfig] = createSignal<RainConfig>(loadConfig());
const [isDirty, setIsDirty] = createSignal(false);

function persistConfigNow() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config()));
    setIsDirty(false);
  } catch (e) {
    console.warn("[Rain] Failed to persist config:", e);
  }
}

async function syncConfigToDisk() {
  try {
    await writeConfigFile(JSON.stringify(config(), null, 2));
  } catch (e) {
    console.warn("[Rain] Failed to sync config to disk:", e);
  }
}

// Load config from disk on startup (async, overrides localStorage if present)
export async function loadConfigFromDisk(): Promise<void> {
  try {
    const raw = await readConfigFile();
    if (raw) {
      const saved = JSON.parse(raw) as SavedConfig;
      const normalized = normalizeConfig(saved);
      setConfig(normalized);
      // Also persist to localStorage for fast startup next time
      persistConfigNow();
    }
  } catch (e) {
    console.warn("[Rain] Failed to load config from disk:", e);
  }
}

export { defaultConfig };

let _debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function useConfig() {
  return {
    config,
    isDirty,
    updateConfig: (partial: Partial<RainConfig>) => {
      setConfig((prev) => sanitizeConfig({ ...prev, ...partial }));
      setIsDirty(true);
      // Auto-persist with debounce
      if (_debounceTimer) clearTimeout(_debounceTimer);
      _debounceTimer = setTimeout(() => {
        persistConfigNow();
        syncConfigToDisk();
      }, 500);
    },
    saveConfig: () => {
      // Immediate save (clears any pending debounce)
      if (_debounceTimer) clearTimeout(_debounceTimer);
      persistConfigNow();
      syncConfigToDisk();
    },
    // resetConfig kept as internal utility, not exposed to UI
    resetSection: (section: "appearance" | "terminal") => {
      if (_debounceTimer) clearTimeout(_debounceTimer);
      if (section === "appearance") {
        setConfig((prev) => ({
          ...prev,
          fontFamily: defaultConfig.fontFamily,
          fontSize: defaultConfig.fontSize,
          lineHeight: defaultConfig.lineHeight,
          letterSpacing: defaultConfig.letterSpacing,
          windowOpacity: defaultConfig.windowOpacity,
          backgroundBlurStrength: defaultConfig.backgroundBlurStrength,
          macosGlassEngine: defaultConfig.macosGlassEngine,
          liquidVariant: defaultConfig.liquidVariant,
          liquidCornerRadius: defaultConfig.liquidCornerRadius,
          liquidTintColor: defaultConfig.liquidTintColor,
          appIcon: defaultConfig.appIcon,
          customBgColor: null,
          customFgColor: null,
          customAccentColor: null,
          customCursorColor: null,
          customTabBarColor: null,
          customInputBarColor: null,
          customShellBgColor: null,
          customErrorColor: null,
          customSuccessColor: null,
          customBorderColor: null,
          customSelectionColor: null,
        }));
      } else {
        setConfig((prev) => ({
          ...prev,
          cursorBlink: defaultConfig.cursorBlink,
          cursorShape: defaultConfig.cursorShape,
          optionAsMeta: defaultConfig.optionAsMeta,
          scrollbackLines: defaultConfig.scrollbackLines,
          promptStyle: defaultConfig.promptStyle,
          terminalStyle: defaultConfig.terminalStyle,
          tmuxMode: defaultConfig.tmuxMode,
          clearHistoryForTuis: defaultConfig.clearHistoryForTuis,
          enableLigatures: defaultConfig.enableLigatures,
          renderer: defaultConfig.renderer,
          showStatusBar: defaultConfig.showStatusBar,
          statusBarShowPath: defaultConfig.statusBarShowPath,
          statusBarShowDimensions: defaultConfig.statusBarShowDimensions,
          statusBarShowActiveProcess: defaultConfig.statusBarShowActiveProcess,
          statusBarShowConnection: defaultConfig.statusBarShowConnection,
        }));
      }
      persistConfigNow();
      syncConfigToDisk();
    },
  };
}
