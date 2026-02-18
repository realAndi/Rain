// Auto-update: check for new versions of Rain via GitHub releases.

import { getAppVersion } from "./ipc";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LAST_CHECK_KEY = "rain-last-update-check";
const DISMISSED_VERSION_KEY = "rain-dismissed-version";

const GITHUB_REPO = "rain-terminal/rain";
const RELEASES_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  releaseNotes: string | null;
}

let _cachedVersion: string | null = null;

export async function getCurrentVersion(): Promise<string> {
  if (_cachedVersion) return _cachedVersion;
  try {
    _cachedVersion = await getAppVersion();
  } catch {
    _cachedVersion = "0.1.0";
  }
  return _cachedVersion;
}

function compareVersions(current: string, latest: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, "")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const c = parse(current);
  const l = parse(latest);
  for (let i = 0; i < Math.max(c.length, l.length); i++) {
    const cv = c[i] ?? 0;
    const lv = l[i] ?? 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}

export async function checkForUpdates(): Promise<UpdateInfo> {
  const currentVersion = await getCurrentVersion();

  try {
    const response = await fetch(RELEASES_URL, {
      headers: { Accept: "application/vnd.github.v3+json" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return {
        currentVersion,
        latestVersion: null,
        updateAvailable: false,
        releaseUrl: null,
        releaseNotes: null,
      };
    }

    const data = await response.json();
    const latestVersion = (data.tag_name ?? "").replace(/^v/, "");
    const releaseUrl: string | null = data.html_url ?? null;
    const releaseNotes: string | null = data.body
      ? (data.body as string).substring(0, 500)
      : null;

    return {
      currentVersion,
      latestVersion: latestVersion || null,
      updateAvailable: !!latestVersion && compareVersions(currentVersion, latestVersion),
      releaseUrl,
      releaseNotes,
    };
  } catch {
    return {
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: null,
      releaseNotes: null,
    };
  }
}

export function shouldCheckForUpdates(): boolean {
  try {
    const lastCheck = localStorage.getItem(LAST_CHECK_KEY);
    if (!lastCheck) return true;
    return Date.now() - parseInt(lastCheck, 10) > CHECK_INTERVAL_MS;
  } catch {
    return false;
  }
}

export function markUpdateChecked(): void {
  try {
    localStorage.setItem(LAST_CHECK_KEY, Date.now().toString());
  } catch {
    // Storage unavailable
  }
}

export function dismissVersion(version: string): void {
  try {
    localStorage.setItem(DISMISSED_VERSION_KEY, version);
  } catch {
    // Storage unavailable
  }
}

export function isDismissed(version: string): boolean {
  try {
    return localStorage.getItem(DISMISSED_VERSION_KEY) === version;
  } catch {
    return false;
  }
}
