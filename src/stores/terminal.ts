import { createStore, produce } from "solid-js/store";
import type { RenderedLine, RenderFramePayload, TerminalEvent, TerminalStoreState } from "../lib/types";
import { collectLinesForRange, trimTrailingEmpty } from "../lib/terminal-output";

export interface TerminalStore {
  state: TerminalStoreState;
  setState: ReturnType<typeof createStore<TerminalStoreState>>[1];
  applyRenderFrame: (payload: RenderFramePayload) => void;
  clearHistory: () => void;
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

export function createTerminalStore(): TerminalStore {
  const [state, setState] = createStore<TerminalStoreState>({
    cursor: { row: 0, col: 0, visible: true, shape: "block" },
    sessionId: null,
    connected: false,
    title: "Rain",
    rows: 24,
    cols: 80,
    altScreen: false,
    altScreenLines: [],
    fallbackLines: [],
    snapshots: [],
    scrollbackLines: [],
    shellIntegrationActive: false,
    pendingBlock: null,
    activeBlock: null,
    cwd: "",
  });

  function applyRenderFrame(payload: RenderFramePayload) {
    const { frame } = payload;

    setState(
      produce((s) => {
        s.cursor = frame.cursor;

        const deferredBlockEvents: TerminalEvent[] = [];
        for (const event of frame.events) {
          switch (event.type) {
            case "AltScreenEntered":
              s.altScreen = true;
              s.altScreenLines = [];
              break;
            case "AltScreenExited":
              s.altScreen = false;
              s.altScreenLines = [];
              break;
            case "TitleChanged":
              s.title = event.title;
              break;
            case "CwdChanged":
              s.cwd = event.path;
              break;
            case "Bell":
              break;
            default:
              deferredBlockEvents.push(event);
              break;
          }
        }

        if (!s.altScreen && frame.scrolled_lines && frame.scrolled_lines.length > 0) {
          for (const line of frame.scrolled_lines) {
            s.scrollbackLines.push({
              index: s.scrollbackLines.length,
              spans: line.spans,
            });
          }
        }

        if (s.altScreen) {
          applyLinesToBuffer(s.altScreenLines, frame.lines);
        } else {
          applyLinesToBuffer(s.fallbackLines, frame.lines);
        }

        for (const event of deferredBlockEvents) {
          processBlockEvent(s, event);
        }
      }),
    );
  }

  function clearHistory() {
    setState(
      produce((s) => {
        s.snapshots = [];
        s.scrollbackLines = [];
        s.fallbackLines = [];
        s.pendingBlock = null;
        s.activeBlock = null;
      }),
    );
  }

  return { state, setState, applyRenderFrame, clearHistory };
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
        outputStart: event.global_row + 1,
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

  const endExclusive = event.global_row + 1;
  const start = active.outputStart ?? endExclusive;
  const lines = collectLinesForRange(
    state.scrollbackLines,
    state.fallbackLines,
    state.rows,
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
