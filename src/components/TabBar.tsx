import { Component, For, Show, createSignal, createEffect, onCleanup } from "solid-js";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { TabsStore } from "../stores/tabs";
import type {
  SerializableColor,
  TabData,
  PaneNode,
  SessionTransferState,
  TabTransferManifest,
  TabTransferPaneNode,
} from "../lib/types";
import type { TerminalStore } from "../stores/terminal";
import {
  createChildWindow,
  listRainWindows,
  emitCrossWindow,
  requestFullRedraw,
  stageTabTransferManifest,
  type TabTransferFailureReason,
  type WindowBounds,
} from "../lib/ipc";
import { IconTerminal, IconClose, IconPlus, IconSettings } from "./icons";

const DRAG_THRESHOLD = 8;
const MAX_TRANSFER_SNAPSHOTS = 80;
const MOVE_GUARD_NOTICE_MS = 2200;
const PREPARE_TIMEOUT_MS = 3500;
const COMMIT_TIMEOUT_MS = 3500;
const PREPARE_RETRY_COUNT = 4;
const TARGET_READY_ATTEMPTS = 15;
const TARGET_READY_ATTEMPT_TIMEOUT_MS = 400;
const TARGET_READY_RETRY_DELAY_MS = 60;

type PrepareResultPayload = {
  requestId: string;
  transferId: string;
  ok: boolean;
  reason?: TabTransferFailureReason | null;
  readyToken?: string | null;
};

type CommitResultPayload = {
  requestId: string;
  transferId: string;
  ok: boolean;
  reason?: TabTransferFailureReason | null;
};

type ReadyResultPayload = {
  requestId: string;
  transferId: string;
  ok: boolean;
};

function canDetach(tab: TabData): boolean {
  return tab.type === "terminal" && !!tab.sessionId && !tab.tmuxSessionName;
}

