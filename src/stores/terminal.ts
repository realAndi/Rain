import { createStore, produce } from "solid-js/store";
import type {
  RenderedLine,
  RenderFramePayload,
  ResizeAckPayload,
  TerminalEvent,
  TerminalStoreState,
} from "../lib/types";
import { collectLinesForRange, trimTrailingEmpty } from "../lib/terminal-output";
import { checkOutput, executeTriggerAction } from "../lib/triggers";
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

const DEFAULT_SNAPSHOT_LIMIT = 1_000;

function resolveSnapshotLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SNAPSHOT_LIMIT;
  return Math.max(100, Math.floor(value));
}

function resolveScrollbackLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 10_000;
  return Math.max(1_000, Math.floor(value));
}

function pruneScrollbackLines(
  scrollbackLines: RenderedLine[],
  visibleBaseGlobal: number,
  scrollbackLimit: number,
): RenderedLine[] {
  const minGlobal = Math.max(0, visibleBaseGlobal - scrollbackLimit);
  if (minGlobal <= 0) return scrollbackLines;
  return scrollbackLines.filter((line) => line.index >= minGlobal);
}

function getMaxScrollOffset(state: TerminalStoreState): number {
  const lines = state.scrollbackLines;
  if (lines.length === 0 || state.visibleBaseGlobal <= 0) return 0;
  const oldest = lines[0]?.index ?? state.visibleBaseGlobal;
  return Math.max(0, state.visibleBaseGlobal - oldest);
}

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
  if (state.altScreen) {
    state.snapshots = [];
    state.scrollbackLines = [];
    state.fallbackLines = [];
    state.visibleLinesByGlobal = {};
    return;
  }
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
  state.tmuxActive = false;
  state.tmuxCompatibilityNotice = false;
}

function isTmuxCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  return /(^|[\s;&|/])tmux(\s|$)/.test(trimmed);
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
    mouseAllMotion: false,
    sgrMouse: false,
    utf8Mouse: false,
    focusEvents: false,
    altScroll: false,
    synchronizedOutput: false,
    bracketedPaste: false,
    cursorKeysApplication: false,
    tmuxActive: false,
    tmuxCompatibilityNotice: false,
    tmuxPaneId: null,
    searchOpen: false,
    searchQuery: "",
    searchMatches: [],
    searchCurrentIndex: -1,
    bell: false,
    inlineImages: [],
  });

  function applyRenderFrame(payload: RenderFramePayload) {
    const { frame } = payload;
    const snapshotLimit = resolveSnapshotLimit(config().snapshotLimit);
    const scrollbackLimit = resolveScrollbackLimit(config().scrollbackLines);

    setState(
      produce((s) => {
        for (const event of frame.events) {
          switch (event.type) {
            case "AltScreenEntered":
              s.altScreen = true;
              s.awaitingNonAltReseed = false;
              s.altScreenLines = [];
              s.scrollOffset = 0;
              if (config().clearHistoryForTuis) {
                s.visibleLinesByGlobal = {};
              }
              break;
            case "AltScreenExited":
              s.altScreen = false;
              s.altScreenLines = [];
              s.scrollOffset = 0;
              if (config().clearHistoryForTuis) {
                s.visibleLinesByGlobal = {};
              }
              s.awaitingNonAltReseed = true;
              s.fallbackLines = [];
              s.lastAltExitVisibleBase = frame.visible_base_global;
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
              s.bell = true;
              break;
            case "MouseModeChanged":
              s.mouseTracking = event.tracking;
              s.mouseMotion = event.motion;
              s.mouseAllMotion = event.all_motion;
              s.sgrMouse = event.sgr;
              s.utf8Mouse = event.utf8;
              s.focusEvents = event.focus;
              s.altScroll = event.alt_scroll;
              s.synchronizedOutput = event.synchronized_output;
              s.bracketedPaste = event.bracketed_paste;
              s.cursorKeysApplication = event.cursor_keys_application;
              break;
            case "ScrollbackCleared":
              s.scrollbackLines = [];
              break;
            case "InlineImage": {
              const imgEvent = event as { type: "InlineImage"; id: string; data_base64: string; width: number; height: number; row: number; col: number };
              s.inlineImages = [...s.inlineImages, {
                id: imgEvent.id,
                dataUri: `data:image/png;base64,${imgEvent.data_base64}`,
                width: imgEvent.width,
                height: imgEvent.height,
                row: imgEvent.row,
                col: imgEvent.col,
              }];
              if (s.inlineImages.length > 50) {
                s.inlineImages = s.inlineImages.slice(-50);
              }
              break;
            }
            case "SixelImage": {
              const sixelEvent = event as { type: "SixelImage"; id: string; data_base64: string; width: number; height: number; row: number; col: number };
              s.inlineImages = [...s.inlineImages, {
                id: sixelEvent.id,
                dataUri: `data:image/png;base64,${sixelEvent.data_base64}`,
                width: sixelEvent.width,
                height: sixelEvent.height,
                row: sixelEvent.row,
                col: sixelEvent.col,
              }];
              if (s.inlineImages.length > 50) {
                s.inlineImages = s.inlineImages.slice(-50);
              }
              break;
            }
            case "KittyImage": {
              const kittyEvent = event as { type: "KittyImage"; id: string; data_base64: string; width: number; height: number; row: number; col: number };
              s.inlineImages = [...s.inlineImages, {
                id: kittyEvent.id,
                dataUri: `data:image/png;base64,${kittyEvent.data_base64}`,
                width: kittyEvent.width,
                height: kittyEvent.height,
                row: kittyEvent.row,
                col: kittyEvent.col,
              }];
              if (s.inlineImages.length > 50) {
                s.inlineImages = s.inlineImages.slice(-50);
              }
              break;
            }
            case "TmuxRequested":
              break;
            default:
              if (event.type === "BlockCompleted" || s.altScreen || s.awaitingNonAltReseed) {
                queuedBlockEvents.push(event);
              } else {
                if (queuedBlockEvents.length > 0) {
                  const kept: typeof queuedBlockEvents = [];
                  const flushed = queuedBlockEvents.splice(0, queuedBlockEvents.length);
                  for (const q of flushed) {
                    if (q.type === "BlockCompleted") {
                      kept.push(q);
                    } else {
                      processBlockEvent(s, q, config().terminalStyle, snapshotLimit);
                    }
                  }
                  if (kept.length > 0) queuedBlockEvents.push(...kept);
                }
                processBlockEvent(s, event, config().terminalStyle, snapshotLimit);
              }
              break;
          }
        }

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

        const isInlineTui = s.altScreen && !config().clearHistoryForTuis;
        if (!isInlineTui) {
          s.visibleBaseGlobal = frame.visible_base_global;
        }

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
            s.scrollbackLines.push({
              index: global,
              spans: line.spans,
            });
          }
          s.scrollbackLines = pruneScrollbackLines(s.scrollbackLines, frame.visible_base_global, scrollbackLimit);
        }

        if (s.altScreen) {
          if (viewportChanged) {
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

          const visibleStart = frame.visible_base_global;
          const visibleEndExclusive = visibleStart + frameRows;
          const nextVisible: Record<number, RenderedLine> = {};

          const preserveHistory = !config().clearHistoryForTuis;
          // Bound how far back we preserve visible history keys
          const minHistoryGlobal = Math.max(0, visibleStart - scrollbackLimit);

          for (const key of Object.keys(s.visibleLinesByGlobal)) {
            const global = Number(key);
            if (!Number.isFinite(global)) continue;
            if (global >= visibleStart && global < visibleEndExclusive) {
              nextVisible[global] = s.visibleLinesByGlobal[global];
            } else if (preserveHistory && global >= minHistoryGlobal && global < visibleStart) {
              nextVisible[global] = s.visibleLinesByGlobal[global];
            }
          }

          for (const line of frame.lines) {
            const global = frame.visible_base_global + line.index;
            const incoming: RenderedLine = { index: global, spans: line.spans };

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

        if (!s.altScreen && !s.awaitingNonAltReseed && queuedBlockEvents.length > 0) {
          const queued = queuedBlockEvents.splice(0, queuedBlockEvents.length);
          for (const q of queued) {
            processBlockEvent(s, q, config().terminalStyle, snapshotLimit);
          }
        }

        if (frameDebug) {
          console.debug(
            `[Rain][frame] apply sid=${payload.session_id.slice(0, 8)} frame_seq=${frame.frame_seq} epoch=${frameResizeEpoch} rows=${frameRows} cols=${frameCols} lines=${frame.lines.length} scrolled=${frame.scrolled_lines?.length ?? 0} events=${frame.events.length}`,
          );
        }
      }),
    );

    for (const line of frame.lines) {
      const text = line.spans.map((s: { text: string }) => s.text).join("");
      if (text.trim()) {
        const trigger = checkOutput(text);
        if (trigger) {
          executeTriggerAction(trigger, text);
        }
      }
    }
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
        const maxScroll = getMaxScrollOffset(s);
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
  if (incoming.length === 0) return;

  const byIndex = new Map<number, number>();
  for (let i = 0; i < buffer.length; i++) {
    byIndex.set(buffer[i].index, i);
  }

  const toAppend: RenderedLine[] = [];
  for (const line of incoming) {
    const existing = byIndex.get(line.index);
    if (existing !== undefined) {
      buffer[existing] = line;
    } else {
      toAppend.push(line);
    }
  }

  if (toAppend.length > 0) {
    buffer.push(...toAppend);
    buffer.sort((a, b) => a.index - b.index);
  }
}

function trimBufferToRows(buffer: RenderedLine[], maxRows: number) {
  let writeIdx = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i].index < maxRows) {
      buffer[writeIdx++] = buffer[i];
    }
  }
  buffer.length = writeIdx;
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

