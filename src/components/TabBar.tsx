import { Component, For, Show, createSignal } from "solid-js";
import type { TabsStore } from "../stores/tabs";
import type { TabData } from "../lib/types";
import type { TerminalStore } from "../stores/terminal";
import { IconTerminal, IconClose, IconPlus, IconSettings } from "./icons";

export const TabBar: Component<{
  tabsStore: TabsStore;
  onNewTab: () => void;
  onCloseTab: (tabId: string) => void;
  onOpenSettings: () => void;
}> = (props) => {
  const [editingTabId, setEditingTabId] = createSignal<string | null>(null);
  const [editValue, setEditValue] = createSignal("");

  const shortCwd = (cwd: string) => {
    if (!cwd) return "";
    const parts = cwd.split("/").filter(Boolean);
    if (parts.length === 0) return "/";
    const last = parts[parts.length - 1];
    return last;
  };

  const tabLabel = (tab: TabData) => {
    if (tab.customLabel) return tab.customLabel;
    const dir = shortCwd(tab.cwd);
    return dir ? dir : tab.label;
  };

  const getTerminalStore = (tab: TabData): TerminalStore | undefined => {
    return props.tabsStore.stores.get(tab.id);
  };

  const getSubtitle = (tab: TabData): string | null => {
    const store = getTerminalStore(tab);
    if (!store) return null;

    // If a command is actively running, show it
    const active = store.state.activeBlock;
    if (active && active.command) {
      return active.command;
    }

    // Otherwise show the terminal title if it differs from defaults
    const title = store.state.title;
    if (title && title !== "Rain" && title !== "") {
      return title;
    }

    return null;
  };

  const isRunning = (tab: TabData): boolean => {
    const store = getTerminalStore(tab);
    if (!store) return false;
    return store.state.activeBlock !== null;
  };

  const startEditing = (tab: TabData) => {
    setEditingTabId(tab.id);
    setEditValue(tab.customLabel ?? tabLabel(tab));
  };

  const commitEdit = (tab: TabData) => {
    const value = editValue().trim();
    if (value === "") {
      // Clear custom label, revert to auto name
      props.tabsStore.updateTabCustomLabel(tab.id, null);
    } else {
      props.tabsStore.updateTabCustomLabel(tab.id, value);
    }
    setEditingTabId(null);
  };

  const cancelEdit = () => {
    setEditingTabId(null);
  };

  const handleInputKeyDown = (e: KeyboardEvent, tab: TabData) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit(tab);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  };

  return (
    <div class="tab-bar" data-tauri-drag-region>
      {/* Spacer for macOS traffic light buttons */}
      <div class="tab-traffic-spacer" />

      <div class="tab-list">
        <For each={props.tabsStore.state.tabs}>
          {(tab, index) => {
            const active = () => index() === props.tabsStore.state.activeIndex;
            const editing = () => editingTabId() === tab.id;
            const running = () => isRunning(tab);
            const subtitle = () => getSubtitle(tab);

            return (
              <div
                class={`tab-item ${active() ? "tab-active" : ""} ${running() ? "tab-running" : ""}`}
                onClick={() => props.tabsStore.switchTab(index())}
              >
                <span class="tab-icon">
                  <Show when={tab.type === "settings"} fallback={
                    <Show when={running()} fallback={<IconTerminal size={13} />}>
                      <span class="tab-running-indicator">
                        <span class="tab-running-dot" />
                      </span>
                    </Show>
                  }>
                    <IconSettings size={13} />
                  </Show>
                </span>

                <div class="tab-content">
                  <Show
                    when={!editing()}
                    fallback={
                      <input
                        class="tab-rename-input"
                        type="text"
                        value={editValue()}
                        onInput={(e) => setEditValue(e.currentTarget.value)}
                        onKeyDown={(e) => handleInputKeyDown(e, tab)}
                        onBlur={() => commitEdit(tab)}
                        onClick={(e) => e.stopPropagation()}
                        ref={(el) => {
                          // Auto-focus and select when input appears
                          requestAnimationFrame(() => {
                            el.focus();
                            el.select();
                          });
                        }}
                      />
                    }
                  >
                    <span
                      class="tab-label"
                      onDblClick={(e) => {
                        e.stopPropagation();
                        startEditing(tab);
                      }}
                    >
                      {tabLabel(tab)}
                    </span>
                  </Show>

                  <Show when={subtitle() && !editing()}>
                    <span class="tab-subtitle" title={subtitle()!}>
                      {subtitle()}
                    </span>
                  </Show>
                </div>

                {props.tabsStore.state.tabs.length > 1 && (
                  <button
                    class="tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onCloseTab(tab.id);
                    }}
                  >
                    <IconClose size={10} />
                  </button>
                )}
              </div>
            );
          }}
        </For>
      </div>

      <div class="tab-actions">
        <button class="tab-add" onClick={props.onNewTab} title="New tab">
          <IconPlus size={14} />
        </button>
        <button class="tab-settings-btn" onClick={props.onOpenSettings} title="Settings">
          <IconSettings size={14} />
        </button>
      </div>
    </div>
  );
};
