import { createStore, produce } from "solid-js/store";
import { createTerminalStore, type TerminalStore } from "./terminal";
import type {
  TabData,
  PaneNode,
  PaneLeaf,
  PaneSplit,
  TabTransferManifest,
  TabTransferPaneNode,
} from "../lib/types";
import type { TmuxLayoutTree } from "../lib/ipc";

export interface Tab {
  data: TabData;
  store: TerminalStore;
}

export interface TabsState {
  tabs: TabData[];
  activeIndex: number;
}

export interface TabsStore {
  state: TabsState;
  stores: Map<string, TerminalStore>;
  addTab: (sessionId: string, label?: string, insertAt?: number, initialCwd?: string) => Tab;
  addTabFromManifest: (manifest: TabTransferManifest, insertAt?: number) => Tab | null;
  addSettingsTab: () => void;
  closeTab: (tabId: string) => void;
  switchTab: (index: number) => void;
  switchTabById: (tabId: string) => void;
  nextTab: () => void;
  prevTab: () => void;
  activeTab: () => TabData | undefined;
  activeStore: () => TerminalStore | undefined;
  getStoreBySessionId: (sessionId: string) => TerminalStore | undefined;
  updateTabLabel: (tabId: string, label: string) => void;
  updateTabCustomLabel: (tabId: string, customLabel: string | null) => void;
  updateTabCwd: (tabId: string, cwd: string) => void;
  splitPane: (tabId: string, paneId: string, direction: "horizontal" | "vertical", newSessionId: string) => string | null;
  closePane: (tabId: string, paneId: string) => void;
  setActivePane: (tabId: string, paneId: string) => void;
  getActivePaneId: (tabId: string) => string;
  getPaneTree: (tabId: string) => PaneNode | undefined;
  moveTab: (fromIndex: number, toIndex: number) => void;
  addTmuxPane: (sessionId: string, paneId: number) => TerminalStore | null;
  removeTmuxTabs: () => void;
  rebuildTmuxLayout: (windowId: number, layoutTree: TmuxLayoutTree) => void;
  replaceTabSession: (tabId: string, newSessionId: string) => void;
  detachTab: (tabId: string) => { sessionId: string; label: string; cwd: string } | null;
  updateTabColor: (tabId: string, color: string | null) => void;
  popClosedTab: () => { cwd: string; label: string; customLabel: string | null; tabColor: string | null } | null;
  getTabsExcept: (tabId: string) => string[];
  getTabsToRight: (tabId: string) => string[];
}

let tabCounter = 0;

