import {
  Component,
  createSignal,
  createEffect,
  For,
  Show,
  onMount,
  onCleanup,
} from "solid-js";
import { Portal } from "solid-js/web";
import { useConfig, type MacosGlassEngine } from "../stores/config";
import { useTheme, THEME_LIST } from "../stores/theme";
import {
  computeBlurProfile,
} from "../lib/glass";
import { saveTextToFile } from "../lib/ipc";
import {
  LIQUID_GLASS_VARIANTS,
  isLiquidGlassSupported,
} from "../lib/liquidGlass";
import {
  IconPalette,
  IconTerminal,
  IconKeyboard,
  IconCheck,
  IconUser,
} from "./icons";
import {
  getProfiles,
  addProfile,
  updateProfile,
  deleteProfile,
  getActiveProfileId,
  setActiveProfileId,
  type ShellProfile,
} from "../lib/profiles";
import {
  getTriggers,
  addTrigger,
  updateTrigger,
  deleteTrigger,
  type OutputTrigger,
} from "../lib/triggers";
import { HslColorPicker } from "./HslColorPicker";
import { showToast } from "./Toast";

type Section = "appearance" | "terminal" | "shortcuts" | "profiles";

const MACOS_GLASS_ENGINES: ReadonlyArray<{
  value: MacosGlassEngine;
  label: string;
  hint: string;
}> = [
  {
    value: "liquid",
    label: "Liquid",
    hint: "Uses tauri-plugin-liquid-glass with native Liquid Glass on macOS 26+.",
  },
  {
    value: "cgs",
    label: "CGS",
    hint: "Uses Rain's current private CoreGraphics blur radius path.",
  },
  {
    value: "cssSafe",
    label: "CSS Safe",
    hint: "Uses web CSS backdrop blur only (no native private effect view).",
  },
];

// ---- Font Family Dropdown ----

// Fonts loaded from Google Fonts (always available)
const GOOGLE_FONTS = [
  "JetBrains Mono",
  "Fira Code",
  "Source Code Pro",
  "IBM Plex Mono",
  "Inconsolata",
  "Roboto Mono",
  "Ubuntu Mono",
  "Space Mono",
];

// Platform system fonts - filtered at runtime to only show installed ones
const SYSTEM_FONT_CANDIDATES = [
  "SF Mono",
  "Menlo",
  "Monaco",
  "Consolas",
  "Cascadia Code",
  "Courier New",
];

// Detect whether a font is actually installed by comparing rendered width
// against a baseline monospace fallback. If the widths differ, the font exists.
function isFontAvailable(fontName: string): boolean {
  const probe = document.createElement("span");
  probe.style.cssText = [
    "font-size: 72px",
    "white-space: pre",
    "position: absolute",
    "visibility: hidden",
    "top: -9999px",
    "left: -9999px",
  ].join(";");
  // use a string with varied widths to maximize detection sensitivity
  probe.textContent = "mmmmmmmmmmlli";
  document.body.appendChild(probe);

  probe.style.fontFamily = "monospace";
  const baselineWidth = probe.getBoundingClientRect().width;

  probe.style.fontFamily = `"${fontName}", monospace`;
  const testWidth = probe.getBoundingClientRect().width;

  document.body.removeChild(probe);
  return Math.abs(testWidth - baselineWidth) > 0.5;
}

const SYSTEM_FONTS = SYSTEM_FONT_CANDIDATES.filter(isFontAvailable);

const ALL_FONTS = [...GOOGLE_FONTS, ...SYSTEM_FONTS];

