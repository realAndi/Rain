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

// Per-theme ANSI 16-color palettes
export const THEME_ANSI_PALETTES: Record<ThemeName, string[]> = {
  "dark": [
    "#0e0e0e", "#f85149", "#56d364", "#e3b341", "#58a6ff", "#bc8cff", "#39d2c0", "#c9d1d9",
    "#484f58", "#ff7b72", "#7ee787", "#f0c85c", "#79c0ff", "#d2a8ff", "#56d4cf", "#f0f6fc",
  ],
  "light": [
    "#e7e7e7", "#d32f2f", "#388e3c", "#f57c00", "#1976d2", "#7b1fa2", "#0097a7", "#424242",
    "#9e9e9e", "#ef5350", "#66bb6a", "#ffa726", "#42a5f5", "#ab47bc", "#26c6da", "#212121",
  ],
  "nord": [
    "#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0",
    "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4",
  ],
  "solarized-dark": [
    "#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5",
    "#586e75", "#cb4b16", "#859900", "#b58900", "#268bd2", "#6c71c4", "#2aa198", "#fdf6e3",
  ],
  "dracula": [
    "#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2",
    "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff",
  ],
  "monokai": [
    "#272822", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f8f8f2",
    "#75715e", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f9f8f5",
  ],
  "gruvbox": [
    "#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984",
    "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2",
  ],
  "catppuccin": [
    "#1e1e2e", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#cba6f7", "#94e2d5", "#cdd6f4",
    "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#cba6f7", "#94e2d5", "#a6adc8",
  ],
  "tokyo-night": [
    "#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6",
    "#414868", "#ff9e9e", "#b9f27c", "#ff9e64", "#82aaff", "#d4b0ff", "#a9e1ff", "#c0caf5",
  ],
  "one-dark": [
    "#282c34", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf",
    "#5c6370", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#ffffff",
  ],
};

// Initialize theme on startup (applies saved theme to DOM)
export function initTheme() {
  const saved = loadTheme();
  setCurrentTheme(saved);
  document.documentElement.setAttribute("data-theme", saved);
}
