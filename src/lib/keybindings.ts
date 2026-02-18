// Keybinding configuration system for Rain terminal.

export interface Keybinding {
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface KeybindingEntry {
  action: string;
  binding: Keybinding;
}

export type KeybindingMap = Record<string, Keybinding>;

const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

export const DEFAULT_KEYBINDINGS: KeybindingMap = {
  "new-tab": { key: "t", meta: isMac, ctrl: !isMac },
  "close-tab": { key: "w", meta: isMac, ctrl: !isMac },
  "next-tab": { key: "Tab", ctrl: true },
  "prev-tab": { key: "Tab", ctrl: true, shift: true },
  "settings": { key: ",", meta: isMac, ctrl: !isMac },
  "clear": { key: "k", meta: isMac, ctrl: !isMac },
  "search": { key: "f", meta: isMac, ctrl: !isMac },
  "split-horizontal": { key: "d", meta: isMac, ctrl: !isMac },
  "split-vertical": { key: "d", meta: isMac, ctrl: !isMac, shift: true },
  "command-palette": { key: "p", meta: isMac, ctrl: !isMac, shift: true },
  "close-pane": { key: "w", meta: isMac, ctrl: !isMac, shift: true },
  "reopen-tab": { key: "t", meta: isMac, ctrl: !isMac, shift: true },
  "tab-1": { key: "1", meta: isMac, ctrl: !isMac },
  "tab-2": { key: "2", meta: isMac, ctrl: !isMac },
  "tab-3": { key: "3", meta: isMac, ctrl: !isMac },
  "tab-4": { key: "4", meta: isMac, ctrl: !isMac },
  "tab-5": { key: "5", meta: isMac, ctrl: !isMac },
  "tab-6": { key: "6", meta: isMac, ctrl: !isMac },
  "tab-7": { key: "7", meta: isMac, ctrl: !isMac },
  "tab-8": { key: "8", meta: isMac, ctrl: !isMac },
  "tab-9": { key: "9", meta: isMac, ctrl: !isMac },
};

const KEYBINDING_STORAGE_KEY = "rain-keybindings";

let _customBindings: Partial<KeybindingMap> = {};

export function loadKeybindings(): void {
  try {
    const raw = localStorage.getItem(KEYBINDING_STORAGE_KEY);
    if (raw) {
      _customBindings = JSON.parse(raw);
    }
  } catch {
    _customBindings = {};
  }
}

export function saveKeybindings(bindings: Partial<KeybindingMap>): void {
  _customBindings = bindings;
  try {
    localStorage.setItem(KEYBINDING_STORAGE_KEY, JSON.stringify(bindings));
  } catch {
    // ignore
  }
}

export function getKeybinding(action: string): Keybinding {
  return _customBindings[action] ?? DEFAULT_KEYBINDINGS[action] ?? { key: "" };
}

export function getAllKeybindings(): KeybindingMap {
  return { ...DEFAULT_KEYBINDINGS, ..._customBindings };
}

export function matchesKeybinding(e: KeyboardEvent, action: string): boolean {
  const binding = getKeybinding(action);
  if (!binding.key) return false;
  
  const keyMatch = e.key.toLowerCase() === binding.key.toLowerCase();
  const metaMatch = !!binding.meta === e.metaKey;
  const ctrlMatch = !!binding.ctrl === e.ctrlKey;
  const shiftMatch = !!binding.shift === e.shiftKey;
  const altMatch = !!binding.alt === e.altKey;
  
  return keyMatch && metaMatch && ctrlMatch && shiftMatch && altMatch;
}

export function formatKeybinding(binding: Keybinding): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push(isMac ? "Ctrl" : "Ctrl");
  if (binding.meta) parts.push(isMac ? "\u2318" : "Win");
  if (binding.alt) parts.push(isMac ? "\u2325" : "Alt");
  if (binding.shift) parts.push("\u21E7");
  
  // Capitalize the key
  const keyLabel = binding.key.length === 1 ? binding.key.toUpperCase() : binding.key;
  parts.push(keyLabel);
  
  return parts.join(isMac ? "" : "+");
}

// Initialize on load
loadKeybindings();
