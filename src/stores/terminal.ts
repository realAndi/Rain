import { createStore, produce } from "solid-js/store";
import type {
  RenderedLine,
  RenderFramePayload,
  ResizeAckPayload,
  TerminalEvent,
  TerminalStoreState,
} from "../lib/types";
import { collectLinesForRange, trimTrailingEmpty } from "../lib/terminal-output";
import { useConfig } from "./config";

export interface TerminalStore {
  state: TerminalStoreState;
  setState: ReturnType<typeof createStore<TerminalStoreState>>[1];
  applyRenderFrame: (payload: RenderFramePayload) => void;
  applyResizeAck: (payload: ResizeAckPayload) => void;
  clearHistory: () => void;
  scrollUp: (lines: number) => void;
  scrollDown: (lines: number) => void;
  scrollToBottom: () => void;
}

let snapshotCounter = 0;

// Error patterns
const ERROR_PATTERNS = [
  /no such file or directory/i,
  /command not found/i,
  /permission denied/i,
  /not a directory/i,
  /is a directory/i,
  /cannot access/i,
  /fatal:/i,
];

function detectFailure(lines: RenderedLine[]): boolean {
  for (const line of lines) {
    const text = line.spans.map((sp) => sp.text).join("");
    for (const pattern of ERROR_PATTERNS) {
      if (pattern.test(text)) return true;
    }
  }
  return false;
}

function isClearCommand(command: string | null | undefined): boolean {
  const trimmed = command?.trim() ?? "";
  if (!trimmed) return false;
  return /^clear(\s+-[A-Za-z0-9-]+)*\s*$/.test(trimmed);
}

function resetStoreHistory(state: TerminalStoreState) {
  state.snapshots = [];
  state.scrollbackLines = [];
  state.fallbackLines = [];
  state.visibleLinesByGlobal = {};
  state.visibleBaseGlobal = 0;
  state.lastNonAltVisibleBaseGlobal = 0;
  state.lastNonAltCursorRow = 0;
  state.awaitingNonAltReseed = false;
  state.pendingBlock = null;
  state.activeBlock = null;
}

function isFrameDebugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const win = window as Window & { __RAIN_FRAME_DEBUG__?: boolean };
  if (win.__RAIN_FRAME_DEBUG__ === true) return true;
  try {
    return window.localStorage.getItem("rain:frame-debug") === "1";
  } catch {
    return false;
  }
}

