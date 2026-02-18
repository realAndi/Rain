import { Component, createSignal, createEffect, Show, onCleanup } from "solid-js";

// ---- HSL <-> Hex conversion utilities ----

export function hslToHex(h: number, s: number, l: number): string {
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

export function hexToHsl(hex: string): [number, number, number] {
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

export function isValidHex(v: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(v);
}

// ---- HSL Color Picker ----

export const HslColorPicker: Component<{
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
