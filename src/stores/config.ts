import { createSignal } from "solid-js";

export interface RainConfig {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  windowOpacity: number;
  backgroundBlurStrength: number;
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
  showStatusBar: boolean;
  statusBarShowPath: boolean;
  statusBarShowDimensions: boolean;
  statusBarShowActiveProcess: boolean;
  statusBarShowConnection: boolean;
  clearHistoryForTuis: boolean;
  appIcon: "default" | "simple";
}

const STORAGE_KEY = "rain-config";
const LEGACY_MAX_BLUR_PX = 40;

const defaultConfig: RainConfig = {
  fontFamily: "JetBrains Mono",
  fontSize: 14,
  lineHeight: 1.2,
  windowOpacity: 0.68,
  backgroundBlurStrength: 40,
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
  showStatusBar: true,
  statusBarShowPath: true,
  statusBarShowDimensions: true,
  statusBarShowActiveProcess: true,
  statusBarShowConnection: true,
  clearHistoryForTuis: false,
  appIcon: "default",
};

function clampOpacity(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampBlurStrength(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
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

  return {
    ...defaultConfig,
    ...rest,
    backgroundBlurStrength: blurStrength,
    windowOpacity: opacity,
  };
}

function sanitizeConfig(cfg: RainConfig): RainConfig {
  return {
    ...cfg,
    windowOpacity: clampOpacity(cfg.windowOpacity),
    backgroundBlurStrength: clampBlurStrength(cfg.backgroundBlurStrength),
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

export function useConfig() {
  return {
    config,
    isDirty,
    updateConfig: (partial: Partial<RainConfig>) => {
      setConfig((prev) => {
        const next = sanitizeConfig({ ...prev, ...partial });
        setIsDirty(true);
        return next;
      });
    },
    saveConfig: () => {
      persistConfigNow();
    },
  };
}
