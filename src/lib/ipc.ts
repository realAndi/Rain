import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { RenderFramePayload, ResizeAckPayload, SessionEndPayload } from "./types";

// Typed wrappers around Tauri IPC commands

export async function createSession(
  shell?: string,
  cwd?: string,
  rows?: number,
  cols?: number,
): Promise<string> {
  return invoke<string>("create_session", { shell, cwd, rows, cols });
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
