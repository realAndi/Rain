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
import { useConfig } from "../stores/config";
import { useTheme, THEME_LIST } from "../stores/theme";
import {
  computeBlurProfile,
} from "../lib/glass";
import { setAppIcon } from "../lib/ipc";
import {
  IconPalette,
  IconTerminal,
  IconKeyboard,
  IconCheck,
} from "./icons";

type Section = "appearance" | "terminal" | "shortcuts";

// ---- HSL <-> Hex conversion utilities ----

function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100;
  const lN = l / 100;
  const a = sN * Math.min(lN, 1 - lN);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = lN - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * Math.max(0, Math.min(1, color)))
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, Math.round(l * 100)];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

function isValidHex(v: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(v);
}

// ---- HSL Color Picker ----

const HslColorPicker: Component<{
  label: string;
  value: string | null;
  defaultColor: string;
  onChange: (color: string | null) => void;
  pickerId: string;
  openPickerId: () => string | null;
  setOpenPickerId: (id: string | null) => void;
}> = (props) => {
  let wrapRef: HTMLDivElement | undefined;
  const displayColor = () => props.value ?? props.defaultColor;
  const open = () => props.openPickerId() === props.pickerId;
  const setOpen = (v: boolean) => props.setOpenPickerId(v ? props.pickerId : null);
  const [hue, setHue] = createSignal(0);
  const [sat, setSat] = createSignal(100);
  const [lit, setLit] = createSignal(50);
  const [hexInput, setHexInput] = createSignal("");

  // Close picker when clicking outside
  function handleClickOutside(e: MouseEvent) {
    if (open() && wrapRef && !wrapRef.contains(e.target as Node)) {
      setOpen(false);
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

  // Sync internal HSL state when the external value changes
  createEffect(() => {
    const color = displayColor();
    if (isValidHex(color)) {
      const [h, s, l] = hexToHsl(color);
      setHue(h);
      setSat(s);
      setLit(l);
      setHexInput(color.toUpperCase());
    }
  });

  function emitColor(h: number, s: number, l: number) {
    const hex = hslToHex(h, s, l);
    setHexInput(hex.toUpperCase());
    props.onChange(hex);
  }

  // Saturation/Lightness area drag
  function handleSLPointerDown(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    updateSL(e, el);
  }

  function handleSLPointerMove(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) {
      updateSL(e, el);
    }
  }

  function updateSL(e: PointerEvent, el: HTMLElement) {
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    const s = Math.round(x * 100);
    const l = Math.round((1 - y) * 100);
    setSat(s);
    setLit(l);
    emitColor(hue(), s, l);
  }

  // Hue strip drag
  function handleHuePointerDown(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    updateHue(e, el);
  }

  function handleHuePointerMove(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) {
      updateHue(e, el);
    }
  }

  function updateHue(e: PointerEvent, el: HTMLElement) {
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const h = Math.round(x * 360);
    setHue(h);
    emitColor(h, sat(), lit());
  }

  function handleHexInput(value: string) {
    setHexInput(value);
    const v = value.startsWith("#") ? value : `#${value}`;
    if (isValidHex(v)) {
      const [h, s, l] = hexToHsl(v);
      setHue(h);
      setSat(s);
      setLit(l);
      props.onChange(v);
    }
  }

  return (
    <div class="hsl-picker-wrap" ref={wrapRef}>
      <div class="settings-color-row">
        <button
          class="settings-color-swatch"
          style={{ background: displayColor() }}
          onClick={() => setOpen(!open())}
          title="Pick color"
        />
        <span class="settings-color-hex">
          {props.value ? props.value.toUpperCase() : "Default"}
        </span>
        <Show when={props.value !== null}>
          <button
            class="settings-color-reset"
            onClick={() => {
              props.onChange(null);
              setOpen(false);
            }}
            title="Reset to theme default"
          >
            Reset
          </button>
        </Show>
      </div>

      <Show when={open()}>
        <div class="hsl-picker">
          {/* Saturation / Lightness area */}
          <div
            class="hsl-sl-area"
            style={{
              background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hue()}, 100%, 50%))`,
            }}
            onPointerDown={handleSLPointerDown}
            onPointerMove={handleSLPointerMove}
          >
            <div
              class="hsl-sl-indicator"
              style={{
                left: `${sat()}%`,
                top: `${100 - lit()}%`,
                background: displayColor(),
              }}
            />
          </div>

          {/* Hue strip */}
          <div
            class="hsl-hue-strip"
            onPointerDown={handleHuePointerDown}
            onPointerMove={handleHuePointerMove}
          >
            <div
              class="hsl-hue-indicator"
              style={{
                left: `${(hue() / 360) * 100}%`,
              }}
            />
          </div>

          {/* Hex input */}
          <input
            class="hsl-hex-input"
            type="text"
            value={hexInput()}
            onInput={(e) => handleHexInput(e.currentTarget.value)}
            spellcheck={false}
            maxLength={7}
          />
        </div>
      </Show>
    </div>
  );
};

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
];

// ---- Settings Component ----

export const Settings: Component = () => {
  const { config, updateConfig, saveConfig, isDirty } = useConfig();
  const { theme, setTheme } = useTheme();
  const [activeSection, setActiveSection] = createSignal<Section>("appearance");
  const [openPickerId, setOpenPickerId] = createSignal<string | null>(null);
  const [saved, setSaved] = createSignal(false);

  function handleSave() {
    saveConfig();
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
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
    <div class="settings-page">
      <div class="settings-layout">
        {/* Sidebar */}
        <nav class="settings-sidebar">
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

            {/* App Icon */}
            <div class="settings-card">
              <h3 class="settings-card-title">App Icon</h3>
              <div class="settings-field">
                <label class="settings-label">Dock icon style</label>
                <div class="settings-cursor-options">
                  <button
                    class={`settings-cursor-option ${config().appIcon === "default" ? "settings-cursor-option-active" : ""}`}
                    onClick={() => {
                      updateConfig({ appIcon: "default" });
                      setAppIcon("default").catch(console.warn);
                    }}
                  >
                    <div class="cursor-preview icon-preview" style={{ background: "linear-gradient(135deg, #4a6a8a, #6a8aaa)", "border-radius": "8px" }}>
                      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                        <path d="M10 3C10 3 8 8 8 12C8 14.2 8.9 16 10 16C11.1 16 12 14.2 12 12C12 8 10 3 10 3Z" fill="rgba(255,255,255,0.9)" />
                      </svg>
                    </div>
                    <span>Default</span>
                  </button>
                  <button
                    class={`settings-cursor-option ${config().appIcon === "simple" ? "settings-cursor-option-active" : ""}`}
                    onClick={() => {
                      updateConfig({ appIcon: "simple" });
                      setAppIcon("simple").catch(console.warn);
                    }}
                  >
                    <div class="cursor-preview icon-preview" style={{ background: "#1a1a2e", "border-radius": "8px" }}>
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <path d="M8 2C8 2 6.5 6 6.5 9.5C6.5 11.4 7.2 13 8 13C8.8 13 9.5 11.4 9.5 9.5C9.5 6 8 2 8 2Z" fill="rgba(255,255,255,0.7)" />
                      </svg>
                    </div>
                    <span>Simple</span>
                  </button>
                </div>
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
          </Show>
        </div>
      </div>
    </div>
  );
};