export const TabBar: Component<{
  tabsStore: TabsStore;
  onNewTab: () => void;
  onCloseTab: (tabId: string) => void;
  onOpenSettings: () => void;
  onMoveTabToWindow?: (tabId: string) => void;
  onIncMoveLock?: () => void;
  onDecMoveLock?: () => void;
  onCloseOtherTabs?: (tabId: string) => void;
  onCloseTabsToRight?: (tabId: string) => void;
}> = (props) => {
  const [editingTabId, setEditingTabId] = createSignal<string | null>(null);
  const [editValue, setEditValue] = createSignal("");
  const [dragIndex, setDragIndex] = createSignal<number | null>(null);
  const [moveGuardNotice, setMoveGuardNotice] = createSignal<string | null>(null);
  const [contextMenu, setContextMenu] = createSignal<{
    tabId: string;
    tabIndex: number;
    x: number;
    y: number;
    windows: WindowBounds[];
  } | null>(null);

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
  let moveGuardTimer: number | null = null;
  let highlightedWindowLabel: string | null = null;

  const shortCwd = (cwd: string) => {
    if (!cwd) return "";
    const parts = cwd.split("/").filter(Boolean);
    if (parts.length === 0) return "/";
    return parts[parts.length - 1];
  };

  const tabLabel = (tab: TabData) => {
    if (tab.customLabel) return tab.customLabel;
    const prefix = tab.tmuxSessionName ? "tmux: " : "";
    const dir = shortCwd(tab.cwd);
    return prefix + (dir ? dir : tab.label);
  };

  const getTerminalStore = (tab: TabData): TerminalStore | undefined => {
    const paneId = tab.activePaneId || props.tabsStore.getActivePaneId(tab.id);
    return paneId ? props.tabsStore.stores.get(paneId) : undefined;
  };

  const getSubtitle = (tab: TabData): string | null => {
    const store = getTerminalStore(tab);
    if (!store) return null;
    const active = store.state.activeBlock;
    if (active && active.command) return active.command;
    const title = store.state.title;
    if (title && title !== "Rain" && title !== "") return title;
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
    props.tabsStore.updateTabCustomLabel(tab.id, value === "" ? null : value);
    setEditingTabId(null);
  };

  const cancelEdit = () => setEditingTabId(null);

  const handleInputKeyDown = (e: KeyboardEvent, tab: TabData) => {
    if (e.key === "Enter") { e.preventDefault(); commitEdit(tab); }
    else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
  };

  const handleBarMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.closest(".tab-item, .tab-actions, .tab-close, .tab-add, .tab-settings-btn, .tab-rename-input")) return;
    e.preventDefault();
    getCurrentWindow().startDragging().catch(() => {});
  };

  // --- Geometry helpers ---

  function snapshotGeometry() {
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

  function computeInsertIndex(centerX: number, fromIdx: number): number {
    let target = fromIdx;
    for (let i = 0; i < tabMidpoints.length; i++) {
      if (i === fromIdx) continue;
      if (i < fromIdx && centerX < tabMidpoints[i]) target = Math.min(target, i);
      else if (i > fromIdx && centerX > tabMidpoints[i]) target = Math.max(target, i);
    }
    return target;
  }

  function applyShifts(from: number, to: number) {
    for (let i = 0; i < tabEls.length; i++) {
      if (i === from) continue;
      let shift = 0;
      if (from < to && i > from && i <= to) shift = -tabWidths[from];
      else if (from > to && i >= to && i < from) shift = tabWidths[from];
      tabEls[i].style.transition = "transform 200ms cubic-bezier(.4,.0,.2,1)";
      tabEls[i].style.transform = shift ? `translateX(${shift}px)` : "";
    }
  }

  // --- Tab transfer helpers ---

  function collectLeafPanes(
    node: PaneNode | undefined,
    out: Array<{ paneId: string; sessionId: string }> = [],
  ) {
    if (!node) return out;
    if (node.type === "leaf") {
      out.push({ paneId: node.id, sessionId: node.sessionId });
      return out;
    }
    collectLeafPanes(node.first, out);
    collectLeafPanes(node.second, out);
    return out;
  }

  function normalizeSplitRatio(ratio: number): number {
    if (!Number.isFinite(ratio)) return 0.5;
    return Math.max(0.1, Math.min(0.9, ratio));
  }

  function toTransferPaneNode(node: PaneNode): TabTransferPaneNode {
    if (node.type === "leaf") {
      return { type: "leaf", sessionId: node.sessionId };
    }
    return {
      type: "split",
      direction: node.direction,
      ratio: normalizeSplitRatio(node.ratio),
      first: toTransferPaneNode(node.first),
      second: toTransferPaneNode(node.second),
    };
  }

  function buildSessionTransferState(
    paneStore: TerminalStore,
    fallbackCwd: string,
  ): SessionTransferState {
    const paneState = paneStore.state;
    return {
      cwd: paneState.cwd?.trim() || fallbackCwd || "",
      shell_integration_active: paneState.shellIntegrationActive,
      snapshots: paneState.snapshots
      .slice(-MAX_TRANSFER_SNAPSHOTS)
      .map((snap) => ({
        id: snap.id,
        command: snap.command,
        lines: snap.lines.map((line) => ({
          index: line.index,
          spans: line.spans.map((span) => ({
            text: span.text,
            fg: span.fg as SerializableColor,
            bg: span.bg as SerializableColor,
            bold: span.bold,
            dim: span.dim,
            italic: span.italic,
            underline: span.underline,
            strikethrough: span.strikethrough,
            url: span.url ?? null,
          })),
        })),
        timestamp: Math.max(0, Math.trunc(snap.timestamp ?? Date.now())),
        end_time: snap.endTime == null ? null : Math.max(0, Math.trunc(snap.endTime)),
        cwd: snap.cwd || paneState.cwd || fallbackCwd || "",
        failed: !!snap.failed,
      })),
      active_block: paneState.activeBlock
        ? {
            id: paneState.activeBlock.id,
            command: paneState.activeBlock.command,
            cwd: paneState.activeBlock.cwd || paneState.cwd || fallbackCwd || "",
            start_time: Math.max(0, Math.trunc(paneState.activeBlock.startTime || Date.now())),
            output_start: Math.max(0, Math.trunc(paneState.activeBlock.outputStart || 0)),
            tmux_command: !!paneState.activeBlock.tmuxCommand,
          }
        : null,
    };
  }

  function emptyTransferState(fallbackCwd: string): SessionTransferState {
    return {
      cwd: fallbackCwd || "",
      shell_integration_active: false,
      snapshots: [],
      active_block: null,
    };
  }

  function showMoveGuard(message: string) {
    setMoveGuardNotice(message);
    if (moveGuardTimer != null) {
      window.clearTimeout(moveGuardTimer);
    }
    moveGuardTimer = window.setTimeout(() => {
      setMoveGuardNotice(null);
      moveGuardTimer = null;
    }, MOVE_GUARD_NOTICE_MS);
  }

  function buildTabTransferPayload(
    tab: TabData,
  ): { primarySessionId: string; label: string; cwd: string; manifest: TabTransferManifest } | null {
    if (!tab.sessionId) return null;
    const fallbackCwd = tab.cwd || "";
    let leaves = collectLeafPanes(tab.paneTree);
    let paneTreeForTransfer: TabTransferPaneNode;
    if (leaves.length === 0) {
      leaves = [{ paneId: tab.activePaneId ?? "", sessionId: tab.sessionId }];
      paneTreeForTransfer = { type: "leaf", sessionId: tab.sessionId };
    } else {
      paneTreeForTransfer = toTransferPaneNode(tab.paneTree!);
    }

    const activePaneId = tab.activePaneId || props.tabsStore.getActivePaneId(tab.id);
    const activeLeaf = leaves.find((leaf) => leaf.paneId === activePaneId) ?? leaves[0];
    const primarySessionId = activeLeaf?.sessionId || tab.sessionId;
    if (!primarySessionId) return null;

    const paneSessions = leaves.map((leaf) => {
      const paneStore =
        (leaf.paneId ? props.tabsStore.stores.get(leaf.paneId) : undefined) ??
        props.tabsStore.getStoreBySessionId(leaf.sessionId);
      return {
        sessionId: leaf.sessionId,
        state: paneStore
          ? buildSessionTransferState(paneStore, fallbackCwd)
          : emptyTransferState(fallbackCwd),
      };
    });

    const activeStore =
      (activeLeaf?.paneId ? props.tabsStore.stores.get(activeLeaf.paneId) : undefined) ??
      props.tabsStore.getStoreBySessionId(primarySessionId);
    const cwd =
      activeStore?.state.cwd?.trim() ||
      fallbackCwd ||
      "";
    const manifest: TabTransferManifest = {
      label: tab.label,
      customLabel: tab.customLabel ?? null,
      cwd,
      paneTree: paneTreeForTransfer,
      activeSessionId: primarySessionId,
      paneSessions,
    };
    return {
      primarySessionId,
      label: tabLabel(tab),
      cwd,
      manifest,
    };
  }

  function createTransferId(): string {
    const cryptoObj = globalThis.crypto as Crypto | undefined;
    if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
    return `move-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function stageTransferPayload(tab: TabData): Promise<{
    transferId: string;
    primarySessionId: string;
    label: string;
    cwd: string;
    manifest: TabTransferManifest;
  } | null> {
    const payload = buildTabTransferPayload(tab);
    if (!payload) {
      showMoveGuard("Unable to move this tab right now.");
      return null;
    }
    const transferId = createTransferId();
    try {
      await stageTabTransferManifest(transferId, payload.manifest);
      return {
        transferId,
        primarySessionId: payload.primarySessionId,
        label: payload.label,
        cwd: payload.cwd,
        manifest: payload.manifest,
      };
    } catch (error) {
      const compactManifest: TabTransferManifest = {
        ...payload.manifest,
        paneSessions: payload.manifest.paneSessions.map((pane) => ({
          sessionId: pane.sessionId,
          state: emptyTransferState(pane.state.cwd || payload.cwd),
        })),
      };
      try {
        await stageTabTransferManifest(transferId, compactManifest);
        return {
          transferId,
          primarySessionId: payload.primarySessionId,
          label: payload.label,
          cwd: payload.cwd,
          manifest: compactManifest,
        };
      } catch (retryError) {
        console.warn("[Rain] Failed to stage transfer manifest:", error, retryError);
      }
      showMoveGuard("Unable to move this tab right now.");
      return null;
    }
  }

  function describeMoveFailure(reason?: TabTransferFailureReason | null): string {
    switch (reason) {
      case "duplicate_session":
        return "Target window already has one of these panes.";
      case "expired_transfer":
        return "Move timed out. Try again.";
      case "invalid_manifest":
        return "Move payload became invalid. Try again.";
      case "not_prepared":
        return "Move target was not ready.";
      case "target_unavailable":
        return "Target window is unavailable.";
      case "timeout":
      default:
        return "Move timed out. Try again.";
    }
  }

  async function emitAndWaitForResult<TPayload extends { requestId: string; transferId: string }>(
    eventName: string,
    requestId: string,
    transferId: string,
    timeoutMs: number,
    emitRequest: () => Promise<void>,
  ): Promise<TPayload | null> {
    let resolvePromise!: (payload: TPayload | null) => void;
    const resultPromise = new Promise<TPayload | null>((resolve) => {
      resolvePromise = resolve;
    });

    let settled = false;
    let timer: number | null = null;
    let unlistenFn: UnlistenFn | null = null;
    const finish = (payload: TPayload | null) => {
      if (settled) return;
      settled = true;
      if (timer != null) window.clearTimeout(timer);
      if (unlistenFn) {
        void unlistenFn();
        unlistenFn = null;
      }
      resolvePromise(payload);
    };

    timer = window.setTimeout(() => finish(null), timeoutMs);
    try {
      unlistenFn = await listen<TPayload>(eventName, (event) => {
        const payload = event.payload;
        if (payload.requestId !== requestId || payload.transferId !== transferId) return;
        finish(payload);
      });
    } catch {
      finish(null);
      return resultPromise;
    }

    try {
      await emitRequest();
    } catch {
      finish(null);
    }
    return resultPromise;
  }

  async function waitForTargetAdoptReady(targetLabel: string, transferId: string): Promise<boolean> {
    const sourceLabel = getCurrentWindow().label;
    for (let attempt = 1; attempt <= TARGET_READY_ATTEMPTS; attempt++) {
      const requestId = createTransferId();
      const result = await emitAndWaitForResult<ReadyResultPayload>(
        "tab-adopt-ready-result",
        requestId,
        transferId,
        TARGET_READY_ATTEMPT_TIMEOUT_MS,
        () =>
          emitCrossWindow(targetLabel, "tab-adopt-ready-check", {
            requestId,
            transferId,
            sourceLabel,
          }),
      );

      if (result?.ok) return true;
      if (attempt < TARGET_READY_ATTEMPTS) {
        await new Promise((resolve) => window.setTimeout(resolve, TARGET_READY_RETRY_DELAY_MS));
      }
    }
    return false;
  }

  async function requestPrepareAdopt(
    targetLabel: string,
    transferId: string,
  ): Promise<{ ok: boolean; reason?: TabTransferFailureReason | null; readyToken?: string | null }> {
    const sourceLabel = getCurrentWindow().label;
    for (let attempt = 1; attempt <= PREPARE_RETRY_COUNT; attempt++) {
      const requestId = createTransferId();
      const result = await emitAndWaitForResult<PrepareResultPayload>(
        "tab-adopt-prepare-result",
        requestId,
        transferId,
        PREPARE_TIMEOUT_MS,
        () =>
          emitCrossWindow(targetLabel, "tab-adopt-prepare", {
            requestId,
            transferId,
            sourceLabel,
          }),
      );
      if (!result) continue;
      if (!result.ok) return { ok: false, reason: result.reason ?? "invalid_manifest" };
      return { ok: true, readyToken: result.readyToken };
    }
    return { ok: false, reason: "timeout" };
  }

  async function requestCommitAdopt(
    targetLabel: string,
    transferId: string,
    readyToken: string,
  ): Promise<{ ok: boolean; reason?: TabTransferFailureReason | null }> {
    const sourceLabel = getCurrentWindow().label;
    const requestId = createTransferId();
    const result = await emitAndWaitForResult<CommitResultPayload>(
      "tab-adopt-commit-result",
      requestId,
      transferId,
      COMMIT_TIMEOUT_MS,
      () =>
        emitCrossWindow(targetLabel, "tab-adopt-commit", {
          requestId,
          transferId,
          readyToken,
          sourceLabel,
        }),
    );
    if (!result) return { ok: false, reason: "timeout" };
    if (!result.ok) return { ok: false, reason: result.reason ?? "invalid_manifest" };
    return { ok: true };
  }

  function applyRollbackSessionState(
    sessionId: string,
    transfer: SessionTransferState,
    fallbackCwd: string,
  ) {
    const store = props.tabsStore.getStoreBySessionId(sessionId);
    if (!store) return;
    const snapshots = transfer.snapshots.map((snap) => ({
      id: snap.id,
      command: snap.command,
      lines: snap.lines.map((line) => ({
        index: line.index,
        spans: line.spans.map((span) => ({
          text: span.text,
          fg: span.fg as SerializableColor,
          bg: span.bg as SerializableColor,
          bold: span.bold,
          dim: span.dim,
          italic: span.italic,
          underline: span.underline,
          strikethrough: span.strikethrough,
          ...(span.url ? { url: span.url } : {}),
        })),
      })),
      timestamp: snap.timestamp,
      endTime: snap.end_time,
      cwd: snap.cwd,
      failed: snap.failed,
    }));
    const activeBlock = transfer.active_block
      ? {
          id: transfer.active_block.id,
          command: transfer.active_block.command,
          cwd: transfer.active_block.cwd,
          startTime: transfer.active_block.start_time,
          outputStart: transfer.active_block.output_start,
          tmuxCommand: transfer.active_block.tmux_command,
        }
      : null;
    store.setState({
      cwd: transfer.cwd || fallbackCwd || store.state.cwd,
      shellIntegrationActive: transfer.shell_integration_active,
      snapshots,
      activeBlock,
    });
  }

  async function rollbackDetachedTab(
    manifest: TabTransferManifest,
    restoreIndex: number,
  ) {
    const restored = props.tabsStore.addTabFromManifest(manifest, restoreIndex);
    if (!restored) return;
    for (const pane of manifest.paneSessions) {
      applyRollbackSessionState(pane.sessionId, pane.state, manifest.cwd || "");
      await requestFullRedraw(pane.sessionId).catch(() => {});
    }
    props.tabsStore.updateTabCwd(restored.data.id, manifest.cwd || "");
  }

  async function executeMoveFlow(
    tabId: string,
    staged: NonNullable<Awaited<ReturnType<typeof stageTransferPayload>>>,
    targetLabel: string,
    restoreIndex?: number,
  ) {
    const prepare = await requestPrepareAdopt(targetLabel, staged.transferId);
    if (!prepare.ok || !prepare.readyToken) {
      showMoveGuard(describeMoveFailure(prepare.reason));
      return;
    }

    props.onIncMoveLock?.();
    try {
      if (!props.onMoveTabToWindow) {
        showMoveGuard("Move action is unavailable in this window.");
        return;
      }
      props.onMoveTabToWindow(tabId);
      const commit = await requestCommitAdopt(
        targetLabel,
        staged.transferId,
        prepare.readyToken,
      );
      if (!commit.ok) {
        await rollbackDetachedTab(
          staged.manifest,
          restoreIndex ?? props.tabsStore.state.tabs.length,
        );
        showMoveGuard(describeMoveFailure(commit.reason));
        return;
      }
    } finally {
      props.onDecMoveLock?.();
    }
  }

  // --- Drag reorder ---

  function resetDrag() {
    for (const el of tabEls) {
      el.style.transition = "";
      el.style.transform = "";
      el.style.zIndex = "";
    }
    setDragIndex(null);
    currentFromIndex = null;
    currentInsertIndex = null;
    pendingDragIndex = null;
    pendingTabEl = null;
    dragActive = false;
    document.body.style.cursor = "";
  }

  const preventSelect = (e: Event) => e.preventDefault();

  const onPointerDown = (e: PointerEvent, index: number) => {
    if (e.button !== 0 || editingTabId() !== null) return;
    closeContextMenu();
    e.preventDefault();
    pendingDragIndex = index;
    pendingStartX = e.clientX;
    pendingTabEl = e.currentTarget as HTMLDivElement;
    dragActive = false;
    cleanupDone = false;
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("selectstart", preventSelect);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (pendingDragIndex === null) return;
    const dx = e.clientX - pendingStartX;

    if (!dragActive) {
      if (Math.abs(dx) < DRAG_THRESHOLD) return;
      dragActive = true;
      const startedIndex = pendingDragIndex;
      if (startedIndex === null) return;
      snapshotGeometry();
      const tabEl = pendingTabEl!;
      const listLeft = tabListRef?.getBoundingClientRect().left ?? 0;
      dragTabOriginLeft = tabEl.getBoundingClientRect().left - listLeft;
      dragStartX = pendingStartX;
      currentFromIndex = startedIndex;
      currentInsertIndex = startedIndex;
      setDragIndex(startedIndex);
      tabEl.style.zIndex = "10";
      tabEl.style.transition = "none";
      tabEl.setPointerCapture(e.pointerId);
      document.body.style.cursor = "grabbing";
    }

    const from = currentFromIndex!;
    const offsetX = e.clientX - dragStartX;
    const currentCenterX = dragTabOriginLeft + tabWidths[from] / 2 + offsetX;
    currentInsertIndex = computeInsertIndex(currentCenterX, from);
    applyShifts(from, currentInsertIndex);

    let snapOffset = 0;
    if (currentInsertIndex > from) {
      for (let i = from + 1; i <= currentInsertIndex; i++) snapOffset += tabWidths[i];
    } else if (currentInsertIndex < from) {
      for (let i = currentInsertIndex; i < from; i++) snapOffset -= tabWidths[i];
    }
    tabEls[from].style.transition = "transform 150ms cubic-bezier(.4,.0,.2,1)";
    tabEls[from].style.transform = `translateX(${snapOffset}px)`;
  };

  const onPointerUp = async (_e: PointerEvent) => {
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("selectstart", preventSelect);

    const from = currentFromIndex;
    const to = currentInsertIndex;
    if (from !== null && to !== null && from !== to && dragActive) {
      let targetShift = 0;
      if (to > from) {
        for (let i = from + 1; i <= to; i++) targetShift += tabWidths[i];
      } else {
        for (let i = to; i < from; i++) targetShift -= tabWidths[i];
      }
      const draggedEl = tabEls[from];
      if (draggedEl) {
        draggedEl.style.transition = "transform 200ms cubic-bezier(.4,.0,.2,1)";
        draggedEl.style.transform = `translateX(${targetShift}px)`;
        const finalize = () => {
          if (cleanupDone) return;
          cleanupDone = true;
          resetDrag();
          props.tabsStore.moveTab(from, to);
        };
        draggedEl.addEventListener("transitionend", finalize, { once: true });
        setTimeout(finalize, 260);
        return;
      }
    }

    resetDrag();
  };

  // --- Tab context menu ---

  function closeContextMenu() {
    if (highlightedWindowLabel) {
      emitCrossWindow(highlightedWindowLabel, "window-unhighlight", {}).catch(() => {});
      highlightedWindowLabel = null;
    }
    setContextMenu(null);
  }

  async function openTabContextMenu(e: MouseEvent, tab: TabData, index: number) {
    e.preventDefault();
    e.stopPropagation();
    if (!canDetach(tab)) return;

    let windows: WindowBounds[] = [];
    try {
      const allWindows = await listRainWindows();
      const myLabel = getCurrentWindow().label;
      windows = allWindows
        .filter(w => w.label !== myLabel && !w.label.startsWith("ghost-"))
        .sort((a, b) => a.label.localeCompare(b.label));
    } catch { /* noop */ }

    const hasMultipleTabs = props.tabsStore.state.tabs.length > 1;
    if (!hasMultipleTabs && windows.length === 0) return;

    setContextMenu({
      tabId: tab.id,
      tabIndex: index,
      x: e.clientX,
      y: e.clientY,
      windows,
    });
  }

  function handleWindowHover(label: string) {
    if (highlightedWindowLabel && highlightedWindowLabel !== label) {
      emitCrossWindow(highlightedWindowLabel, "window-unhighlight", {}).catch(() => {});
    }
    highlightedWindowLabel = label;
    emitCrossWindow(label, "window-highlight", {}).catch(() => {});
  }

  function handleWindowLeave(label: string) {
    if (highlightedWindowLabel === label) {
      emitCrossWindow(label, "window-unhighlight", {}).catch(() => {});
      highlightedWindowLabel = null;
    }
  }

  async function handleMoveToNewWindow(tabId: string) {
    closeContextMenu();
    const tab = props.tabsStore.state.tabs.find(t => t.id === tabId);
    if (!tab || !canDetach(tab)) return;

    const tabIndex = props.tabsStore.state.tabs.findIndex(t => t.id === tabId);
    const staged = await stageTransferPayload(tab);
    if (!staged) return;

    const createdWindow = await createChildWindow(
      staged.primarySessionId,
      staged.label,
      window.screenX + 50,
      window.screenY + 50,
      window.innerWidth,
      window.innerHeight,
      staged.cwd || undefined,
      staged.transferId,
    ).catch((err) => {
      console.error("[Rain] Failed to create child window:", err);
      showMoveGuard("Failed to create target window.");
      return null;
    });
    if (createdWindow) {
      const ready = await waitForTargetAdoptReady(createdWindow, staged.transferId);
      if (!ready) {
        showMoveGuard("Target window is still starting up. Try again.");
        return;
      }
      await executeMoveFlow(tabId, staged, createdWindow, tabIndex);
    }
  }

  async function handleMoveToWindow(tabId: string, targetLabel: string) {
    closeContextMenu();
    const tab = props.tabsStore.state.tabs.find(t => t.id === tabId);
    if (!tab || !canDetach(tab)) return;

    const tabIndex = props.tabsStore.state.tabs.findIndex(t => t.id === tabId);
    const staged = await stageTransferPayload(tab);
    if (!staged) return;

    await executeMoveFlow(tabId, staged, targetLabel, tabIndex);
  }

  // Close context menu on outside click or Escape
  function handleDocumentMouseDown(e: MouseEvent) {
    if (!contextMenu()) return;
    const menuEl = document.querySelector(".tab-context-menu");
    if (menuEl && menuEl.contains(e.target as Node)) return;
    closeContextMenu();
  }
  function handleDocumentKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && contextMenu()) {
      e.preventDefault();
      closeContextMenu();
    }
  }
  document.addEventListener("mousedown", handleDocumentMouseDown);
  document.addEventListener("keydown", handleDocumentKeyDown);

  onCleanup(() => {
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("selectstart", preventSelect);
    document.removeEventListener("mousedown", handleDocumentMouseDown);
    document.removeEventListener("keydown", handleDocumentKeyDown);
    document.body.style.cursor = "";
    if (moveGuardTimer != null) {
      window.clearTimeout(moveGuardTimer);
      moveGuardTimer = null;
    }
    if (highlightedWindowLabel) {
      emitCrossWindow(highlightedWindowLabel, "window-unhighlight", {}).catch(() => {});
      highlightedWindowLabel = null;
    }
  });

  createEffect(() => {
    const _idx = props.tabsStore.state.activeIndex;
    const _len = props.tabsStore.state.tabs.length;
    setTimeout(() => {
      const el = tabListRef?.querySelector(".tab-active") as HTMLElement | null;
      el?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    }, 0);
  });

  return (
    <div class={`tab-bar${contextMenu() ? " tab-bar-has-menu" : ""}`} role="tablist" aria-label="Terminal tabs" data-tauri-drag-region onMouseDown={handleBarMouseDown}>
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
                role="tab"
                aria-selected={active()}
                aria-label={`${tabLabel(tab)}${running() ? ", running" : ""}`}
                title={tab.cwd || tab.customLabel || tab.label}
                tabIndex={active() ? 0 : -1}
                onClick={() => { if (!dragActive) props.tabsStore.switchTab(index()); }}
                onPointerDown={(e) => onPointerDown(e, index())}
                onContextMenu={(e) => openTabContextMenu(e, tab, index())}
              >
                <Show when={tab.tabColor}>
                  <span
                    class="tab-color-badge"
                    style={{ "background-color": tab.tabColor! }}
                  />
                </Show>
                <Show when={active() && tab.type === "terminal"}>
                  <input
                    class="tab-color-picker"
                    type="color"
                    value={tab.tabColor ?? "#5da3ff"}
                    title="Set tab color"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    onInput={(e) => {
                      e.stopPropagation();
                      props.tabsStore.updateTabColor(tab.id, e.currentTarget.value);
                    }}
                  />
                </Show>
                <Show when={active() && !!tab.tabColor}>
                  <button
                    class="tab-color-clear-btn"
                    title="Clear tab color"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.tabsStore.updateTabColor(tab.id, null);
                    }}
                  >
                    ×
                  </button>
                </Show>
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
                        ref={(el) => { requestAnimationFrame(() => { el.focus(); el.select(); }); }}
                      />
                    }
                  >
                    <span
                      class="tab-label"
                      onDblClick={(e) => { e.stopPropagation(); startEditing(tab); }}
                    >
                      {tabLabel(tab)}
                    </span>
                  </Show>

                  <Show when={subtitle() && !editing()}>
                    <span class="tab-subtitle" title={subtitle()!}>{subtitle()}</span>
                  </Show>
                </div>

                <button
                  class="tab-close"
                  aria-label={`Close ${tabLabel(tab)}`}
                  onClick={(e) => { e.stopPropagation(); props.onCloseTab(tab.id); }}
                >
                  <IconClose size={10} />
                </button>
              </div>
            );
          }}
        </For>
      </div>

      <div class="tab-actions">
        <Show when={moveGuardNotice()}>
          <span class="tab-move-guard-notice">{moveGuardNotice()}</span>
        </Show>
        <button class="tab-add" onClick={props.onNewTab} title="New tab">
          <IconPlus size={14} />
        </button>
        <button class="tab-settings-btn" onClick={props.onOpenSettings} title="Settings">
          <IconSettings size={14} />
        </button>
      </div>

      <Show when={contextMenu()}>
        {(menu) => {
          const hasMultipleTabs = () => props.tabsStore.state.tabs.length > 1;
          return (
            <div
              class="tab-context-menu context-menu"
              role="menu"
              aria-label="Tab actions"
              style={{ position: "fixed", left: `${menu().x}px`, top: `${menu().y}px` }}
            >
              <Show when={hasMultipleTabs()}>
                <button
                  class="context-menu-item"
                  role="menuitem"
                  onClick={() => handleMoveToNewWindow(menu().tabId)}
                >
                  Move to new window
                </button>
              </Show>
              <Show when={hasMultipleTabs() && menu().windows.length > 0}>
                <div class="context-menu-separator" />
              </Show>
              <For each={menu().windows}>
                {(win, winIndex) => (
                  <button
                    class="context-menu-item"
                    role="menuitem"
                    onMouseEnter={() => handleWindowHover(win.label)}
                    onMouseLeave={() => handleWindowLeave(win.label)}
                    onClick={() => handleMoveToWindow(menu().tabId, win.label)}
                  >
                    Move to window {winIndex() + 1}
                  </button>
                )}
              </For>
              <Show when={hasMultipleTabs()}>
                <div class="context-menu-separator" />
                <button
                  class="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    const tabId = menu().tabId;
                    closeContextMenu();
                    props.onCloseOtherTabs?.(tabId);
                  }}
                >
                  Close Other Tabs
                </button>
                <button
                  class="context-menu-item"
                  role="menuitem"
                  disabled={menu().tabIndex >= props.tabsStore.state.tabs.length - 1}
                  onClick={() => {
                    const tabId = menu().tabId;
                    closeContextMenu();
                    props.onCloseTabsToRight?.(tabId);
                  }}
                >
                  Close Tabs to the Right
                </button>
              </Show>
            </div>
          );
        }}
      </Show>
    </div>
  );
};
