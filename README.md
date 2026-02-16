# Rain

A modern, local-first terminal emulator built with Tauri and Rust. No AI, no cloud, no accounts — just a fast, beautiful terminal.

## Features

- **Command blocks** — Per-command output cards with copy, status indicators, and timestamps
- **Shell integration** — Automatic command detection via FinalTerm protocol (zsh, bash, fish)
- **Tabbed interface** — Multiple tabs with rename support (double-click), running command indicators
- **10 built-in themes** — Dark, Light, Nord, Solarized Dark, Dracula, Monokai, Gruvbox, Catppuccin, Tokyo Night, One Dark
- **Custom colors** — Override background, text, accent, and cursor colors per-theme
- **Window transparency** — Adjustable opacity and backdrop blur
- **Settings tab** — Full appearance, terminal, and keyboard shortcut configuration
- **Full ANSI support** — Colors, cursor styles, alternate screen, bracketed paste
- **Fast rendering** — SolidJS fine-grained reactivity, only changed cells trigger DOM updates
- **macOS-native** — System WebView via Tauri (no Electron bloat), overlay titlebar

## Architecture

```
rain/
  src-tauri/            # Rust backend
    src/
      pty/              # PTY management (spawn, read, write, resize)
      terminal/         # Terminal state machine (grid, cursor, modes, VTE)
      render/           # Render frame generation (dirty tracking, styled spans)
      ipc/              # Tauri commands and events
      shell/            # Shell integration (FinalTerm hooks, detection)
    shell-hooks/        # Shell hook scripts (zsh, bash, fish)
  src/                  # SolidJS frontend
    components/         # UI components (Terminal, TabBar, Settings, etc.)
    stores/             # Reactive state (terminal, tabs, config, theme)
    lib/                # Utilities (IPC wrappers, input encoding, font metrics)
    styles/             # CSS with theme variables
```

**Backend**: Rust with `portable-pty` for PTY management and `vte` for escape sequence parsing. Pre-styled render frames are sent to the frontend — no ANSI parsing in JavaScript.

**Frontend**: SolidJS + TypeScript rendered in Tauri's system WebView. Fine-grained signals mean only cells that actually change trigger DOM updates.

**IPC**: Tauri events (backend → frontend) for render frames, Tauri commands (frontend → backend) for input, resize, and session management.

## Prerequisites

- [Rust](https://rustup.rs/) (stable, 1.86+)
- [Node.js](https://nodejs.org/) (v18+)
- macOS 12+ (for Tauri WebView support)

## Getting Started

```bash
# Install dependencies
npm install

# Run in development mode
npm run tauri dev

# Build for production
npm run tauri build
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+T` | New tab |
| `Cmd+W` | Close tab |
| `Cmd+K` | Clear terminal |
| `Cmd+,` | Settings |
| `Cmd+1-9` | Switch to tab |
| `Cmd+Shift+[` | Previous tab |
| `Cmd+Shift+]` | Next tab |
| `Shift+Enter` | New line in input |

## License

MIT
