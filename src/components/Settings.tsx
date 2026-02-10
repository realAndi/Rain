import {
  Component,
  createSignal,
  For,
  Show,
} from "solid-js";
import { useConfig } from "../stores/config";
import { useTheme, THEME_LIST } from "../stores/theme";
import {
  IconPalette,
  IconTerminal,
  IconKeyboard,
  IconCheck,
} from "./icons";

type Section = "appearance" | "terminal" | "shortcuts";

const ColorPicker: Component<{
  label: string;
  value: string | null;
  defaultColor: string;
  onChange: (color: string | null) => void;
}> = (props) => {
  let inputRef: HTMLInputElement | undefined;

  const displayColor = () => props.value ?? props.defaultColor;

  return (
    <div class="settings-color-row">
      <button
        class="settings-color-swatch"
        style={{ background: displayColor() }}
        onClick={() => inputRef?.click()}
        title="Pick color"
      />
      <input
        ref={inputRef}
        type="color"
        class="settings-color-native-input"
        value={displayColor()}
        onInput={(e) => props.onChange(e.currentTarget.value)}
      />
      <span class="settings-color-hex">
        {props.value ? props.value.toUpperCase() : "Default"}
      </span>
      <Show when={props.value !== null}>
        <button
          class="settings-color-reset"
          onClick={() => props.onChange(null)}
          title="Reset to theme default"
        >
          Reset
        </button>
      </Show>
    </div>
  );
};

const shortcuts = [
  { keys: "\u2318 T", description: "New tab" },
  { keys: "\u2318 W", description: "Close tab" },
  { keys: "\u2318 K", description: "Clear terminal" },
  { keys: "\u2318 ,", description: "Settings" },
  { keys: "\u2318 1\u20139", description: "Switch to tab" },
  { keys: "\u2318 \u21e7 [", description: "Previous tab" },
  { keys: "\u2318 \u21e7 ]", description: "Next tab" },
];

