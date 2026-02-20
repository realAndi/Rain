import { Component, For, Show, onMount, onCleanup, createSignal, createEffect, createMemo, on, untrack } from "solid-js";
import { ContextMenu } from "./ContextMenu";
import { produce } from "solid-js/store";
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
import {
  SuggestionEngine,
  HistoryProvider,
  ContextualOutputProvider,
  FilesystemProvider,
  ProjectAwareProvider,
  PathCommandProvider,
  RuntimeSnoopProvider,
  recordCommandInDir,
  type FilesystemCache,
  type SnoopCacheEntry,
} from "../lib/suggestions";
import { writeInput, resizeTerminal, requestFullRedraw, tmuxSendKeys, tmuxResizePane, saveTextToFile, listDirectory, scanProjectCommands, scanPathCommands, snoopPathContext, type ProjectCommands } from "../lib/ipc";
import { checkPasteContent } from "../lib/pasteSafety";
import { keyEventToBytes } from "../lib/input";
import { measureFontMetrics, calculateTerminalSize, invalidateFontMetrics, type FontMetrics } from "../lib/font";
import { collectLinesForRange } from "../lib/terminal-output";
import { TerminalLine } from "./TerminalLine";
import { Cursor } from "./Cursor";
import { IconFolder, IconCopy, IconCommand, IconArrowDown } from "./icons";
import { matchesKeybinding } from "../lib/keybindings";
import { buildFullGrid, formatCwdSimplified, extractUsername, getHostname, formatCwdDefault } from "./terminal/utils";
import { CommandBlock } from "./terminal/CommandBlock";
import { TraditionalBlock } from "./terminal/TraditionalBlock";
import { WelcomeState } from "./terminal/WelcomeState";
import { SearchBar } from "./terminal/SearchBar";