export function createTerminalStore(): TerminalStore {
  const queuedBlockEvents: TerminalEvent[] = [];
  const frameDebug = isFrameDebugEnabled();
  const { config } = useConfig();

  const [state, setState] = createStore<TerminalStoreState>({
    lastFrameSeq: 0,
    currentResizeEpoch: 0,
    cursor: { row: 0, col: 0, visible: true, shape: "block" },
    sessionId: null,
    connected: false,
    title: "Rain",
    rows: 24,
    cols: 80,
    visibleBaseGlobal: 0,
    visibleLinesByGlobal: {},
    altScreen: false,
    awaitingNonAltReseed: false,
    altScreenLines: [],
    fallbackLines: [],
    snapshots: [],
    scrollbackLines: [],
    shellIntegrationActive: false,
    pendingBlock: null,
    activeBlock: null,
    cwd: "",
    lastNonAltVisibleBaseGlobal: 0,
    lastNonAltCursorRow: 0,
    lastAltExitVisibleBase: null,
    scrollOffset: 0,
    mouseTracking: false,
    mouseMotion: false,
    sgrMouse: false,
    focusEvents: false,
    searchOpen: false,
    searchQuery: "",
    searchMatches: [],
    searchCurrentIndex: -1,
  });

  function applyRenderFrame(payload: RenderFramePayload) {
    const { frame } = payload;

    setState(
      produce((s) => {
        // --- ALWAYS apply ALL events, even on stale frames ---
        // Events are state transitions (shell integration, alt screen, title, etc.)
        // that must never be dropped by epoch/seq gating. Dropping block events
        // during resize causes shellIntegrationActive to never activate, leaving
        // the terminal blank on startup.
        for (const event of frame.events) {
          switch (event.type) {
            case "AltScreenEntered":
              s.altScreen = true;
              s.awaitingNonAltReseed = false;
              s.altScreenLines = [];
              // Only drop visible context when fullscreen TUI is active;
              // inline mode keeps it so history can still render.
              if (config().clearHistoryForTuis) {
                s.visibleLinesByGlobal = {};
              }
              break;
            case "AltScreenExited":
              s.altScreen = false;
              s.altScreenLines = [];
              // Preserve visible context in inline mode until reseed replaces it
              if (config().clearHistoryForTuis) {
                s.visibleLinesByGlobal = {};
              }
              s.awaitingNonAltReseed = true;
              s.fallbackLines = [];
              // Track the viewport origin so finalizeActiveBlock can capture
              // farewell text that starts before the original outputStart.
              s.lastAltExitVisibleBase = frame.visible_base_global;
              // If activeBlock already exists, reset outputStart directly.
              if (s.activeBlock) {
                s.activeBlock.outputStart = frame.visible_base_global;
              }
              break;
            case "TitleChanged":
              s.title = event.title;
              break;
            case "CwdChanged":
              s.cwd = event.path;
              break;
            case "Bell":
              break;
            case "MouseModeChanged":
              s.mouseTracking = event.tracking;
              s.mouseMotion = event.motion;
              s.sgrMouse = event.sgr;
              s.focusEvents = event.focus;
              break;
            case "ScrollbackCleared":
              // CSI 3J: clear scrollback history
              s.scrollbackLines = [];
              break;
            case "InlineImage":
              // Handled by Terminal component
              break;
            default:
              // BlockCompleted is ALWAYS deferred to after line processing
              // so finalizeActiveBlock sees the latest visibleLinesByGlobal
              // (e.g. farewell text that arrived in the same frame).
              // Other block events (BlockStarted, BlockCommand) are processed
              // immediately when possible so activeBlock is set promptly —
              // AltScreenExited needs it to exist for outputStart resets.
              if (event.type === "BlockCompleted" || s.altScreen || s.awaitingNonAltReseed) {
                queuedBlockEvents.push(event);
              } else {
                if (queuedBlockEvents.length > 0) {
                  const queued = queuedBlockEvents.splice(0, queuedBlockEvents.length);
                  for (const q of queued) {
                    processBlockEvent(s, q);
                  }
                }
                processBlockEvent(s, event);
              }
              break;
          }
        }

        // --- Epoch/seq gates for renderable content only ---
        const frameResizeEpoch = Math.max(0, frame.resize_epoch ?? 0);
        if (frameResizeEpoch < s.currentResizeEpoch) {
          if (frameDebug) {
            console.debug(
              `[Rain][frame] drop stale-epoch content sid=${payload.session_id.slice(0, 8)} frame_seq=${frame.frame_seq} frame_epoch=${frameResizeEpoch} current_epoch=${s.currentResizeEpoch} (events were applied)`,
            );
          }
          return;
        }
        if (frameResizeEpoch > s.currentResizeEpoch) {
          s.currentResizeEpoch = frameResizeEpoch;
        }

        if (frame.frame_seq <= s.lastFrameSeq) {
          if (frameDebug) {
            console.debug(
              `[Rain][frame] drop stale-seq content sid=${payload.session_id.slice(0, 8)} frame_seq=${frame.frame_seq} last_seq=${s.lastFrameSeq} epoch=${frameResizeEpoch} (events were applied)`,
            );
          }
          return;
        }
        s.lastFrameSeq = frame.frame_seq;

        const prevRows = s.rows;
        const prevCols = s.cols;
        const frameRows = Math.max(1, frame.visible_rows || s.rows);
        const frameCols = Math.max(1, frame.visible_cols || s.cols);
        const viewportChanged = frameRows !== prevRows || frameCols !== prevCols;
        s.cursor = frame.cursor;
        s.rows = frameRows;
        s.cols = frameCols;

        // During inline TUI mode, the backend sends visible_base_global=0
        // for alt-screen frames. Don't overwrite the real base or history
        // lookups will break. Keep the last non-alt value instead.
        const isInlineTui = s.altScreen && !config().clearHistoryForTuis;
        if (!isInlineTui) {
          s.visibleBaseGlobal = frame.visible_base_global;
        }

        // Snapshot non-alt anchors so inline history can render correctly
        if (!s.altScreen) {
          s.lastNonAltVisibleBaseGlobal = frame.visible_base_global;
          s.lastNonAltCursorRow = frame.cursor.row;
        }

        if (!s.altScreen && frame.scrolled_lines && frame.scrolled_lines.length > 0) {
          const startGlobal = Math.max(
            0,
            frame.visible_base_global - frame.scrolled_lines.length,
          );
          for (let i = 0; i < frame.scrolled_lines.length; i++) {
            const line = frame.scrolled_lines[i];
            const global = startGlobal + i;
            s.scrollbackLines[global] = {
              index: global,
              spans: line.spans,
            };
          }
        }

        if (s.altScreen) {
          if (viewportChanged) {
            // Alt-screen TUIs repaint on SIGWINCH; don't merge stale viewport content.
            s.altScreenLines = frame.lines.map((line) => ({
              index: line.index,
              spans: line.spans,
            }));
          } else {
            applyLinesToBuffer(s.altScreenLines, frame.lines);
          }
          trimBufferToRows(s.altScreenLines, frameRows);
        } else {
          applyLinesToBuffer(s.fallbackLines, frame.lines);
          trimBufferToRows(s.fallbackLines, frameRows);

          // Keep a bounded visible map keyed by global row.
          // Preserve unchanged lines in the current viewport range and apply
          // incoming dirty lines at their global row IDs.
          const visibleStart = frame.visible_base_global;
          const visibleEndExclusive = visibleStart + frameRows;
          const nextVisible: Record<number, RenderedLine> = {};

          // When keeping history for TUIs, preserve all existing history keys
          // that are outside the current viewport. This prevents post-TUI
          // grid erases (CSI 2J) from wiping history line data that snapshots
          // and fallback rendering depend on.
          const preserveHistory = !config().clearHistoryForTuis;

          for (const key of Object.keys(s.visibleLinesByGlobal)) {
            const global = Number(key);
            if (!Number.isFinite(global)) continue;
            if (global >= visibleStart && global < visibleEndExclusive) {
              nextVisible[global] = s.visibleLinesByGlobal[global];
            } else if (preserveHistory && global < visibleStart) {
              // Keep history keys below the viewport so they survive grid erases
              nextVisible[global] = s.visibleLinesByGlobal[global];
            }
          }

          for (const line of frame.lines) {
            const global = frame.visible_base_global + line.index;
            const incoming: RenderedLine = { index: global, spans: line.spans };

            // When preserving history, don't overwrite existing non-empty
            // history lines with blank lines from a post-TUI grid erase.
            if (preserveHistory && global < visibleStart) {
              const existing = nextVisible[global];
              const incomingEmpty = incoming.spans.length === 0 ||
                incoming.spans.every((sp) => sp.text.trim() === "");
              if (existing && incomingEmpty) continue;
            }

            nextVisible[global] = incoming;
          }

          s.visibleLinesByGlobal = nextVisible;

          if (s.awaitingNonAltReseed && hasAllVisibleRows(s.fallbackLines, frameRows)) {
            s.awaitingNonAltReseed = false;
          }
        }

        // Flush queued block events AFTER line processing so that
        // finalizeActiveBlock/processBlockEvent always sees the latest
        // visibleLinesByGlobal (including farewell text from this frame).
        if (!s.altScreen && !s.awaitingNonAltReseed && queuedBlockEvents.length > 0) {
          const queued = queuedBlockEvents.splice(0, queuedBlockEvents.length);
          for (const q of queued) {
            processBlockEvent(s, q);
          }
        }

        if (frameDebug) {
          console.debug(
            `[Rain][frame] apply sid=${payload.session_id.slice(0, 8)} frame_seq=${frame.frame_seq} epoch=${frameResizeEpoch} rows=${frameRows} cols=${frameCols} lines=${frame.lines.length} scrolled=${frame.scrolled_lines?.length ?? 0} events=${frame.events.length}`,
          );
        }
      }),
    );
  }

  function applyResizeAck(payload: ResizeAckPayload) {
    setState(
      produce((s) => {
        if (payload.resize_epoch < s.currentResizeEpoch) {
          return;
        }

        const prevRows = s.rows;
        const prevCols = s.cols;
        const ackRows = Math.max(1, payload.rows || s.rows);
        const ackCols = Math.max(1, payload.cols || s.cols);
        const dimsChanged = ackRows !== prevRows || ackCols !== prevCols;
        const shrinking = ackRows < prevRows || ackCols < prevCols;

        if (frameDebug) {
          console.debug(
            `[Rain][resize-ack] sid=${payload.session_id.slice(0, 8)} rows=${payload.rows} cols=${payload.cols} frame_seq=${payload.frame_seq} ack_epoch=${payload.resize_epoch} prev_epoch=${s.currentResizeEpoch} dims_changed=${dimsChanged}`,
          );
        }

        s.currentResizeEpoch = payload.resize_epoch;
        s.rows = ackRows;
        s.cols = ackCols;

        if (!dimsChanged) {
          return;
        }

        if (s.altScreen) {
          s.altScreenLines = [];
        }

        if (shrinking) {
          trimBufferToRows(s.fallbackLines, ackRows);
          s.visibleLinesByGlobal = {};
        }
      }),
    );
  }

  function clearHistory() {
    queuedBlockEvents.length = 0;
    setState(
      produce((s) => {
        resetStoreHistory(s);
      }),
    );
  }

  function scrollUp(lines: number) {
    setState(
      produce((s) => {
        const maxScroll = Math.max(0, s.scrollbackLines.length);
        s.scrollOffset = Math.min(s.scrollOffset + lines, maxScroll);
      }),
    );
  }

  function scrollDown(lines: number) {
    setState(
      produce((s) => {
        s.scrollOffset = Math.max(0, s.scrollOffset - lines);
      }),
    );
  }

  function scrollToBottom() {
    setState("scrollOffset", 0);
  }

  return { state, setState, applyRenderFrame, applyResizeAck, clearHistory, scrollUp, scrollDown, scrollToBottom };
}

