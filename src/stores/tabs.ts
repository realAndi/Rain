import { createStore, produce } from "solid-js/store";
import { createTerminalStore, type TerminalStore } from "./terminal";
import type { TabData } from "../lib/types";

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

  function addTab(sessionId: string, label?: string): Tab {
    const id = `tab-${++tabCounter}`;
    const store = createTerminalStore();
    store.setState({ sessionId, connected: true });

    const tabData: TabData = {
      id,
      type: "terminal",
      label: label ?? "Shell",
      customLabel: null,
      sessionId,
      cwd: "",
    };

    stores.set(id, store);
    sessionToTab.set(sessionId, id);

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

  function closeTab(tabId: string) {
    const tabData = state.tabs.find((t) => t.id === tabId);
    if (!tabData) return;

    // Don't close the last terminal tab
    const terminalTabs = state.tabs.filter((t) => t.type === "terminal");
    if (tabData.type === "terminal" && terminalTabs.length <= 1) return;

    const idx = state.tabs.findIndex((t) => t.id === tabId);

    if (tabData.sessionId) {
      sessionToTab.delete(tabData.sessionId);
    }
    stores.delete(tabId);

    setState(
      produce((s) => {
        s.tabs.splice(idx, 1);
        // Adjust active index
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
    return tab ? stores.get(tab.id) : undefined;
  }

  function getStoreBySessionId(sessionId: string): TerminalStore | undefined {
    const tabId = sessionToTab.get(sessionId);
    return tabId ? stores.get(tabId) : undefined;
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
  };
}