export const Settings: Component = () => {
  const { config, updateConfig } = useConfig();
  const { theme, setTheme } = useTheme();
  const [activeSection, setActiveSection] = createSignal<Section>("appearance");

  const sections: { id: Section; label: string; icon: () => any }[] = [
    {
      id: "appearance",
      label: "Appearance",
      icon: () => <IconPalette size={14} />,
    },
    {
      id: "terminal",
      label: "Terminal",
      icon: () => <IconTerminal size={14} />,
    },
    {
      id: "shortcuts",
      label: "Keyboard Shortcuts",
      icon: () => <IconKeyboard size={14} />,
    },
  ];

  function clampFontSize(val: number): number {
    return Math.min(24, Math.max(10, val));
  }

  function clampLineHeight(val: number): number {
    return Math.min(2.0, Math.max(1.0, Math.round(val * 10) / 10));
  }

  function clampScrollback(val: number): number {
    return Math.min(100_000, Math.max(1_000, val));
  }

  return (
    <div class="settings-tab">
      <div class="settings-body">
        {/* Sidebar */}
        <nav class="settings-sidebar">
          <div class="settings-sidebar-title">Settings</div>
          <For each={sections}>
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
        </nav>

        {/* Content */}
        <div class="settings-content">
          {/* Appearance Section */}
          <Show when={activeSection() === "appearance"}>
            <div class="settings-section">
              <h3 class="settings-section-title">
                <IconPalette size={14} />
                Appearance
              </h3>

              {/* Theme picker */}
              <div class="settings-field">
                <label class="settings-label">Theme</label>
                <div class="settings-theme-cards">
                  <For each={THEME_LIST}>
                    {(t) => (
                      <button
                        class={`settings-theme-card ${theme() === t.name ? "settings-theme-card-active" : ""}`}
                        onClick={() => setTheme(t.name)}
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

              {/* Font family */}
              <div class="settings-field">
                <label class="settings-label">Font Family</label>
                <p class="settings-hint">
                  Comma-separated list of font families for the terminal.
                </p>
                <input
                  class="settings-input"
                  type="text"
                  value={config().fontFamily}
                  onInput={(e) =>
                    updateConfig({ fontFamily: e.currentTarget.value })
                  }
                  spellcheck={false}
                />
              </div>

              {/* Font size */}
              <div class="settings-field">
                <label class="settings-label">Font Size</label>
                <p class="settings-hint">
                  Terminal font size in pixels (10 - 24).
                </p>
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

              {/* Line height */}
              <div class="settings-field">
                <label class="settings-label">Line Height</label>
                <p class="settings-hint">
                  Line height multiplier (1.0 - 2.0).
                </p>
                <div class="settings-number-input">
                  <button
                    class="settings-number-btn"
                    onClick={() =>
                      updateConfig({
                        lineHeight: clampLineHeight(
                          config().lineHeight - 0.1
                        ),
                      })
                    }
                    disabled={config().lineHeight <= 1.0}
                  >
                    -
                  </button>
                  <input
                    class="settings-input settings-input-narrow"
                    type="number"
                    min="1.0"
                    max="2.0"
                    step="0.1"
                    value={config().lineHeight.toFixed(1)}
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
                        lineHeight: clampLineHeight(
                          config().lineHeight + 0.1
                        ),
                      })
                    }
                    disabled={config().lineHeight >= 2.0}
                  >
                    +
                  </button>
                </div>
              </div>

              {/* Window opacity */}
              <div class="settings-field">
                <label class="settings-label">Window Opacity</label>
                <p class="settings-hint">
                  Controls the overall window transparency (30% - 100%).
                </p>
                <div class="settings-range-row">
                  <input
                    class="settings-range-input"
                    type="range"
                    min="0.3"
                    max="1.0"
                    step="0.05"
                    value={config().windowOpacity}
                    onInput={(e) => {
                      const v = parseFloat(e.currentTarget.value);
                      if (!isNaN(v)) updateConfig({ windowOpacity: v });
                    }}
                  />
                  <span class="settings-range-value">
                    {Math.round(config().windowOpacity * 100)}%
                  </span>
                </div>
              </div>

              {/* Background blur */}
              <div class="settings-field">
                <label class="settings-label">Background Blur</label>
                <p class="settings-hint">
                  Blurs the desktop behind the window. Only visible when opacity is below 100%.
                </p>
                <div class="settings-range-row">
                  <input
                    class="settings-range-input"
                    type="range"
                    min="0"
                    max="40"
                    step="1"
                    value={config().backgroundBlur}
                    onInput={(e) => {
                      const v = parseInt(e.currentTarget.value);
                      if (!isNaN(v)) updateConfig({ backgroundBlur: v });
                    }}
                  />
                  <span class="settings-range-value">
                    {config().backgroundBlur}px
                  </span>
                </div>
              </div>

              {/* Custom Colors */}
              <div class="settings-color-group">
                <label class="settings-label">Custom Colors</label>
                <p class="settings-hint">
                  Override individual theme colors. Reset to restore the theme default.
                </p>
                <div class="settings-color-list">
                  <div class="settings-color-field">
                    <span class="settings-color-label">Background Color</span>
                    <ColorPicker
                      label="Background Color"
                      value={config().customBgColor}
                      defaultColor={getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#0e0e0e"}
                      onChange={(c) => updateConfig({ customBgColor: c })}
                    />
                  </div>
                  <div class="settings-color-field">
                    <span class="settings-color-label">Text Color</span>
                    <ColorPicker
                      label="Text Color"
                      value={config().customFgColor}
                      defaultColor={getComputedStyle(document.documentElement).getPropertyValue("--fg").trim() || "#d4d4d4"}
                      onChange={(c) => updateConfig({ customFgColor: c })}
                    />
                  </div>
                  <div class="settings-color-field">
                    <span class="settings-color-label">Accent Color</span>
                    <ColorPicker
                      label="Accent Color"
                      value={config().customAccentColor}
                      defaultColor={getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#01c1a2"}
                      onChange={(c) => updateConfig({ customAccentColor: c })}
                    />
                  </div>
                  <div class="settings-color-field">
                    <span class="settings-color-label">Cursor Color</span>
                    <ColorPicker
                      label="Cursor Color"
                      value={config().customCursorColor}
                      defaultColor={getComputedStyle(document.documentElement).getPropertyValue("--cursor-color").trim() || "#d4d4d4"}
                      onChange={(c) => updateConfig({ customCursorColor: c })}
                    />
                  </div>
                </div>
              </div>
            </div>
          </Show>

          {/* Terminal Section */}
          <Show when={activeSection() === "terminal"}>
            <div class="settings-section">
              <h3 class="settings-section-title">
                <IconTerminal size={14} />
                Terminal
              </h3>

              {/* Cursor style */}
              <div class="settings-field">
                <label class="settings-label">Cursor Style</label>
                <p class="settings-hint">
                  Choose the shape of the terminal cursor.
                </p>
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

              {/* Cursor blink */}
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

              {/* Option as Meta */}
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

              {/* Scrollback lines */}
              <div class="settings-field">
                <label class="settings-label">Scrollback Lines</label>
                <p class="settings-hint">
                  Maximum number of lines kept in scrollback history (1,000 -
                  100,000).
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
          </Show>

          {/* Keyboard Shortcuts Section */}
          <Show when={activeSection() === "shortcuts"}>
            <div class="settings-section">
              <h3 class="settings-section-title">
                <IconKeyboard size={14} />
                Keyboard Shortcuts
              </h3>
              <p class="settings-section-desc">
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