export const Terminal: Component<{ store: TerminalStore; active: boolean; isTabActive?: boolean; onOpenSettings?: () => void; onSplitRight?: () => void; onSplitDown?: () => void }> = (props) => {
  let containerRef!: HTMLDivElement;
  let scrollRef!: HTMLDivElement;
  let srAnnouncerRef: HTMLDivElement | undefined;
  const { config } = useConfig();
  const inputBuffer = createInputBuffer();

  const suggestionEngine = new SuggestionEngine();
  suggestionEngine.register(
    new HistoryProvider(
      () => inputBuffer.getHistory(),
      () => props.store.state.snapshots,
    ),
  );
  // Filesystem provider with async cache (option b from spec)
  const [fsCache, setFsCache] = createSignal<FilesystemCache | null>(null);
  let fsFetchDir = "";
  let fsFetchCwd = "";
  let fsFetchGeneration = 0;

  suggestionEngine.register(
    new ContextualOutputProvider(
      () => props.store.state.snapshots,
      () => fsCache(),
    ),
  );
  suggestionEngine.register(
    new FilesystemProvider(() => fsCache()),
  );

  function fetchDirectoryCache(dir: string, cwd: string) {
    fsFetchDir = dir;
    fsFetchCwd = cwd;
    const gen = ++fsFetchGeneration;
    listDirectory(dir)
      .then((entries) => {
        if (gen !== fsFetchGeneration) return;
        setFsCache({ entries, dir, cwd });
      })
      .catch(() => {
        if (gen !== fsFetchGeneration) return;
        setFsCache(null);
      });
  }

  createEffect(() => {
    const text = inputBuffer.state().text;
    const cwd = props.store.state.cwd;
    const dir = FilesystemProvider.directoryToFetch(text, cwd);
    if (!dir) {
      if (fsCache()) setFsCache(null);
      fsFetchDir = "";
      fsFetchCwd = "";
      return;
    }
    if (dir === fsFetchDir && cwd === fsFetchCwd) return;
    fetchDirectoryCache(dir, cwd);
  });

  // Invalidate filesystem cache when a command completes (e.g. mkdir, touch, rm)
  createEffect(on(
    () => props.store.state.snapshots.length,
    () => {
      if (fsFetchDir && fsFetchCwd) {
        fetchDirectoryCache(fsFetchDir, fsFetchCwd);
      }
    },
  ));

  // Project-aware provider: reads package.json scripts, Cargo.toml, Makefile targets, etc.
  const [projectCommands, setProjectCommands] = createSignal<ProjectCommands | null>(null);
  let projectCwd = "";

  suggestionEngine.register(
    new ProjectAwareProvider(() => projectCommands()),
  );

  createEffect(on(
    () => props.store.state.cwd,
    (cwd) => {
      if (!cwd || cwd === projectCwd) return;
      projectCwd = cwd;
      scanProjectCommands(cwd)
        .then((result) => {
          if (cwd !== projectCwd) return;
          setProjectCommands(result);
        })
        .catch(() => setProjectCommands(null));
    },
  ));

  // PATH command provider: discovers installed CLI tools once on mount
  const [pathCommands, setPathCommands] = createSignal<string[]>([]);

  suggestionEngine.register(
    new PathCommandProvider(() => pathCommands()),
  );

  // Runtime snoop provider: inspects target directories for runnable files and project config
  const [snoopCache, setSnoopCache] = createSignal<SnoopCacheEntry | null>(null);
  let snoopDir = "";
  let snoopRuntime = "";
  let snoopGeneration = 0;

  suggestionEngine.register(
    new RuntimeSnoopProvider(() => snoopCache()),
  );

  createEffect(() => {
    const text = inputBuffer.state().text;
    const cwd = props.store.state.cwd;
    const parsed = RuntimeSnoopProvider.directoryToSnoop(text, cwd);
    if (!parsed) {
      if (snoopCache()) setSnoopCache(null);
      snoopDir = "";
      snoopRuntime = "";
      return;
    }
    if (parsed.dir === snoopDir && parsed.runtime === snoopRuntime) return;
    snoopDir = parsed.dir;
    snoopRuntime = parsed.runtime;
    const gen = ++snoopGeneration;
    snoopPathContext(parsed.dir, parsed.runtime)
      .then((result) => {
        if (gen !== snoopGeneration) return;
        setSnoopCache({
          result,
          dir: parsed.dir,
          runtime: parsed.runtime,
          cmdPrefix: parsed.cmdPrefix,
          argDir: parsed.argDir,
        });
      })
      .catch(() => {
        if (gen !== snoopGeneration) return;
        setSnoopCache(null);
      });
  });

  // Unified input sender: routes to tmux or PTY depending on pane type
  const sendInput = (sessionId: string, data: number[]) => {
    const tmuxPaneId = props.store.state.tmuxPaneId;
    if (tmuxPaneId != null) {
      return tmuxSendKeys(tmuxPaneId, data);
    }
    return writeInput(sessionId, data);
  };
  const [metrics, setMetrics] = createSignal<FontMetrics | null>(null);
  const [isScrolledUp, setIsScrolledUp] = createSignal(false);
  const [containerHeight, setContainerHeight] = createSignal(600);
  const [waitingForTab, setWaitingForTab] = createSignal(false);

  // Selection state for text selection
  const [selection, setSelection] = createSignal<SelectionState>(createSelectionState());

  const inlineImages = () => props.store.state.inlineImages;

  // Context menu state
  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number; selectedText?: string; linkUrl?: string } | null>(null);

  // Visual bell flash state
  const [bellFlash, setBellFlash] = createSignal(false);

  // Regex search toggle
  const [searchUseRegex, setSearchUseRegex] = createSignal(false);
  const [searchRegexError, setSearchRegexError] = createSignal(false);

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

    scanPathCommands()
      .then((cmds) => setPathCommands(cmds))
      .catch(() => {});

    containerRef.focus();
    const onWindowFocus = () => emitFocusEvent(true);
    const onWindowBlur = () => emitFocusEvent(false);
    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("blur", onWindowBlur);

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

      const tmuxPaneId = props.store.state.tmuxPaneId;
      const resizeOp = tmuxPaneId != null
        ? tmuxResizePane(tmuxPaneId, rows, cols)
        : resizeTerminal(sid, rows, cols);
      resizeOp
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
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("blur", onWindowBlur);
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

  // Keep terminal focused when active and the tab is visible
  createEffect(() => {
    const tabActive = props.isTabActive ?? true;
    if (tabActive && props.active && containerRef) {
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
    // Alt screen: honor mouse tracking first, then alternate scroll mode.
    if (props.store.state.altScreen) {
      const sid = props.store.state.sessionId;
      if (!sid) return;

      if (props.store.state.mouseTracking) {
        e.preventDefault();
        const viewport = containerRef?.querySelector(".terminal-content, .alt-screen, .active-viewport, .terminal-history") as HTMLElement;
        if (!viewport) return;
        const { row, col } = pixelToGrid(e as unknown as MouseEvent, viewport);
        const button = e.deltaY < 0 ? 64 : 65; // wheel up/down
        sendInput(sid, encodeMouseEvent(button, col, row, true)).catch(console.error);
        return;
      }

      if (props.store.state.altScroll) {
        e.preventDefault();
        const lines = Math.max(1, Math.round(Math.abs(e.deltaY) / 20));
        const arrow = e.deltaY < 0 ? "\x1b[A" : "\x1b[B";
        const seq = arrow.repeat(lines);
        const encoder = new TextEncoder();
        sendInput(sid, Array.from(encoder.encode(seq))).catch(console.error);
      }
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
        sendInput(sid, encodeMouseEvent(lastMouseButton, col, row, true)).catch(console.error);
      }
      return;
    }

    // Text selection
    // Allow native browser selection for completed output blocks.
    // Keep custom grid-based selection for the active viewport/alt-screen.
    const target = e.target as HTMLElement;
    if (target.closest(".command-block, .traditional-block")) {
      containerRef?.focus();
      return;
    }
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
    if (!mouseButtonDown && !props.store.state.mouseAllMotion) return;
    const viewport = containerRef?.querySelector(".terminal-content, .alt-screen, .active-viewport, .terminal-history") as HTMLElement;
    if (!viewport) return;
    const { row, col } = pixelToGrid(e, viewport);

    // Mouse motion tracking (1002 drag, 1003 all-motion)
    if ((props.store.state.mouseMotion || props.store.state.mouseAllMotion) && props.store.state.mouseTracking && !e.shiftKey) {
      const sid = props.store.state.sessionId;
      if (sid) {
        const baseButton = mouseButtonDown ? lastMouseButton : 3;
        const button = baseButton + 32; // motion flag
        sendInput(sid, encodeMouseEvent(button, col, row, true)).catch(console.error);
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
        sendInput(sid, encodeMouseEvent(lastMouseButton, col, row, false)).catch(console.error);
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

  // Focus event reporting for DECSET 1004.
  const emitFocusEvent = (focused: boolean) => {
    if (!props.active || !props.store.state.focusEvents) return;
    const sid = props.store.state.sessionId;
    if (!sid) return;
    sendInput(sid, focused ? [0x1b, 0x5b, 0x49] : [0x1b, 0x5b, 0x4f]).catch(console.error);
  };

  const handleFocus = () => emitFocusEvent(true);
  const handleBlur = () => emitFocusEvent(false);

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

  function exportScrollback() {
    const lines: string[] = [];
    // Collect all snapshot output
    for (const snap of props.store.state.snapshots) {
      if (snap.command) lines.push(`$ ${snap.command}`);
      for (const line of snap.lines) {
        lines.push(line.spans.map((s) => s.text).join("").trimEnd());
      }
      lines.push("");
    }
    // Add current visible lines
    const fallback = props.store.state.fallbackLines;
    for (const line of fallback) {
      lines.push(line.spans.map((s) => s.text).join("").trimEnd());
    }

    const text = lines.join("\n");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    saveTextToFile(text, `rain-export-${timestamp}.txt`).catch(console.error);
  }

  function updateSearchQuery(query: string) {
    props.store.setState(produce((s) => {
      s.searchQuery = query;
      if (!query) {
        s.searchMatches = [];
        s.searchCurrentIndex = -1;
        setSearchRegexError(false);
        return;
      }

      const matches: SearchMatch[] = [];
      const useRegex = searchUseRegex();
      const lines = getAllDisplayLines();

      if (useRegex) {
        let re: RegExp;
        try {
          re = new RegExp(query, "gi");
          setSearchRegexError(false);
        } catch {
          setSearchRegexError(true);
          s.searchMatches = [];
          s.searchCurrentIndex = -1;
          return;
        }
        for (const line of lines) {
          const text = line.spans.map((sp) => sp.text).join("");
          let m: RegExpExecArray | null;
          re.lastIndex = 0;
          while ((m = re.exec(text)) !== null) {
            if (m[0].length === 0) { re.lastIndex++; continue; }
            matches.push({
              globalRow: line.index,
              startCol: m.index,
              endCol: m.index + m[0].length - 1,
            });
          }
        }
      } else {
        const lowerQuery = query.toLowerCase();
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

  // Screen reader announcement helper
  function announce(message: string) {
    if (srAnnouncerRef) {
      srAnnouncerRef.textContent = "";
      requestAnimationFrame(() => {
        if (srAnnouncerRef) srAnnouncerRef.textContent = message;
      });
    }
  }

  // Announce command completion to screen readers
  createEffect(on(
    () => props.store.state.snapshots.length,
    (len, prevLen) => {
      if (prevLen !== undefined && len > prevLen) {
        const snap = props.store.state.snapshots[len - 1];
        if (snap?.command) {
          announce(`Command ${snap.command} ${snap.failed ? "failed" : "completed"}`);
        }
      }
    }
  ));

  // Announce CWD changes to screen readers
  createEffect(on(
    () => props.store.state.cwd,
    (cwd, prevCwd) => {
      if (prevCwd !== undefined && cwd !== prevCwd && cwd) {
        announce(`Directory changed to ${cwd}`);
      }
    }
  ));

  // Clear inline images when entering alt screen (fullscreen TUIs redraw everything)
  createEffect(on(
    () => props.store.state.altScreen,
    (alt) => {
      if (alt && inlineImages().length > 0) {
        props.store.setState("inlineImages", []);
      }
    },
  ));

  // Visual bell: flash the terminal border briefly
  createEffect(() => {
    const bell = props.store.state.bell;
    if (bell) {
      setBellFlash(true);
      const timerId = setTimeout(() => setBellFlash(false), 150);
      onCleanup(() => clearTimeout(timerId));
      untrack(() => {
        props.store.setState(produce((s) => { s.bell = false; }));
      });
    }
  });

  createEffect(on(
    () => props.store.state.tmuxCompatibilityNotice,
    (visible) => {
      if (!visible) return;
      const timerId = setTimeout(() => {
        props.store.setState(produce((s) => {
          s.tmuxCompatibilityNotice = false;
        }));
      }, 2800);
      onCleanup(() => clearTimeout(timerId));
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
  const tmuxForcesTraditional = () => config().terminalStyle === "chat" && props.store.state.tmuxActive;
  const isTraditional = () => config().terminalStyle === "traditional" || tmuxForcesTraditional();
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
    sendInput(sid, Array.from(bytes)).catch(console.error);
  }

  // Send raw bytes to PTY (for alt screen mode)
  function sendRawBytes(e: KeyboardEvent) {
    const sid = props.store.state.sessionId;
    if (!sid) return;
    const cfg = config();
    const bytes = keyEventToBytes(e, cfg.optionAsMeta, props.store.state.cursorKeysApplication);
    if (bytes.length > 0) {
      sendInput(sid, Array.from(bytes)).catch(console.error);
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
    sendInput(sid, Array.from(data)).catch(console.error);
    setWaitingForTab(true);
  }

  // Key handler - split between local buffer (normal) and raw PTY (alt screen)
  const handleKeyDown = (e: KeyboardEvent) => {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    // App shortcuts always pass through
    if (matchesKeybinding(e, "clear")) {
      e.preventDefault();
      props.store.clearHistory();
      return;
    }
    if (matchesKeybinding(e, "settings")) {
      e.preventDefault();
      props.onOpenSettings?.();
      return;
    }
    if (
      matchesKeybinding(e, "new-tab") ||
      matchesKeybinding(e, "close-tab") ||
      matchesKeybinding(e, "close-pane") ||
      matchesKeybinding(e, "next-tab") ||
      matchesKeybinding(e, "prev-tab") ||
      matchesKeybinding(e, "split-horizontal") ||
      matchesKeybinding(e, "split-vertical") ||
      matchesKeybinding(e, "command-palette")
    ) {
      return;
    }
    if ((e.metaKey || e.ctrlKey) && key >= "1" && key <= "9") {
      for (let i = 1; i <= 9; i++) {
        if (matchesKeybinding(e, `tab-${i}`)) return;
      }
    }
    if (e.metaKey && e.shiftKey && (key === "[" || key === "]")) {
      return;
    }

    // Cmd+F: toggle search
    if (matchesKeybinding(e, "search")) {
      e.preventDefault();
      if (props.store.state.searchOpen) {
        closeSearch();
      } else {
        openSearch();
      }
      return;
    }

    // Cmd+S: Export scrollback
    if (e.metaKey && key === "s" && !e.shiftKey && !e.ctrlKey) {
      e.preventDefault();
      exportScrollback();
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
    if (e.metaKey && key === "c") {
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
      if (e.metaKey && key === "c") {
        const sel = window.getSelection();
        if (sel && sel.toString().length > 0) return;
      }
      if (e.metaKey && key === "v") return;

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
    if (e.metaKey && key === "a") {
      e.preventDefault();
      inputBuffer.selectAll();
      return;
    }

    // Cmd+C: copy selection from buffer
    if (e.metaKey && key === "c") {
      e.preventDefault();
      const text = inputBuffer.getSelectedText();
      if (text) {
        navigator.clipboard.writeText(text).catch(console.error);
      }
      return;
    }

    // Cmd+V: paste into buffer
    if (e.metaKey && key === "v") {
      // Let the paste event handler deal with it
      return;
    }

    // Cmd+X: cut selection
    if (e.metaKey && key === "x") {
      e.preventDefault();
      const text = inputBuffer.getSelectedText();
      if (text) {
        navigator.clipboard.writeText(text).catch(console.error);
        inputBuffer.deleteSelection();
      }
      return;
    }

    // Ctrl+C: send interrupt to PTY and clear buffer
    if (e.ctrlKey && key === "c") {
      e.preventDefault();
      sendInput(sid, [0x03]).catch(console.error); // ETX
      inputBuffer.clear();
      return;
    }

    // Ctrl+D: send EOF
    if (e.ctrlKey && key === "d") {
      e.preventDefault();
      sendInput(sid, [0x04]).catch(console.error); // EOT
      return;
    }

    // Ctrl+L: clear screen
    if (e.ctrlKey && e.key === "l") {
      e.preventDefault();
      sendInput(sid, [0x0c]).catch(console.error);
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
      case "Enter": {
        e.preventDefault();
        const text = inputBuffer.submit();
        if (text.trim()) {
          recordCommandInDir(text, props.store.state.cwd);
        }
        if (isClearCommand(text)) {
          props.store.clearHistory();
        }
        sendToPty(text);
        return;
      }

      case "Tab":
        e.preventDefault();
        if (e.shiftKey) {
          inputBuffer.cycleSuggestion(-1);
        } else if (inputBuffer.acceptSuggestion()) {
          refreshSuggestionsNow();
        } else {
          sendTab();
        }
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
        // Ctrl+Right: accept one word of the suggestion (Fish-style partial accept)
        if (e.ctrlKey && !e.metaKey && !e.shiftKey) {
          if (inputBuffer.acceptSuggestionWord()) return;
        }
        if (!e.metaKey && !e.altKey && !e.shiftKey && !e.ctrlKey) {
          const s = inputBuffer.state();
          if (s.cursorPos >= s.text.length && inputBuffer.acceptSuggestion()) {
            return;
          }
        }
        if (e.metaKey) {
          inputBuffer.moveToEnd(e.shiftKey);
        } else if (e.altKey) {
          // Alt+Right at end of input: partial accept; otherwise normal word move
          if (!e.shiftKey) {
            const s = inputBuffer.state();
            if (s.cursorPos >= s.text.length && inputBuffer.acceptSuggestionWord()) return;
          }
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
        if (!inputBuffer.dismissSuggestion()) {
          inputBuffer.clear();
        }
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

    const safetyCheck = checkPasteContent(text);
    if (safetyCheck.isSuspicious) {
      const confirmed = window.confirm(
        `${safetyCheck.reason}\n\nAre you sure you want to paste this?`
      );
      if (!confirmed) return;
    }

    if (props.store.state.altScreen || props.store.state.activeBlock) {
      // Alt screen or running command: send paste to PTY
      const sid = props.store.state.sessionId;
      if (!sid) return;
      const encoder = new TextEncoder();
      const textBytes = encoder.encode(text);
      if (props.store.state.bracketedPaste) {
        // Wrap in bracketed paste delimiters when mode 2004 is active
        const pasteStart = new Uint8Array([0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e]);
        const pasteEnd = new Uint8Array([0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]);
        const data = new Uint8Array(pasteStart.length + textBytes.length + pasteEnd.length);
        data.set(pasteStart, 0);
        data.set(textBytes, pasteStart.length);
        data.set(pasteEnd, pasteStart.length + textBytes.length);
        sendInput(sid, Array.from(data)).catch(console.error);
      } else {
        sendInput(sid, Array.from(textBytes)).catch(console.error);
      }
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

  // Debounce suggestion computation: wait 500ms of no typing before showing ghost text
  let suggestionTimer: ReturnType<typeof setTimeout> | null = null;

  function refreshSuggestionsNow() {
    if (suggestionTimer) clearTimeout(suggestionTimer);
    const s = inputBuffer.state();
    const cwd = props.store.state.cwd;
    const prefix = s.text;
    const cursorAtEnd = s.cursorPos === prefix.length;
    if (!prefix.trim() || !cursorAtEnd) return;
    const candidates = suggestionEngine.suggestAll({ prefix, cwd, cursorAtEnd });
    const texts = candidates.map((c) => c.text);
    const best = texts.length > 0 ? texts[0] : null;
    inputBuffer.setSuggestion(best);
    inputBuffer.setAllSuggestions(texts);
    inputBuffer.setSuggestionIndex(0);
  }

  createEffect(() => {
    const s = inputBuffer.state();
    const cwd = props.store.state.cwd;

    // Clear current suggestion immediately when input changes
    inputBuffer.setSuggestion(null);
    inputBuffer.setAllSuggestions([]);
    inputBuffer.setSuggestionIndex(0);

    if (suggestionTimer) clearTimeout(suggestionTimer);

    const prefix = s.text;
    const cursorAtEnd = s.cursorPos === prefix.length;
    if (!prefix.trim() || !cursorAtEnd) return;

    suggestionTimer = setTimeout(() => {
      refreshSuggestionsNow();
    }, 500);
  });

  onCleanup(() => {
    if (suggestionTimer) clearTimeout(suggestionTimer);
  });

  // Ghost text reacts to the suggestion signal (supports cycling)
  const ghostText = createMemo(() => {
    const s = inputBuffer.suggestion();
    const text = inputBuffer.state().text;
    if (!s || !s.startsWith(text)) return null;
    const ghost = s.slice(text.length);
    return ghost || null;
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
      classList={{ "terminal-hidden": !props.active, "terminal-traditional": isTraditional(), "terminal-bell-flash": bellFlash() }}
      role="application"
      aria-label="Terminal"
      aria-roledescription="terminal emulator"
      tabIndex={0}
      data-ligatures={config().enableLigatures ? "true" : "false"}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onMouseDown={handleTermMouseDown}
      onMouseMove={handleTermMouseMove}
      onMouseUp={handleTermMouseUp}
      onWheel={handleWheel}
      onContextMenu={(e: MouseEvent) => {
        e.preventDefault();
        let selectedText: string | undefined;
        const sel = selection();
        if (sel.active && sel.range) {
          const lines = getAllDisplayLines();
          selectedText = extractSelectedText(lines, sel.range) || undefined;
        }
        let linkUrl: string | undefined;
        const target = e.target as HTMLElement;
        if (target.classList.contains("term-url")) {
          linkUrl = target.dataset.url || target.textContent || undefined;
        }
        setContextMenu({ x: e.clientX, y: e.clientY, selectedText, linkUrl });
      }}
      style={{
        "font-family": fontFamily(),
        "font-size": `${fontSize()}px`,
        "line-height": `${lineHeight()}px`,
        "letter-spacing": `${config().letterSpacing}px`,
      }}
    >
      {/* Screen reader announcements */}
      <div
        class="sr-only"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        ref={(el) => { srAnnouncerRef = el; }}
      />
      {/* Search bar */}
      <Show when={props.store.state.searchOpen}>
        <SearchBar
          query={props.store.state.searchQuery}
          matchCount={props.store.state.searchMatches.length}
          currentIndex={props.store.state.searchCurrentIndex}
          useRegex={searchUseRegex()}
          regexError={searchRegexError()}
          onQueryChange={updateSearchQuery}
          onNext={searchNext}
          onPrev={searchPrev}
          onClose={closeSearch}
          onToggleRegex={() => {
            setSearchUseRegex((v) => !v);
            updateSearchQuery(props.store.state.searchQuery);
          }}
        />
      </Show>
      {/* Disconnected/error banner */}
      <Show when={props.store.state.sessionId && !props.store.state.connected}>
        <div class="terminal-disconnected-banner">
          Session ended
        </div>
      </Show>
      <Show when={props.store.state.tmuxCompatibilityNotice}>
        <div class="terminal-compat-banner">
          tmux running in compatibility mode (use Rain's native integration with Cmd+Shift+T)
        </div>
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
          role="log"
          aria-live="polite"
          aria-label="Terminal output"
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
                  aria-label="Terminal input"
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
                    <Show when={ghostText()}>
                      <span class="ghost-suggestion">{ghostText()}</span>
                    </Show>
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

        {/* Inline images from image protocols */}
        <Show when={inlineImages().length > 0}>
          <div class="inline-images-overlay" style={{ position: "relative" }}>
            <For each={inlineImages()}>
              {(img) => (
                <div
                  class="inline-image"
                  style={{
                    "max-width": img.width > 0 ? `${img.width}px` : "100%",
                  }}
                >
                  <img
                    src={img.dataUri}
                    alt="Terminal inline image"
                    style={{
                      "max-width": "100%",
                      height: "auto",
                      "border-radius": "4px",
                    }}
                    loading="lazy"
                  />
                </div>
              )}
            </For>
          </div>
        </Show>

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
              aria-label="Terminal input"
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
                {/* Wrapped buffer lines with ghost suggestion on last line */}
                <For each={bufferLines()}>
                  {(line, index) => (
                    <div class="term-line">
                      {line}
                      <Show when={index() === bufferLines().length - 1 && ghostText()}>
                        <span class="ghost-suggestion">{ghostText()}</span>
                      </Show>
                    </div>
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

      {/* Right-click context menu */}
      <Show when={contextMenu()}>
        {(pos) => (
          <ContextMenu
            x={pos().x}
            y={pos().y}
            hasSelection={selection().active}
            selectedText={pos().selectedText}
            linkUrl={pos().linkUrl}
            onCopy={() => {
              const sel = selection();
              if (sel.active && sel.range) {
                const lines = getAllDisplayLines();
                const text = extractSelectedText(lines, sel.range);
                if (text) navigator.clipboard.writeText(text).catch(console.error);
              }
              setContextMenu(null);
            }}
            onPaste={async () => {
              try {
                const text = await navigator.clipboard.readText();
                if (text) {
                  if (props.store.state.altScreen || props.store.state.activeBlock) {
                    const sid = props.store.state.sessionId;
                    if (sid) {
                      const encoder = new TextEncoder();
                      if (props.store.state.bracketedPaste) {
                        const wrapped = "\x1b[200~" + text + "\x1b[201~";
                        sendInput(sid, Array.from(encoder.encode(wrapped))).catch(console.error);
                      } else {
                        sendInput(sid, Array.from(encoder.encode(text))).catch(console.error);
                      }
                    }
                  } else {
                    inputBuffer.insert(text);
                  }
                }
              } catch (e) { console.error(e); }
              setContextMenu(null);
            }}
            onClear={() => {
              props.store.clearHistory();
              setContextMenu(null);
            }}
            onSelectAll={() => {
              const lines = getAllDisplayLines();
              if (lines.length > 0) {
                const lastLine = lines[lines.length - 1];
                const lastText = lastLine.spans.map(s => s.text).join("");
                setSelection({
                  active: true,
                  range: { start: { row: 0, col: 0 }, end: { row: lastLine.index, col: Math.max(0, lastText.length - 1) } },
                  selecting: false,
                });
              }
              setContextMenu(null);
            }}
            onSearchSelection={() => {
              const text = pos().selectedText;
              if (text) {
                openSearch();
                updateSearchQuery(text);
              }
              setContextMenu(null);
            }}
            onOpenLink={() => {
              const url = pos().linkUrl;
              if (url) window.open(url, "_blank");
              setContextMenu(null);
            }}
            onSplitRight={() => {
              props.onSplitRight?.();
              setContextMenu(null);
            }}
            onSplitDown={() => {
              props.onSplitDown?.();
              setContextMenu(null);
            }}
            onExport={() => {
              exportScrollback();
              setContextMenu(null);
            }}
            onClose={() => setContextMenu(null)}
          />
        )}
      </Show>
    </div>
  );
};
