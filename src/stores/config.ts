import { createSignal } from "solid-js";

export interface RainConfig {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  windowOpacity: number;
  backgroundBlur: number;
  cursorBlink: boolean;
  cursorShape: "block" | "underline" | "bar";
  optionAsMeta: boolean;
  scrollbackLines: number;
  customBgColor: string | null;
  customFgColor: string | null;
  customAccentColor: string | null;
  customCursorColor: string | null;
}

const STORAGE_KEY = "rain-config";

const defaultConfig: RainConfig = {
  fontFamily: "JetBrains Mono, Menlo, Monaco, Courier New, monospace",
  fontSize: 14,
  lineHeight: 1.4,
  windowOpacity: 0.65,
  backgroundBlur: 0,
  cursorBlink: true,
  cursorShape: "block",
  optionAsMeta: true,
  scrollbackLines: 10_000,
  customBgColor: null,
  customFgColor: null,
  customAccentColor: null,
  customCursorColor: null,
};

function loadConfig(): RainConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultConfig;
    const saved = JSON.parse(raw) as Partial<RainConfig>;
    // merge saved values over defaults so new keys always have a fallback
    return { ...defaultConfig, ...saved };
  } catch {
    return defaultConfig;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persistConfig(cfg: RainConfig) {
  // debounce writes so slider drags don't hammer localStorage
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    } catch (e) {
      console.warn("[Rain] Failed to persist config:", e);
    }
  }, 300);
}

const [config, setConfig] = createSignal<RainConfig>(loadConfig());

export function useConfig() {
  return {
    config,
    updateConfig: (partial: Partial<RainConfig>) => {
      setConfig((prev) => {
        const next = { ...prev, ...partial };
        persistConfig(next);
        return next;
      });
    },
  };
}
