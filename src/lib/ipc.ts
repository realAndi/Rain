import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  RenderFramePayload,
  ResizeAckPayload,
  SessionEndPayload,
  CreateSessionResult,
  SessionTransferState,
  TabTransferManifest,
} from "./types";

// Typed wrappers around Tauri IPC commands

export async function createSession(
  shell?: string,
  cwd?: string,
  rows?: number,
  cols?: number,
  env?: Record<string, string>,
  tmuxMode?: "integrated" | "native",
): Promise<CreateSessionResult> {
  return invoke<CreateSessionResult>("create_session", {
    shell,
    cwd,
    rows,
    cols,
    env,
    tmuxMode,
  });
}

export async function writeInput(sessionId: string, data: number[]): Promise<void> {
  return invoke("write_input", { sessionId, data });
}

export async function resizeTerminal(
  sessionId: string,
  rows: number,
  cols: number,
): Promise<void> {
  return invoke("resize_terminal", { sessionId, rows, cols });
}

export async function destroySession(sessionId: string): Promise<void> {
  return invoke("destroy_session", { sessionId });
}

export async function getBlockOutput(
  sessionId: string,
  startRow: number,
  endRow: number,
): Promise<string> {
  return invoke<string>("get_block_output", { sessionId, startRow, endRow });
}

export async function requestFullRedraw(sessionId: string): Promise<void> {
  return invoke("request_full_redraw", { sessionId });
}

// Window appearance

export async function setWindowBlurRadius(radius: number): Promise<void> {
  return invoke("set_window_blur_radius", { radius: Math.max(0, Math.round(radius)) });
}

export async function setWindowOpacity(opacity: number): Promise<void> {
  return invoke("set_window_opacity", { opacity: Math.max(0, Math.min(1, opacity)) });
}

export async function getHostname(): Promise<string> {
  return invoke<string>("get_hostname");
}

export async function setAppIcon(iconName: string): Promise<void> {
  return invoke("set_app_icon", { iconName });
}

export async function quitApp(): Promise<void> {
  return invoke("quit_app");
}

// --- window management ---

export async function createChildWindow(
  sessionId: string,
  label: string,
  x: number,
  y: number,
  width: number,
  height: number,
  cwd?: string,
  transferId?: string,
): Promise<string> {
  return invoke<string>("create_child_window", { sessionId, label, x, y, width, height, cwd, transferId });
}

// --- drag ghost ---

export async function createDragGhost(
  label: string,
  paneCount: number,
  splitDirection: string | null,
  x: number,
  y: number,
  width: number,
): Promise<void> {
  return invoke("create_drag_ghost", { label, paneCount, splitDirection, x, y, width });
}

export async function closeDragGhost(): Promise<void> {
  return invoke("close_drag_ghost");
}

// --- cross-window tab coordination ---