// Inject a single Google Fonts <link> for all web fonts.
// Idempotent, called at module scope so fonts start loading immediately.
let googleFontsLoaded = false;
function loadGoogleFonts() {
  if (googleFontsLoaded) return;
  googleFontsLoaded = true;
  const families = GOOGLE_FONTS.map(
    (f) => `family=${f.replace(/ /g, "+")}`,
  ).join("&");
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?${families}&display=swap`;
  document.head.appendChild(link);
}
loadGoogleFonts();

const FontFamilyDropdown: Component<{
  value: string;
  onChange: (font: string) => void;
}> = (props) => {
  let wrapRef: HTMLDivElement | undefined;
  let triggerRef: HTMLButtonElement | undefined;
  let panelRef: HTMLDivElement | undefined;
  const [open, setOpen] = createSignal(false);
  const [customMode, setCustomMode] = createSignal(false);
  const [customValue, setCustomValue] = createSignal("");
  const [panelPos, setPanelPos] = createSignal({ top: 0, left: 0, width: 0, maxHeight: 300 });

  const isCustomFont = () => !ALL_FONTS.includes(props.value);

  function handleClickOutside(e: MouseEvent) {
    const target = e.target as Node;
    if (
      open() &&
      wrapRef && !wrapRef.contains(target) &&
      (!panelRef || !panelRef.contains(target))
    ) {
      setOpen(false);
      setCustomMode(false);
    }
  }

  createEffect(() => {
    if (open()) {
      document.addEventListener("pointerdown", handleClickOutside);
    } else {
      document.removeEventListener("pointerdown", handleClickOutside);
    }
  });

  onCleanup(() => {
    document.removeEventListener("pointerdown", handleClickOutside);
  });

  function selectFont(font: string) {
    props.onChange(font);
    setOpen(false);
    setCustomMode(false);
  }

  function enterCustomMode() {
    setCustomMode(true);
    setCustomValue(isCustomFont() ? props.value : "");
  }

  function handleCustomSubmit() {
    const val = customValue().trim();
    if (val) {
      props.onChange(val);
      setOpen(false);
      setCustomMode(false);
    }
  }

  function renderFontOption(font: string) {
    return (
      <button
        class={`font-dropdown-option ${props.value === font ? "font-dropdown-option-active" : ""}`}
        style={{ "font-family": `"${font}", monospace` }}
        onClick={() => selectFont(font)}
      >
        <span class="font-dropdown-option-label">{font}</span>
        <Show when={props.value === font}>
          <span class="font-dropdown-option-check">
            <IconCheck size={10} />
          </span>
        </Show>
      </button>
    );
  }

  return (
    <div class="font-dropdown-wrap" ref={wrapRef}>
      <button
        class="font-dropdown-trigger"
        ref={triggerRef}
        style={{ "font-family": `"${props.value}", monospace` }}
        onClick={() => {
          const wasOpen = open();
          setOpen(!wasOpen);
          if (wasOpen) {
            setCustomMode(false);
          } else if (triggerRef) {
            const rect = triggerRef.getBoundingClientRect();
            const gap = 4;
            const padding = 8;
            const maxH = Math.min(300, rect.top - gap - padding);
            setPanelPos({ top: rect.top - gap - maxH, left: rect.left, width: rect.width, maxHeight: maxH });
          }
        }}
      >
        <span class="font-dropdown-trigger-label">{props.value}</span>
        <svg class="font-dropdown-trigger-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2.5 3.75L5 6.25L7.5 3.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>

      <Show when={open()}>
        <Portal>
          <div
            class="font-dropdown-panel"
            ref={panelRef}
            style={{
              position: "fixed",
              top: `${panelPos().top}px`,
              left: `${panelPos().left}px`,
              width: `${panelPos().width}px`,
              "max-height": `${panelPos().maxHeight}px`,
            }}
          >
            <div class="font-dropdown-list">
              <div class="font-dropdown-group-label">Web Fonts</div>
              <For each={GOOGLE_FONTS}>
                {(font) => renderFontOption(font)}
              </For>
              <Show when={SYSTEM_FONTS.length > 0}>
                <div class="font-dropdown-group-label">System Fonts</div>
                <For each={SYSTEM_FONTS}>
                  {(font) => renderFontOption(font)}
                </For>
              </Show>
            </div>
            <div class="font-dropdown-divider" />
            <Show
              when={!customMode()}
              fallback={
                <div class="font-dropdown-custom-row">
                  <input
                    class="font-dropdown-custom-input"
                    type="text"
                    placeholder="Enter font name..."
                    value={customValue()}
                    onInput={(e) => setCustomValue(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCustomSubmit();
                      if (e.key === "Escape") setCustomMode(false);
                    }}
                    spellcheck={false}
                    ref={(el) => setTimeout(() => el.focus(), 0)}
                  />
                  <button
                    class="font-dropdown-custom-apply"
                    onClick={handleCustomSubmit}
                    disabled={!customValue().trim()}
                  >
                    Apply
                  </button>
                </div>
              }
            >
              <button
                class={`font-dropdown-option font-dropdown-option-custom ${isCustomFont() ? "font-dropdown-option-active" : ""}`}
                onClick={enterCustomMode}
              >
                <span class="font-dropdown-option-label">
                  {isCustomFont() ? props.value : "Custom..."}
                </span>
                <Show when={isCustomFont()}>
                  <span class="font-dropdown-option-check">
                    <IconCheck size={10} />
                  </span>
                </Show>
              </button>
            </Show>
          </div>
        </Portal>
      </Show>
    </div>
  );
};

// ---- Data ----

const shortcuts = [
  { keys: "\u2318 T", description: "New tab" },
  { keys: "\u2318 W", description: "Close tab" },
  { keys: "\u2318 K", description: "Clear terminal" },
  { keys: "\u2318 ,", description: "Settings" },
  { keys: "\u2318 1\u20139", description: "Switch to tab" },
  { keys: "\u2318 \u21e7 [", description: "Previous tab" },
  { keys: "\u2318 \u21e7 ]", description: "Next tab" },
];

const NAV_SECTIONS: { id: Section; label: string; icon: () => any }[] = [
  { id: "appearance", label: "Appearance", icon: () => <IconPalette size={14} /> },
  { id: "terminal", label: "Terminal", icon: () => <IconTerminal size={14} /> },
  { id: "shortcuts", label: "Shortcuts", icon: () => <IconKeyboard size={14} /> },
  { id: "profiles", label: "Profiles", icon: () => <IconUser size={14} /> },
];

// ---- Settings Component ----

export const Settings: Component = () => {
  const { config, updateConfig, saveConfig, isDirty, resetSection } = useConfig();
  const { theme, setTheme } = useTheme();
  const [activeSection, setActiveSection] = createSignal<Section>("appearance");
  const [openPickerId, setOpenPickerId] = createSignal<string | null>(null);
  const [saved, setSaved] = createSignal(false);
  const [profileList, setProfileList] = createSignal<ShellProfile[]>(getProfiles());
  const [selectedProfileId, setSelectedProfileId] = createSignal(getActiveProfileId());
  const [profileEnvDraft, setProfileEnvDraft] = createSignal("");
  const [triggerList, setTriggerList] = createSignal<OutputTrigger[]>(getTriggers());
  const [nativeLiquidSupported, setNativeLiquidSupported] = createSignal<boolean | null>(null);
  const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

  function formatEnvMap(env?: Record<string, string>): string {
    if (!env || Object.keys(env).length === 0) return "";
    return Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
  }

  function parseEnvDraft(text: string): Record<string, string> | undefined {
    const map: Record<string, string> = {};
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const sep = line.indexOf("=");
      if (sep <= 0) continue;
      const key = line.slice(0, sep).trim();
      const value = line.slice(sep + 1).trim();
      if (!key) continue;
      map[key] = value;
    }
    return Object.keys(map).length > 0 ? map : undefined;
  }

  function refreshProfiles(preferredProfileId?: string) {
    const nextProfiles = getProfiles();
    setProfileList(nextProfiles);
    const fallbackId = nextProfiles.find((profile) => profile.id === preferredProfileId)
      ? preferredProfileId!
      : nextProfiles.find((profile) => profile.id === selectedProfileId())?.id ??
        nextProfiles[0]?.id ??
        "default";
    setSelectedProfileId(fallbackId);
    setActiveProfileId(fallbackId);
  }

  const selectedProfile = () =>
    profileList().find((profile) => profile.id === selectedProfileId()) ?? profileList()[0];

  createEffect(() => {
    const current = selectedProfile();
    if (!current) return;
    if (current.id !== selectedProfileId()) {
      setSelectedProfileId(current.id);
    }
    setActiveProfileId(current.id);
    setProfileEnvDraft(formatEnvMap(current.env));
  });

  let fileInputRef: HTMLInputElement | undefined;

  function handleSave() {
    saveConfig();
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  async function handleExportConfig() {
    try {
      const json = JSON.stringify(config(), null, 2);
      const saved = await saveTextToFile(json, "rain-config.json");
      if (saved) showToast("Config exported successfully", "success");
    } catch (e) {
      console.error(e);
      showToast("Failed to export config", "error");
    }
  }

  function handleImportConfig() {
    fileInputRef?.click();
  }

  function handleFileSelected(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string);
        if (typeof parsed !== "object" || parsed === null) {
          showToast("Invalid config file format", "error");
          return;
        }
        updateConfig(parsed);
        saveConfig();
        showToast("Config imported successfully", "success");
      } catch {
        showToast("Failed to parse config file", "error");
      }
      input.value = "";
    };
    reader.onerror = () => {
      showToast("Failed to read config file", "error");
      input.value = "";
    };
    reader.readAsText(file);
  }

  // Cmd+S saves settings
  function handleKeyDown(e: KeyboardEvent) {
    if (e.metaKey && e.key === "s") {
      e.preventDefault();
      handleSave();
    }
  }

  onMount(() => {
    document.addEventListener("keydown", handleKeyDown);
    if (isMac) {
      isLiquidGlassSupported()
        .then((supported) => setNativeLiquidSupported(supported))
        .catch((error) => {
          console.warn("[Rain] Failed to check native Liquid Glass support:", error);
          setNativeLiquidSupported(false);
        });
    }
  });

  onCleanup(() => {
    document.removeEventListener("keydown", handleKeyDown);
  });

  function clampFontSize(val: number): number {
    return Math.min(24, Math.max(10, val));
  }

  function clampLineHeight(val: number): number {
    return Math.min(2.0, Math.max(0.0, Math.round(val * 100) / 100));
  }

  function clampScrollback(val: number): number {
    return Math.min(100_000, Math.max(1_000, val));
  }

  const blurPreview = () =>
    computeBlurProfile(
      config().windowOpacity,
      config().backgroundBlurStrength,
    );

  // When a theme preset is selected, clear all custom colors
  function selectTheme(name: string) {
    setTheme(name as any);
    updateConfig({
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
    });
  }

  function getCssVar(name: string, fallback: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }

  return (
    <div class="settings-page" role="dialog" aria-label="Settings">
      <div class="settings-layout">
        {/* Sidebar */}
        <nav class="settings-sidebar" role="navigation" aria-label="Settings sections">
          <div class="settings-sidebar-heading">Settings</div>
          <For each={NAV_SECTIONS}>
            {(section) => (
              <button
                class={`settings-nav-item ${activeSection() === section.id ? "settings-nav-active" : ""}`}
                onClick={() => setActiveSection(section.id)}
              >
                <span class="settings-nav-icon">{section.icon()}</span>
                {section.label}
              </button>
            )}
          </For>
          <div class="settings-sidebar-spacer" />
          <button
            class={`settings-save-btn ${isDirty() ? "settings-save-dirty" : ""}`}
            onClick={handleSave}
          >
            {saved() ? "Saved" : isDirty() ? "Save" : "Saved"}
          </button>
        </nav>

        {/* Content */}
        <div class="settings-content">
          {/* ---- APPEARANCE ---- */}
          <Show when={activeSection() === "appearance"}>
            {/* Theme */}
            <div class="settings-card">
              <h3 class="settings-card-title">Theme</h3>
              <div class="settings-theme-cards">
                <For each={THEME_LIST}>
                  {(t) => (
                    <button
                      class={`settings-theme-card ${theme() === t.name ? "settings-theme-card-active" : ""}`}
                      onClick={() => selectTheme(t.name)}
                    >
                      <div class="theme-preview">
                        <div class="theme-preview-swatch" style={{ background: t.bg }} />
                        <div class="theme-preview-accent" style={{ background: t.accent }} />
                      </div>
                      <div class="theme-card-label">
                        {t.label}
                        <Show when={theme() === t.name}>
                          <span class="theme-card-check">
                            <IconCheck size={10} />
                          </span>
                        </Show>
                      </div>
                    </button>
                  )}
                </For>
              </div>
            </div>


            {/* Background Effects */}
            <div class="settings-card">
              <h3 class="settings-card-title">Background Effects</h3>

              <div class="settings-field">
                <label class="settings-label">Background Opacity</label>
                <div class="settings-range-row">
                  <input
                    class="settings-range-input"
                    type="range"
                    min="0.01"
                    max="1.0"
                    step="0.01"
                    value={config().windowOpacity}
                    onInput={(e) => {
                      const v = parseFloat(e.currentTarget.value);
                      if (!isNaN(v)) updateConfig({ windowOpacity: Math.max(0.01, v) });
                    }}
                  />
                  <span class="settings-range-value">
                    {Math.round(config().windowOpacity * 100)}%
                  </span>
                </div>
              </div>

              <div class="settings-field">
                <label class="settings-label">Blur Strength</label>
                <div class="settings-range-row">
                  <input
                    class="settings-range-input"
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={config().backgroundBlurStrength}
                    onInput={(e) => {
                      const v = parseInt(e.currentTarget.value);
                      if (!isNaN(v))
                        updateConfig({ backgroundBlurStrength: v });
                    }}
                  />
                  <span class="settings-range-value">
                    {config().backgroundBlurStrength}% /{" "}
                    {Math.round(blurPreview().blurPx)}px
                  </span>
                </div>
              </div>

              <Show when={isMac}>
                <div class="settings-field">
                  <label class="settings-label">macOS Glass Engine</label>
                  <select
                    class="settings-input"
                    value={config().macosGlassEngine}
                    onChange={(e) => {
                      updateConfig({
                        macosGlassEngine: e.currentTarget.value as MacosGlassEngine,
                      });
                    }}
                  >
                    <For each={MACOS_GLASS_ENGINES}>
                      {(option) => (
                        <option value={option.value}>
                          {option.label}
                        </option>
                      )}
                    </For>
                  </select>
                  <Show when={MACOS_GLASS_ENGINES.find((option) => option.value === config().macosGlassEngine)}>
                    {(entry) => (
                      <p class="settings-hint">{entry().hint}</p>
                    )}
                  </Show>
                  <Show when={config().macosGlassEngine === "liquid" && nativeLiquidSupported() === false}>
                    <p class="settings-hint">
                      Native Liquid Glass is unavailable on this macOS version. The plugin
                      will use vibrancy fallback, and Rain automatically falls back to CGS if
                      plugin calls fail.
                    </p>
                  </Show>
                  <Show when={config().macosGlassEngine === "cssSafe"}>
                    <p class="settings-hint">
                      CSS Safe mode avoids native private effect views and relies on web blur.
                    </p>
                  </Show>
                </div>

                <Show when={config().macosGlassEngine === "liquid"}>
                  <div class="settings-field">
                    <label class="settings-label">Liquid Variant</label>
                    <select
                      class="settings-input"
                      value={String(config().liquidVariant)}
                      onChange={(e) => {
                        const next = Number.parseInt(e.currentTarget.value, 10);
                        if (!Number.isNaN(next)) {
                          updateConfig({ liquidVariant: next });
                        }
                      }}
                    >
                      <For each={LIQUID_GLASS_VARIANTS}>
                        {(variant) => (
                          <option value={String(variant.value)}>
                            {variant.label}
                          </option>
                        )}
                      </For>
                    </select>
                    <p class="settings-hint">
                      Material variants are only applied when native Liquid Glass is available.
                    </p>
                  </div>

                  <div class="settings-field">
                    <label class="settings-label">Liquid Corner Radius</label>
                    <div class="settings-range-row">
                      <input
                        class="settings-range-input"
                        type="range"
                        min="0"
                        max="64"
                        step="1"
                        value={config().liquidCornerRadius}
                        onInput={(e) => {
                          const next = Number.parseInt(e.currentTarget.value, 10);
                          if (!Number.isNaN(next)) {
                            updateConfig({ liquidCornerRadius: next });
                          }
                        }}
                      />
                      <span class="settings-range-value">
                        {config().liquidCornerRadius}px
                      </span>
                    </div>
                  </div>

                  <div class="settings-field">
                    <label class="settings-label">Liquid Tint Color</label>
                    <input
                      class="settings-input"
                      type="text"
                      placeholder="#FFFFFF20"
                      value={config().liquidTintColor ?? ""}
                      onChange={(e) => {
                        const value = e.currentTarget.value.trim();
                        updateConfig({ liquidTintColor: value.length > 0 ? value : null });
                      }}
                    />
                    <p class="settings-hint">
                      Optional hex tint (`#RRGGBB` or `#RRGGBBAA`). Leave empty to disable tint.
                    </p>
                  </div>
                </Show>
              </Show>
            </div>

            {/* Colors */}
            <div class="settings-card">
              <h3 class="settings-card-title">Colors</h3>
              <p class="settings-hint">
                Customize individual colors. Selecting a theme resets all overrides.
              </p>
              <div class="settings-color-list">
                <div class="settings-color-field">
                  <span class="settings-color-label">Background</span>
                  <HslColorPicker
                    label="Background Color"
                    value={config().customBgColor}
                    defaultColor={getCssVar("--bg", "#0e0e0e")}
                    onChange={(c) => updateConfig({ customBgColor: c })}
                    pickerId="bg" openPickerId={openPickerId} setOpenPickerId={setOpenPickerId}
                  />
                </div>
                <div class="settings-color-field">
                  <span class="settings-color-label">Text</span>
                  <HslColorPicker
                    label="Text Color"
                    value={config().customFgColor}
                    defaultColor={getCssVar("--fg", "#d4d4d4")}
                    onChange={(c) => updateConfig({ customFgColor: c })}
                    pickerId="fg" openPickerId={openPickerId} setOpenPickerId={setOpenPickerId}
                  />
                </div>
                <div class="settings-color-field">
                  <span class="settings-color-label">Accent</span>
                  <HslColorPicker
                    label="Accent Color"
                    value={config().customAccentColor}
                    defaultColor={getCssVar("--accent", "#01c1a2")}
                    onChange={(c) => updateConfig({ customAccentColor: c })}
                    pickerId="accent" openPickerId={openPickerId} setOpenPickerId={setOpenPickerId}
                  />
                </div>
                <div class="settings-color-field">
                  <span class="settings-color-label">Cursor</span>
                  <HslColorPicker
                    label="Cursor Color"
                    value={config().customCursorColor}
                    defaultColor={getCssVar("--cursor-color", "#d4d4d4")}
                    onChange={(c) => updateConfig({ customCursorColor: c })}
                    pickerId="cursor" openPickerId={openPickerId} setOpenPickerId={setOpenPickerId}
                  />
                </div>
                <div class="settings-color-field">
                  <span class="settings-color-label">Tab Bar</span>
                  <HslColorPicker
                    label="Tab Bar Color"
                    value={config().customTabBarColor}
                    defaultColor={getCssVar("--bg", "#0e0e0e")}
                    onChange={(c) => updateConfig({ customTabBarColor: c })}
                    pickerId="tabbar" openPickerId={openPickerId} setOpenPickerId={setOpenPickerId}
                  />
                </div>
                <div class="settings-color-field">
                  <span class="settings-color-label">Input Bar</span>
                  <HslColorPicker
                    label="Input Bar Color"
                    value={config().customInputBarColor}
                    defaultColor={getCssVar("--bg", "#0e0e0e")}
                    onChange={(c) => updateConfig({ customInputBarColor: c })}
                    pickerId="inputbar" openPickerId={openPickerId} setOpenPickerId={setOpenPickerId}
                  />
                </div>
                <div class="settings-color-field">
                  <span class="settings-color-label">Shell Background</span>
                  <HslColorPicker
                    label="Shell Background Color"
                    value={config().customShellBgColor}
                    defaultColor={getCssVar("--bg", "#0e0e0e")}
                    onChange={(c) => updateConfig({ customShellBgColor: c })}
                    pickerId="shellbg" openPickerId={openPickerId} setOpenPickerId={setOpenPickerId}
                  />
                </div>
                <div class="settings-color-field">
                  <span class="settings-color-label">Error</span>
                  <HslColorPicker
                    label="Error Color"
                    value={config().customErrorColor}
                    defaultColor={getCssVar("--error", "#f85149")}
                    onChange={(c) => updateConfig({ customErrorColor: c })}
                    pickerId="error" openPickerId={openPickerId} setOpenPickerId={setOpenPickerId}
                  />
                </div>
                <div class="settings-color-field">
                  <span class="settings-color-label">Success / Path</span>
                  <HslColorPicker
                    label="Success Color"
                    value={config().customSuccessColor}
                    defaultColor={getCssVar("--success", "#01c1a2")}
                    onChange={(c) => updateConfig({ customSuccessColor: c })}
                    pickerId="success" openPickerId={openPickerId} setOpenPickerId={setOpenPickerId}
                  />
                </div>
                <div class="settings-color-field">
                  <span class="settings-color-label">Border</span>
                  <HslColorPicker
                    label="Border Color"
                    value={config().customBorderColor}
                    defaultColor={getCssVar("--border", "#2a2a2a")}
                    onChange={(c) => updateConfig({ customBorderColor: c })}
                    pickerId="border" openPickerId={openPickerId} setOpenPickerId={setOpenPickerId}
                  />
                </div>
                <div class="settings-color-field">
                  <span class="settings-color-label">Selection</span>
                  <HslColorPicker
                    label="Selection Color"
                    value={config().customSelectionColor}
                    defaultColor="#ffffff"
                    onChange={(c) => updateConfig({ customSelectionColor: c })}
                    pickerId="selection" openPickerId={openPickerId} setOpenPickerId={setOpenPickerId}
                  />
                </div>
              </div>
            </div>

            {/* Typography */}
            <div class="settings-card">
              <h3 class="settings-card-title">Typography</h3>

              {/* Live preview */}
              <div
                class="typo-preview"
                style={{
                  "font-family": `"${config().fontFamily}", monospace`,
                  "font-size": `${config().fontSize}px`,
                  "line-height": `${config().lineHeight}`,
                  "letter-spacing": `${config().letterSpacing}px`,
                }}
              >
                <div class="typo-preview-line">
                  <span class="typo-preview-path">~/projects</span>
                  <span class="typo-preview-dollar"> $ </span>
                  <span class="typo-preview-cmd">echo "Hello, World!"</span>
                </div>
                <div class="typo-preview-line typo-preview-output">Hello, World!</div>
                <div class="typo-preview-line">
                  <span class="typo-preview-path">~/projects</span>
                  <span class="typo-preview-dollar"> $ </span>
                  <span class="typo-preview-cmd">ls -la src/</span>
                </div>
                <div class="typo-preview-line typo-preview-output">
                  -rw-r--r--  1 user  staff  1420 main.ts
                </div>
                <div class="typo-preview-line typo-preview-output">
                  -rw-r--r--  1 user  staff   860 utils.ts
                </div>
                <div class="typo-preview-line">
                  <span class="typo-preview-path">~/projects</span>
                  <span class="typo-preview-dollar"> $ </span>
                  <span class="typo-preview-cursor" />
                </div>
              </div>

              {/* Font family */}
              <div class="settings-field">
                <label class="settings-label">Font Family</label>
                <FontFamilyDropdown
                  value={config().fontFamily}
                  onChange={(font) => updateConfig({ fontFamily: font })}
                />
              </div>

              {/* Size / Height / Spacing in a row */}
              <div class="settings-card-row typo-controls-row">
                <div class="settings-field settings-field-flex">
                  <label class="settings-label">Size</label>
                  <div class="settings-number-input">
                    <button
                      class="settings-number-btn"
                      onClick={() =>
                        updateConfig({
                          fontSize: clampFontSize(config().fontSize - 1),
                        })
                      }
                      disabled={config().fontSize <= 10}
                    >
                      -
                    </button>
                    <input
                      class="settings-input settings-input-narrow"
                      type="number"
                      min="10"
                      max="24"
                      value={config().fontSize}
                      onInput={(e) => {
                        const v = parseInt(e.currentTarget.value);
                        if (!isNaN(v))
                          updateConfig({ fontSize: clampFontSize(v) });
                      }}
                    />
                    <button
                      class="settings-number-btn"
                      onClick={() =>
                        updateConfig({
                          fontSize: clampFontSize(config().fontSize + 1),
                        })
                      }
                      disabled={config().fontSize >= 24}
                    >
                      +
                    </button>
                    <span class="settings-number-unit">px</span>
                  </div>
                </div>

                <div class="settings-field settings-field-flex">
                  <label class="settings-label">Line Height</label>
                  <div class="settings-number-input">
                    <button
                      class="settings-number-btn"
                      onClick={() =>
                        updateConfig({
                          lineHeight: clampLineHeight(config().lineHeight - 0.01),
                        })
                      }
                      disabled={config().lineHeight <= 0.0}
                    >
                      -
                    </button>
                    <input
                      class="settings-input settings-input-narrow"
                      type="number"
                      min="0.0"
                      max="2.0"
                      step="0.01"
                      value={config().lineHeight.toFixed(2)}
                      onInput={(e) => {
                        const v = parseFloat(e.currentTarget.value);
                        if (!isNaN(v))
                          updateConfig({ lineHeight: clampLineHeight(v) });
                      }}
                    />
                    <button
                      class="settings-number-btn"
                      onClick={() =>
                        updateConfig({
                          lineHeight: clampLineHeight(config().lineHeight + 0.01),
                        })
                      }
                      disabled={config().lineHeight >= 2.0}
                    >
                      +
                    </button>
                  </div>
                </div>

                <div class="settings-field settings-field-flex">
                  <label class="settings-label">Spacing</label>
                  <div class="settings-number-input">
                    <button
                      class="settings-number-btn"
                      onClick={() =>
                        updateConfig({
                          letterSpacing: Math.max(-2, Math.round((config().letterSpacing - 0.1) * 10) / 10),
                        })
                      }
                      disabled={config().letterSpacing <= -2}
                    >
                      -
                    </button>
                    <input
                      class="settings-input settings-input-narrow"
                      type="number"
                      min="-2"
                      max="4"
                      step="0.1"
                      value={config().letterSpacing.toFixed(1)}
                      onInput={(e) => {
                        const v = parseFloat(e.currentTarget.value);
                        if (!isNaN(v))
                          updateConfig({ letterSpacing: Math.max(-2, Math.min(4, Math.round(v * 10) / 10)) });
                      }}
                    />
                    <button
                      class="settings-number-btn"
                      onClick={() =>
                        updateConfig({
                          letterSpacing: Math.min(4, Math.round((config().letterSpacing + 0.1) * 10) / 10),
                        })
                      }
                      disabled={config().letterSpacing >= 4}
                    >
                      +
                    </button>
                    <span class="settings-number-unit">px</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Reset Appearance */}
            <div class="settings-card settings-reset-card">
              <button class="settings-reset-btn" onClick={() => {
                if (window.confirm("Reset all appearance settings to defaults?")) resetSection("appearance");
              }}>
                Reset Appearance to Defaults
              </button>
            </div>
          </Show>

          {/* ---- TERMINAL ---- */}
          <Show when={activeSection() === "terminal"}>
            <div class="settings-card">
              <h3 class="settings-card-title">Terminal Style</h3>
              <div class="settings-field">
                <label class="settings-label">Layout mode</label>
                <div class="settings-cursor-options">
                  <button
                    class={`settings-cursor-option ${config().terminalStyle === "chat" ? "settings-cursor-option-active" : ""}`}
                    onClick={() => updateConfig({ terminalStyle: "chat" })}
                  >
                    <div class="cursor-preview" style={{ "font-size": "9px", "align-items": "center", "justify-content": "center" }}>
                      Chat
                    </div>
                    <span>Chat</span>
                  </button>
                  <button
                    class={`settings-cursor-option ${config().terminalStyle === "traditional" ? "settings-cursor-option-active" : ""}`}
                    onClick={() => updateConfig({ terminalStyle: "traditional" })}
                  >
                    <div class="cursor-preview" style={{ "font-size": "9px", "align-items": "center", "justify-content": "center" }}>
                      &gt;_
                    </div>
                    <span>Traditional</span>
                  </button>
                </div>
              </div>
            </div>

            <div class="settings-card">
              <h3 class="settings-card-title">tmux Integration</h3>
              <div class="settings-field">
                <label class="settings-label">tmux handling mode</label>
                <p class="settings-hint">
                  Integrated mode intercepts <code>tmux</code> and renders panes
                  through tmux control mode (<code>-CC</code>). Native mode runs
                  tmux directly inside the terminal.
                </p>
                <div class="settings-cursor-options">
                  <button
                    class={`settings-cursor-option ${config().tmuxMode === "integrated" ? "settings-cursor-option-active" : ""}`}
                    onClick={() => updateConfig({ tmuxMode: "integrated" })}
                  >
                    <div class="cursor-preview" style={{ "font-size": "9px", "align-items": "center", "justify-content": "center" }}>
                      -CC
                    </div>
                    <span>Integrated</span>
                  </button>
                  <button
                    class={`settings-cursor-option ${config().tmuxMode === "native" ? "settings-cursor-option-active" : ""}`}
                    onClick={() => updateConfig({ tmuxMode: "native" })}
                  >
                    <div class="cursor-preview" style={{ "font-size": "9px", "align-items": "center", "justify-content": "center" }}>
                      tmux
                    </div>
                    <span>Native</span>
                  </button>
                </div>
              </div>
            </div>

            <div class="settings-card">
              <h3 class="settings-card-title">Prompt Style</h3>
              <div class="settings-field">
                <label class="settings-label">Input prompt display</label>
                <div class="settings-cursor-options">
                  <button
                    class={`settings-cursor-option ${config().promptStyle === "default" ? "settings-cursor-option-active" : ""}`}
                    onClick={() => updateConfig({ promptStyle: "default" })}
                  >
                    <div class="cursor-preview" style={{ "font-size": "9px", "align-items": "center", "justify-content": "center" }}>
                      user@mac
                    </div>
                    <span>Default</span>
                  </button>
                  <button
                    class={`settings-cursor-option ${config().promptStyle === "simplified" ? "settings-cursor-option-active" : ""}`}
                    onClick={() => updateConfig({ promptStyle: "simplified" })}
                  >
                    <div class="cursor-preview" style={{ "font-size": "9px", "align-items": "center", "justify-content": "center" }}>
                      ~/path
                    </div>
                    <span>Simplified</span>
                  </button>
                  <button
                    class={`settings-cursor-option ${config().promptStyle === "blank" ? "settings-cursor-option-active" : ""}`}
                    onClick={() => updateConfig({ promptStyle: "blank" })}
                  >
                    <div class="cursor-preview" style={{ "font-size": "9px", "align-items": "center", "justify-content": "center" }}>
                      _
                    </div>
                    <span>Blank</span>
                  </button>
                </div>
              </div>
            </div>

            <div class="settings-card">
              <h3 class="settings-card-title">Cursor</h3>

              <div class="settings-field">
                <label class="settings-label">Cursor Style</label>
                <div class="settings-cursor-options">
                  <button
                    class={`settings-cursor-option ${config().cursorShape === "block" ? "settings-cursor-option-active" : ""}`}
                    onClick={() => updateConfig({ cursorShape: "block" })}
                  >
                    <div class="cursor-preview">
                      <span class="cursor-demo cursor-demo-block" />
                    </div>
                    <span>Block</span>
                  </button>
                  <button
                    class={`settings-cursor-option ${config().cursorShape === "underline" ? "settings-cursor-option-active" : ""}`}
                    onClick={() => updateConfig({ cursorShape: "underline" })}
                  >
                    <div class="cursor-preview">
                      <span class="cursor-demo cursor-demo-underline" />
                    </div>
                    <span>Underline</span>
                  </button>
                  <button
                    class={`settings-cursor-option ${config().cursorShape === "bar" ? "settings-cursor-option-active" : ""}`}
                    onClick={() => updateConfig({ cursorShape: "bar" })}
                  >
                    <div class="cursor-preview">
                      <span class="cursor-demo cursor-demo-bar" />
                    </div>
                    <span>Bar</span>
                  </button>
                </div>
              </div>

              <div class="settings-field settings-field-row">
                <div class="settings-field-info">
                  <label class="settings-label">Cursor Blink</label>
                  <p class="settings-hint">
                    Whether the cursor blinks in the terminal.
                  </p>
                </div>
                <button
                  class={`settings-toggle ${config().cursorBlink ? "settings-toggle-on" : ""}`}
                  onClick={() =>
                    updateConfig({ cursorBlink: !config().cursorBlink })
                  }
                >
                  <span class="settings-toggle-knob" />
                </button>
              </div>
            </div>

            <div class="settings-card">
              <h3 class="settings-card-title">Behavior</h3>

              <div class="settings-field settings-field-row">
                <div class="settings-field-info">
                  <label class="settings-label">Option as Meta Key</label>
                  <p class="settings-hint">
                    Treat the Option key as the Meta key in the terminal.
                  </p>
                </div>
                <button
                  class={`settings-toggle ${config().optionAsMeta ? "settings-toggle-on" : ""}`}
                  onClick={() =>
                    updateConfig({ optionAsMeta: !config().optionAsMeta })
                  }
                >
                  <span class="settings-toggle-knob" />
                </button>
              </div>

              <div class="settings-field settings-field-row">
                <div class="settings-field-info">
                  <label class="settings-label">Clear History for TUIs</label>
                  <p class="settings-hint">
                    Hide command history when TUIs are active (alt-screen and primary-screen). Disable to keep history visible above.
                  </p>
                </div>
                <button
                  class={`settings-toggle ${config().clearHistoryForTuis ? "settings-toggle-on" : ""}`}
                  onClick={() =>
                    updateConfig({ clearHistoryForTuis: !config().clearHistoryForTuis })
                  }
                >
                  <span class="settings-toggle-knob" />
                </button>
              </div>

              <div class="settings-field settings-field-row">
                <div class="settings-field-info">
                  <label class="settings-label">Enable Ligatures</label>
                  <p class="settings-hint">
                    Render coding ligatures for fonts that support them.
                  </p>
                </div>
                <button
                  class={`settings-toggle ${config().enableLigatures ? "settings-toggle-on" : ""}`}
                  onClick={() =>
                    updateConfig({ enableLigatures: !config().enableLigatures })
                  }
                >
                  <span class="settings-toggle-knob" />
                </button>
              </div>

              <div class="settings-field">
                <label class="settings-label">Scrollback Lines</label>
                <p class="settings-hint">
                  Maximum lines kept in scrollback history (1,000 - 100,000).
                </p>
                <div class="settings-number-input">
                  <input
                    class="settings-input settings-input-wide"
                    type="number"
                    min="1000"
                    max="100000"
                    step="1000"
                    value={config().scrollbackLines}
                    onInput={(e) => {
                      const v = parseInt(e.currentTarget.value);
                      if (!isNaN(v))
                        updateConfig({
                          scrollbackLines: clampScrollback(v),
                        });
                    }}
                  />
                  <span class="settings-number-unit">lines</span>
                </div>
              </div>

              <div class="settings-field">
                <label class="settings-label">Command History Limit</label>
                <p class="settings-hint">
                  Maximum completed command blocks kept in memory (100 - 10,000). Lower values reduce memory usage during long sessions.
                </p>
                <div class="settings-number-input">
                  <input
                    class="settings-input settings-input-wide"
                    type="number"
                    min="100"
                    max="10000"
                    step="100"
                    value={config().snapshotLimit}
                    onInput={(e) => {
                      const v = parseInt(e.currentTarget.value);
                      if (!isNaN(v))
                        updateConfig({
                          snapshotLimit: Math.min(10000, Math.max(100, v)),
                        });
                    }}
                  />
                  <span class="settings-number-unit">blocks</span>
                </div>
              </div>
            </div>

            <div class="settings-card">
              <h3 class="settings-card-title">Renderer</h3>
              <div class="settings-field">
                <label class="settings-label">Preferred Renderer</label>
                <p class="settings-hint">
                  Auto tries WebGL2 first for maximum GPU performance, then falls back to Canvas2D. WebGL forces WebGL2 (falls back to Canvas if unavailable). Canvas uses Canvas2D only. DOM uses browser layout and may be slower during heavy output.
                </p>
                <div class="settings-cursor-options">
                  <button
                    class={`settings-cursor-option ${config().renderer === "auto" ? "settings-cursor-option-active" : ""}`}
                    onClick={() => updateConfig({ renderer: "auto" })}
                  >
                    <div class="cursor-preview" style={{ "font-size": "9px", "align-items": "center", "justify-content": "center" }}>
                      Auto
                    </div>
                    <span>Auto</span>
                  </button>
                  <button
                    class={`settings-cursor-option ${config().renderer === "webgl" ? "settings-cursor-option-active" : ""}`}
                    onClick={() => updateConfig({ renderer: "webgl" })}
                  >
                    <div class="cursor-preview" style={{ "font-size": "9px", "align-items": "center", "justify-content": "center" }}>
                      WebGL
                    </div>
                    <span>WebGL</span>
                  </button>
                  <button
                    class={`settings-cursor-option ${config().renderer === "canvas" ? "settings-cursor-option-active" : ""}`}
                    onClick={() => updateConfig({ renderer: "canvas" })}
                  >
                    <div class="cursor-preview" style={{ "font-size": "9px", "align-items": "center", "justify-content": "center" }}>
                      Canvas
                    </div>
                    <span>Canvas</span>
                  </button>
                  <button
                    class={`settings-cursor-option ${config().renderer === "dom" ? "settings-cursor-option-active" : ""}`}
                    onClick={() => updateConfig({ renderer: "dom" })}
                  >
                    <div class="cursor-preview" style={{ "font-size": "9px", "align-items": "center", "justify-content": "center" }}>
                      DOM
                    </div>
                    <span>DOM</span>
                  </button>
                </div>
              </div>
            </div>

            <div class="settings-card">
              <h3 class="settings-card-title">Status Bar</h3>

              <div class="settings-field settings-field-row">
                <div class="settings-field-info">
                  <label class="settings-label">Show Status Bar</label>
                  <p class="settings-hint">
                    Display the status bar at the bottom of the window.
                  </p>
                </div>
                <button
                  class={`settings-toggle ${config().showStatusBar ? "settings-toggle-on" : ""}`}
                  onClick={() =>
                    updateConfig({ showStatusBar: !config().showStatusBar })
                  }
                >
                  <span class="settings-toggle-knob" />
                </button>
              </div>

              <div
                class="settings-status-bar-items"
                style={{ opacity: config().showStatusBar ? 1 : 0.4, "pointer-events": config().showStatusBar ? "auto" : "none" }}
              >
                <div class="settings-field settings-field-row">
                  <div class="settings-field-info">
                    <label class="settings-label">Working Directory</label>
                    <p class="settings-hint">
                      Show the current path.
                    </p>
                  </div>
                  <button
                    class={`settings-toggle ${config().statusBarShowPath ? "settings-toggle-on" : ""}`}
                    onClick={() =>
                      updateConfig({ statusBarShowPath: !config().statusBarShowPath })
                    }
                  >
                    <span class="settings-toggle-knob" />
                  </button>
                </div>

                <div class="settings-field settings-field-row">
                  <div class="settings-field-info">
                    <label class="settings-label">Terminal Size</label>
                    <p class="settings-hint">
                      Show the column and row dimensions.
                    </p>
                  </div>
                  <button
                    class={`settings-toggle ${config().statusBarShowDimensions ? "settings-toggle-on" : ""}`}
                    onClick={() =>
                      updateConfig({ statusBarShowDimensions: !config().statusBarShowDimensions })
                    }
                  >
                    <span class="settings-toggle-knob" />
                  </button>
                </div>

                <div class="settings-field settings-field-row">
                  <div class="settings-field-info">
                    <label class="settings-label">Active Process</label>
                    <p class="settings-hint">
                      Show the currently running process name.
                    </p>
                  </div>
                  <button
                    class={`settings-toggle ${config().statusBarShowActiveProcess ? "settings-toggle-on" : ""}`}
                    onClick={() =>
                      updateConfig({ statusBarShowActiveProcess: !config().statusBarShowActiveProcess })
                    }
                  >
                    <span class="settings-toggle-knob" />
                  </button>
                </div>

                <div class="settings-field settings-field-row">
                  <div class="settings-field-info">
                    <label class="settings-label">Connection Status</label>
                    <p class="settings-hint">
                      Show the connection indicator.
                    </p>
                  </div>
                  <button
                    class={`settings-toggle ${config().statusBarShowConnection ? "settings-toggle-on" : ""}`}
                    onClick={() =>
                      updateConfig({ statusBarShowConnection: !config().statusBarShowConnection })
                    }
                  >
                    <span class="settings-toggle-knob" />
                  </button>
                </div>
              </div>
            </div>

            <div class="settings-card">
              <h3 class="settings-card-title">Output Triggers</h3>
              <p class="settings-hint">
                Match terminal output with regex and run an action.
              </p>
              <div style={{ display: "flex", "flex-direction": "column", gap: "10px" }}>
                <For each={triggerList()}>
                  {(trigger) => (
                    <div style={{ display: "grid", "grid-template-columns": "1fr 1.3fr auto auto", gap: "8px", "align-items": "center" }}>
                      <input
                        class="settings-input"
                        type="text"
                        value={trigger.name}
                        placeholder="Trigger name"
                        onInput={(e) => {
                          updateTrigger(trigger.id, { name: e.currentTarget.value });
                          setTriggerList(getTriggers());
                        }}
                      />
                      <input
                        class="settings-input"
                        type="text"
                        value={trigger.pattern}
                        placeholder="Regex pattern"
                        onInput={(e) => {
                          updateTrigger(trigger.id, { pattern: e.currentTarget.value });
                          setTriggerList(getTriggers());
                        }}
                      />
                      <select
                        class="settings-input"
                        value={trigger.action}
                        onChange={(e) => {
                          const action = e.currentTarget.value as OutputTrigger["action"];
                          updateTrigger(trigger.id, { action });
                          setTriggerList(getTriggers());
                        }}
                      >
                        <option value="notify">Notify</option>
                        <option value="sound">Sound</option>
                        <option value="badge">Badge</option>
                      </select>
                      <button
                        class={`settings-toggle ${trigger.enabled ? "settings-toggle-on" : ""}`}
                        onClick={() => {
                          updateTrigger(trigger.id, { enabled: !trigger.enabled });
                          setTriggerList(getTriggers());
                        }}
                        title={trigger.enabled ? "Disable trigger" : "Enable trigger"}
                      >
                        <span class="settings-toggle-knob" />
                      </button>
                      <div style={{ "grid-column": "1 / span 4", display: "flex", "justify-content": "flex-end", gap: "8px" }}>
                        <button
                          class="settings-profile-delete"
                          onClick={() => {
                            deleteTrigger(trigger.id);
                            setTriggerList(getTriggers());
                          }}
                          title="Delete trigger"
                        >
                          &times;
                        </button>
                      </div>
                    </div>
                  )}
                </For>
              </div>
              <button
                class="settings-btn"
                style={{ margin: "12px 0 0" }}
                onClick={() => {
                  addTrigger({
                    name: "New trigger",
                    pattern: "",
                    enabled: false,
                    action: "notify",
                  });
                  setTriggerList(getTriggers());
                }}
              >
                Add Trigger
              </button>
            </div>

            {/* Reset Terminal */}
            <div class="settings-card settings-reset-card">
              <button class="settings-reset-btn" onClick={() => {
                if (window.confirm("Reset all terminal settings to defaults?")) resetSection("terminal");
              }}>
                Reset Terminal to Defaults
              </button>
            </div>
          </Show>

          {/* ---- SHORTCUTS ---- */}
          <Show when={activeSection() === "shortcuts"}>
            <div class="settings-card">
              <h3 class="settings-card-title">Keyboard Shortcuts</h3>
              <p class="settings-hint">
                Reference list of available keyboard shortcuts.
              </p>
              <div class="settings-shortcuts-table">
                <For each={shortcuts}>
                  {(shortcut) => (
                    <div class="settings-shortcut-row">
                      <kbd class="settings-kbd">{shortcut.keys}</kbd>
                      <span class="settings-shortcut-desc">
                        {shortcut.description}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </div>

            <div class="settings-card">
              <h3 class="settings-card-title">Global Hotkey</h3>
              <div class="settings-field">
                <label class="settings-label">System-Wide Shortcut</label>
                <p class="settings-hint">
                  Example: <code>CmdOrCtrl+Shift+Space</code>. Leave empty to disable.
                </p>
                <input
                  class="settings-input"
                  type="text"
                  value={config().globalHotkey ?? ""}
                  placeholder="CmdOrCtrl+Shift+Space"
                  onInput={(e) => {
                    const value = e.currentTarget.value.trim();
                    updateConfig({ globalHotkey: value.length > 0 ? value : null });
                  }}
                />
              </div>
            </div>
          </Show>

          {/* ---- DATA ---- */}
          <div class="settings-card">
            <h3 class="settings-card-title">Data</h3>
            <p class="settings-hint">
              Export your current configuration as a JSON file, or import a previously exported config.
            </p>
            <div style={{ display: "flex", gap: "8px" }}>
              <button class="settings-btn" onClick={handleExportConfig}>
                Export Config
              </button>
              <button class="settings-btn" onClick={handleImportConfig}>
                Import Config
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              style={{ display: "none" }}
              onChange={handleFileSelected}
            />
          </div>

          {/* ---- PROFILES ---- */}
          <Show when={activeSection() === "profiles"}>
            <div class="settings-card settings-profiles-split">
              {/* Left panel: profile list */}
              <div class="settings-profiles-sidebar">
                <h3 class="settings-card-title">Profiles</h3>

                <div class="settings-profiles-list">
                  <For each={profileList()}>
                    {(profile) => (
                      <div
                        class={`settings-profile-item ${selectedProfileId() === profile.id ? "settings-profile-selected" : ""}`}
                        onClick={() => {
                          setSelectedProfileId(profile.id);
                          setActiveProfileId(profile.id);
                        }}
                      >
                        <div class="settings-profile-info">
                          <div class="settings-profile-name-row">
                            <span class="settings-profile-name">{profile.name}</span>
                            <Show when={selectedProfileId() === profile.id}>
                              <span class="settings-profile-active-badge">Active</span>
                            </Show>
                          </div>
                          <span class="settings-profile-detail">
                            {profile.shell ?? "Default shell"}
                            {profile.cwd ? ` · ${profile.cwd}` : ""}
                            {profile.env && Object.keys(profile.env).length > 0
                              ? ` · ${Object.keys(profile.env).length} env`
                              : ""}
                          </span>
                        </div>
                        <Show when={profile.id !== "default"}>
                          <button
                            class="settings-profile-delete"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteProfile(profile.id);
                              refreshProfiles();
                            }}
                          >
                            &times;
                          </button>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>

                <button
                  class="settings-btn"
                  onClick={() => {
                    const created = addProfile({ name: `Profile ${profileList().length}` });
                    refreshProfiles(created.id);
                  }}
                >
                  Add Profile
                </button>
              </div>

              {/* Right panel: editor */}
              <div class="settings-profiles-editor">
                <Show
                  when={selectedProfile()}
                  fallback={
                    <div class="settings-profiles-placeholder">
                      <IconUser size={32} />
                      <p>Select a profile to edit</p>
                    </div>
                  }
                >
                  {(profile) => (
                    <>
                      <h3 class="settings-card-title">
                        {profile().id === "default" ? "Default Profile" : profile().name}
                      </h3>

                      <div class="settings-field">
                        <label class="settings-label">Profile Name</label>
                        <input
                          class="settings-input"
                          type="text"
                          value={profile().name}
                          onInput={(e) => {
                            updateProfile(profile().id, { name: e.currentTarget.value });
                            refreshProfiles(profile().id);
                          }}
                        />
                      </div>

                      <div class="settings-field">
                        <label class="settings-label">Shell Path</label>
                        <p class="settings-hint">
                          Absolute path to the shell binary, e.g. <code>/bin/zsh</code>.
                        </p>
                        <input
                          class="settings-input"
                          type="text"
                          value={profile().shell ?? ""}
                          placeholder="Use system default shell"
                          onInput={(e) => {
                            const shell = e.currentTarget.value.trim();
                            updateProfile(profile().id, { shell: shell || undefined });
                            refreshProfiles(profile().id);
                          }}
                        />
                      </div>

                      <div class="settings-field">
                        <label class="settings-label">Working Directory</label>
                        <p class="settings-hint">
                          Starting directory when a new tab is opened with this profile.
                        </p>
                        <input
                          class="settings-input"
                          type="text"
                          value={profile().cwd ?? ""}
                          placeholder="Use current pane directory"
                          onInput={(e) => {
                            const cwd = e.currentTarget.value.trim();
                            updateProfile(profile().id, { cwd: cwd || undefined });
                            refreshProfiles(profile().id);
                          }}
                        />
                      </div>

                      <div class="settings-field">
                        <label class="settings-label">Environment Variables</label>
                        <p class="settings-hint">
                          One <code>KEY=VALUE</code> per line. Lines starting with <code>#</code> are ignored.
                        </p>
                        <textarea
                          class="settings-input settings-textarea"
                          value={profileEnvDraft()}
                          placeholder={"FOO=bar\nAPI_URL=https://example.com"}
                          onInput={(e) => {
                            setProfileEnvDraft(e.currentTarget.value);
                          }}
                          onBlur={(e) => {
                            const text = e.currentTarget.value;
                            updateProfile(profile().id, { env: parseEnvDraft(text) });
                            refreshProfiles(profile().id);
                          }}
                        />
                      </div>
                    </>
                  )}
                </Show>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
};
