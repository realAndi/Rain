import { createStore, produce } from "solid-js/store";
import { createTerminalStore, type TerminalStore } from "./terminal";
import type { TabData, PaneNode, PaneLeaf, PaneSplit } from "../lib/types";

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
  addTab: (sessionId: string, label?: string) => Tab;
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
}

let tabCounter = 0;

export function createTabsStore(): TabsStore {
  const [state, setState] = createStore<TabsState>({
    tabs: [],
    activeIndex: 0,
  });

  // Map of tabId -> TerminalStore (stores can't live in solid-js/store)
  const stores = new Map<string, TerminalStore>();
  // Map of sessionId -> tabId for routing render frames
  const sessionToTab = new Map<string, string>();

  let paneCounter = 0;

  function addTab(sessionId: string, label?: string): Tab {
    const id = `tab-${++tabCounter}`;
    const paneId = `pane-${++paneCounter}`;
    const store = createTerminalStore();
    store.setState({ sessionId, connected: true });

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
      cwd: "",
      paneTree,
      activePaneId: paneId,
    };

    stores.set(paneId, store);
    sessionToTab.set(sessionId, paneId);

    setState(
      produce((s) => {
        s.tabs.push(tabData);
        s.activeIndex = s.tabs.length - 1;
      }),
    );

    return { data: tabData, store };
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

  return {
    state,
    stores,
    addTab,
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
  };
}