export function createTabsStore(): TabsStore {
  const [state, setState] = createStore<TabsState>({
    tabs: [],
    activeIndex: 0,
  });

  const closedTabsStack: Array<{ cwd: string; label: string; customLabel: string | null; tabColor: string | null }> = [];
  const MAX_CLOSED_TABS = 10;

  // Map of tabId -> TerminalStore (stores can't live in solid-js/store)
  const stores = new Map<string, TerminalStore>();
  // Map of sessionId -> tabId for routing render frames
  const sessionToTab = new Map<string, string>();

  let paneCounter = 0;

  function addTab(
    sessionId: string,
    label?: string,
    insertAt?: number,
    initialCwd?: string,
  ): Tab {
    const id = `tab-${++tabCounter}`;
    const paneId = `pane-${++paneCounter}`;
    const store = createTerminalStore();
    const startingCwd = initialCwd ?? "";
    store.setState({ sessionId, connected: true, cwd: startingCwd });

    const paneTree: PaneLeaf = {
      type: "leaf",
      id: paneId,
      sessionId,
    };

    const tabData: TabData = {
      id,
      type: "terminal",
      label: label ?? "Shell",
      customLabel: null,
      sessionId,
      cwd: startingCwd,
      paneTree,
      activePaneId: paneId,
      tabColor: null,
    };

    stores.set(paneId, store);
    sessionToTab.set(sessionId, paneId);

    setState(
      produce((s) => {
        if (insertAt != null && insertAt >= 0 && insertAt <= s.tabs.length) {
          s.tabs.splice(insertAt, 0, tabData);
          s.activeIndex = insertAt;
        } else {
          s.tabs.push(tabData);
          s.activeIndex = s.tabs.length - 1;
        }
      }),
    );

    return { data: tabData, store };
  }

  function addTabFromManifest(manifest: TabTransferManifest, insertAt?: number): Tab | null {
    const id = `tab-${++tabCounter}`;
    const paneSessions = new Map(manifest.paneSessions.map((pane) => [pane.sessionId, pane.state]));
    const createdPaneIds: string[] = [];
    const createdSessionIds: string[] = [];
    const sessionToPane = new Map<string, string>();

    const cleanup = () => {
      for (const paneId of createdPaneIds) stores.delete(paneId);
      for (const sessionId of createdSessionIds) sessionToTab.delete(sessionId);
    };

    const clampRatio = (ratio: number): number => {
      if (!Number.isFinite(ratio)) return 0.5;
      return Math.max(0.1, Math.min(0.9, ratio));
    };

    const buildNode = (node: TabTransferPaneNode): PaneNode | null => {
      if (node.type === "leaf") {
        if (!node.sessionId) return null;
        const paneId = `pane-${++paneCounter}`;
        const store = createTerminalStore();
        const initialCwd = paneSessions.get(node.sessionId)?.cwd?.trim() || manifest.cwd || "";
        store.setState({ sessionId: node.sessionId, connected: true, cwd: initialCwd });
        stores.set(paneId, store);
        sessionToTab.set(node.sessionId, paneId);
        createdPaneIds.push(paneId);
        createdSessionIds.push(node.sessionId);
        sessionToPane.set(node.sessionId, paneId);
        return {
          type: "leaf",
          id: paneId,
          sessionId: node.sessionId,
        };
      }

      const first = buildNode(node.first);
      const second = buildNode(node.second);
      if (!first || !second) return null;
      return {
        type: "split",
        id: `split-${++paneCounter}`,
        direction: node.direction === "vertical" ? "vertical" : "horizontal",
        ratio: clampRatio(node.ratio),
        first,
        second,
      };
    };

    const paneTree = buildNode(manifest.paneTree);
    if (!paneTree || sessionToPane.size === 0) {
      cleanup();
      return null;
    }

    const fallbackLeaf = firstLeaf(paneTree);
    const activePaneId =
      sessionToPane.get(manifest.activeSessionId) ??
      sessionToPane.get(manifest.paneSessions[0]?.sessionId ?? "") ??
      fallbackLeaf.id;
    const tabData: TabData = {
      id,
      type: "terminal",
      label: manifest.label || "Shell",
      customLabel: manifest.customLabel ?? null,
      sessionId: fallbackLeaf.sessionId,
      cwd: manifest.cwd || "",
      paneTree,
      activePaneId,
    };

    setState(
      produce((s) => {
        if (insertAt != null && insertAt >= 0 && insertAt <= s.tabs.length) {
          s.tabs.splice(insertAt, 0, tabData);
          s.activeIndex = insertAt;
        } else {
          s.tabs.push(tabData);
          s.activeIndex = s.tabs.length - 1;
        }
      }),
    );

    const activeStore = stores.get(activePaneId) ?? stores.get(fallbackLeaf.id);
    if (!activeStore) {
      cleanup();
      return null;
    }
    return { data: tabData, store: activeStore };
  }

  function addSettingsTab() {
    // If a settings tab already exists, switch to it
    const existing = state.tabs.find((t) => t.type === "settings");
    if (existing) {
      switchTabById(existing.id);
      return;
    }

    const id = `tab-${++tabCounter}`;
    const tabData: TabData = {
      id,
      type: "settings",
      label: "Settings",
      customLabel: null,
      sessionId: null,
      cwd: "",
    };

    setState(
      produce((s) => {
        s.tabs.push(tabData);
        s.activeIndex = s.tabs.length - 1;
      }),
    );
  }

  // Collect all leaf pane IDs from a pane tree
  function collectLeafIds(node: PaneNode): string[] {
    if (node.type === "leaf") return [node.id];
    return [...collectLeafIds(node.first), ...collectLeafIds(node.second)];
  }

  // Collect all session IDs from a pane tree
  function collectSessionIds(node: PaneNode): string[] {
    if (node.type === "leaf") return [node.sessionId];
    return [...collectSessionIds(node.first), ...collectSessionIds(node.second)];
  }

  function closeTab(tabId: string) {
    const tabData = state.tabs.find((t) => t.id === tabId);
    if (!tabData) return;

    if (tabData.type === "terminal") {
      closedTabsStack.push({
        cwd: tabData.cwd,
        label: tabData.label,
        customLabel: tabData.customLabel,
        tabColor: tabData.tabColor ?? null,
      });
      if (closedTabsStack.length > MAX_CLOSED_TABS) closedTabsStack.shift();
    }

    const idx = state.tabs.findIndex((t) => t.id === tabId);

    // Clean up all pane stores and session mappings
    if (tabData.paneTree) {
      for (const paneId of collectLeafIds(tabData.paneTree)) {
        stores.delete(paneId);
      }
      for (const sid of collectSessionIds(tabData.paneTree)) {
        sessionToTab.delete(sid);
      }
    } else {
      if (tabData.sessionId) {
        sessionToTab.delete(tabData.sessionId);
      }
      stores.delete(tabId);
    }

    setState(
      produce((s) => {
        s.tabs.splice(idx, 1);
        if (s.activeIndex >= s.tabs.length) {
          s.activeIndex = s.tabs.length - 1;
        } else if (s.activeIndex > idx) {
          s.activeIndex--;
        }
      }),
    );
  }

  function switchTab(index: number) {
    if (index >= 0 && index < state.tabs.length) {
      setState("activeIndex", index);
    }
  }

  function switchTabById(tabId: string) {
    const idx = state.tabs.findIndex((t) => t.id === tabId);
    if (idx >= 0) switchTab(idx);
  }

  function nextTab() {
    switchTab((state.activeIndex + 1) % state.tabs.length);
  }

  function prevTab() {
    switchTab((state.activeIndex - 1 + state.tabs.length) % state.tabs.length);
  }

  function activeTab(): TabData | undefined {
    return state.tabs[state.activeIndex];
  }

  function activeStore(): TerminalStore | undefined {
    const tab = activeTab();
    if (!tab) return undefined;
    // If tab has panes, return the active pane's store
    if (tab.activePaneId) {
      return stores.get(tab.activePaneId);
    }
    return stores.get(tab.id);
  }

  function getStoreBySessionId(sessionId: string): TerminalStore | undefined {
    const paneId = sessionToTab.get(sessionId);
    return paneId ? stores.get(paneId) : undefined;
  }

  function updateTabLabel(tabId: string, label: string) {
    setState(
      produce((s) => {
        const tab = s.tabs.find((t) => t.id === tabId);
        if (tab) tab.label = label;
      }),
    );
  }

  function updateTabCustomLabel(tabId: string, customLabel: string | null) {
    setState(
      produce((s) => {
        const tab = s.tabs.find((t) => t.id === tabId);
        if (tab) tab.customLabel = customLabel;
      }),
    );
  }

  function updateTabCwd(tabId: string, cwd: string) {
    setState(
      produce((s) => {
        const tab = s.tabs.find((t) => t.id === tabId);
        if (tab) tab.cwd = cwd;
      }),
    );
  }

  // Replace a leaf node in a pane tree, returning the new tree
  function replaceInTree(node: PaneNode, targetId: string, replacement: PaneNode): PaneNode {
    if (node.type === "leaf") {
      return node.id === targetId ? replacement : node;
    }
    return {
      ...node,
      first: replaceInTree(node.first, targetId, replacement),
      second: replaceInTree(node.second, targetId, replacement),
    };
  }

  // Remove a leaf from the tree, returning the remaining sibling (or null if not found)
  function removeFromTree(node: PaneNode, targetId: string): PaneNode | null {
    if (node.type === "leaf") {
      return node.id === targetId ? null : node;
    }
    if (node.first.type === "leaf" && node.first.id === targetId) {
      return node.second;
    }
    if (node.second.type === "leaf" && node.second.id === targetId) {
      return node.first;
    }
    const newFirst = removeFromTree(node.first, targetId);
    if (newFirst !== node.first) {
      return newFirst ? { ...node, first: newFirst } : node.second;
    }
    const newSecond = removeFromTree(node.second, targetId);
    if (newSecond !== node.second) {
      return newSecond ? { ...node, second: newSecond } : node.first;
    }
    return node;
  }

  // Find the first leaf in a tree
  function firstLeaf(node: PaneNode): PaneLeaf {
    if (node.type === "leaf") return node;
    return firstLeaf(node.first);
  }

  function splitPane(
    tabId: string,
    paneId: string,
    direction: "horizontal" | "vertical",
    newSessionId: string,
  ): string | null {
    const tab = state.tabs.find((t) => t.id === tabId);
    if (!tab || !tab.paneTree) return null;

    const newPaneId = `pane-${++paneCounter}`;
    const newStore = createTerminalStore();
    newStore.setState({ sessionId: newSessionId, connected: true });
    stores.set(newPaneId, newStore);
    sessionToTab.set(newSessionId, newPaneId);

    const newLeaf: PaneLeaf = {
      type: "leaf",
      id: newPaneId,
      sessionId: newSessionId,
    };

    // Find the target leaf
    const splitId = `split-${++paneCounter}`;
    const splitNode: PaneSplit = {
      type: "split",
      id: splitId,
      direction,
      ratio: 0.5,
      first: { type: "leaf", id: paneId, sessionId: "" } as PaneLeaf, // placeholder
      second: newLeaf,
    };

    // Replace the target leaf with a split containing original + new
    const newTree = replaceInTree(tab.paneTree, paneId, splitNode);
    // Fix the first child to be the original leaf (replaceInTree replaces it with the split)
    // Actually, we need to keep the original leaf in the first position
    // Let me fix this: replaceInTree replaces the node with targetId, so the original leaf
    // is gone. We need to construct the split properly.

    // Find the original leaf to preserve it
    function findLeaf(node: PaneNode, id: string): PaneLeaf | null {
      if (node.type === "leaf") return node.id === id ? node : null;
      return findLeaf(node.first, id) || findLeaf(node.second, id);
    }

    const originalLeaf = findLeaf(tab.paneTree, paneId);
    if (!originalLeaf) return null;

    const properSplit: PaneSplit = {
      type: "split",
      id: splitId,
      direction,
      ratio: 0.5,
      first: { ...originalLeaf },
      second: newLeaf,
    };

    const properTree = replaceInTree(tab.paneTree, paneId, properSplit);

    setState(
      produce((s) => {
        const t = s.tabs.find((t) => t.id === tabId);
        if (t) {
          t.paneTree = properTree;
          t.activePaneId = newPaneId;
        }
      }),
    );

    return newPaneId;
  }

  function closePane(tabId: string, paneId: string) {
    const tab = state.tabs.find((t) => t.id === tabId);
    if (!tab || !tab.paneTree) return;

    // Clean up the store
    const store = stores.get(paneId);
    if (store?.state.sessionId) {
      sessionToTab.delete(store.state.sessionId);
    }
    stores.delete(paneId);

    const remaining = removeFromTree(tab.paneTree, paneId);
    if (!remaining) return; // shouldn't happen

    setState(
      produce((s) => {
        const t = s.tabs.find((t) => t.id === tabId);
        if (t) {
          t.paneTree = remaining;
          // If active pane was closed, activate the first leaf in remaining tree
          if (t.activePaneId === paneId) {
            t.activePaneId = firstLeaf(remaining).id;
          }
        }
      }),
    );
  }

  function setActivePane(tabId: string, paneId: string) {
    setState(
      produce((s) => {
        const tab = s.tabs.find((t) => t.id === tabId);
        if (tab) tab.activePaneId = paneId;
      }),
    );
  }

  function getActivePaneId(tabId: string): string {
    const tab = state.tabs.find((t) => t.id === tabId);
    if (tab?.activePaneId) return tab.activePaneId;
    if (tab?.paneTree) return firstLeaf(tab.paneTree).id;
    return "";
  }

  function getPaneTree(tabId: string): PaneNode | undefined {
    const tab = state.tabs.find((t) => t.id === tabId);
    return tab?.paneTree;
  }

  function addTmuxPane(sessionId: string, tmuxPaneId: number): TerminalStore | null {
    // Register the store so render frames can route to it.
    // The actual split tree will be built by rebuildTmuxLayout when LayoutChanged fires.
    const rainPaneId = getOrCreatePaneForSession(sessionId, tmuxPaneId);

    // If a tab is already marked as tmux, just register the store (no new tab).
    const existingTmuxTab = state.tabs.find((t) => t.tmuxSessionName != null);
    if (existingTmuxTab) {
      return stores.get(rainPaneId) ?? null;
    }

    // First tmux pane: mark the CURRENT active tab as the tmux tab instead of
    // creating a new one. This gives the iTerm2-like feel where tmux takes over
    // the current tab and the status bar indicates tmux is active.
    const currentTab = activeTab();
    if (currentTab && currentTab.type === "terminal") {
      // Clean up the old PTY pane store for the current tab's leaf
      const oldPaneId = currentTab.activePaneId || (currentTab.paneTree ? firstLeaf(currentTab.paneTree).id : "");
      const oldStore = stores.get(oldPaneId);
      if (oldStore?.state.sessionId) {
        sessionToTab.delete(oldStore.state.sessionId);
      }
      stores.delete(oldPaneId);

      // Replace the tab's pane tree with the tmux pane
      const paneTree: PaneLeaf = {
        type: "leaf",
        id: rainPaneId,
        sessionId,
      };

      setState(
        produce((s) => {
          const t = s.tabs.find((t) => t.id === currentTab.id);
          if (t) {
            t.paneTree = paneTree;
            t.activePaneId = rainPaneId;
            t.tmuxSessionName = "tmux";
            t.tmuxWindowId = 0;
            t.sessionId = sessionId;
          }
        }),
      );

      return stores.get(rainPaneId) ?? null;
    }

    // Fallback: no active terminal tab, create a new one
    const id = `tab-${++tabCounter}`;
    const paneTree: PaneLeaf = {
      type: "leaf",
      id: rainPaneId,
      sessionId,
    };

    const tabData: TabData = {
      id,
      type: "terminal",
      label: "tmux",
      customLabel: null,
      sessionId,
      cwd: "",
      paneTree,
      activePaneId: rainPaneId,
      tmuxSessionName: "tmux",
      tmuxWindowId: 0,
    };

    setState(
      produce((s) => {
        s.tabs.push(tabData);
        s.activeIndex = s.tabs.length - 1;
      }),
    );

    return stores.get(rainPaneId) ?? null;
  }

  function removeTmuxTabs() {
    const tmuxTabs = state.tabs.filter((t) => t.tmuxSessionName != null);
    for (const tab of tmuxTabs) {
      // Clean up tmux pane stores
      if (tab.paneTree) {
        for (const pid of collectLeafIds(tab.paneTree)) {
          const store = stores.get(pid);
          if (store?.state.sessionId) {
            sessionToTab.delete(store.state.sessionId);
            tmuxSessionToPaneId.delete(store.state.sessionId);
          }
          stores.delete(pid);
        }
      }

      // Clear the tmux marker so the tab reverts to a regular shell tab.
      // The tab stays open -- App.tsx will spawn a fresh PTY session into it.
      setState(
        produce((s) => {
          const t = s.tabs.find((t) => t.id === tab.id);
          if (t) {
            t.tmuxSessionName = null;
            t.tmuxWindowId = null;
          }
        }),
      );
    }
  }

  // --- tmux layout tree conversion ---

  // Map of tmux session_id -> Rain pane ID for reuse across layout rebuilds
  const tmuxSessionToPaneId = new Map<string, string>();

  function getOrCreatePaneForSession(sessionId: string, tmuxPaneId: number): string {
    const existing = tmuxSessionToPaneId.get(sessionId);
    if (existing && stores.has(existing)) return existing;

    const rainPaneId = `pane-${++paneCounter}`;
    const store = createTerminalStore();
    store.setState({ sessionId, connected: true, tmuxPaneId });
    stores.set(rainPaneId, store);
    sessionToTab.set(sessionId, rainPaneId);
    tmuxSessionToPaneId.set(sessionId, rainPaneId);
    return rainPaneId;
  }

  // Convert a TmuxLayoutTree into Rain's binary PaneNode tree.
  // tmux splits can have N children, Rain's PaneSplit is binary (first/second).
  // We fold N children into nested binary splits with proportional ratios.
  function tmuxTreeToPaneNode(tree: TmuxLayoutTree): PaneNode {
    if (tree.type === "Leaf") {
      const rainPaneId = getOrCreatePaneForSession(tree.session_id, tree.pane_id);
      return {
        type: "leaf",
        id: rainPaneId,
        sessionId: tree.session_id,
      } as PaneLeaf;
    }

    const direction: "horizontal" | "vertical" =
      tree.type === "HSplit" ? "horizontal" : "vertical";
    const children = tree.children.map((c) => tmuxTreeToPaneNode(c));

    if (children.length === 0) {
      // shouldn't happen but be safe
      return children[0] ?? { type: "leaf", id: `pane-${++paneCounter}`, sessionId: "" } as PaneLeaf;
    }
    if (children.length === 1) return children[0];

    // Binary fold: pair up children left to right.
    // Compute ratio from the child sizes.
    return binaryFoldChildren(children, tree.children, direction);
  }

  function binaryFoldChildren(
    nodes: PaneNode[],
    originals: TmuxLayoutTree[],
    direction: "horizontal" | "vertical",
  ): PaneNode {
    if (nodes.length === 1) return nodes[0];
    if (nodes.length === 2) {
      const sizeA = childSize(originals[0], direction);
      const sizeB = childSize(originals[1], direction);
      const total = sizeA + sizeB;
      return {
        type: "split",
        id: `split-${++paneCounter}`,
        direction,
        ratio: total > 0 ? sizeA / total : 0.5,
        first: nodes[0],
        second: nodes[1],
      } as PaneSplit;
    }

    // More than 2: fold first child against the rest
    const sizeFirst = childSize(originals[0], direction);
    const sizeRest = originals.slice(1).reduce((s, c) => s + childSize(c, direction), 0);
    const total = sizeFirst + sizeRest;

    return {
      type: "split",
      id: `split-${++paneCounter}`,
      direction,
      ratio: total > 0 ? sizeFirst / total : 0.5,
      first: nodes[0],
      second: binaryFoldChildren(nodes.slice(1), originals.slice(1), direction),
    } as PaneSplit;
  }

  function childSize(tree: TmuxLayoutTree, direction: "horizontal" | "vertical"): number {
    if (direction === "horizontal") return tree.width;
    return tree.height;
  }

  function rebuildTmuxLayout(windowId: number, layoutTree: TmuxLayoutTree) {
    // Find the tmux tab for this window (or any tmux tab if windowId doesn't match)
    const tmuxTab = state.tabs.find(
      (t) => t.tmuxWindowId === windowId && t.tmuxSessionName != null,
    ) ?? state.tabs.find((t) => t.tmuxSessionName != null);

    if (!tmuxTab) return;

    // Convert the layout tree into a PaneNode tree
    const newPaneTree = tmuxTreeToPaneNode(layoutTree);

    // Collect all pane IDs in the new tree to find which old ones to remove
    const newLeafIds = new Set<string>();
    collectLeafIdsFromNode(newPaneTree, newLeafIds);

    // Clean up stores for panes that no longer exist in the new layout
    if (tmuxTab.paneTree) {
      for (const oldPaneId of collectLeafIds(tmuxTab.paneTree)) {
        if (!newLeafIds.has(oldPaneId)) {
          const store = stores.get(oldPaneId);
          if (store?.state.sessionId) {
            sessionToTab.delete(store.state.sessionId);
            tmuxSessionToPaneId.delete(store.state.sessionId);
          }
          stores.delete(oldPaneId);
        }
      }
    }

    // Update the tab's pane tree (PaneContainer re-renders reactively)
    setState(
      produce((s) => {
        const t = s.tabs.find((t) => t.id === tmuxTab.id);
        if (t) {
          t.paneTree = newPaneTree;
          t.tmuxWindowId = windowId;
          // If the active pane was removed, pick the first leaf
          if (t.activePaneId && !newLeafIds.has(t.activePaneId)) {
            t.activePaneId = firstLeafId(newPaneTree);
          }
        }
      }),
    );
  }

  function collectLeafIdsFromNode(node: PaneNode, ids: Set<string>) {
    if (node.type === "leaf") {
      ids.add(node.id);
    } else {
      collectLeafIdsFromNode(node.first, ids);
      collectLeafIdsFromNode(node.second, ids);
    }
  }

  function firstLeafId(node: PaneNode): string {
    if (node.type === "leaf") return node.id;
    return firstLeafId(node.first);
  }

  function replaceTabSession(tabId: string, newSessionId: string) {
    const tab = state.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    const newPaneId = `pane-${++paneCounter}`;
    const store = createTerminalStore();
    store.setState({ sessionId: newSessionId, connected: true });
    stores.set(newPaneId, store);
    sessionToTab.set(newSessionId, newPaneId);

    const paneTree: PaneLeaf = {
      type: "leaf",
      id: newPaneId,
      sessionId: newSessionId,
    };

    setState(
      produce((s) => {
        const t = s.tabs.find((t) => t.id === tabId);
        if (t) {
          t.paneTree = paneTree;
          t.activePaneId = newPaneId;
          t.sessionId = newSessionId;
        }
      }),
    );
  }

  function detachTab(tabId: string): { sessionId: string; label: string; cwd: string } | null {
    const tabData = state.tabs.find((t) => t.id === tabId);
    if (!tabData || tabData.type !== "terminal" || !tabData.sessionId) return null;

    const result = {
      sessionId: tabData.sessionId,
      label: tabData.customLabel ?? tabData.label,
      cwd: tabData.cwd,
    };

    const idx = state.tabs.findIndex((t) => t.id === tabId);

    // Clean up stores and session mappings without destroying the PTY session
    if (tabData.paneTree) {
      for (const paneId of collectLeafIds(tabData.paneTree)) {
        stores.delete(paneId);
      }
      for (const sid of collectSessionIds(tabData.paneTree)) {
        sessionToTab.delete(sid);
      }
    }

    setState(
      produce((s) => {
        s.tabs.splice(idx, 1);
        if (s.activeIndex >= s.tabs.length) {
          s.activeIndex = s.tabs.length - 1;
        } else if (s.activeIndex > idx) {
          s.activeIndex--;
        }
      }),
    );

    return result;
  }

  function popClosedTab(): { cwd: string; label: string; customLabel: string | null; tabColor: string | null } | null {
    return closedTabsStack.pop() ?? null;
  }

  function updateTabColor(tabId: string, color: string | null) {
    setState(
      produce((s) => {
        const tab = s.tabs.find((t) => t.id === tabId);
        if (tab) tab.tabColor = color;
      }),
    );
  }

  function moveTab(fromIndex: number, toIndex: number) {
    if (
      fromIndex === toIndex ||
      fromIndex < 0 || fromIndex >= state.tabs.length ||
      toIndex < 0 || toIndex >= state.tabs.length
    ) return;

    setState(
      produce((s) => {
        const [moved] = s.tabs.splice(fromIndex, 1);
        s.tabs.splice(toIndex, 0, moved);
        // Keep the moved tab active
        if (s.activeIndex === fromIndex) {
          s.activeIndex = toIndex;
        } else if (fromIndex < s.activeIndex && toIndex >= s.activeIndex) {
          s.activeIndex--;
        } else if (fromIndex > s.activeIndex && toIndex <= s.activeIndex) {
          s.activeIndex++;
        }
      }),
    );
  }

  function getTabsExcept(tabId: string): string[] {
    return state.tabs
      .filter((t) => t.id !== tabId && t.type === "terminal")
      .map((t) => t.id);
  }

  function getTabsToRight(tabId: string): string[] {
    const idx = state.tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return [];
    return state.tabs
      .slice(idx + 1)
      .filter((t) => t.type === "terminal")
      .map((t) => t.id);
  }

  return {
    state,
    stores,
    addTab,
    addTabFromManifest,
    addSettingsTab,
    closeTab,
    switchTab,
    switchTabById,
    nextTab,
    prevTab,
    activeTab,
    activeStore,
    getStoreBySessionId,
    updateTabLabel,
    updateTabCustomLabel,
    updateTabCwd,
    splitPane,
    closePane,
    setActivePane,
    getActivePaneId,
    getPaneTree,
    moveTab,
    addTmuxPane,
    removeTmuxTabs,
    rebuildTmuxLayout,
    replaceTabSession,
    detachTab,
    updateTabColor,
    popClosedTab,
    getTabsExcept,
    getTabsToRight,
  };
}
