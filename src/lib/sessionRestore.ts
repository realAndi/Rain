// Session restore: persist and restore workspace state across app restarts.

import { saveWorkspace, loadWorkspace } from "./ipc";

export interface SavedPane {
  sessionId: string;
  cwd: string;
}

export interface SavedPaneNode {
  type: "leaf" | "split";
  cwd?: string;
  direction?: "horizontal" | "vertical";
  ratio?: number;
  first?: SavedPaneNode;
  second?: SavedPaneNode;
}

export interface SavedTab {
  label: string;
  customLabel: string | null;
  cwd: string;
  paneTree: SavedPaneNode;
  // Index of the active leaf (depth-first order)
  activeLeafIndex: number;
}

export interface SavedWorkspace {
  version: 1;
  tabs: SavedTab[];
  activeTabIndex: number;
  savedAt: number;
}

type PaneTreeLike =
  | {
      type: "leaf";
      id?: string;
      sessionId?: string;
    }
  | {
      type: "split";
      direction?: "horizontal" | "vertical";
      ratio?: number;
      first?: PaneTreeLike;
      second?: PaneTreeLike;
    };

function paneTreeToSaved(
  node: PaneTreeLike | undefined,
  getCwd: (sessionId: string) => string,
): SavedPaneNode {
  if (!node || node.type === "leaf") {
    return {
      type: "leaf",
      cwd: node?.sessionId ? getCwd(node.sessionId) : "",
    };
  }
  return {
    type: "split",
    direction: node.direction as "horizontal" | "vertical",
    ratio: node.ratio ?? 0.5,
    first: paneTreeToSaved(node.first, getCwd),
    second: paneTreeToSaved(node.second, getCwd),
  };
}

function sessionIdForPaneId(node: PaneTreeLike | undefined, paneId: string): string | null {
  if (!node) return null;
  if (node.type === "leaf") {
    if (node.id === paneId && node.sessionId) return node.sessionId;
    return null;
  }
  return sessionIdForPaneId(node.first, paneId) ?? sessionIdForPaneId(node.second, paneId);
}

function collectLeafSessionIds(node: PaneTreeLike | undefined, out: string[] = []): string[] {
  if (!node) return out;
  if (node.type === "leaf") {
    if (node.sessionId) out.push(node.sessionId);
    return out;
  }
  collectLeafSessionIds(node.first, out);
  collectLeafSessionIds(node.second, out);
  return out;
}

export function buildSavedWorkspace(
  tabs: Array<{
    id: string;
    type: string;
    label: string;
    customLabel: string | null;
    cwd: string;
    sessionId: string | null;
    paneTree?: any;
    activePaneId?: string;
  }>,
  activeIndex: number,
  getStoreCwd: (sessionId: string) => string,
): SavedWorkspace {
  const savedTabs: SavedTab[] = [];

  for (const tab of tabs) {
    if (tab.type !== "terminal") continue;

    const paneTree = tab.paneTree
      ? paneTreeToSaved(tab.paneTree as PaneTreeLike, getStoreCwd)
      : { type: "leaf" as const, cwd: tab.cwd || getStoreCwd(tab.sessionId ?? "") };

    let activeLeafIndex = 0;
    if (tab.paneTree && tab.activePaneId) {
      const sourceTree = tab.paneTree as PaneTreeLike;
      const activeSessionId = sessionIdForPaneId(sourceTree, tab.activePaneId);
      if (activeSessionId) {
        const leafSessionIds = collectLeafSessionIds(sourceTree);
        const sessionLeafIndex = leafSessionIds.findIndex((sid) => sid === activeSessionId);
        if (sessionLeafIndex >= 0) {
          activeLeafIndex = sessionLeafIndex;
        }
      }
    }

    savedTabs.push({
      label: tab.label,
      customLabel: tab.customLabel,
      cwd: tab.cwd || getStoreCwd(tab.sessionId ?? ""),
      paneTree,
      activeLeafIndex,
    });
  }

  return {
    version: 1,
    tabs: savedTabs,
    activeTabIndex: savedTabs.length > 0
      ? Math.min(Math.max(activeIndex, 0), savedTabs.length - 1)
      : 0,
    savedAt: Date.now(),
  };
}

export async function persistWorkspace(workspace: SavedWorkspace): Promise<void> {
  try {
    await saveWorkspace(JSON.stringify(workspace));
  } catch (e) {
    console.warn("[Rain] Failed to save workspace:", e);
  }
}

export async function restoreWorkspace(): Promise<SavedWorkspace | null> {
  try {
    const raw = await loadWorkspace();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedWorkspace> & {
      tabs?: Array<Partial<SavedTab> & { activeIndex?: number }>;
    };
    if (parsed.version !== 1 || !Array.isArray(parsed.tabs)) return null;
    // Discard saves older than 30 days
    if (typeof parsed.savedAt !== "number") return null;
    if (Date.now() - parsed.savedAt > 30 * 24 * 60 * 60 * 1000) return null;

    const normalizedTabs: SavedTab[] = parsed.tabs
      .filter((tab) => tab && tab.paneTree && tab.label)
      .map((tab) => ({
        label: tab.label ?? "Shell",
        customLabel: tab.customLabel ?? null,
        cwd: tab.cwd ?? "",
        paneTree: tab.paneTree as SavedPaneNode,
        // Backward compatibility with older saves that used `activeIndex`
        activeLeafIndex: typeof tab.activeLeafIndex === "number"
          ? Math.max(0, Math.floor(tab.activeLeafIndex))
          : typeof tab.activeIndex === "number"
            ? Math.max(0, Math.floor(tab.activeIndex))
            : 0,
      }));

    if (normalizedTabs.length === 0) return null;

    return {
      version: 1,
      tabs: normalizedTabs,
      activeTabIndex: Math.min(
        Math.max(typeof parsed.activeTabIndex === "number" ? parsed.activeTabIndex : 0, 0),
        normalizedTabs.length - 1,
      ),
      savedAt: parsed.savedAt,
    };
  } catch (e) {
    console.warn("[Rain] Failed to load workspace:", e);
    return null;
  }
}
