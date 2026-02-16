import { Component, For, Show, createSignal, onCleanup } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { TabsStore } from "../stores/tabs";
import type { TabData } from "../lib/types";
import type { TerminalStore } from "../stores/terminal";
import { IconTerminal, IconClose, IconPlus, IconSettings } from "./icons";

// Minimum px the pointer must travel before a drag begins
const DRAG_THRESHOLD = 5;

export const TabBar: Component<{
  tabsStore: TabsStore;
  onNewTab: () => void;
  onCloseTab: (tabId: string) => void;
  onOpenSettings: () => void;
}> = (props) => {
  const [editingTabId, setEditingTabId] = createSignal<string | null>(null);
  const [editValue, setEditValue] = createSignal("");

  // Only used for CSS class (visual styling like opacity/shadow)
  const [dragIndex, setDragIndex] = createSignal<number | null>(null);

  // Refs we need across handlers
  let tabListRef: HTMLDivElement | undefined;
  let tabEls: HTMLDivElement[] = [];
  let dragStartX = 0;
  let dragTabOriginLeft = 0;
  let tabWidths: number[] = [];
  let tabMidpoints: number[] = [];
  let dragActive = false;
  let pendingDragIndex: number | null = null;
  let pendingStartX = 0;
  let pendingTabEl: HTMLDivElement | null = null;
  let currentFromIndex: number | null = null;
  let currentInsertIndex: number | null = null;
  let cleanupDone = false;

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

    const active = store.state.activeBlock;
    if (active && active.command) {
      return active.command;
    }

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

  const handleBarMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;

    const target = e.target as HTMLElement | null;
    if (!target) return;

    if (
      target.closest(
        ".tab-item, .tab-actions, .tab-close, .tab-add, .tab-settings-btn, .tab-rename-input",
      )
    ) {
      return;
    }

    e.preventDefault();
    getCurrentWindow()
      .startDragging()
      .catch((err) => console.warn("[Rain] Failed to start dragging:", err));
  };

  // ---- Pointer-based tab reorder (all transforms are imperative) ----

  function snapshotTabGeometry() {
    tabEls = tabListRef
      ? (Array.from(tabListRef.querySelectorAll(".tab-item")) as HTMLDivElement[])
      : [];
    tabWidths = tabEls.map((el) => el.offsetWidth);
    const listLeft = tabListRef?.getBoundingClientRect().left ?? 0;
    tabMidpoints = tabEls.map((el) => {
      const rect = el.getBoundingClientRect();
      return rect.left - listLeft + rect.width / 2;
    });
  }

  function computeInsertIndex(draggedCenterX: number, fromIdx: number): number {
    let target = fromIdx;
    for (let i = 0; i < tabMidpoints.length; i++) {
      if (i === fromIdx) continue;
      if (i < fromIdx && draggedCenterX < tabMidpoints[i]) {
        target = Math.min(target, i);
      } else if (i > fromIdx && draggedCenterX > tabMidpoints[i]) {
        target = Math.max(target, i);
      }
    }
    return target;
  }

  function getShiftForIndex(i: number, from: number, to: number): number {
    if (i === from) return 0;
    if (from < to && i > from && i <= to) return -tabWidths[from];
    if (from > to && i >= to && i < from) return tabWidths[from];
    return 0;
  }

  function applyShifts(from: number, to: number) {
    for (let i = 0; i < tabEls.length; i++) {
      if (i === from) continue;
      const shift = getShiftForIndex(i, from, to);
      tabEls[i].style.transition = "transform 200ms cubic-bezier(.4,.0,.2,1)";
      tabEls[i].style.transform = shift ? `translateX(${shift}px)` : "";
    }
  }

  function clearAllTransforms() {
    for (const el of tabEls) {
      el.style.transition = "";
      el.style.transform = "";
      el.style.zIndex = "";
    }
  }

  const onPointerDown = (e: PointerEvent, index: number) => {
    if (e.button !== 0) return;
    if (editingTabId() !== null) return;

    pendingDragIndex = index;
    pendingStartX = e.clientX;
    pendingTabEl = e.currentTarget as HTMLDivElement;
    dragActive = false;
    cleanupDone = false;

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (pendingDragIndex === null) return;

    const dx = e.clientX - pendingStartX;

    if (!dragActive) {
      if (Math.abs(dx) < DRAG_THRESHOLD) return;
      // Commit: start the drag
      dragActive = true;
      snapshotTabGeometry();
      const tabEl = pendingTabEl!;
      const listLeft = tabListRef?.getBoundingClientRect().left ?? 0;
      dragTabOriginLeft = tabEl.getBoundingClientRect().left - listLeft;
      dragStartX = pendingStartX;
      currentFromIndex = pendingDragIndex;
      currentInsertIndex = pendingDragIndex;
      setDragIndex(pendingDragIndex);
      // Imperative: lift dragged tab
      tabEl.style.zIndex = "10";
      tabEl.style.transition = "none";
      tabEl.setPointerCapture(e.pointerId);
    }

    const from = currentFromIndex!;
    const offsetX = e.clientX - dragStartX;

    // Imperatively position the dragged tab
    tabEls[from].style.transform = `translateX(${offsetX}px)`;

    // Determine where the dragged tab's center currently is
    const currentCenterX = dragTabOriginLeft + tabWidths[from] / 2 + offsetX;
    currentInsertIndex = computeInsertIndex(currentCenterX, from);
    applyShifts(from, currentInsertIndex);
  };

  const onPointerUp = (_e: PointerEvent) => {
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);

    const from = currentFromIndex;
    const to = currentInsertIndex;

    if (from !== null && to !== null && from !== to && dragActive) {
      // Compute final resting position for the dragged tab
      let targetShift = 0;
      if (to > from) {
        for (let i = from + 1; i <= to; i++) targetShift += tabWidths[i];
      } else {
        for (let i = to; i < from; i++) targetShift -= tabWidths[i];
      }

      const draggedEl = tabEls[from];
      if (draggedEl) {
        // Animate dragged tab to its target slot
        draggedEl.style.transition = "transform 200ms cubic-bezier(.4,.0,.2,1)";
        draggedEl.style.transform = `translateX(${targetShift}px)`;

        const finalize = () => {
          if (cleanupDone) return;
          cleanupDone = true;
          clearAllTransforms();
          setDragIndex(null);
          props.tabsStore.moveTab(from, to);
          currentFromIndex = null;
          currentInsertIndex = null;
          dragActive = false;
          pendingDragIndex = null;
          pendingTabEl = null;
        };

        draggedEl.addEventListener("transitionend", finalize, { once: true });
        // Fallback timeout in case transitionend doesn't fire
        setTimeout(finalize, 260);
        return;
      }
    }

    // No move needed or drag never activated – just reset
    clearAllTransforms();
    setDragIndex(null);
    currentFromIndex = null;
    currentInsertIndex = null;
    pendingDragIndex = null;
    pendingTabEl = null;
    dragActive = false;
  };

  onCleanup(() => {
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
  });

  return (
    <div class="tab-bar" data-tauri-drag-region onMouseDown={handleBarMouseDown}>
      {/* Spacer for macOS traffic light buttons */}
      <div class="tab-traffic-spacer" />

      <div class="tab-list" ref={tabListRef}>
        <For each={props.tabsStore.state.tabs}>
          {(tab, index) => {
            const active = () => index() === props.tabsStore.state.activeIndex;
            const editing = () => editingTabId() === tab.id;
            const running = () => isRunning(tab);
            const subtitle = () => getSubtitle(tab);
            const isDragging = () => dragIndex() === index();

            return (
              <div
                class={`tab-item ${active() ? "tab-active" : ""} ${running() ? "tab-running" : ""} ${isDragging() ? "tab-dragging" : ""}`}
                onClick={() => {
                  if (!dragActive) props.tabsStore.switchTab(index());
                }}
                onPointerDown={(e) => onPointerDown(e, index())}
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

                <button
                  class="tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onCloseTab(tab.id);
                  }}
                >
                  <IconClose size={10} />
                </button>
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