export interface WindowBounds {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type TabTransferFailureReason =
  | "duplicate_session"
  | "expired_transfer"
  | "invalid_manifest"
  | "not_prepared"
  | "timeout"
  | "target_unavailable";

export interface TabTransferPrepareResult {
  ok: boolean;
  reason: TabTransferFailureReason | null;
  ready_token: string | null;
  expires_at_ms: number | null;
  session_ids: string[];
}

export interface TabTransferCommitResult {
  ok: boolean;
  reason: TabTransferFailureReason | null;
  manifest: TabTransferManifest | null;
}

export async function listRainWindows(): Promise<WindowBounds[]> {
  return invoke<WindowBounds[]>("list_rain_windows");
}

export async function emitCrossWindow(
  targetLabel: string,
  eventName: string,
  payload: unknown,
): Promise<void> {
  return invoke("emit_cross_window", { targetLabel, eventName, payload });
}

export async function stageSessionTransferState(
  sessionId: string,
  transferState: SessionTransferState,
): Promise<void> {
  return invoke("stage_session_transfer_state", { sessionId, transferState });
}

export async function takeSessionTransferState(
  sessionId: string,
): Promise<SessionTransferState | null> {
  return invoke<SessionTransferState | null>("take_session_transfer_state", { sessionId });
}

export async function stageTabTransferManifest(
  transferId: string,
  manifest: TabTransferManifest,
): Promise<void> {
  return invoke("stage_tab_transfer_manifest", { transferId, manifest });
}

export async function takeTabTransferManifest(
  transferId: string,
): Promise<TabTransferManifest | null> {
  return invoke<TabTransferManifest | null>("take_tab_transfer_manifest", { transferId });
}

export async function prepareTabTransferAdopt(
  transferId: string,
  targetLabel: string,
): Promise<TabTransferPrepareResult> {
  return invoke<TabTransferPrepareResult>("prepare_tab_transfer_adopt", { transferId, targetLabel });
}

export async function releaseTabTransferAdopt(
  transferId: string,
  targetLabel: string,
  readyToken: string,
): Promise<void> {
  return invoke("release_tab_transfer_adopt", { transferId, targetLabel, readyToken });
}

export async function commitTabTransferAdopt(
  transferId: string,
  targetLabel: string,
  readyToken: string,
): Promise<TabTransferCommitResult> {
  return invoke<TabTransferCommitResult>("commit_tab_transfer_adopt", { transferId, targetLabel, readyToken });
}

// --- tmux integration ---

export interface TmuxSessionListing {
  id: string;
  name: string;
  windows: number;
  attached: boolean;
}

export interface TmuxPaneInfo {
  pane_id: number;
  session_id: string;
  width: number;
  height: number;
}

export type TmuxLayoutTree =
  | { type: "Leaf"; pane_id: number; session_id: string; width: number; height: number }
  | { type: "HSplit"; children: TmuxLayoutTree[]; width: number; height: number }
  | { type: "VSplit"; children: TmuxLayoutTree[]; width: number; height: number };

export type TmuxEvent =
  | { type: "Started"; session_name: string; panes: TmuxPaneInfo[] }
  | { type: "PaneAdded"; pane_id: number; session_id: string; window_id: number }
  | { type: "PaneRemoved"; pane_id: number; session_id: string }
  | { type: "WindowAdded"; window_id: number; name: string }
  | { type: "WindowClosed"; window_id: number; removed_sessions: string[] }
  | { type: "WindowRenamed"; window_id: number; name: string }
  | { type: "LayoutChanged"; window_id: number; panes: TmuxPaneInfo[]; layout_tree: TmuxLayoutTree }
  | { type: "Detached" }
  | { type: "Ended" };

export async function tmuxStart(args?: string): Promise<void> {
  return invoke("tmux_start", { args });
}

export async function tmuxSendKeys(paneId: number, data: number[]): Promise<void> {
  return invoke("tmux_send_keys", { paneId, data });
}

export async function tmuxNewWindow(): Promise<void> {
  return invoke("tmux_new_window");
}

export async function tmuxSplitPane(direction: string, paneId?: number): Promise<void> {
  return invoke("tmux_split_pane", { direction, paneId });
}

export async function tmuxClosePane(paneId: number): Promise<void> {
  return invoke("tmux_close_pane", { paneId });
}

export async function tmuxResizePane(paneId: number, rows: number, cols: number): Promise<void> {
  return invoke("tmux_resize_pane", { paneId, rows, cols });
}

export async function tmuxSelectPane(paneId: number): Promise<void> {
  return invoke("tmux_select_pane", { paneId });
}

export async function tmuxDetach(): Promise<void> {
  return invoke("tmux_detach");
}

export async function tmuxListSessions(): Promise<TmuxSessionListing[]> {
  return invoke<TmuxSessionListing[]>("tmux_list_sessions");
}

export async function tmuxSendCommand(command: string): Promise<void> {
  return invoke("tmux_send_command", { command });
}

export async function onTmuxEvent(
  callback: (event: TmuxEvent) => void,
): Promise<UnlistenFn> {
  return listen<TmuxEvent>("tmux-event", (event) => {
    callback(event.payload);
  });
}

// --- session restore ---

export async function saveWorkspace(workspace: string): Promise<void> {
  return invoke("save_workspace", { workspace });
}

export async function loadWorkspace(): Promise<string | null> {
  return invoke<string | null>("load_workspace");
}

// --- config file ---

export async function readConfigFile(): Promise<string | null> {
  return invoke<string | null>("read_config_file");
}

export async function writeConfigFile(contents: string): Promise<void> {
  return invoke("write_config_file", { contents });
}

// --- global hotkey ---

export async function toggleWindowVisibility(): Promise<void> {
  return invoke("toggle_window_visibility");
}

export async function registerGlobalHotkey(accelerator: string): Promise<void> {
  return invoke("register_global_hotkey", { accelerator });
}

// --- scrollback export ---

export async function saveTextToFile(content: string, defaultName: string): Promise<boolean> {
  return invoke<boolean>("save_text_to_file", { content, defaultName });
}

// --- version ---

export async function getAppVersion(): Promise<string> {
  return invoke<string>("get_app_version");
}

// Event listeners

export async function onRenderFrame(
  callback: (payload: RenderFramePayload) => void,
): Promise<UnlistenFn> {
  return listen<RenderFramePayload>("render-frame", (event) => {
    callback(event.payload);
  });
}

export async function onSessionCreated(
  callback: (sessionId: string) => void,
): Promise<UnlistenFn> {
  return listen<string>("session-created", (event) => {
    callback(event.payload);
  });
}

export async function onSessionEnded(
  callback: (payload: SessionEndPayload) => void,
): Promise<UnlistenFn> {
  return listen<SessionEndPayload>("session-ended", (event) => {
    callback(event.payload);
  });
}

export async function onResizeAck(
  callback: (payload: ResizeAckPayload) => void,
): Promise<UnlistenFn> {
  return listen<ResizeAckPayload>("resize-ack", (event) => {
    callback(event.payload);
  });
}
