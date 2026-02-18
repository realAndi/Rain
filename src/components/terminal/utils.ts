import type { RenderedLine } from "../../lib/types";
import { getHostname as fetchHostname } from "../../lib/ipc";

// Build a complete grid of `rows` lines from a sparse buffer, filling gaps with empty lines
export function buildFullGrid(buffer: RenderedLine[], rows: number): RenderedLine[] {
  const byIndex = new Map<number, RenderedLine>();
  for (const line of buffer) byIndex.set(line.index, line);
  const result: RenderedLine[] = [];
  for (let i = 0; i < rows; i++) {
    result.push(byIndex.get(i) ?? { index: i, spans: [] });
  }
  return result;
}

// Shared cwd formatting utilities
export function formatCwdSimplified(cwd: string): string {
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

export function extractUsername(cwd: string): string {
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

export function getHostname(): string {
  return _cachedHostname;
}

// For default prompt: show just the last directory name, or ~ for home
export function formatCwdDefault(cwd: string): string {
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
