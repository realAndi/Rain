import { createSignal } from "solid-js";

export type ThemeName =
  | "dark"
  | "light"
  | "nord"
  | "solarized-dark"
  | "dracula"
  | "monokai"
  | "gruvbox"
  | "catppuccin"
  | "tokyo-night"
  | "one-dark";

export const THEME_LIST: { name: ThemeName; label: string; bg: string; accent: string }[] = [
  { name: "dark",           label: "Dark",           bg: "#0e0e0e", accent: "#01c1a2" },
  { name: "light",          label: "Light",          bg: "#f8f7f5", accent: "#0d9373" },
  { name: "nord",           label: "Nord",           bg: "#2e3440", accent: "#88c0d0" },
  { name: "solarized-dark", label: "Solarized Dark", bg: "#002b36", accent: "#2aa198" },
  { name: "dracula",        label: "Dracula",        bg: "#282a36", accent: "#bd93f9" },
  { name: "monokai",        label: "Monokai",        bg: "#272822", accent: "#f92672" },
  { name: "gruvbox",        label: "Gruvbox",        bg: "#282828", accent: "#fabd2f" },
  { name: "catppuccin",     label: "Catppuccin",     bg: "#1e1e2e", accent: "#cba6f7" },
  { name: "tokyo-night",    label: "Tokyo Night",    bg: "#1a1b26", accent: "#7aa2f7" },
  { name: "one-dark",       label: "One Dark",       bg: "#282c34", accent: "#61afef" },
];

const THEME_STORAGE_KEY = "rain-theme";

function loadTheme(): ThemeName {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved && THEME_LIST.some((t) => t.name === saved)) {
      return saved as ThemeName;
    }
  } catch {
    // ignore
  }
  return "dark";
}

const [currentTheme, setCurrentTheme] = createSignal<ThemeName>(loadTheme());

export function useTheme() {
  return {
    theme: currentTheme,
    setTheme: (name: ThemeName) => {
      setCurrentTheme(name);
      document.documentElement.setAttribute("data-theme", name);
      try {
        localStorage.setItem(THEME_STORAGE_KEY, name);
      } catch {
        // ignore
      }
    },
    toggleTheme: () => {
      const next = currentTheme() === "dark" ? "light" : "dark";
      setCurrentTheme(next);
      document.documentElement.setAttribute("data-theme", next);
      try {
        localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // ignore
      }
    },
  };
}

// Initialize theme on startup (applies saved theme to DOM)
export function initTheme() {
  const saved = loadTheme();
  setCurrentTheme(saved);
  document.documentElement.setAttribute("data-theme", saved);
}
