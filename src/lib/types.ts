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
  | {
      type: "MouseModeChanged";
      tracking: boolean;
      motion: boolean;
      all_motion: boolean;
      sgr: boolean;
      utf8: boolean;
      focus: boolean;
      alt_scroll: boolean;
      synchronized_output: boolean;
      bracketed_paste: boolean;
      cursor_keys_application: boolean;
    }
  | { type: "ScrollbackCleared" }
  | { type: "InlineImage"; id: string; data_base64: string; width: number; height: number; row: number; col: number }
  | { type: "SixelImage"; id: string; data_base64: string; width: number; height: number; row: number; col: number }
  | { type: "KittyImage"; id: string; action: string; data_base64: string; width: number; height: number; row: number; col: number; image_id: number; placement_id: number }
  | { type: "TmuxRequested"; args: string };

export interface SessionEndPayload {
  session_id: string;
  exit_code: number | null;
}

export interface CreateSessionResult {
  session_id: string;
  inside_tmux: boolean;
}

export interface ResizeAckPayload {
  session_id: string;
  rows: number;
  cols: number;
  frame_seq: number;
  resize_epoch: number;
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
  tmuxCommand: boolean;
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
  mouseAllMotion: boolean;
  sgrMouse: boolean;
  utf8Mouse: boolean;
  focusEvents: boolean;
  altScroll: boolean;
  synchronizedOutput: boolean;
  bracketedPaste: boolean;
  cursorKeysApplication: boolean;
  // tmux-aware rendering fallback state
  tmuxActive: boolean;
  tmuxCompatibilityNotice: boolean;
  // tmux control mode: pane ID assigned by the controller (null for regular sessions)
  tmuxPaneId: number | null;
  // Viewport origin at the moment of the last alt-screen exit.
  // Used by finalizeActiveBlock to capture farewell text that may
  // start before the original outputStart.
  lastAltExitVisibleBase: number | null;
  // Whether search bar is open
  searchOpen: boolean;
  searchQuery: string;
  searchMatches: SearchMatch[];
  searchCurrentIndex: number;
  // Visual bell trigger flag
  bell: boolean;
  // Inline images from image protocols (iTerm2 OSC 1337, Sixel, Kitty)
  inlineImages: InlineImageEntry[];
}

export interface InlineImageEntry {
  id: string;
  dataUri: string;
  width: number;
  height: number;
  row: number;
  col: number;
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
  /** Non-null when this tab represents a tmux window */
  tmuxSessionName?: string | null;
  /** tmux window ID this tab corresponds to */
  tmuxWindowId?: number | null;
  /** Optional color badge for visual tab identification */
  tabColor?: string | null;
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

// Cross-window transfer payloads

export interface SessionTransferSpan {
  text: string;
  fg: SerializableColor;
  bg: SerializableColor;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  url?: string | null;
}

export interface SessionTransferLine {
  index: number;
  spans: SessionTransferSpan[];
}

export interface SessionTransferSnapshot {
  id: string;
  command: string;
  lines: SessionTransferLine[];
  timestamp: number;
  end_time: number | null;
  cwd: string;
  failed: boolean;
}

export interface SessionTransferActiveBlock {
  id: string;
  command: string;
  cwd: string;
  start_time: number;
  output_start: number;
  tmux_command: boolean;
}

export interface SessionTransferState {
  cwd: string;
  shell_integration_active: boolean;
  snapshots: SessionTransferSnapshot[];
  active_block: SessionTransferActiveBlock | null;
}

export type TabTransferPaneNode =
  | { type: "leaf"; sessionId: string }
  | {
      type: "split";
      direction: "horizontal" | "vertical";
      ratio: number;
      first: TabTransferPaneNode;
      second: TabTransferPaneNode;
    };

export interface TabTransferPaneSession {
  sessionId: string;
  state: SessionTransferState;
}

export interface TabTransferManifest {
  label: string;
  customLabel: string | null;
  cwd: string;
  paneTree: TabTransferPaneNode;
  activeSessionId: string;
  paneSessions: TabTransferPaneSession[];
}