function applyLinesToBuffer(buffer: RenderedLine[], incoming: RenderedLine[]) {
  for (const line of incoming) {
    const idx = buffer.findIndex((l) => l.index === line.index);
    if (idx >= 0) {
      buffer[idx] = line;
    } else {
      buffer.push(line);
    }
  }
  buffer.sort((a, b) => a.index - b.index);
}

function trimBufferToRows(buffer: RenderedLine[], maxRows: number) {
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (buffer[i].index >= maxRows) {
      buffer.splice(i, 1);
    }
  }
}

function hasAllVisibleRows(buffer: RenderedLine[], rows: number): boolean {
  if (rows <= 0) return true;
  const present = new Set<number>();
  for (const line of buffer) present.add(line.index);
  for (let i = 0; i < rows; i++) {
    if (!present.has(i)) return false;
  }
  return true;
}

function processBlockEvent(state: TerminalStoreState, event: TerminalEvent) {
  switch (event.type) {
    case "BlockStarted": {
      state.shellIntegrationActive = true;
      state.pendingBlock = { id: event.id, cwd: event.cwd };
      break;
    }
    case "BlockCommand": {
      state.shellIntegrationActive = true;
      const pending = state.pendingBlock && state.pendingBlock.id === event.id
        ? state.pendingBlock
        : null;
      state.pendingBlock = null;
      state.activeBlock = {
        id: event.id,
        command: event.command,
        cwd: pending?.cwd ?? state.cwd,
        startTime: Date.now(),
        outputStart: event.global_row,
      };
      break;
    }
    case "BlockCompleted": {
      state.shellIntegrationActive = true;
      finalizeActiveBlock(state, event);
      break;
    }
    default:
      break;
  }
}

