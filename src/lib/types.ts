// TypeScript types mirroring the Rust IPC structs.

export interface RenderFramePayload {
  session_id: string;
  frame: RenderFrame;
}

export interface RenderFrame {
  lines: RenderedLine[];
  scrolled_lines: RenderedLine[];
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
  | { type: "CwdChanged"; path: string };

export interface SessionEndPayload {
  session_id: string;
  exit_code: number | null;
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
  cursor: CursorRender;
  sessionId: string | null;
  connected: boolean;
  title: string;
  rows: number;
  cols: number;
  altScreen: boolean;
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
}

// Tab types

export interface TabData {
  id: string;
  type: "terminal" | "settings";
  label: string;
  customLabel: string | null;
  sessionId: string | null;
  cwd: string;
}
