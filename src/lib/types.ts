// TypeScript types mirroring the Rust IPC structs.

export interface RenderFramePayload {
  session_id: string;
  frame: RenderFrame;
}

export interface RenderFrame {
  frame_seq: number;
  resize_epoch: number;
  lines: RenderedLine[];
  scrolled_lines: RenderedLine[];
  visible_base_global: number;
  visible_rows: number;
  visible_cols: number;
  cursor: CursorRender;
  events: TerminalEvent[];
}

export interface RenderedLine {
  index: number;
  spans: StyledSpan[];
}

export interface StyledSpan {
  text: string;
  fg: SerializableColor;
  bg: SerializableColor;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  url?: string;
}

export interface SearchMatch {
  globalRow: number;
  startCol: number;
  endCol: number;
}

export type SerializableColor =
  | { type: "Default" }
  | { type: "Indexed"; index: number }
  | { type: "Rgb"; r: number; g: number; b: number };

export interface CursorRender {
  row: number;
  col: number;
  visible: boolean;
  shape: "block" | "underline" | "bar";
}

export type TerminalEvent =
  | { type: "BlockStarted"; id: string; cwd: string; global_row: number }
  | { type: "BlockCommand"; id: string; command: string; global_row: number }
  | { type: "BlockCompleted"; id: string; exit_code: number; global_row: number }
  | { type: "TitleChanged"; title: string }
  | { type: "AltScreenEntered" }
  | { type: "AltScreenExited" }
  | { type: "Bell" }
  | { type: "CwdChanged"; path: string }
  | { type: "MouseModeChanged"; tracking: boolean; motion: boolean; sgr: boolean; focus: boolean }
  | { type: "ScrollbackCleared" }
  | { type: "InlineImage"; id: string; data_base64: string; width: number; height: number; row: number; col: number };

export interface SessionEndPayload {
  session_id: string;
  exit_code: number | null;
}

export interface ResizeAckPayload {
  session_id: string;
  rows: number;
  cols: number;
  frame_seq: number;
  resize_epoch: number;
}

// Frontend-specific types

export interface Block {
  id: string;
  prompt: string;
  command: string | null;
  lines: RenderedLine[];
  status: "prompt" | "running" | "complete";
  exitCode: number | null;
  cwd: string;
  startTime: number;
  endTime: number | null;
}

// A frozen snapshot of a completed command's output.
export interface CommandSnapshot {
  id: string;
  command: string;
  lines: RenderedLine[];
  timestamp: number;
  endTime: number | null;
  cwd: string;
  failed: boolean;
}

export interface PendingBlock {
  id: string;
  cwd: string;
}

export interface ActiveBlock {
  id: string;
  command: string;
  cwd: string;
  startTime: number;
  outputStart: number;
}

export interface TerminalStoreState {
  // Highest frame sequence applied to this store (stale frames are ignored)
  lastFrameSeq: number;
  // Latest resize generation applied to this store.
  currentResizeEpoch: number;
  cursor: CursorRender;
  sessionId: string | null;
  connected: boolean;
  title: string;
  rows: number;
  cols: number;
  // Global row represented by visible row 0 of the latest non-alt frame
  visibleBaseGlobal: number;
  // Visible lines keyed by global row for block-range lookups
  visibleLinesByGlobal: Record<number, RenderedLine>;
  altScreen: boolean;
  // When true, block slicing is paused until we receive a fresh non-alt frame
  // that reseeds visibleLinesByGlobal.
  awaitingNonAltReseed: boolean;
  altScreenLines: RenderedLine[];
  fallbackLines: RenderedLine[];
  // Completed command blocks
  snapshots: CommandSnapshot[];
  // Lines scrolled off the visible grid (global scrollback)
  scrollbackLines: RenderedLine[];
  // True when shell integration (OSC 133) has been detected
  shellIntegrationActive: boolean;
  // Pending block data from prompt start (OSC 133;A)
  pendingBlock: PendingBlock | null;
  // Active running block (OSC 133;B .. D)
  activeBlock: ActiveBlock | null;
  // Current working directory
  cwd: string;
  // Last non-alt viewport base (preserved during alt screen for inline history)
  lastNonAltVisibleBaseGlobal: number;
  // Last non-alt cursor row (preserved during alt screen for inline history)
  lastNonAltCursorRow: number;
  // Grid-level scroll offset (0 = at bottom / live, positive = lines scrolled back)
  scrollOffset: number;
  // Mouse mode flags from backend
  mouseTracking: boolean;
  mouseMotion: boolean;
  sgrMouse: boolean;
  focusEvents: boolean;
  // Viewport origin at the moment of the last alt-screen exit.
  // Used by finalizeActiveBlock to capture farewell text that may
  // start before the original outputStart.
  lastAltExitVisibleBase: number | null;
  // Whether search bar is open
  searchOpen: boolean;
  searchQuery: string;
  searchMatches: SearchMatch[];
  searchCurrentIndex: number;
}

// Tab types

export interface TabData {
  id: string;
  type: "terminal" | "settings";
  label: string;
  customLabel: string | null;
  sessionId: string | null;
  cwd: string;
  paneTree?: PaneNode;
  activePaneId?: string;
}

// Split pane types
export type PaneNode =
  | PaneLeaf
  | PaneSplit;

export interface PaneLeaf {
  type: "leaf";
  id: string;
  sessionId: string;
}

export interface PaneSplit {
  type: "split";
  id: string;
  direction: "horizontal" | "vertical";
  ratio: number;
  first: PaneNode;
  second: PaneNode;
}

// Time grouping for command snapshots
export interface TimeGroupData {
  timestamp: number;
  snapshots: CommandSnapshot[];
}