function finalizeActiveBlock(state: TerminalStoreState, event: TerminalEvent) {
  if (event.type !== "BlockCompleted") return;
  const active = state.activeBlock;
  if (!active || active.id !== event.id) return;

  if (isClearCommand(active.command)) {
    resetStoreHistory(state);
    return;
  }

  const endExclusive = event.global_row + 1;
  let start = active.outputStart ?? endExclusive;
  // If the command used alt screen, farewell text may start before
  // the original outputStart (e.g. after CSI 2J + CSI H moves cursor
  // to row 0). Use the viewport origin from alt screen exit.
  if (state.lastAltExitVisibleBase !== null) {
    start = Math.min(start, state.lastAltExitVisibleBase);
    state.lastAltExitVisibleBase = null;
  }
  const lines = collectLinesForRange(
    state.scrollbackLines,
    state.visibleLinesByGlobal,
    state.visibleBaseGlobal,
    start,
    endExclusive,
  );
  const trimmed = trimTrailingEmpty(lines);
  const failed = event.exit_code !== 0 || detectFailure(trimmed);

  if (active.command || trimmed.length > 0) {
    state.snapshots.push({
      id: `snap-${event.id}-${++snapshotCounter}`,
      command: active.command,
      lines: trimmed,
      timestamp: active.startTime || Date.now(),
      endTime: Date.now(),
      cwd: active.cwd || state.cwd,
      failed,
    });
  }

  state.activeBlock = null;
}
