import { Component, For, Show, onMount, onCleanup, createSignal, createEffect, createMemo, on } from "solid-js";
import { produce } from "solid-js/store";
import { appVersion } from "../lib/version";
import type { TerminalStore } from "../stores/terminal";
import type { CommandSnapshot, RenderedLine, SearchMatch } from "../lib/types";
import {
  createSelectionState,
  normalizeRange,
  extractSelectedText,
  type SelectionRange,
  type SelectionState,
} from "../lib/selection";
import { useConfig } from "../stores/config";
import { createInputBuffer } from "../stores/inputBuffer";
import { writeInput, resizeTerminal, requestFullRedraw, getHostname as fetchHostname } from "../lib/ipc";
import { keyEventToBytes } from "../lib/input";
import { measureFontMetrics, calculateTerminalSize, invalidateFontMetrics, type FontMetrics } from "../lib/font";
import { collectLinesForRange } from "../lib/terminal-output";
import { TerminalLine } from "./TerminalLine";
import { Cursor } from "./Cursor";
import { IconFolder, IconCopy, IconCommand, IconArrowDown } from "./icons";

// Build a complete grid of `rows` lines from a sparse buffer, filling gaps with empty lines
function buildFullGrid(buffer: RenderedLine[], rows: number): RenderedLine[] {
  const byIndex = new Map<number, RenderedLine>();
  for (const line of buffer) byIndex.set(line.index, line);
  const result: RenderedLine[] = [];
  for (let i = 0; i < rows; i++) {
    result.push(byIndex.get(i) ?? { index: i, spans: [] });
  }
  return result;
}

// Shared cwd formatting utilities
function formatCwdSimplified(cwd: string): string {
  if (!cwd) return "~";
  const home = "/Users/";
  if (cwd.startsWith(home)) {
    const rest = cwd.substring(home.length);
    const slashIdx = rest.indexOf("/");
    if (slashIdx >= 0) return "~" + rest.substring(slashIdx);
    return "~";
  }
  return cwd;
}

function extractUsername(cwd: string): string {
  if (!cwd) return "user";
  const home = "/Users/";
  if (cwd.startsWith(home)) {
    const rest = cwd.substring(home.length);
    const slashIdx = rest.indexOf("/");
    return slashIdx >= 0 ? rest.substring(0, slashIdx) : rest;
  }
  return "user";
}

// Real hostname fetched from the OS via Tauri IPC
let _cachedHostname = "localhost";

// Fetch hostname at module load time
fetchHostname().then((h) => { _cachedHostname = h; }).catch(() => {});

function getHostname(): string {
  return _cachedHostname;
}

// For default prompt: show just the last directory name, or ~ for home
function formatCwdDefault(cwd: string): string {
  if (!cwd) return "~";
  const home = "/Users/";
  if (cwd.startsWith(home)) {
    const rest = cwd.substring(home.length);
    const slashIdx = rest.indexOf("/");
    if (slashIdx < 0) return "~"; // exactly at home
    const afterHome = rest.substring(slashIdx + 1);
    if (!afterHome) return "~";
    // Return just the last path segment
    const lastSlash = afterHome.lastIndexOf("/");
    return lastSlash >= 0 ? afterHome.substring(lastSlash + 1) : afterHome;
  }
  // Not under /Users, show last segment
  const lastSlash = cwd.lastIndexOf("/");
  if (lastSlash >= 0 && lastSlash < cwd.length - 1) return cwd.substring(lastSlash + 1);
  return cwd;
}