function processBlockEvent(
  state: TerminalStoreState,
  event: TerminalEvent,
  terminalStyle: "chat" | "traditional",
  snapshotLimit: number,
) {
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
      const tmuxCommand = isTmuxCommand(event.command);
      if (tmuxCommand) {
        if (!state.tmuxActive && terminalStyle === "chat") {
          state.tmuxCompatibilityNotice = true;
        }
        state.tmuxActive = true;
      }
      state.activeBlock = {
        id: event.id,
        command: event.command,
        cwd: pending?.cwd ?? state.cwd,
        startTime: Date.now(),
        outputStart: event.global_row,
        tmuxCommand,
      };
      break;
    }
    case "BlockCompleted": {
      state.shellIntegrationActive = true;
      finalizeActiveBlock(state, event, snapshotLimit);
      break;
    }
    default:
      break;
  }
}

function finalizeActiveBlock(
  state: TerminalStoreState,
  event: TerminalEvent,
  snapshotLimit: number,
) {
  if (event.type !== "BlockCompleted") return;
  const active = state.activeBlock;
  if (!active || active.id !== event.id) return;

  if (isClearCommand(active.command)) {
    resetStoreHistory(state);
    return;
  }

  const endExclusive = event.global_row + 1;
  let start = active.outputStart ?? endExclusive;
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

    if (state.snapshots.length > snapshotLimit) {
      state.snapshots = state.snapshots.slice(-snapshotLimit);
    }

    if (typeof document !== "undefined" && document.hidden) {
      const elapsed = Date.now() - (active.startTime ?? Date.now());
      if (elapsed > 5000 && active.command) {
        if (typeof Notification !== "undefined" && Notification.permission === "default") {
          Notification.requestPermission().catch(() => {});
        }
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          try {
            const status = event.exit_code === 0 ? "completed" : "failed";
            new Notification(`Command ${status}`, {
              body: active.command,
              silent: true,
            });
          } catch {
            // Notifications may not be available
          }
        }
      }
    }
  }

  if (active.tmuxCommand) {
    state.tmuxActive = false;
  }
  state.activeBlock = null;
}
