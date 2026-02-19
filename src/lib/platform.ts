// Platform detection utilities for Rain terminal.

export type Platform = "macos" | "windows" | "linux" | "unknown";

let _cachedPlatform: Platform | null = null;

export function detectPlatform(): Platform {
  if (_cachedPlatform) return _cachedPlatform;

  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) _cachedPlatform = "macos";
  else if (ua.includes("win")) _cachedPlatform = "windows";
  else if (ua.includes("linux")) _cachedPlatform = "linux";
  else _cachedPlatform = "unknown";

  return _cachedPlatform;
}

export function isMacOS(): boolean {
  return detectPlatform() === "macos";
}

export function isWindows(): boolean {
  return detectPlatform() === "windows";
}

export function isLinux(): boolean {
  return detectPlatform() === "linux";
}

export function modifierKey(): string {
  return isMacOS() ? "Cmd" : "Ctrl";
}

export function modifierSymbol(): string {
  return isMacOS() ? "\u2318" : "Ctrl+";
}

/**
 * Shorten a working directory path by replacing the user's home directory
 * prefix with `~`. Handles macOS, Linux, and Windows home directory formats.
 */
export function shortenHomePath(cwd: string): string {
  return cwd
    .replace(/^\/Users\/[^/]+/, "~")         // macOS: /Users/username
    .replace(/^\/home\/[^/]+/, "~")           // Linux: /home/username
    .replace(/^[A-Z]:\\Users\\[^\\]+/, "~");  // Windows: C:\Users\username
}