// Render a completed command block as a card
const CommandBlock: Component<{
  snapshot: CommandSnapshot;
  charWidth: number;
  promptStyle: "default" | "simplified" | "blank";
}> = (props) => {
  const [copied, setCopied] = createSignal<"command" | "output" | null>(null);

  const displayCwd = () => {
    const cwd = props.snapshot.cwd;
    if (props.promptStyle === "blank") return "";
    if (props.promptStyle === "default") return cwd || "~";
    return formatCwdSimplified(cwd);
  };

  const duration = () => {
    const end = props.snapshot.endTime;
    if (!end) return null;
    const ms = end - props.snapshot.timestamp;
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(3)}s`;
  };

  const timeStr = () => {
    const d = new Date(props.snapshot.timestamp);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  const copyCommand = (e: MouseEvent) => {
    e.stopPropagation();
    if (props.snapshot.command) {
      navigator.clipboard.writeText(props.snapshot.command).catch(console.error);
      setCopied("command");
      setTimeout(() => setCopied(null), 1500);
    }
  };

  const copyOutput = (e: MouseEvent) => {
    e.stopPropagation();
    const text = props.snapshot.lines
      .map((line) =>
        line.spans
          .map((s) => s.text)
          .join("")
          .trimEnd(),
      )
      .join("\n");
    navigator.clipboard.writeText(text).catch(console.error);
    setCopied("output");
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div
      class="command-block"
      classList={{ "block-failed": props.snapshot.failed }}
    >
      {/* Floating action toolbar */}
      <div class="block-actions">
        <Show when={props.snapshot.command}>
          <button
            class="block-action-btn"
            onClick={copyCommand}
            title="Copy command"
          >
            <IconCommand size={12} />
          </button>
        </Show>
        <Show when={props.snapshot.lines.length > 0}>
          <button
            class="block-action-btn"
            onClick={copyOutput}
            title="Copy output"
          >
            <IconCopy size={12} />
          </button>
        </Show>
      </div>

      <div class="block-header">
        <span class="block-header-icon"><IconFolder size={11} /></span>
        <span class="block-cwd">{displayCwd()}</span>
        <Show when={duration()}>
          <span class="block-duration">{duration()}</span>
        </Show>
        <span class="block-timestamp">{timeStr()}</span>
      </div>

      <Show when={props.snapshot.command}>
        <div class="block-command">
          <span class="block-prompt-char">$</span>
          {props.snapshot.command}
        </div>
      </Show>

      <Show when={props.snapshot.lines.length > 0}>
        <div class="block-output">
          <For each={props.snapshot.lines}>
            {(line) => <TerminalLine line={line} charWidth={props.charWidth} />}
          </For>
        </div>
      </Show>

      {/* Footer for completed blocks with exit info */}
      <Show when={props.snapshot.endTime !== null && props.snapshot.endTime !== undefined}>
        <div class="block-footer">
          <span class={`block-exit-code ${props.snapshot.failed ? "exit-error" : "exit-success"}`}>
            {props.snapshot.failed ? "failed" : "ok"}
          </span>
          <Show when={duration()}>
            <span class="block-duration">{duration()}</span>
          </Show>
          <button class="block-action" onClick={copyOutput}>
            <IconCopy size={11} />
            {copied() === "output" ? "copied!" : "copy"}
          </button>
        </div>
      </Show>
    </div>
  );
};

// Traditional-style block: renders a snapshot as continuous lines without card chrome
const TraditionalBlock: Component<{
  snapshot: CommandSnapshot;
  charWidth: number;
  promptStyle: "default" | "simplified" | "blank";
}> = (props) => {
  const displayPrompt = () => {
    const cwd = props.snapshot.cwd;
    if (props.promptStyle === "blank") return null;
    if (props.promptStyle === "default") {
      const user = extractUsername(cwd);
      const host = getHostname();
      const dirName = formatCwdDefault(cwd);
      return `${user}@${host} ${dirName}`;
    }
    return formatCwdSimplified(cwd);
  };

  const promptChar = () => {
    if (props.promptStyle === "blank") return "";
    if (props.promptStyle === "default") return "%";
    return "$";
  };

  return (
    <div class="traditional-block">
      <Show when={props.snapshot.command}>
        <div class="term-line traditional-prompt-line">
          <Show when={displayPrompt()}>
            <span class="traditional-prompt-text">{displayPrompt()}</span>
            <span class="traditional-prompt-char"> {promptChar()} </span>
          </Show>
          <span class="traditional-command-text">{props.snapshot.command}</span>
        </div>
      </Show>
      <Show when={props.snapshot.lines.length > 0}>
        <For each={props.snapshot.lines}>
          {(line) => <TerminalLine line={line} charWidth={props.charWidth} />}
        </For>
      </Show>
    </div>
  );
};

// Welcome screen for empty terminals
const WelcomeState: Component = () => {
  return (
    <div class="welcome-state">
      <div class="welcome-title">Rain</div>
      <Show when={appVersion()}><div class="welcome-version">v{appVersion()}</div></Show>
      <pre class="welcome-art">{`                                                   
                  #                  
                 ###                 
               ######               
              #########              
             ###########             
            ##############            
          #################          
         ###################         
        #####################        
       ###   #################       
      #######   ###############      
      ########   ##############      
      #####   #################      
      ############        #####      
       #######################       
        #####################        
         ###################         
           ###############           
               #######               
                                     `}</pre>
      <div class="welcome-shortcuts">
        <div class="welcome-shortcut">
          <span class="welcome-key">Cmd+T</span>
          <span>New tab</span>
        </div>
        <div class="welcome-shortcut">
          <span class="welcome-key">Cmd+K</span>
          <span>Clear</span>
        </div>
        <div class="welcome-shortcut">
          <span class="welcome-key">Cmd+,</span>
          <span>Settings</span>
        </div>
      </div>
    </div>
  );
};

// Search bar for Cmd+F terminal search
const SearchBar: Component<{
  query: string;
  matchCount: number;
  currentIndex: number;
  onQueryChange: (q: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}> = (props) => {
  let inputRef!: HTMLInputElement;

  onMount(() => {
    inputRef?.focus();
  });

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        props.onPrev();
      } else {
        props.onNext();
      }
    }
  };

  return (
    <div class="search-bar">
      <input
        ref={inputRef}
        type="text"
        class="search-input"
        placeholder="Search..."
        value={props.query}
        onInput={(e) => props.onQueryChange(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
      />
      <span class="search-count">
        {props.matchCount > 0 ? `${props.currentIndex + 1}/${props.matchCount}` : "no matches"}
      </span>
      <button class="search-btn" onClick={props.onPrev} title="Previous (Shift+Enter)">&#x25B2;</button>
      <button class="search-btn" onClick={props.onNext} title="Next (Enter)">&#x25BC;</button>
      <button class="search-btn search-close" onClick={props.onClose} title="Close (Esc)">&times;</button>
    </div>
  );
};

export const Terminal: Component<{ store: TerminalStore; active: boolean; onOpenSettings?: () => void }> = (props) => {
  let containerRef!: HTMLDivElement;
  let scrollRef!: HTMLDivElement;
  const { config } = useConfig();
  const inputBuffer = createInputBuffer();
  const [metrics, setMetrics] = createSignal<FontMetrics | null>(null);
  const [isScrolledUp, setIsScrolledUp] = createSignal(false);
  const [containerHeight, setContainerHeight] = createSignal(600);
  const [waitingForTab, setWaitingForTab] = createSignal(false);

  // Selection state for text selection
  const [selection, setSelection] = createSignal<SelectionState>(createSelectionState());

  // Inline images from OSC 1337
  const [inlineImages, setInlineImages] = createSignal<Array<{
    id: string;
    dataUri: string;
    width: number;
    height: number;
    row: number;
    col: number;
  }>>([]);

  function isClearCommand(command: string): boolean {
    const trimmed = command.trim();
    if (!trimmed) return false;
    // Treat `clear` and common flag forms (`clear -x`) as history reset commands.
    return /^clear(\s+-[A-Za-z0-9-]+)*\s*$/.test(trimmed);
  }

  onMount(() => {
    const cfg = config();
    const m = measureFontMetrics(cfg.fontFamily, cfg.fontSize, cfg.lineHeight, cfg.letterSpacing);
    setMetrics(m);

    containerRef.focus();

    // Horizontal padding on terminal-scroll (12px each side)
    const scrollPadding = 24;
    const MIN_STABLE_WIDTH_PX = 120;
    const MIN_STABLE_HEIGHT_PX = 72;
    const MIN_ALT_ROWS = 4;
    const MIN_ALT_COLS = 20;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingRows: number | null = null;
    let pendingCols: number | null = null;
    let resizeInFlight = false;
    let queuedResize: { rows: number; cols: number } | null = null;
    let lastIssuedRows = props.store.state.rows;
    let lastIssuedCols = props.store.state.cols;
    let initialMeasureAttempts = 0;
    const MAX_INITIAL_ATTEMPTS = 20;

    function dispatchResize(sid: string, rows: number, cols: number) {
      if (resizeInFlight) {
        queuedResize = { rows, cols };
        return;
      }

      resizeInFlight = true;

      resizeTerminal(sid, rows, cols)
        .catch(console.error)
        .finally(() => {
          resizeInFlight = false;
          if (!queuedResize) return;
          const next = queuedResize;
          queuedResize = null;
          if (props.store.state.sessionId === sid && (next.rows !== rows || next.cols !== cols)) {
            dispatchResize(sid, next.rows, next.cols);
          }
        });
    }

    function measure() {
      const met = metrics();
      if (!met) return;
      const containerWidth = containerRef.clientWidth - scrollPadding;
      const containerHeightPx = containerRef.clientHeight;
      setContainerHeight(containerHeightPx);

      // Ignore transient zero/tiny layout snapshots during resize transitions.
      if (containerWidth < MIN_STABLE_WIDTH_PX || containerHeightPx < MIN_STABLE_HEIGHT_PX) {
        // On startup the first paint can report tiny dimensions.
        // Keep polling aggressively until layout settles (capped retries).
        if (initialMeasureAttempts < MAX_INITIAL_ATTEMPTS || props.active) {
          initialMeasureAttempts++;
          if (resizeTimer !== null) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(measure, 16);
        }
        return;
      }

      const measured = calculateTerminalSize(containerWidth, containerHeightPx, met);
      const rows = props.store.state.altScreen ? Math.max(measured.rows, MIN_ALT_ROWS) : measured.rows;
      const cols = props.store.state.altScreen ? Math.max(measured.cols, MIN_ALT_COLS) : measured.cols;

      if (rows === props.store.state.rows && cols === props.store.state.cols) {
        lastIssuedRows = rows;
        lastIssuedCols = cols;
        pendingRows = null;
        pendingCols = null;
        return;
      }

      // Require two consecutive identical measurements before issuing resize.
      if (pendingRows !== rows || pendingCols !== cols) {
        pendingRows = rows;
        pendingCols = cols;
        requestAnimationFrame(measure);
        return;
      }

      pendingRows = null;
      pendingCols = null;

      if (rows === lastIssuedRows && cols === lastIssuedCols) {
        return;
      }

      lastIssuedRows = rows;
      lastIssuedCols = cols;

      const sid = props.store.state.sessionId;
      if (sid) {
        dispatchResize(sid, rows, cols);
      }
    }

    // Debounced version for ResizeObserver to avoid flooding the backend
    // with rapid resize events during window drag
    function debouncedMeasure() {
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(measure, 30);
    }

    // Defer initial measurement so flex layout is settled
    requestAnimationFrame(measure);

    // ResizeObserver handles subsequent resizes + catches initial layout
    const observer = new ResizeObserver(debouncedMeasure);
    observer.observe(containerRef);

    // Re-measure immediately when this terminal becomes active.
    createEffect(() => {
      if (!props.active) return;
      requestAnimationFrame(measure);
    });

    onCleanup(() => {
      observer.disconnect();
      if (resizeTimer !== null) clearTimeout(resizeTimer);
    });
  });

  // Re-measure font metrics when font settings change
  createEffect(() => {
    const cfg = config();
    const family = cfg.fontFamily;
    const size = cfg.fontSize;
    const lh = cfg.lineHeight;
    const ls = cfg.letterSpacing;
    invalidateFontMetrics();
    const m = measureFontMetrics(family, size, lh, ls);
    setMetrics(m);
  });

  // Keep terminal focused when active and not in alt screen
  createEffect(() => {
    if (props.active && !props.store.state.altScreen && containerRef) {
      requestAnimationFrame(() => containerRef.focus());
    }
  });

  // Startup redraw should track resize epochs so we always redraw for the
  // current epoch, not just the first connected state.
  let redrawSessionId: string | null = null;
  let lastRedrawEpoch = -1;
  createEffect(() => {
    const sid = props.store.state.sessionId;
    const connected = props.store.state.connected;
    const epoch = props.store.state.currentResizeEpoch;
    const active = props.active;

    if (sid !== redrawSessionId) {
      redrawSessionId = sid ?? null;
      lastRedrawEpoch = -1;
    }

    if (!sid || !connected || !active) return;
    if (epoch <= lastRedrawEpoch) return;

    lastRedrawEpoch = epoch;
    requestFullRedraw(sid).catch(console.error);
    requestAnimationFrame(() => containerRef?.focus());
  });

  // Track where the prompt starts so multiline input stays visible.
  const [promptRow, setPromptRow] = createSignal(0);

  createEffect(on(
    () => props.store.state.snapshots.length,
    () => {
      setPromptRow(props.store.state.cursor.row);
      // Clear the local buffer when a command completes (new prompt)
      inputBuffer.clear();
    }
  ));

  createEffect(on(
    () => props.store.state.pendingBlock,
    (pending) => {
      if (pending) {
        setPromptRow(props.store.state.cursor.row);
      }
    }
  ));

  // Tab completion: watch for render frames after tab press.
  // Compare the PTY cursor line against what we sent to extract the completion.
  const [tabSentText, setTabSentText] = createSignal("");

  createEffect(on(
    () => props.store.state.fallbackLines,
    () => {
      if (!waitingForTab()) return;
      setWaitingForTab(false);

      const cursorRow = props.store.state.cursor.row;
      const line = props.store.state.fallbackLines.find((l) => l.index === cursorRow);
      if (!line) return;

      const fullLine = line.spans.map((s) => s.text).join("").trimEnd();
      const sent = tabSentText();

      // Find our sent text within the line to extract the completed version.
      // The shell may have extended it (completion) or left it unchanged.
      const sentIdx = fullLine.indexOf(sent);
      if (sentIdx >= 0) {
        // Everything from where our text started to end of line is the completed input
        const completed = fullLine.slice(sentIdx).trimEnd();
        if (completed !== sent && completed.length > 0) {
          inputBuffer.setText(completed);
        }
        // If unchanged, multiple completions may have been printed below.
        // Don't touch the buffer, let the output show in history.
      }
    }
  ));

  // Track scroll position for FAB
  const handleScroll = () => {
    if (!scrollRef) return;
    const threshold = 50;
    const isAtBottom = scrollRef.scrollHeight - scrollRef.scrollTop - scrollRef.clientHeight < threshold;
    setIsScrolledUp(!isAtBottom);
  };

  const scrollToBottom = () => {
    if (scrollRef) {
      scrollRef.scrollTo({ top: scrollRef.scrollHeight, behavior: "smooth" });
    }
    props.store.scrollToBottom();
  };

  // Wheel handler for grid-level scrollback and alt screen forwarding
  const handleWheel = (e: WheelEvent) => {
    // Alt screen: forward scroll as arrow keys to PTY
    if (props.store.state.altScreen) {
      e.preventDefault();
      const sid = props.store.state.sessionId;
      if (!sid) return;
      const lines = Math.max(1, Math.round(Math.abs(e.deltaY) / 20));
      const arrow = e.deltaY < 0 ? "\x1b[A" : "\x1b[B";
      const seq = arrow.repeat(lines);
      const encoder = new TextEncoder();
      writeInput(sid, Array.from(encoder.encode(seq))).catch(console.error);
      return;
    }

    // Active command or traditional raw output: grid-level scrollback
    if (props.store.state.activeBlock || !props.store.state.shellIntegrationActive) {
      const lines = Math.max(1, Math.round(Math.abs(e.deltaY) / 20));
      if (e.deltaY < 0) {
        props.store.scrollUp(lines);
      } else {
        props.store.scrollDown(lines);
      }
    }
  };

  // Mouse coordinate conversion from pixels to grid row/col
  function pixelToGrid(e: MouseEvent, container: HTMLElement): { row: number; col: number } {
    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const col = Math.floor(x / charWidth());
    const row = Math.floor(y / lineHeight());
    return { row: Math.max(0, row), col: Math.max(0, col) };
  }

  // Encode mouse event as escape sequence for PTY
  function encodeMouseEvent(button: number, col: number, row: number, press: boolean): number[] {
    // 1-based coordinates for mouse reporting
    const c = col + 1;
    const r = row + 1;

    if (props.store.state.sgrMouse) {
      // SGR mode (1006): \x1b[<button;col;rowM or \x1b[<button;col;rowm
      const suffix = press ? "M" : "m";
      const seq = `\x1b[<${button};${c};${r}${suffix}`;
      return Array.from(new TextEncoder().encode(seq));
    } else {
      // Normal mode (1000): \x1b[M + encoded bytes
      if (press) {
        const cb = button + 32;
        const cx = Math.min(c + 32, 255);
        const cy = Math.min(r + 32, 255);
        return [0x1b, 0x5b, 0x4d, cb, cx, cy];
      }
      // Release in normal mode
      const cb = 3 + 32; // release
      const cx = Math.min(c + 32, 255);
      const cy = Math.min(r + 32, 255);
      return [0x1b, 0x5b, 0x4d, cb, cx, cy];
    }
  }

  // Mouse button mapping
  function mouseButtonId(e: MouseEvent): number {
    switch (e.button) {
      case 0: return 0; // left
      case 1: return 1; // middle
      case 2: return 2; // right
      default: return 0;
    }
  }

  // Track if mouse button is held (for motion tracking)
  let mouseButtonDown = false;
  let lastMouseButton = 0;

  // Mouse event handlers for PTY mouse reporting + text selection
  const handleTermMouseDown = (e: MouseEvent) => {
    const viewport = containerRef?.querySelector(".terminal-content, .alt-screen, .active-viewport, .terminal-history") as HTMLElement;
    if (!viewport) return;
    const { row, col } = pixelToGrid(e, viewport);

    // Mouse tracking mode: send to PTY (unless Shift is held for selection override)
    if (props.store.state.mouseTracking && !e.shiftKey) {
      e.preventDefault();
      containerRef?.focus();
      mouseButtonDown = true;
      lastMouseButton = mouseButtonId(e);
      const sid = props.store.state.sessionId;
      if (sid) {
        writeInput(sid, encodeMouseEvent(lastMouseButton, col, row, true)).catch(console.error);
      }
      return;
    }

    // Text selection
    e.preventDefault();
    containerRef?.focus();
    mouseButtonDown = true;

    // Double-click: select word
    if (e.detail === 2) {
      selectWord(row, col);
      return;
    }

    // Triple-click: select line
    if (e.detail === 3) {
      selectLine(row);
      return;
    }

    setSelection({
      active: false,
      range: { start: { row, col }, end: { row, col } },
      selecting: true,
    });
  };

  const handleTermMouseMove = (e: MouseEvent) => {
    if (!mouseButtonDown) return;
    const viewport = containerRef?.querySelector(".terminal-content, .alt-screen, .active-viewport, .terminal-history") as HTMLElement;
    if (!viewport) return;
    const { row, col } = pixelToGrid(e, viewport);

    // Mouse motion tracking
    if (props.store.state.mouseMotion && props.store.state.mouseTracking && !e.shiftKey) {
      const sid = props.store.state.sessionId;
      if (sid) {
        const button = lastMouseButton + 32; // motion flag
        writeInput(sid, encodeMouseEvent(button, col, row, true)).catch(console.error);
      }
      return;
    }

    // Drag selection
    const sel = selection();
    if (sel.selecting && sel.range) {
      setSelection({
        ...sel,
        range: { start: sel.range.start, end: { row, col } },
      });
    }
  };

  const handleTermMouseUp = (e: MouseEvent) => {
    const viewport = containerRef?.querySelector(".terminal-content, .alt-screen, .active-viewport, .terminal-history") as HTMLElement;
    if (!viewport) return;
    const { row, col } = pixelToGrid(e, viewport);

    // Mouse tracking: send release
    if (props.store.state.mouseTracking && !e.shiftKey) {
      mouseButtonDown = false;
      const sid = props.store.state.sessionId;
      if (sid) {
        writeInput(sid, encodeMouseEvent(lastMouseButton, col, row, false)).catch(console.error);
      }
      return;
    }

    mouseButtonDown = false;
    const sel = selection();
    if (sel.selecting && sel.range) {
      const norm = normalizeRange(sel.range);
      const hasSelection = norm.start.row !== norm.end.row || norm.start.col !== norm.end.col;
      setSelection({
        active: hasSelection,
        range: hasSelection ? sel.range : null,
        selecting: false,
      });
    }
  };

  function selectWord(row: number, col: number) {
    // Get the line text and find word boundaries
    const lines = getAllDisplayLines();
    const line = lines.find((l) => l.index === row);
    if (!line) return;
    const text = line.spans.map((s) => s.text).join("");
    if (col >= text.length) return;

    let start = col;
    let end = col;
    const wordChars = /[a-zA-Z0-9_\-./~]/;
    while (start > 0 && wordChars.test(text[start - 1])) start--;
    while (end < text.length - 1 && wordChars.test(text[end + 1])) end++;

    setSelection({
      active: true,
      range: { start: { row, col: start }, end: { row, col: end } },
      selecting: false,
    });
  }

  function selectLine(row: number) {
    const lines = getAllDisplayLines();
    const line = lines.find((l) => l.index === row);
    if (!line) return;
    const text = line.spans.map((s) => s.text).join("");
    setSelection({
      active: true,
      range: { start: { row, col: 0 }, end: { row, col: Math.max(0, text.length - 1) } },
      selecting: false,
    });
  }

  function clearSelection() {
    setSelection(createSelectionState());
  }

  // Get all lines currently displayed (for selection text extraction)
  function getAllDisplayLines(): RenderedLine[] {
    if (props.store.state.altScreen) {
      return props.store.state.altScreenLines;
    }
    if (props.store.state.activeBlock) {
      return primaryScreenLines();
    }
    // Combine all visible lines
    const all: RenderedLine[] = [];
    for (const snap of props.store.state.snapshots) {
      all.push(...snap.lines);
    }
    all.push(...(fallbackOutputLines() ?? []));
    return all;
  }

  // Focus/blur handlers for focus event reporting
  const handleFocus = () => {
    if (props.store.state.focusEvents) {
      const sid = props.store.state.sessionId;
      if (sid) {
        writeInput(sid, [0x1b, 0x5b, 0x49]).catch(console.error); // \x1b[I
      }
    }
  };

  const handleBlur = () => {
    if (props.store.state.focusEvents) {
      const sid = props.store.state.sessionId;
      if (sid) {
        writeInput(sid, [0x1b, 0x5b, 0x4f]).catch(console.error); // \x1b[O
      }
    }
  };

  // Search functions
  function openSearch() {
    props.store.setState(produce((s) => {
      s.searchOpen = true;
    }));
  }

  function closeSearch() {
    props.store.setState(produce((s) => {
      s.searchOpen = false;
      s.searchQuery = "";
      s.searchMatches = [];
      s.searchCurrentIndex = -1;
    }));
  }

  function updateSearchQuery(query: string) {
    props.store.setState(produce((s) => {
      s.searchQuery = query;
      if (!query) {
        s.searchMatches = [];
        s.searchCurrentIndex = -1;
        return;
      }

      const matches: SearchMatch[] = [];
      const lowerQuery = query.toLowerCase();
      const lines = getAllDisplayLines();
      for (const line of lines) {
        const text = line.spans.map((sp) => sp.text).join("").toLowerCase();
        let idx = 0;
        while ((idx = text.indexOf(lowerQuery, idx)) !== -1) {
          matches.push({
            globalRow: line.index,
            startCol: idx,
            endCol: idx + query.length - 1,
          });
          idx += 1;
        }
      }
      s.searchMatches = matches;
      s.searchCurrentIndex = matches.length > 0 ? 0 : -1;
    }));
  }

  function searchNext() {
    props.store.setState(produce((s) => {
      if (s.searchMatches.length === 0) return;
      s.searchCurrentIndex = (s.searchCurrentIndex + 1) % s.searchMatches.length;
    }));
  }

  function searchPrev() {
    props.store.setState(produce((s) => {
      if (s.searchMatches.length === 0) return;
      s.searchCurrentIndex = (s.searchCurrentIndex - 1 + s.searchMatches.length) % s.searchMatches.length;
    }));
  }

  // Handle inline image events
  createEffect(on(
    () => props.store.state.lastFrameSeq,
    () => {
      // Check for image events - we handle them here instead of in the store
      // since they need DOM rendering
    },
  ));

  // PTY input lines (used for alt screen fallback and active output)
  const inputLines = createMemo(() => {
    const cursorRow = props.store.state.cursor.row;
    const pr = promptRow();
    const startRow = Math.min(pr, cursorRow);
    const result: import("../lib/types").RenderedLine[] = [];
    const visibleMap = new Map<number, import("../lib/types").RenderedLine>();
    for (const line of props.store.state.fallbackLines) {
      visibleMap.set(line.index, line);
    }
    for (let row = startRow; row <= cursorRow; row++) {
      const line = visibleMap.get(row);
      if (line) result.push({ index: result.length, spans: [...line.spans] });
      else result.push({ index: result.length, spans: [] });
    }
    return result;
  });

  const inputCursor = createMemo(() => {
    const c = props.store.state.cursor;
    const startRow = Math.min(promptRow(), c.row);
    return { ...c, row: c.row - startRow };
  });

  createEffect(() => {
    const _ = inputLines().length;
    requestAnimationFrame(() => {
      const inputContent = containerRef?.querySelector(".input-content");
      if (inputContent) {
        inputContent.scrollTop = inputContent.scrollHeight;
      }
    });
  });

  // TUI render mode helpers (must be above memos that reference them)
  const isTraditional = () => config().terminalStyle === "traditional";
  const promptStyle = () => config().promptStyle;
  const fullscreenTui = () => props.store.state.altScreen && config().clearHistoryForTuis;
  const inlineTui = () => props.store.state.altScreen && !config().clearHistoryForTuis;
  const keepHistoryDuringPrimaryActive = () =>
    !!props.store.state.activeBlock &&
    !props.store.state.altScreen;

  const activeOutputLines = createMemo(() => {
    const active = props.store.state.activeBlock;
    if (!active) return [];
    const endGlobalExclusive =
      props.store.state.visibleBaseGlobal + props.store.state.cursor.row + 1;
    if (endGlobalExclusive <= active.outputStart) return [];
    return collectLinesForRange(
      props.store.state.scrollbackLines,
      props.store.state.visibleLinesByGlobal,
      props.store.state.visibleBaseGlobal,
      active.outputStart,
      endGlobalExclusive,
    );
  });

  const fallbackOutputLines = createMemo(() => {
    if (props.store.state.shellIntegrationActive) return [];

    // During inline TUI, use the preserved non-alt anchors so history
    // lookups reference the correct global rows instead of alt-screen 0.
    const base = inlineTui()
      ? props.store.state.lastNonAltVisibleBaseGlobal
      : props.store.state.visibleBaseGlobal;
    const cursorRow = inlineTui()
      ? props.store.state.lastNonAltCursorRow
      : props.store.state.cursor.row;

    const endGlobalExclusive = base + cursorRow + 1;
    if (endGlobalExclusive <= 0) return [];
    return collectLinesForRange(
      props.store.state.scrollbackLines,
      props.store.state.visibleLinesByGlobal,
      base,
      0,
      endGlobalExclusive,
    );
  });

  const hasRenderableFallbackContent = createMemo(() => {
    const lines = fallbackOutputLines();
    if (!lines) return false;
    return lines.some((line) =>
      line.spans.some((span) => span.text.trim().length > 0)
    );
  });

  const activeSnapshot = createMemo<CommandSnapshot | null>(() => {
    const active = props.store.state.activeBlock;
    if (!active) return null;
    const lines = activeOutputLines();
    if (!active.command && lines.length === 0) return null;
    // When running on the primary screen, output is rendered by the
    // primaryScreenLines() viewport — don't duplicate it in the block.
    const isPrimaryScreen = !props.store.state.altScreen;
    return {
      id: `active-${active.id}`,
      command: active.command,
      lines: isPrimaryScreen ? [] : lines,
      timestamp: active.startTime || Date.now(),
      endTime: null,
      cwd: active.cwd || props.store.state.cwd,
      failed: false,
    };
  });

  // For active commands that remain on the primary screen (no alt-screen),
  // render the terminal grid starting from the command's outputStart row.
  // Rows before outputStart contain echoed command text already shown by
  // the TraditionalBlock/CommandBlock prompt, so we skip them.
  const primaryScreenLines = createMemo<RenderedLine[]>(() => {
    const active = props.store.state.activeBlock;
    if (!active) return [];

    const rows = Math.max(1, props.store.state.rows || 1);
    const visibleBase = props.store.state.visibleBaseGlobal;
    // Skip rows before outputStart — those contain the echoed command
    // text that the prompt block already renders.
    const startRow = Math.max(0, active.outputStart - visibleBase);

    const lines: RenderedLine[] = [];
    for (let i = startRow; i < rows; i++) {
      const globalRow = visibleBase + i;
      const visibleLine = props.store.state.visibleLinesByGlobal[globalRow];
      if (visibleLine) {
        lines.push({ index: i, spans: visibleLine.spans });
        continue;
      }

      const fallbackLine = props.store.state.fallbackLines.find((line) => line.index === i);
      if (fallbackLine) {
        lines.push({ index: i, spans: fallbackLine.spans });
      } else {
        lines.push({ index: i, spans: [] });
      }
    }
    return lines;
  });

  const primaryScreenCursor = createMemo(() => {
    return props.store.state.cursor;
  });

  const isEmpty = createMemo(() => {
    return (
      props.store.state.snapshots.length === 0 &&
      !activeSnapshot() &&
      !hasRenderableFallbackContent()
    );
  });

  // Auto-scroll to bottom (skip while keeping history visible for TUIs)
  createEffect(() => {
    const _ = (activeOutputLines() ?? []).length;
    const __ = props.store.state.snapshots.length;
    const ___ = (fallbackOutputLines() ?? []).length;
    if (inlineTui() || keepHistoryDuringPrimaryActive()) return;
    if (scrollRef) {
      requestAnimationFrame(() => {
        scrollRef.scrollTop = scrollRef.scrollHeight;
      });
    }
  });

  // Send the full command text to PTY
  function sendToPty(text: string) {
    const sid = props.store.state.sessionId;
    if (!sid) return;
    const encoder = new TextEncoder();
    const bytes = encoder.encode(text + "\r");
    writeInput(sid, Array.from(bytes)).catch(console.error);
  }

  // Send raw bytes to PTY (for alt screen mode)
  function sendRawBytes(e: KeyboardEvent) {
    const sid = props.store.state.sessionId;
    if (!sid) return;
    const cfg = config();
    const bytes = keyEventToBytes(e, cfg.optionAsMeta);
    if (bytes.length > 0) {
      writeInput(sid, Array.from(bytes)).catch(console.error);
    }
  }

  // Send tab to PTY for shell completion
  function sendTab() {
    const sid = props.store.state.sessionId;
    if (!sid) return;
    const currentText = inputBuffer.state().text;
    setTabSentText(currentText);
    const encoder = new TextEncoder();
    // Send Ctrl+U (clear line), then the buffer text, then tab
    const clearLine = new Uint8Array([0x15]); // Ctrl+U
    const bufferBytes = encoder.encode(currentText);
    const tabByte = new Uint8Array([0x09]);
    const data = new Uint8Array(clearLine.length + bufferBytes.length + tabByte.length);
    data.set(clearLine, 0);
    data.set(bufferBytes, clearLine.length);
    data.set(tabByte, clearLine.length + bufferBytes.length);
    writeInput(sid, Array.from(data)).catch(console.error);
    setWaitingForTab(true);
  }

  // Key handler - split between local buffer (normal) and raw PTY (alt screen)
  const handleKeyDown = (e: KeyboardEvent) => {
    // App shortcuts always pass through
    if (e.metaKey && e.key === "k") {
      e.preventDefault();
      props.store.clearHistory();
      return;
    }
    if (e.metaKey && e.key === ",") {
      e.preventDefault();
      props.onOpenSettings?.();
      return;
    }
    if (e.metaKey && (e.key === "t" || e.key === "w" || (e.key >= "1" && e.key <= "9"))) {
      return;
    }
    if (e.metaKey && e.shiftKey && (e.key === "[" || e.key === "]")) {
      return;
    }

    // Cmd+F: toggle search
    if (e.metaKey && e.key === "f") {
      e.preventDefault();
      if (props.store.state.searchOpen) {
        closeSearch();
      } else {
        openSearch();
      }
      return;
    }

    // Shift+PageUp/Down: scrollback navigation
    if (e.shiftKey && e.key === "PageUp") {
      e.preventDefault();
      props.store.scrollUp(props.store.state.rows);
      return;
    }
    if (e.shiftKey && e.key === "PageDown") {
      e.preventDefault();
      props.store.scrollDown(props.store.state.rows);
      return;
    }
    if (e.shiftKey && e.key === "Home") {
      e.preventDefault();
      props.store.scrollUp(999999);
      return;
    }
    if (e.shiftKey && e.key === "End") {
      e.preventDefault();
      props.store.scrollToBottom();
      return;
    }

    // Cmd+C with active selection: copy selected text
    if (e.metaKey && e.key === "c") {
      const sel = selection();
      if (sel.active && sel.range) {
        e.preventDefault();
        const lines = getAllDisplayLines();
        const text = extractSelectedText(lines, sel.range);
        if (text) {
          navigator.clipboard.writeText(text).catch(console.error);
        }
        clearSelection();
        return;
      }
    }

    // Any non-modifier key press resets scroll offset and clears selection
    if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.length === 1) {
      if (props.store.state.scrollOffset > 0) {
        props.store.scrollToBottom();
      }
      clearSelection();
    }

    // Alt screen or running command: raw PTY mode
    // (local buffer only active at the prompt, not while a command executes)
    if (props.store.state.altScreen || props.store.state.activeBlock) {
      if (e.metaKey && e.key === "c") {
        const sel = window.getSelection();
        if (sel && sel.toString().length > 0) return;
      }
      if (e.metaKey && e.key === "v") return;

      e.preventDefault();
      sendRawBytes(e);
      return;
    }

    // Normal mode: local buffer editing
    const sid = props.store.state.sessionId;
    if (!sid) return;

    // Reset cursor blink on any input activity
    resetBlink();

    // Cmd+A: select all in buffer
    if (e.metaKey && e.key === "a") {
      e.preventDefault();
      inputBuffer.selectAll();
      return;
    }

    // Cmd+C: copy selection from buffer
    if (e.metaKey && e.key === "c") {
      e.preventDefault();
      const text = inputBuffer.getSelectedText();
      if (text) {
        navigator.clipboard.writeText(text).catch(console.error);
      }
      return;
    }

    // Cmd+V: paste into buffer
    if (e.metaKey && e.key === "v") {
      // Let the paste event handler deal with it
      return;
    }

    // Cmd+X: cut selection
    if (e.metaKey && e.key === "x") {
      e.preventDefault();
      const text = inputBuffer.getSelectedText();
      if (text) {
        navigator.clipboard.writeText(text).catch(console.error);
        inputBuffer.deleteSelection();
      }
      return;
    }

    // Ctrl+C: send interrupt to PTY and clear buffer
    if (e.ctrlKey && e.key === "c") {
      e.preventDefault();
      writeInput(sid, [0x03]).catch(console.error); // ETX
      inputBuffer.clear();
      return;
    }

    // Ctrl+D: send EOF
    if (e.ctrlKey && e.key === "d") {
      e.preventDefault();
      writeInput(sid, [0x04]).catch(console.error); // EOT
      return;
    }

    // Ctrl+L: clear screen
    if (e.ctrlKey && e.key === "l") {
      e.preventDefault();
      writeInput(sid, [0x0c]).catch(console.error);
      return;
    }

    // Ctrl+U: clear line in buffer
    if (e.ctrlKey && e.key === "u") {
      e.preventDefault();
      inputBuffer.clear();
      return;
    }

    // Ctrl+W: delete word backward
    if (e.ctrlKey && e.key === "w") {
      e.preventDefault();
      inputBuffer.deleteWordBackward();
      return;
    }

    switch (e.key) {
      case "Enter":
        e.preventDefault();
        const text = inputBuffer.submit();
        if (isClearCommand(text)) {
          props.store.clearHistory();
        }
        sendToPty(text);
        return;

      case "Tab":
        e.preventDefault();
        sendTab();
        return;

      case "ArrowUp":
        e.preventDefault();
        inputBuffer.historyUp();
        return;

      case "ArrowDown":
        e.preventDefault();
        inputBuffer.historyDown();
        return;

      case "ArrowLeft":
        e.preventDefault();
        if (e.metaKey) {
          inputBuffer.moveToStart(e.shiftKey);
        } else if (e.altKey) {
          inputBuffer.moveWordLeft(e.shiftKey);
        } else {
          inputBuffer.moveCursorLeft(e.shiftKey);
        }
        return;

      case "ArrowRight":
        e.preventDefault();
        if (e.metaKey) {
          inputBuffer.moveToEnd(e.shiftKey);
        } else if (e.altKey) {
          inputBuffer.moveWordRight(e.shiftKey);
        } else {
          inputBuffer.moveCursorRight(e.shiftKey);
        }
        return;

      case "Home":
        e.preventDefault();
        inputBuffer.moveToStart(e.shiftKey);
        return;

      case "End":
        e.preventDefault();
        inputBuffer.moveToEnd(e.shiftKey);
        return;

      case "Backspace":
        e.preventDefault();
        inputBuffer.backspace();
        return;

      case "Delete":
        e.preventDefault();
        inputBuffer.deleteForward();
        return;

      case "Escape":
        e.preventDefault();
        inputBuffer.clear();
        return;

      default:
        // Printable characters
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          inputBuffer.insert(e.key);
        }
        return;
    }
  };

  const handlePaste = (e: ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData?.getData("text");
    if (!text) return;

    if (props.store.state.altScreen || props.store.state.activeBlock) {
      // Alt screen or running command: bracketed paste to PTY
      const sid = props.store.state.sessionId;
      if (!sid) return;
      const encoder = new TextEncoder();
      const pasteStart = new Uint8Array([0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e]);
      const pasteEnd = new Uint8Array([0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]);
      const textBytes = encoder.encode(text);
      const data = new Uint8Array(pasteStart.length + textBytes.length + pasteEnd.length);
      data.set(pasteStart, 0);
      data.set(textBytes, pasteStart.length);
      data.set(pasteEnd, pasteStart.length + textBytes.length);
      writeInput(sid, Array.from(data)).catch(console.error);
    } else {
      // Normal mode: insert into local buffer
      inputBuffer.insert(text);
    }
  };

  // Click in local buffer input area to position cursor
  const handleLocalInputClick = (e: MouseEvent) => {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const cw = charWidth();
    const pos = Math.round(x / cw);
    const s = inputBuffer.state();
    inputBuffer.moveCursor(Math.min(pos, s.text.length));
    containerRef?.focus();
  };

  // Double-click to select word
  const handleLocalInputDblClick = (e: MouseEvent) => {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const cw = charWidth();
    const pos = Math.round(x / cw);
    inputBuffer.selectWord(pos);
    containerRef?.focus();
  };

  const promptText = () => {
    const cwd = props.store.state.cwd;
    const style = promptStyle();
    if (style === "blank") return null;
    if (style === "default") {
      const user = extractUsername(cwd);
      const host = getHostname();
      // Show just the last directory name, or ~ for home
      const dirName = formatCwdDefault(cwd);
      return { text: `${user}@${host} ${dirName}`, char: "%" };
    }
    return { text: formatCwdSimplified(cwd), char: "$" };
  };

  const m = () => metrics();
  const lineHeight = () => m()?.lineHeight ?? 20;
  const fontFamily = () => {
    const f = m()?.fontFamily;
    return f ? `"${f}", monospace` : "monospace";
  };
  const fontSize = () => m()?.fontSize ?? 14;
  const charWidth = () => m()?.charWidth ?? 8;

  // Cursor blink reset: toggle a key to restart CSS animation on input
  const [blinkKey, setBlinkKey] = createSignal(0);
  function resetBlink() {
    setBlinkKey((k) => k + 1);
  }

  // Local buffer rendering helpers
  const termCols = () => props.store.state.cols || 80;

  // Wrap buffer text into lines at terminal column width
  const bufferLines = createMemo(() => {
    const text = inputBuffer.state().text;
    const cols = termCols();
    if (text.length <= cols) return [text || "\u200B"];
    const lines: string[] = [];
    for (let i = 0; i < text.length; i += cols) {
      lines.push(text.slice(i, i + cols));
    }
    if (lines.length === 0) lines.push("\u200B");
    return lines;
  });

  // Cursor position accounting for wrapping
  const bufferCursor = createMemo(() => {
    const s = inputBuffer.state();
    const cols = termCols();
    const row = Math.floor(s.cursorPos / cols);
    const col = s.cursorPos % cols;
    return {
      row,
      col,
      visible: true,
      shape: config().cursorShape as "block" | "underline" | "bar",
    };
  });

  // Selection highlight rects (may span multiple lines when wrapped)
  const selectionRects = createMemo(() => {
    const range = inputBuffer.selectionRange();
    if (!range) return [];
    const [start, end] = range;
    const cols = termCols();
    const cw = charWidth();
    const lh = lineHeight();
    const rects: { left: string; top: string; width: string; height: string }[] = [];

    const startRow = Math.floor(start / cols);
    const endRow = Math.floor((end - 1) / cols);

    for (let row = startRow; row <= endRow; row++) {
      const rowStart = row * cols;
      const selStart = Math.max(start, rowStart) - rowStart;
      const selEnd = Math.min(end, rowStart + cols) - rowStart;
      rects.push({
        left: `${selStart * cw}px`,
        top: `${row * lh}px`,
        width: `${(selEnd - selStart) * cw}px`,
        height: `${lh}px`,
      });
    }
    return rects;
  });

  return (
    <div
      ref={containerRef}
      class="terminal-container"
      classList={{ "terminal-hidden": !props.active, "terminal-traditional": isTraditional() }}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onMouseDown={handleTermMouseDown}
      onMouseMove={handleTermMouseMove}
      onMouseUp={handleTermMouseUp}
      onWheel={handleWheel}
      style={{
        "font-family": fontFamily(),
        "font-size": `${fontSize()}px`,
        "line-height": `${lineHeight()}px`,
        "letter-spacing": `${config().letterSpacing}px`,
      }}
    >
      {/* Search bar */}
      <Show when={props.store.state.searchOpen}>
        <SearchBar
          query={props.store.state.searchQuery}
          matchCount={props.store.state.searchMatches.length}
          currentIndex={props.store.state.searchCurrentIndex}
          onQueryChange={updateSearchQuery}
          onNext={searchNext}
          onPrev={searchPrev}
          onClose={closeSearch}
        />
      </Show>
      {/* Fullscreen TUI: absolute overlay when setting is enabled */}
      <Show when={fullscreenTui()}>
        <div class="alt-screen">
          <div class="terminal-content" style={{ position: "relative" }}>
            <For each={buildFullGrid(props.store.state.altScreenLines, props.store.state.rows)}>
              {(line) => (
                <TerminalLine
                  line={line}
                  charWidth={charWidth()}
                  selectionRange={selection().range}
                  searchMatches={props.store.state.searchMatches}
                  searchCurrentIndex={props.store.state.searchCurrentIndex}
                />
              )}
            </For>
            <Cursor
              cursor={props.store.state.cursor}
              charWidth={charWidth()}
              lineHeight={lineHeight()}
            />
          </div>
        </div>
      </Show>

      <Show when={!fullscreenTui()}>
        {/* Scroll container for idle, active-command, and inline TUI states */}
        <div
          class="terminal-scroll"
          ref={scrollRef}
          onScroll={handleScroll}
          style={{
            "overflow-y": (props.store.state.activeBlock && !inlineTui() && !keepHistoryDuringPrimaryActive())
              ? "hidden"
              : undefined,
          }}
        >
          {/* History: shown when idle, inline alt TUI, or primary-screen keep-history mode */}
          <Show when={!props.store.state.activeBlock || inlineTui() || keepHistoryDuringPrimaryActive()}>
            <div class="terminal-history">
              <Show when={isEmpty() && !isTraditional() && !inlineTui()}>
                <WelcomeState />
              </Show>

              {/* Chat mode: command blocks as cards */}
              <Show when={!isTraditional()}>
                <For each={props.store.state.snapshots}>
                  {(snap) => (
                    <CommandBlock
                      snapshot={snap}
                      charWidth={charWidth()}
                      promptStyle={config().promptStyle}
                    />
                  )}
                </For>
              </Show>

              {/* Traditional mode: continuous output */}
              <Show when={isTraditional()}>
                <For each={props.store.state.snapshots}>
                  {(snap) => (
                    <TraditionalBlock
                      snapshot={snap}
                      charWidth={charWidth()}
                      promptStyle={config().promptStyle}
                    />
                  )}
                </For>
              </Show>

              <Show when={!props.store.state.shellIntegrationActive && hasRenderableFallbackContent()}>
                <div class="active-output">
                  <For each={fallbackOutputLines()}>
                    {(line) => (
                      <TerminalLine
                        line={line}
                        charWidth={charWidth()}
                        selectionRange={selection().range}
                        searchMatches={props.store.state.searchMatches}
                        searchCurrentIndex={props.store.state.searchCurrentIndex}
                      />
                    )}
                  </For>
                </div>
              </Show>

              {/* Active block: always show so the prompt/path is visible.
                   PS1 is suppressed by shell hooks, so without this the user
                   would only see the raw command text with no directory context. */}
              <Show when={!isTraditional() && activeSnapshot()}>
                {(snap) => (
                  <CommandBlock
                    snapshot={snap()}
                    charWidth={charWidth()}
                    promptStyle={config().promptStyle}
                  />
                )}
              </Show>

              <Show when={isTraditional() && activeSnapshot()}>
                {(snap) => (
                  <TraditionalBlock
                    snapshot={snap()}
                    charWidth={charWidth()}
                    promptStyle={config().promptStyle}
                  />
                )}
              </Show>

              {/* Traditional mode: inline input (hidden while a command/TUI is active) */}
              <Show when={isTraditional() && !inlineTui() && !props.store.state.activeBlock}>
                <div
                  class="traditional-input-line"
                  onClick={handleLocalInputClick}
                  onDblClick={handleLocalInputDblClick}
                >
                  <Show when={promptText()}>
                    {(prompt) => (
                      <>
                        <Show when={promptStyle() === "simplified"}>
                          <span class="input-prompt-icon"><IconFolder size={11} /></span>
                        </Show>
                        <span class="traditional-prompt-text">{prompt().text}</span>
                        <span class="traditional-prompt-char"> {prompt().char} </span>
                      </>
                    )}
                  </Show>
                  <span class="traditional-inline-buffer" style={{ position: "relative" }}>
                    <For each={selectionRects()}>
                      {(rect) => (
                        <span class="input-selection" style={rect} />
                      )}
                    </For>
                    {inputBuffer.state().text || "\u200B"}
                    {(() => {
                      const _key = blinkKey();
                      return (
                        <Cursor
                          cursor={bufferCursor()}
                          charWidth={charWidth()}
                          lineHeight={lineHeight()}
                        />
                      );
                    })()}
                  </span>
                </div>

                {/* Traditional welcome below the prompt */}
                <Show when={isEmpty()}>
                  <WelcomeState />
                </Show>
              </Show>
            </div>
          </Show>

          {/* Inline TUI viewport: alt-screen content rendered in document flow */}
          <Show when={inlineTui()}>
            <div class="alt-screen-inline">
              <div class="terminal-content" style={{ position: "relative" }}>
                <For each={buildFullGrid(props.store.state.altScreenLines, props.store.state.rows)}>
                  {(line) => (
                    <TerminalLine
                      line={line}
                      charWidth={charWidth()}
                      selectionRange={selection().range}
                      searchMatches={props.store.state.searchMatches}
                      searchCurrentIndex={props.store.state.searchCurrentIndex}
                    />
                  )}
                </For>
                <Cursor
                  cursor={props.store.state.cursor}
                  charWidth={charWidth()}
                  lineHeight={lineHeight()}
                />
              </div>
            </div>
          </Show>

          {/* Active command: render full viewport lines inline (not during inline TUI) */}
          <Show when={!!props.store.state.activeBlock && !inlineTui()}>
            <div class="terminal-content active-viewport" style={{ position: "relative" }}>
              <For each={primaryScreenLines()}>
                {(line) => (
                  <TerminalLine
                    line={line}
                    charWidth={charWidth()}
                    selectionRange={selection().range}
                    searchMatches={props.store.state.searchMatches}
                    searchCurrentIndex={props.store.state.searchCurrentIndex}
                  />
                )}
              </For>
              <Cursor
                cursor={primaryScreenCursor()}
                charWidth={charWidth()}
                lineHeight={lineHeight()}
                blinking={false}
              />
            </div>
          </Show>
        </div>

        {/* Scroll-to-bottom FAB */}
        <Show when={!inlineTui() && (!props.store.state.activeBlock || keepHistoryDuringPrimaryActive())}>
          <button
            class="scroll-fab"
            classList={{ "scroll-fab-visible": isScrolledUp() || props.store.state.scrollOffset > 0 }}
            onClick={scrollToBottom}
            title="Scroll to bottom"
          >
            <IconArrowDown size={16} />
            <Show when={props.store.state.scrollOffset > 0}>
              <span class="scroll-offset-badge">{props.store.state.scrollOffset}</span>
            </Show>
          </button>
        </Show>

        {/* Chat mode: input area (hidden during inline TUI) */}
        <Show when={!isTraditional() && !props.store.state.activeBlock && !inlineTui()}>
        <div class="terminal-active">
          <div class="input-card">
            <Show when={promptText()}>
              {(prompt) => (
                <div class="input-prompt-bar">
                  <Show when={promptStyle() === "simplified"}>
                    <span class="input-prompt-icon"><IconFolder size={11} /></span>
                  </Show>
                  <span class="input-prompt-cwd">{prompt().text}</span>
                  <span class="input-prompt-dollar">{prompt().char}</span>
                </div>
              )}
            </Show>
            <div
              class="input-content"
              style={{ "max-height": `${Math.floor(containerHeight() * 0.3)}px` }}
              onClick={handleLocalInputClick}
              onDblClick={handleLocalInputDblClick}
            >
              <div class="terminal-content local-input-buffer" style={{ position: "relative" }}>
                {/* Selection highlights (may span multiple wrapped lines) */}
                <For each={selectionRects()}>
                  {(rect) => (
                    <div class="input-selection" style={rect} />
                  )}
                </For>
                {/* Wrapped buffer lines */}
                <For each={bufferLines()}>
                  {(line) => (
                    <div class="term-line">{line}</div>
                  )}
                </For>
                {/* Blinking cursor with blink reset on input */}
                {(() => {
                  const _key = blinkKey();
                  return (
                    <Cursor
                      cursor={bufferCursor()}
                      charWidth={charWidth()}
                      lineHeight={lineHeight()}
                    />
                  );
                })()}
              </div>
            </div>
          </div>
        </div>
        </Show>
      </Show>

    </div>
  );
};
