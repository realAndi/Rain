import {
  Component,
  For,
  onMount,
  onCleanup,
  Show,
  createEffect,
  createMemo,
  createSignal,
} from "solid-js";
import { PaneContainer } from "./components/PaneContainer";
import { TabBar } from "./components/TabBar";
import { StatusBar } from "./components/StatusBar";
import { Settings } from "./components/Settings";
import { CommandPalette, type PaletteAction } from "./components/CommandPalette";
import { HistoryBrowser } from "./components/HistoryBrowser";
import { createTabsStore } from "./stores/tabs";
import { useConfig, defaultConfig, type MacosGlassEngine } from "./stores/config";
import {
  computeBlurProfile,
  computeGlassSurfaceOpacities,
  deriveBackgroundPalette,
  opacityUnitToPercent,
} from "./lib/glass";
import { useTheme, THEME_LIST, type ThemeName } from "./stores/theme";
import {
  createSession,
  destroySession,
  onRenderFrame,
  onResizeAck,
  onSessionEnded,
  requestFullRedraw,
  setAppIcon,
  setWindowBlurRadius,
  setWindowOpacity,
  writeInput,
  emitCrossWindow,
  takeSessionTransferState,
  takeTabTransferManifest,
  prepareTabTransferAdopt,
  releaseTabTransferAdopt,
  commitTabTransferAdopt,
  type TabTransferFailureReason,
  tmuxStart,
  tmuxListSessions,
  tmuxSplitPane,
  tmuxSelectPane,
  tmuxClosePane,
  tmuxDetach,
  onTmuxEvent,
  type TmuxEvent,
  registerGlobalHotkey,
  listRainWindows,
  quitApp,
  saveTextToFile,
} from "./lib/ipc";
import {
  disableLiquidGlassEffect,
  setLiquidGlassEffectSafe,
} from "./lib/liquidGlass";
import { detectPlatform, shortenHomePath } from "./lib/platform";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  PaneNode,
  RenderFramePayload,
  SerializableColor,
  SessionTransferState,
  TabTransferManifest,
} from "./lib/types";
import { buildSavedWorkspace, persistWorkspace, restoreWorkspace, type SavedWorkspace, type SavedPaneNode } from "./lib/sessionRestore";
import { matchesKeybinding } from "./lib/keybindings";
import { getActiveProfile, getProfile } from "./lib/profiles";
import { ToastContainer, showToast } from "./components/Toast";
import {
  checkForUpdates,
  shouldCheckForUpdates,
  markUpdateChecked,
  dismissVersion,
  isDismissed,
  type UpdateInfo,
} from "./lib/updater";

const THEME_BG_MAP = new Map(THEME_LIST.map((entry) => [entry.name, entry.bg]));
const THEME_ACCENT_MAP = new Map(
  THEME_LIST.map((entry) => [entry.name, entry.accent]),
);

const ADOPT_TRANSFER_FALLBACK_MS = 18000;
const ADOPT_TRANSFER_POLL_MS = 120;

type AdoptProgressState = {
  transferId: string;
  label: string;
  total: number;
  created: number;
  applied: number;
  redrawn: number;
};

const App: Component = () => {
  const tabs = createTabsStore();
  const { config, updateConfig } = useConfig();
  const { theme, setTheme } = useTheme();
  const unlisteners: UnlistenFn[] = [];
  const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
  const [liquidRuntimeFailed, setLiquidRuntimeFailed] = createSignal(false);
  const [windowHighlighted, setWindowHighlighted] = createSignal(false);
  const [adoptProgress, setAdoptProgress] = createSignal<AdoptProgressState | null>(null);
  const [showPalette, setShowPalette] = createSignal(false);
  const [showHistory, setShowHistory] = createSignal(false);
  const [updateInfo, setUpdateInfo] = createSignal<UpdateInfo | null>(null);
  let glassEffectRunSeq = 0;
  const pendingFrames = new Map<string, RenderFramePayload[]>();
  const adoptProgressByTransfer = new Map<string, {
    label: string;
    total: number;
    created: number;
    applied: Set<string>;
    redrawn: Set<string>;
  }>();
  const adoptTransferBySession = new Map<string, string>();

  function flushPendingFrames(sessionId: string) {
    const buffered = pendingFrames.get(sessionId);
    if (!buffered || buffered.length === 0) return;
    pendingFrames.delete(sessionId);
    const store = tabs.getStoreBySessionId(sessionId);
    if (store) {
      for (const frame of buffered) {
        store.applyRenderFrame(frame);
      }
    }
  }

  const [moveLockCount, setMoveLockCount] = createSignal(0);
  function incMoveLock() { setMoveLockCount((c) => c + 1); }
  function decMoveLock() { setMoveLockCount((c) => Math.max(0, c - 1)); }

  const [appReady, setAppReady] = createSignal(false);
  let requestWindowShutdown: (() => Promise<void>) | null = null;

  function updateAdoptProgressState(transferId: string) {
    const progress = adoptProgressByTransfer.get(transferId);
    if (!progress) return;
    setAdoptProgress({
      transferId,
      label: progress.label,
      total: progress.total,
      created: progress.created,
      applied: progress.applied.size,
      redrawn: progress.redrawn.size,
    });
  }

  function beginAdoptProgress(transferId: string, label: string, sessionIds: string[]) {
    const uniqueSessions = Array.from(new Set(sessionIds));
    adoptProgressByTransfer.set(transferId, {
      label,
      total: uniqueSessions.length,
      created: uniqueSessions.length,
      applied: new Set<string>(),
      redrawn: new Set<string>(),
    });
    for (const sessionId of uniqueSessions) {
      adoptTransferBySession.set(sessionId, transferId);
    }
    updateAdoptProgressState(transferId);
  }

  function markSessionApplied(transferId: string, sessionId: string) {
    const progress = adoptProgressByTransfer.get(transferId);
    if (!progress) return;
    progress.applied.add(sessionId);
    updateAdoptProgressState(transferId);
  }

  function markSessionRedrawn(sessionId: string) {
    const transferId = adoptTransferBySession.get(sessionId);
    if (!transferId) return;
    const progress = adoptProgressByTransfer.get(transferId);
    if (!progress) {
      adoptTransferBySession.delete(sessionId);
      return;
    }
    progress.redrawn.add(sessionId);
    updateAdoptProgressState(transferId);
    if (progress.redrawn.size >= progress.total) {
      for (const [sid, tid] of adoptTransferBySession) {
        if (tid === transferId) {
          adoptTransferBySession.delete(sid);
        }
      }
      adoptProgressByTransfer.delete(transferId);
      setTimeout(() => {
        setAdoptProgress((current) =>
          current?.transferId === transferId ? null : current,
        );
      }, 180);
    }
  }

  function describeFailureReason(reason?: TabTransferFailureReason | null): string {
    switch (reason) {
      case "duplicate_session":
        return "duplicate_session";
      case "expired_transfer":
        return "expired_transfer";
      case "invalid_manifest":
        return "invalid_manifest";
      case "not_prepared":
        return "not_prepared";
      default:
        return "invalid_manifest";
    }
  }

  function sessionInTree(node: PaneNode | undefined, sessionId: string): boolean {
    if (!node) return false;
    if (node.type === "leaf") return node.sessionId === sessionId;
    return sessionInTree(node.first, sessionId) || sessionInTree(node.second, sessionId);
  }

  function applyTransferredSessionState(sessionId: string, transfer: SessionTransferState) {
    const store = tabs.getStoreBySessionId(sessionId);
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
      cwd: transfer.cwd || store.state.cwd,
      shellIntegrationActive: transfer.shell_integration_active,
      snapshots,
      activeBlock,
    });

    const tab = tabs.state.tabs.find(
      (candidate) =>
        candidate.type === "terminal" &&
        sessionInTree(candidate.paneTree, sessionId),
    );
    if (tab && transfer.cwd) {
      tabs.updateTabCwd(tab.id, transfer.cwd);
    }
  }

  function hydrateTransferredSessionState(sessionId: string) {
    takeSessionTransferState(sessionId)
      .then((transfer) => {
        if (!transfer) return;
        applyTransferredSessionState(sessionId, transfer);
      })
      .catch((error) => {
        console.warn("[Rain] Failed to hydrate transferred session state:", error);
      });
  }

  function hasDuplicateManifestSession(manifest: TabTransferManifest): boolean {
    return manifest.paneSessions.some((pane) => tabs.getStoreBySessionId(pane.sessionId));
  }

  function adoptManifestIntoTabs(
    manifest: TabTransferManifest,
    insertAt?: number,
    transferId?: string,
  ): boolean {
    if (hasDuplicateManifestSession(manifest)) {
      console.warn("[Rain] One or more sessions already exist in this window, skipping adopt");
      return false;
    }
    const added = tabs.addTabFromManifest(manifest, insertAt);
    if (!added) {
      console.warn("[Rain] Failed to rebuild moved tab from transfer manifest");
      return false;
    }

    const progressId = transferId ?? `adopt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    beginAdoptProgress(
      progressId,
      manifest.customLabel || manifest.label || "Tab",
      manifest.paneSessions.map((pane) => pane.sessionId),
    );
    for (const pane of manifest.paneSessions) {
      applyTransferredSessionState(pane.sessionId, pane.state);
      markSessionApplied(progressId, pane.sessionId);
      flushPendingFrames(pane.sessionId);
      requestFullRedraw(pane.sessionId).catch(console.error);
    }
    if (manifest.cwd) {
      tabs.updateTabCwd(added.data.id, manifest.cwd);
    }
    return true;
  }

  function openSettings() {
    tabs.addSettingsTab();
  }

  async function spawnTab(profileId?: string) {
    try {
      const activeStore = tabs.activeStore();
      const rows = activeStore?.state.rows ?? 24;
      const cols = activeStore?.state.cols ?? 80;
      const profile = profileId ? getProfile(profileId) : getActiveProfile();
      const shell = profile?.shell?.trim() || undefined;
      const profileCwd = profile?.cwd?.trim() || undefined;
      const cwd = profileCwd || activeStore?.state.cwd?.trim() || undefined;
      const env =
        profile?.env && Object.keys(profile.env).length > 0
          ? profile.env
          : undefined;

      const result = await createSession(
        shell,
        cwd,
        rows,
        cols,
        env,
        config().tmuxMode,
      );
      const sessionId = result.session_id;
      console.log("[Rain] Session created:", sessionId, result.inside_tmux ? "(inside tmux)" : "");

      const profileLabel = profile?.id && profile.id !== "default" ? profile.name : "Shell";
      const tab = tabs.addTab(sessionId, profileLabel, undefined, cwd);
      flushPendingFrames(sessionId);

      // If Rain is running inside an existing tmux session, mark it active
      // so the frontend switches to traditional mode immediately.
      if (result.inside_tmux) {
        const store = tabs.getStoreBySessionId(sessionId);
        if (store) {
          store.setState("tmuxActive", true);
        }
      }

      await requestFullRedraw(sessionId);
      return tab;
    } catch (err) {
      console.error("[Rain] Failed to create tab:", err);
      showToast("Failed to create terminal session", "error");
      return undefined;
    }
  }

  async function reopenClosedTab() {
    const entry = tabs.popClosedTab();
    if (!entry) return;
    try {
      const activeStore = tabs.activeStore();
      const rows = activeStore?.state.rows ?? 24;
      const cols = activeStore?.state.cols ?? 80;
      const result = await createSession(undefined, entry.cwd || undefined, rows, cols, undefined, config().tmuxMode);
      const tab = tabs.addTab(result.session_id, entry.label, undefined, entry.cwd);
      if (entry.customLabel) tabs.updateTabCustomLabel(tab.data.id, entry.customLabel);
      if (entry.tabColor) tabs.updateTabColor(tab.data.id, entry.tabColor);
      flushPendingFrames(result.session_id);
      await requestFullRedraw(result.session_id);
    } catch (err) {
      console.error("[Rain] Failed to reopen tab:", err);
      showToast("Failed to reopen tab", "error");
    }
  }

  async function duplicateTab() {
    const tab = tabs.activeTab();
    if (!tab || tab.type !== "terminal") return;
    const store = tab.activePaneId ? tabs.stores.get(tab.activePaneId) : undefined;
    const cwd = store?.state.cwd || tab.cwd || undefined;
    try {
      const rows = store?.state.rows ?? 24;
      const cols = store?.state.cols ?? 80;
      const result = await createSession(undefined, cwd, rows, cols, undefined, config().tmuxMode);
      tabs.addTab(result.session_id, tab.customLabel || tab.label, undefined, cwd);
      flushPendingFrames(result.session_id);
      await requestFullRedraw(result.session_id);
    } catch (err) {
      console.error("[Rain] Failed to duplicate tab:", err);
      showToast("Failed to duplicate tab", "error");
    }
  }

  async function closeTab(tabId: string) {
    const tabData = tabs.state.tabs.find((t) => t.id === tabId);
    if (!tabData) return;

    // tmux tabs: detach instead of destroying a PTY session
    if (tabData.tmuxSessionName) {
      tmuxDetach().catch(console.error);
      setTmuxActive(false);
      tabs.removeTmuxTabs();
      return;
    }

    if (tabData.sessionId) {
      try {
        await destroySession(tabData.sessionId);
      } catch (e) {
        console.error("[Rain] Failed to destroy session:", e);
      }
    }
    tabs.closeTab(tabId);
  }

  function handleMoveTabToWindow(tabId: string) {
    const moved = tabs.detachTab(tabId);
    if (!moved) return;
  }

  async function saveWorkspaceSnapshot() {
    const getStoreCwd = (sessionId: string) => {
      const store = tabs.getStoreBySessionId(sessionId);
      return store?.state.cwd ?? "";
    };
    const workspace = buildSavedWorkspace(
      tabs.state.tabs,
      tabs.state.activeIndex,
      getStoreCwd,
    );
    await persistWorkspace(workspace);
  }

  // Global keyboard shortcuts for tabs
  function handleGlobalKeyDown(e: KeyboardEvent) {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    // Cmd+Shift+P: toggle Command Palette
    if (matchesKeybinding(e, "command-palette")) {
      e.preventDefault();
      setShowPalette((v) => !v);
      return;
    }

    // Cmd+Shift+H: History browser
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && key === "h") {
      e.preventDefault();
      setShowHistory((v) => !v);
      return;
    }

    // Cmd+= or Cmd++ (Mac) / Ctrl+= or Ctrl++ (Win/Linux): zoom in
    if ((isMac ? e.metaKey : e.ctrlKey) && (key === "=" || key === "+")) {
      e.preventDefault();
      updateConfig({ fontSize: Math.min(24, config().fontSize + 1) });
      return;
    }
    // Cmd+- (Mac) / Ctrl+- (Win/Linux): zoom out
    if ((isMac ? e.metaKey : e.ctrlKey) && key === "-") {
      e.preventDefault();
      updateConfig({ fontSize: Math.max(10, config().fontSize - 1) });
      return;
    }
    // Cmd+0 (Mac) / Ctrl+0 (Win/Linux): reset zoom
    if ((isMac ? e.metaKey : e.ctrlKey) && key === "0") {
      e.preventDefault();
      updateConfig({ fontSize: defaultConfig.fontSize });
      return;
    }

    if (matchesKeybinding(e, "settings")) {
      e.preventDefault();
      openSettings();
      return;
    }

    if (matchesKeybinding(e, "reopen-tab")) {
      e.preventDefault();
      reopenClosedTab();
      return;
    }

    if (matchesKeybinding(e, "new-tab")) {
      e.preventDefault();
      spawnTab();
      return;
    }

    if (matchesKeybinding(e, "close-tab") || matchesKeybinding(e, "close-pane")) {
      e.preventDefault();
      const active = tabs.activeTab();
      if (!active) return;

      // If the tab has split panes, close just the active pane
      if (active.paneTree && active.paneTree.type === "split") {
        const paneId = tabs.getActivePaneId(active.id);
        const store = tabs.stores.get(paneId);
        if (store?.state.tmuxPaneId != null) {
          // tmux pane: tell tmux to close it, layout change will rebuild the tree
          tmuxClosePane(store.state.tmuxPaneId).catch(console.error);
        } else if (store?.state.sessionId) {
          destroySession(store.state.sessionId).catch(console.error);
          tabs.closePane(active.id, paneId);
        }
      } else {
        closeTab(active.id);
      }
      return;
    }

    // Cmd+1-9 switch tabs
    for (let i = 1; i <= 9; i++) {
      if (matchesKeybinding(e, `tab-${i}`)) {
        e.preventDefault();
        tabs.switchTab(i - 1);
        return;
      }
    }

    // Keep Cmd+Shift+[ / ] as additional native-style fallbacks.
    if (matchesKeybinding(e, "prev-tab") || (e.metaKey && e.shiftKey && key === "[")) {
      e.preventDefault();
      tabs.prevTab();
      return;
    }
    if (matchesKeybinding(e, "next-tab") || (e.metaKey && e.shiftKey && key === "]")) {
      e.preventDefault();
      tabs.nextTab();
      return;
    }

    // Cmd+D: split horizontal (left|right), Cmd+Shift+D: split vertical (top/bottom)
    if (matchesKeybinding(e, "split-horizontal") || matchesKeybinding(e, "split-vertical")) {
      e.preventDefault();
      const tab = tabs.activeTab();
      if (tab && tab.type === "terminal") {
        const direction = matchesKeybinding(e, "split-vertical")
          ? "vertical"
          : "horizontal";
        const activePaneId = tabs.getActivePaneId(tab.id);
        const activePaneStore = tabs.stores.get(activePaneId);
        const tmuxPaneId = activePaneStore?.state.tmuxPaneId;
        if (tmuxPaneId != null) {
          // Keep tmux's active pane in sync, then request a tmux-native split.
          tmuxSelectPane(tmuxPaneId)
            .catch(() => undefined)
            .then(() => tmuxSplitPane(direction, tmuxPaneId))
            .catch(console.error);
        } else {
          splitActivePane(tab.id, activePaneId, direction);
        }
      }
      return;
    }
  }

  async function splitActivePane(tabId: string, paneId: string, direction: "horizontal" | "vertical") {
    try {
      const paneStore = tabs.stores.get(paneId);
      const rows = paneStore?.state.rows ?? 24;
      const cols = paneStore?.state.cols ?? 80;
      const tab = tabs.activeTab();
      const cwd = paneStore?.state.cwd || tab?.cwd || undefined;
      const result = await createSession(
        undefined,
        cwd,
        rows,
        cols,
        undefined,
        config().tmuxMode,
      );
      const sessionId = result.session_id;
      tabs.splitPane(tabId, paneId, direction, sessionId);
      flushPendingFrames(sessionId);
      if (result.inside_tmux) {
        const store = tabs.getStoreBySessionId(sessionId);
        if (store) {
          store.setState("tmuxActive", true);
        }
      }
      await requestFullRedraw(sessionId);
    } catch (err) {
      console.error("[Rain] Failed to split pane:", err);
      showToast("Failed to split pane", "error");
    }
  }

  function handleSplitFromPalette(direction: "horizontal" | "vertical") {
    const tab = tabs.activeTab();
    if (!tab || tab.type !== "terminal") return;
    const activePaneId = tabs.getActivePaneId(tab.id);
    const activePaneStore = tabs.stores.get(activePaneId);
    const tmuxPaneId = activePaneStore?.state.tmuxPaneId;
    if (tmuxPaneId != null) {
      tmuxSelectPane(tmuxPaneId)
        .catch(() => undefined)
        .then(() => tmuxSplitPane(direction, tmuxPaneId))
        .catch(console.error);
    } else {
      splitActivePane(tab.id, activePaneId, direction);
    }
  }

  const allSnapshots = () => {
    const all: import("./lib/types").CommandSnapshot[] = [];
    for (const [, store] of tabs.stores) {
      all.push(...store.state.snapshots);
    }
    return all.sort((a, b) => a.timestamp - b.timestamp);
  };

  const handleHistoryRerun = async (command: string) => {
    const store = tabs.activeStore();
    const sid = store?.state.sessionId;
    if (!sid) return;
    const encoder = new TextEncoder();
    const bytes = Array.from(encoder.encode(command + "\n"));
    await writeInput(sid, bytes).catch(console.error);
  };

  const paletteActions = (): PaletteAction[] => [
    { id: "new-tab", label: "New Tab", shortcut: "Cmd+T", category: "Tabs", action: () => { spawnTab(); } },
    { id: "close-tab", label: "Close Tab", shortcut: "Cmd+W", category: "Tabs", action: () => {
      const tab = tabs.activeTab();
      if (tab) closeTab(tab.id);
    }},
    { id: "reopen-tab", label: "Reopen Closed Tab", shortcut: isMac ? "Cmd+Shift+T" : "Ctrl+Shift+T", category: "Tabs", action: () => { reopenClosedTab(); } },
    { id: "duplicate-tab", label: "Duplicate Tab", category: "Tabs", action: () => { duplicateTab(); } },
    { id: "next-tab", label: "Next Tab", shortcut: "Ctrl+Tab", category: "Tabs", action: () => tabs.nextTab() },
    { id: "prev-tab", label: "Previous Tab", shortcut: "Ctrl+Shift+Tab", category: "Tabs", action: () => tabs.prevTab() },
    { id: "close-others", label: "Close Other Tabs", category: "Tabs", action: () => {
      const active = tabs.activeTab();
      if (!active) return;
      const others = tabs.state.tabs.filter((t) => t.id !== active.id);
      for (const t of others) closeTab(t.id);
    }},
    { id: "close-right", label: "Close Tabs to the Right", category: "Tabs", action: () => {
      const idx = tabs.state.activeIndex;
      const toClose = tabs.state.tabs.slice(idx + 1);
      for (const t of toClose) closeTab(t.id);
    }},
    { id: "rename-tab", label: "Rename Tab", category: "Tabs", action: () => {
      const tab = tabs.activeTab();
      if (!tab || tab.type !== "terminal") return;
      const name = prompt("Tab name:", tab.customLabel ?? tab.label);
      if (name !== null) tabs.updateTabCustomLabel(tab.id, name.trim() || null);
    }},
    { id: "copy-path", label: "Copy Path", category: "Terminal", action: () => {
      const store = tabs.activeStore();
      const cwd = store?.state.cwd;
      if (cwd) navigator.clipboard.writeText(cwd).catch(console.error);
    }},
    { id: "settings", label: "Open Settings", shortcut: isMac ? "Cmd+," : "Ctrl+,", category: "App", action: () => openSettings() },
    { id: "clear", label: "Clear Terminal", shortcut: isMac ? "Cmd+K" : "Ctrl+K", category: "Terminal", action: () => {
      const store = tabs.activeStore();
      if (store) store.clearHistory();
    }},
    { id: "split-h", label: "Split Pane Horizontally", shortcut: isMac ? "Cmd+D" : "Ctrl+D", category: "Panes", action: () => handleSplitFromPalette("horizontal") },
    { id: "split-v", label: "Split Pane Vertically", shortcut: isMac ? "Cmd+Shift+D" : "Ctrl+Shift+D", category: "Panes", action: () => handleSplitFromPalette("vertical") },
    { id: "search", label: "Search Terminal", shortcut: isMac ? "Cmd+F" : "Ctrl+F", category: "Terminal", action: () => {
      const store = tabs.activeStore();
      if (store) store.setState({ searchOpen: true });
    }},
    { id: "zoom-in", label: "Zoom In", shortcut: isMac ? "Cmd+=" : "Ctrl+=", category: "View", action: () => {
      updateConfig({ fontSize: Math.min(24, config().fontSize + 1) });
    }},
    { id: "zoom-out", label: "Zoom Out", shortcut: isMac ? "Cmd+-" : "Ctrl+-", category: "View", action: () => {
      updateConfig({ fontSize: Math.max(10, config().fontSize - 1) });
    }},
    { id: "zoom-reset", label: "Reset Zoom", shortcut: isMac ? "Cmd+0" : "Ctrl+0", category: "View", action: () => {
      updateConfig({ fontSize: defaultConfig.fontSize });
    }},
    { id: "export-terminal", label: "Export Terminal Output", shortcut: isMac ? "Cmd+S" : "Ctrl+S", category: "Terminal", action: () => {
      const store = tabs.activeStore();
      if (!store) return;
      const lines: string[] = [];
      for (const snap of store.state.snapshots) {
        if (snap.command) lines.push(`$ ${snap.command}`);
        for (const line of snap.lines) {
          lines.push(line.spans.map((s) => s.text).join("").trimEnd());
        }
        lines.push("");
      }
      for (const line of store.state.fallbackLines) {
        lines.push(line.spans.map((s) => s.text).join("").trimEnd());
      }
      const text = lines.join("\n");
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      saveTextToFile(text, `rain-export-${timestamp}.txt`).catch(console.error);
    }},
    { id: "toggle-statusbar", label: "Toggle Status Bar", category: "View", action: () => {
      updateConfig({ showStatusBar: !config().showStatusBar });
    }},
    { id: "toggle-theme", label: "Toggle Theme", category: "View", action: () => {
      const currentIdx = THEME_LIST.findIndex((t) => t.name === theme());
      const nextIdx = (currentIdx + 1) % THEME_LIST.length;
      setTheme(THEME_LIST[nextIdx].name);
    }},
  ];

  // Track the session that requested tmux so we can switch back on detach
  const [tmuxOriginTab, setTmuxOriginTab] = createSignal<string | null>(null);
  // Guard to prevent duplicate tmux_start calls from repeated TmuxRequested events
  const [tmuxActive, setTmuxActive] = createSignal(false);
  // Available tmux sessions detected on startup
  const [tmuxAvailableSessions, setTmuxAvailableSessions] = createSignal<Awaited<ReturnType<typeof tmuxListSessions>>>([]);

  async function handleTmuxRequested(args: string) {
    if (tmuxActive()) {
      return;
    }
    setTmuxActive(true);
    try {
      // Remember which tab the user was in before tmux
      const tab = tabs.activeTab();
      if (tab) setTmuxOriginTab(tab.id);

      await tmuxStart(args || undefined);
      console.log("[Rain] tmux control mode started");
    } catch (err) {
      const msg = String(err ?? "");
      if (msg.includes("tmux session already active")) {
        // Duplicate start request, keep active guard set and ignore.
        console.debug("[Rain] tmux control mode already active; skipping duplicate start");
        return;
      }
      setTmuxActive(false);
      console.error("[Rain] Failed to start tmux:", err);
      showToast("Failed to start tmux session", "error");
    }
  }

  // Expose tmux helpers on window for devtools debugging
  if (typeof window !== "undefined") {
    (window as any).__rain_tmux = {
      start: (args?: string) => handleTmuxRequested(args ?? ""),
      split: (dir: string, paneId?: number) => tmuxSplitPane(dir, paneId),
      detach: () => tmuxDetach(),
      sessions: () => tmuxListSessions(),
    };
  }

  function handleTmuxEvent(event: TmuxEvent) {
    switch (event.type) {
      case "PaneAdded": {
        // Create a store for this tmux pane and add it as a tab pane
        const store = tabs.addTmuxPane(event.session_id, event.pane_id);
        if (store) {
          flushPendingFrames(event.session_id);
        }
        break;
      }
      case "WindowAdded": {
        // Could add a new tab here for multi-window support
        break;
      }
      case "WindowClosed": {
        // Clean up stores for removed panes
        for (const sid of event.removed_sessions) {
          const store = tabs.getStoreBySessionId(sid);
          if (store) {
            store.setState({ connected: false });
          }
        }
        break;
      }
      case "LayoutChanged": {
        console.debug("[Rain] tmux layout changed", {
          window: event.window_id,
          panes: event.panes.map((p) => ({ id: p.pane_id, sid: p.session_id, w: p.width, h: p.height })),
          tree: event.layout_tree,
        });
        tabs.rebuildTmuxLayout(event.window_id, event.layout_tree);
        break;
      }
      case "Detached":
      case "Ended": {
        setTmuxActive(false);
        setTmuxOriginTab(null);
        // Clean up tmux pane stores and unmark the tab
        tabs.removeTmuxTabs();
        // Respawn a fresh PTY session into the now-empty tab
        const tab = tabs.activeTab();
        if (tab && tab.type === "terminal") {
          const rows = 24;
          const cols = 80;
          createSession(
            undefined,
            undefined,
            rows,
            cols,
            undefined,
            config().tmuxMode,
          )
            .then(async (result) => {
              tabs.replaceTabSession(tab.id, result.session_id);
              flushPendingFrames(result.session_id);
              await requestFullRedraw(result.session_id);
            })
            .catch(console.error);
        }
        break;
      }
    }
  }

  onMount(async () => {
    document.addEventListener("keydown", handleGlobalKeyDown);

    let shutdownInFlight = false;
    const appWindow = getCurrentWindow();
    const shutdownWindow = async () => {
      if (shutdownInFlight) return;
      shutdownInFlight = true;
      try {
        let isLastWindow = true;
        try {
          const windows = await listRainWindows();
          isLastWindow = windows.length <= 1;
        } catch (error) {
          console.warn("[Rain] Failed to inspect windows during shutdown:", error);
        }

        // Only persist on final app exit. Persisting from arbitrary windows can
        // overwrite workspace state owned by other still-open windows.
        if (isLastWindow) {
          await saveWorkspaceSnapshot();
          await quitApp();
          return;
        }

        await appWindow.destroy();
      } catch (error) {
        shutdownInFlight = false;
        console.error("[Rain] Failed to shut down window:", error);
      }
    };
    requestWindowShutdown = shutdownWindow;

    const unCloseRequested = await appWindow.onCloseRequested((event) => {
      event.preventDefault();
      void shutdownWindow();
    });
    unlisteners.push(unCloseRequested);

    // Register all event listeners in parallel for faster startup
    const [unFrame, unEnd, unResizeAck, unTmux] = await Promise.all([
      onRenderFrame((payload) => {
        // Intercept TmuxRequested events before store processing
        if (payload.frame?.events) {
          for (const ev of payload.frame.events) {
            if (ev.type === "TmuxRequested" && "args" in ev) {
              handleTmuxRequested((ev as { type: string; args: string }).args);
            }
          }
        }

        // Route to the correct tab's store by session_id
        const store = tabs.getStoreBySessionId(payload.session_id);
        if (store) {
          flushPendingFrames(payload.session_id);
          store.applyRenderFrame(payload);
          markSessionRedrawn(payload.session_id);
        } else {
          // Store doesn't exist yet - buffer the frame
          let buf = pendingFrames.get(payload.session_id);
          if (!buf) {
            buf = [];
            pendingFrames.set(payload.session_id, buf);
          }
          buf.push(payload);
        }
      }),
      onSessionEnded((payload) => {
        const store = tabs.getStoreBySessionId(payload.session_id);
        if (store) {
          store.setState({ connected: false });
        }
      }),
      onResizeAck((payload) => {
        const store = tabs.getStoreBySessionId(payload.session_id);
        if (store) {
          store.applyResizeAck(payload);
        }
      }),
      onTmuxEvent(handleTmuxEvent),
    ]);
    unlisteners.push(unFrame, unEnd, unResizeAck, unTmux);

    const insertIndexFromX = (insertX?: number): number | undefined => {
      if (insertX == null) return undefined;
      const tabListEl = document.querySelector(".tab-list") as HTMLElement | null;
      if (!tabListEl) return undefined;
      const listRect = tabListEl.getBoundingClientRect();
      const localX = Math.max(0, Math.min(listRect.width, insertX - listRect.left));
      const els = Array.from(tabListEl.querySelectorAll(".tab-item")) as HTMLElement[];
      let insertAt = els.length;
      for (let i = 0; i < els.length; i++) {
        const rect = els[i].getBoundingClientRect();
        const midpointX = rect.left - listRect.left + rect.width / 2;
        if (localX < midpointX) {
          insertAt = i;
          break;
        }
      }
      return insertAt;
    };

    const committedTransferIds = new Set<string>();
    const failedTransferIds = new Set<string>();

    const unTabReadyCheck = await listen<{
      requestId: string;
      transferId: string;
      sourceLabel: string;
    }>("tab-adopt-ready-check", (event) => {
      const { requestId, transferId, sourceLabel } = event.payload;
      const targetLabel = getCurrentWindow().label;
      if (sourceLabel === targetLabel) return;
      void emitCrossWindow(sourceLabel, "tab-adopt-ready-result", {
        requestId,
        transferId,
        ok: true,
        targetLabel,
      }).catch(() => {});
    });
    unlisteners.push(unTabReadyCheck);

    const unTabPrepare = await listen<{
      requestId: string;
      transferId: string;
      sourceLabel: string;
    }>("tab-adopt-prepare", (event) => {
      const { requestId, transferId, sourceLabel } = event.payload;
      void (async () => {
        const targetLabel = getCurrentWindow().label;
        if (sourceLabel === targetLabel) return;
        try {
          const prepared = await prepareTabTransferAdopt(transferId, targetLabel);
          if (!prepared.ok || !prepared.ready_token) {
            await emitCrossWindow(sourceLabel, "tab-adopt-prepare-result", {
              requestId,
              transferId,
              ok: false,
              reason: describeFailureReason(prepared.reason),
            }).catch(() => {});
            return;
          }

          const hasDup = prepared.session_ids.some((sessionId) => tabs.getStoreBySessionId(sessionId));
          if (hasDup) {
            await releaseTabTransferAdopt(transferId, targetLabel, prepared.ready_token).catch(() => {});
            await emitCrossWindow(sourceLabel, "tab-adopt-prepare-result", {
              requestId,
              transferId,
              ok: false,
              reason: "duplicate_session",
            }).catch(() => {});
            return;
          }

          await emitCrossWindow(sourceLabel, "tab-adopt-prepare-result", {
            requestId,
            transferId,
            ok: true,
            readyToken: prepared.ready_token,
          }).catch(() => {});
        } catch (error) {
          console.warn("[Rain] Failed to prepare adopt:", error);
          await emitCrossWindow(sourceLabel, "tab-adopt-prepare-result", {
            requestId,
            transferId,
            ok: false,
            reason: "invalid_manifest",
          }).catch(() => {});
        }
      })();
    });
    unlisteners.push(unTabPrepare);

    const unTabCommit = await listen<{
      requestId: string;
      transferId: string;
      readyToken: string;
      sourceLabel: string;
      insertX?: number;
    }>("tab-adopt-commit", (event) => {
      const { requestId, transferId, readyToken, sourceLabel, insertX } = event.payload;
      void (async () => {
        const targetLabel = getCurrentWindow().label;
        if (sourceLabel === targetLabel) return;
        try {
          const committed = await commitTabTransferAdopt(transferId, targetLabel, readyToken);
          if (!committed.ok || !committed.manifest) {
            failedTransferIds.add(transferId);
            await emitCrossWindow(sourceLabel, "tab-adopt-commit-result", {
              requestId,
              transferId,
              ok: false,
              reason: describeFailureReason(committed.reason),
            }).catch(() => {});
            return;
          }

          if (hasDuplicateManifestSession(committed.manifest)) {
            failedTransferIds.add(transferId);
            await emitCrossWindow(sourceLabel, "tab-adopt-commit-result", {
              requestId,
              transferId,
              ok: false,
              reason: "duplicate_session",
            }).catch(() => {});
            return;
          }

          const insertAt = insertIndexFromX(insertX);
          if (!adoptManifestIntoTabs(committed.manifest, insertAt, transferId)) {
            failedTransferIds.add(transferId);
            await emitCrossWindow(sourceLabel, "tab-adopt-commit-result", {
              requestId,
              transferId,
              ok: false,
              reason: "invalid_manifest",
            }).catch(() => {});
            return;
          }

          failedTransferIds.delete(transferId);
          committedTransferIds.add(transferId);
          await emitCrossWindow(sourceLabel, "tab-adopt-commit-result", {
            requestId,
            transferId,
            ok: true,
          }).catch(() => {});
          getCurrentWindow().setFocus().catch(() => {});
        } catch (error) {
          failedTransferIds.add(transferId);
          console.error("[Rain] Failed to commit adopt:", error);
          await emitCrossWindow(sourceLabel, "tab-adopt-commit-result", {
            requestId,
            transferId,
            ok: false,
            reason: "invalid_manifest",
          }).catch(() => {});
        }
      })();
    });
    unlisteners.push(unTabCommit);

    // Cross-window tab adoption: another window dropped a tab onto our tab bar
    const unTabAdopt = await listen<{
      sessionId?: string;
      label: string;
      cwd: string;
      insertX?: number;
      transferId?: string;
    }>("tab-adopt", (event) => {
      const { sessionId, label, cwd, insertX, transferId } = event.payload;
      console.log("[Rain] Adopting tab from another window:", transferId ?? sessionId);

      const insertAt = insertIndexFromX(insertX);

      void (async () => {
        try {
          if (transferId) {
            const manifest = await takeTabTransferManifest(transferId);
            if (manifest && adoptManifestIntoTabs(manifest, insertAt, transferId)) {
              getCurrentWindow().setFocus().catch(() => {});
              return;
            }
            console.warn("[Rain] Missing/invalid transfer manifest; skipping partial adopt");
            return;
          }

          if (!sessionId) return;
          if (tabs.getStoreBySessionId(sessionId)) {
            console.warn("[Rain] Session already exists in this window, skipping adopt:", sessionId);
            return;
          }

          tabs.addTab(sessionId, label, insertAt, cwd);
          flushPendingFrames(sessionId);
          hydrateTransferredSessionState(sessionId);
          requestFullRedraw(sessionId).catch(console.error);
          getCurrentWindow().setFocus().catch(() => {});
        } catch (error) {
          console.error("[Rain] Failed to adopt tab from another window:", error);
        }
      })();
    });
    unlisteners.push(unTabAdopt);

    const unWindowHighlight = await listen("window-highlight", () => {
      setWindowHighlighted(true);
    });
    unlisteners.push(unWindowHighlight);

    const unWindowUnhighlight = await listen("window-unhighlight", () => {
      setWindowHighlighted(false);
    });
    unlisteners.push(unWindowUnhighlight);

    // Check URL params for session adoption (child window from move-to-window)
    const params = new URLSearchParams(window.location.search);
    const adoptTransferId = params.get("adoptTransfer");
    const adoptSessionId = params.get("adopt");

    if (adoptTransferId) {
      const waitStartedAt = Date.now();
      while (Date.now() - waitStartedAt < ADOPT_TRANSFER_FALLBACK_MS) {
        if (committedTransferIds.has(adoptTransferId)) {
          break;
        }
        if (failedTransferIds.has(adoptTransferId)) {
          break;
        }
        if (tabs.state.tabs.length > 0) {
          break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, ADOPT_TRANSFER_POLL_MS));
      }
      if (tabs.state.tabs.length === 0) {
        await spawnTab();
      }
    } else if (adoptSessionId) {
      const label = params.get("label") ?? "Shell";
      const cwd = params.get("cwd") ?? undefined;
      console.log("[Rain] Adopting session:", adoptSessionId, "label:", label);
      tabs.addTab(adoptSessionId, label, undefined, cwd);
      flushPendingFrames(adoptSessionId);
      hydrateTransferredSessionState(adoptSessionId);
      requestFullRedraw(adoptSessionId).catch(console.error);
    } else {
      // --- Session restore ---
      const savedWorkspace = await restoreWorkspace();
      if (savedWorkspace && savedWorkspace.tabs.length > 0) {
        const activeStore = tabs.activeStore();
        const restoreRows = activeStore?.state.rows ?? 24;
        const restoreCols = activeStore?.state.cols ?? 80;
        const emptyTransferState = (cwd: string): SessionTransferState => ({
          cwd,
          shell_integration_active: false,
          snapshots: [],
          active_block: null,
        });

        async function restorePaneNode(
          node: SavedPaneNode,
          paneSessions: TabTransferManifest["paneSessions"],
          tmuxSessionIds: Set<string>,
          createdSessionIds: string[],
        ): Promise<TabTransferManifest["paneTree"]> {
          if (node.type === "leaf") {
            const cwd = node.cwd?.trim() || undefined;
            const result = await createSession(
              undefined,
              cwd,
              restoreRows,
              restoreCols,
              undefined,
              config().tmuxMode,
            );
            createdSessionIds.push(result.session_id);
            if (result.inside_tmux) {
              tmuxSessionIds.add(result.session_id);
            }
            paneSessions.push({
              sessionId: result.session_id,
              state: emptyTransferState(cwd ?? ""),
            });
            return { type: "leaf", sessionId: result.session_id };
          }

          const direction = node.direction === "vertical" ? "vertical" : "horizontal";
          const ratio = typeof node.ratio === "number"
            ? Math.max(0.1, Math.min(0.9, node.ratio))
            : 0.5;
          const firstNode = node.first ?? { type: "leaf", cwd: node.cwd ?? "" };
          const secondNode = node.second ?? { type: "leaf", cwd: node.cwd ?? "" };
          const first = await restorePaneNode(firstNode, paneSessions, tmuxSessionIds, createdSessionIds);
          const second = await restorePaneNode(secondNode, paneSessions, tmuxSessionIds, createdSessionIds);
          return {
            type: "split",
            direction,
            ratio,
            first,
            second,
          };
        }

        let restoredAny = false;
        for (const savedTab of savedWorkspace.tabs) {
          const paneSessions: TabTransferManifest["paneSessions"] = [];
          const tmuxSessionIds = new Set<string>();
          const createdSessionIds: string[] = [];
          try {
            const paneTree = await restorePaneNode(
              savedTab.paneTree,
              paneSessions,
              tmuxSessionIds,
              createdSessionIds,
            );
            if (paneSessions.length === 0) {
              continue;
            }

            const activeLeafIndex = Math.max(
              0,
              Math.min(savedTab.activeLeafIndex ?? 0, paneSessions.length - 1),
            );
            const activeSessionId =
              paneSessions[activeLeafIndex]?.sessionId ?? paneSessions[0]?.sessionId;
            if (!activeSessionId) continue;

            const manifest: TabTransferManifest = {
              label: savedTab.label || "Shell",
              customLabel: savedTab.customLabel ?? null,
              cwd: savedTab.cwd || paneSessions[0]?.state.cwd || "",
              paneTree,
              activeSessionId,
              paneSessions,
            };

            const added = tabs.addTabFromManifest(manifest);
            if (!added) {
              throw new Error("Failed to restore pane tree");
            }

            for (const pane of paneSessions) {
              flushPendingFrames(pane.sessionId);
              requestFullRedraw(pane.sessionId).catch(console.error);
              if (tmuxSessionIds.has(pane.sessionId)) {
                const store = tabs.getStoreBySessionId(pane.sessionId);
                store?.setState("tmuxActive", true);
              }
            }

            restoredAny = true;
          } catch (e) {
            console.warn("[Rain] Failed to restore tab:", e);
            for (const sessionId of createdSessionIds) {
              await destroySession(sessionId).catch(() => {});
            }
          }
        }
        if (restoredAny) {
          const targetIdx = Math.min(savedWorkspace.activeTabIndex, tabs.state.tabs.length - 1);
          if (targetIdx >= 0) tabs.switchTab(targetIdx);
        }
      }

      if (tabs.state.tabs.length === 0) {
        await spawnTab();
      }
    }

    // Save workspace as a browser lifecycle fallback (Tauri close hook above
    // handles the reliable app-window close path).
    const handleBeforeUnload = () => {
      void saveWorkspaceSnapshot();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("pagehide", handleBeforeUnload);
    unlisteners.push(() => window.removeEventListener("beforeunload", handleBeforeUnload));
    unlisteners.push(() => window.removeEventListener("pagehide", handleBeforeUnload));

    // Check for existing tmux sessions in the background
    tmuxListSessions()
      .then((sessions) => {
        if (sessions.length > 0) {
          setTmuxAvailableSessions(sessions);
          console.log("[Rain] Found existing tmux sessions:", sessions.map((s) => s.name));
        }
      })
      .catch(() => {
        // tmux not installed or no server running, that's fine
      });

    // Check for updates in the background
    if (shouldCheckForUpdates()) {
      checkForUpdates()
        .then((info) => {
          markUpdateChecked();
          if (info.updateAvailable && info.latestVersion && !isDismissed(info.latestVersion)) {
            setUpdateInfo(info);
          }
        })
        .catch(() => {});
    }

    // Mark the app as fully initialized. The auto-close effect watches
    // this signal so it never fires before the first tab has been created.
    setAppReady(true);
  });

  // Tauri drag-and-drop: listen for native file drop events
  onMount(async () => {
    const unlisten = await listen<{ paths: string[] }>("tauri://drag-drop", (event) => {
      const store = tabs.activeStore();
      const sid = store?.state.sessionId;
      if (!sid || !event.payload.paths || event.payload.paths.length === 0) return;
      const paths = event.payload.paths
        .map((p: string) => /['\s]/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p)
        .join(" ");
      if (paths) {
        const encoder = new TextEncoder();
        writeInput(sid, Array.from(encoder.encode(paths + " "))).catch(console.error);
      }
    });
    onCleanup(() => unlisten());
  });

  onCleanup(() => {
    requestWindowShutdown = null;
    document.removeEventListener("keydown", handleGlobalKeyDown);
    for (const unlisten of unlisteners) {
      unlisten();
    }
  });

  // Close the current window when all tabs are gone; if this is the final
  // Rain window, exit the app entirely.
  createEffect(() => {
    const count = tabs.state.tabs.length;
    const locked = moveLockCount() > 0;
    if (appReady() && count === 0 && !locked) {
      if (requestWindowShutdown) {
        void requestWindowShutdown();
      }
    }
  });

  // Keep native window alpha fixed and let CSS control background opacity.
  // This keeps terminal text/UI crisp while only the background becomes transparent.
  createEffect(() => {
    setWindowOpacity(1.0).catch((e) =>
      console.warn("[Rain] Failed to set window opacity:", e),
    );
  });

  // Apply dock icon from config on startup and when changed.
  createEffect(() => {
    setAppIcon(config().appIcon).catch((e) =>
      console.warn("[Rain] Failed to set app icon:", e),
    );
  });

  // Register configured global hotkey (platform support handled in backend).
  createEffect(() => {
    const accelerator = config().globalHotkey?.trim();
    if (!accelerator) return;
    registerGlobalHotkey(accelerator).catch((e) =>
      console.warn("[Rain] Failed to register global hotkey:", e),
    );
  });

  const effectiveBgColor = createMemo(
    () => config().customBgColor ?? THEME_BG_MAP.get(theme()) ?? "#0e0e0e",
  );
  const effectiveAccentColor = createMemo(
    () =>
      config().customAccentColor ??
      THEME_ACCENT_MAP.get(theme()) ??
      "#01c1a2",
  );

  const blurProfile = createMemo(() =>
    computeBlurProfile(
      config().windowOpacity,
      config().backgroundBlurStrength,
    ),
  );

  const effectiveMacGlassEngine = createMemo<MacosGlassEngine>(() => {
    if (!isMac) return "cssSafe";
    const selected = config().macosGlassEngine;
    if (selected === "liquid" && liquidRuntimeFailed()) return "cgs";
    return selected;
  });

  const useCssBackdropBlur = createMemo(() => {
    const blur = blurProfile();
    if (!blur.enabled) return false;
    if (!isMac) return true;
    return effectiveMacGlassEngine() === "cssSafe";
  });

  // Apply the selected macOS glass engine. Liquid mode uses the plugin and
  // falls back to CGS blur if runtime plugin calls fail.
  createEffect(() => {
    if (!isMac) return;

    const selectedEngine = config().macosGlassEngine;
    const engine = effectiveMacGlassEngine();
    const blurPx = Math.round(blurProfile().blurPx);
    const variant = config().liquidVariant;
    const cornerRadius = config().liquidCornerRadius;
    const tintColor = config().liquidTintColor ?? undefined;
    const runSeq = ++glassEffectRunSeq;

    void (async () => {
      if (engine === "liquid") {
        const result = await setLiquidGlassEffectSafe({
          enabled: true,
          variant,
          cornerRadius,
          tintColor,
        });

        if (runSeq !== glassEffectRunSeq) return;

        if (!result.ok) {
          console.warn("[Rain] Liquid Glass apply failed. Falling back to CGS blur.");
          setLiquidRuntimeFailed(true);
          await setWindowBlurRadius(blurPx).catch((e) =>
            console.warn("[Rain] Failed to apply CGS fallback blur:", e),
          );
          return;
        }

        if (liquidRuntimeFailed()) {
          setLiquidRuntimeFailed(false);
        }

        await setWindowBlurRadius(0).catch((e) =>
          console.warn("[Rain] Failed to clear blur radius for Liquid mode:", e),
        );
        return;
      }

      if (selectedEngine !== "liquid" && liquidRuntimeFailed()) {
        setLiquidRuntimeFailed(false);
      }

      await disableLiquidGlassEffect();
      if (runSeq !== glassEffectRunSeq) return;

      if (engine === "cgs") {
        await setWindowBlurRadius(blurPx).catch((e) =>
          console.warn("[Rain] Failed to set CGS blur radius:", e),
        );
      } else {
        await setWindowBlurRadius(0).catch((e) =>
          console.warn("[Rain] Failed to clear CGS blur radius:", e),
        );
      }
    })();
  });

  // Dynamic window title based on active terminal state (debounced)
  createEffect(() => {
    const store = tabs.activeStore();
    let title: string;
    if (!store) {
      title = "";
    } else {
      const cwd = store.state.cwd;
      const activeCmd = store.state.activeBlock?.command;
      if (activeCmd) {
        title = activeCmd;
      } else if (cwd) {
        title = shortenHomePath(cwd);
      } else {
        title = "";
      }
    }

    // Debounce the actual DOM update to avoid flicker during rapid cwd changes
    const timerId = setTimeout(() => {
      document.title = title;
    }, 100);
    onCleanup(() => clearTimeout(timerId));
  });

  const surfaceOpacities = createMemo(() =>
    computeGlassSurfaceOpacities(
      config().windowOpacity,
      config().backgroundBlurStrength,
    ),
  );
  const backgroundPalette = createMemo(() => {
    return deriveBackgroundPalette(
      effectiveBgColor(),
      effectiveAccentColor(),
    );
  });

  const rootStyle = createMemo<Record<string, string>>(() => {
    const blur = blurProfile();
    const opacities = surfaceOpacities();
    const palette = backgroundPalette();
    const frameBorderColor = palette?.border ?? "var(--border)";

    return {
      // Apply font globally so all UI elements (tabs, status bar, blocks) use it
      "font-family": `"${config().fontFamily}", monospace`,
      // CSS blur is active on non-macOS and in explicit macOS cssSafe mode.
      "--glass-backdrop-filter": useCssBackdropBlur()
        ? `blur(${blur.blurPx.toFixed(2)}px) saturate(${blur.saturationPercent.toFixed(1)}%) contrast(${blur.contrastPercent.toFixed(1)}%)`
        : "none",
      "--glass-backdrop-overlay": useCssBackdropBlur()
        ? `${blur.overlayPercent.toFixed(2)}%`
        : "0%",
      "--glass-frame-border": frameBorderColor,
      // Opacity slider controls CSS surface density directly.
      // Blur slider is independent (handled by native CGS on Mac, CSS on others).
      "--glass-base-opacity": opacityUnitToPercent(opacities.body),
      "--surface-body-opacity": opacityUnitToPercent(opacities.body),
      "--bg": effectiveBgColor(),
      ...(palette
        ? {
            "--bg-raised": palette.bgRaised,
            "--bg-hover": palette.bgHover,
            "--bg-block": palette.bgBlock,
            "--bg-input": palette.bgInput,
            "--border": palette.border,
            "--border-block": palette.borderBlock,
            "--scrollbar-thumb": palette.scrollbarThumb,
            "--scrollbar-thumb-hover": palette.scrollbarThumbHover,
            "--selection-bg": palette.selectionBg,
            "--shadow-block": palette.shadowBlock,
            "--shadow-input": palette.shadowInput,
          }
        : {}),
      ...(config().customFgColor
        ? { "--fg": config().customFgColor as string }
        : {}),
      ...(config().customAccentColor
        ? {
            "--accent": config().customAccentColor as string,
            "--accent-dim": `color-mix(in srgb, ${config().customAccentColor as string} 20%, transparent)`,
          }
        : {}),
      ...(config().customCursorColor
        ? { "--cursor-color": config().customCursorColor as string }
        : {}),
      ...(config().customTabBarColor
        ? { "--custom-tab-bar-bg": config().customTabBarColor as string }
        : {}),
      ...(config().customInputBarColor
        ? { "--custom-input-bar-bg": config().customInputBarColor as string }
        : {}),
      ...(config().customShellBgColor
        ? { "--custom-shell-bg": config().customShellBgColor as string }
        : {}),
      ...(config().customErrorColor
        ? {
            "--error": config().customErrorColor as string,
            "--error-dim": `color-mix(in srgb, ${config().customErrorColor as string} 10%, transparent)`,
          }
        : {}),
      ...(config().customSuccessColor
        ? { "--success": config().customSuccessColor as string }
        : {}),
      ...(config().customBorderColor
        ? {
            "--border": config().customBorderColor as string,
            "--border-block": config().customBorderColor as string,
          }
        : {}),
      ...(config().customSelectionColor
        ? { "--selection-bg": `color-mix(in srgb, ${config().customSelectionColor as string} 25%, transparent)` }
        : {}),
    };
  });

  return (
    <div
      class={`rain-app${windowHighlighted() ? " rain-window-highlighted" : ""}`}
      data-platform={detectPlatform()}
      style={rootStyle()}
    >
      <Show when={updateInfo()}>
        {(info) => (
          <div class="update-banner">
            <span class="update-banner-text">
              Rain <strong>v{info().latestVersion}</strong> is available (you have v{info().currentVersion})
            </span>
            <div class="update-banner-actions">
              <button
                onClick={() => {
                  if (info().latestVersion) dismissVersion(info().latestVersion!);
                  setUpdateInfo(null);
                }}
              >
                Dismiss
              </button>
              <Show when={info().releaseUrl}>
                <button
                  class="primary"
                  onClick={() => window.open(info().releaseUrl!, "_blank")}
                >
                  View Release
                </button>
              </Show>
            </div>
          </div>
        )}
      </Show>
      <TabBar
        tabsStore={tabs}
        onNewTab={spawnTab}
        onCloseTab={closeTab}
        onOpenSettings={openSettings}
        onMoveTabToWindow={handleMoveTabToWindow}
        onIncMoveLock={incMoveLock}
        onDecMoveLock={decMoveLock}
        onCloseOtherTabs={(tabId) => {
          const toClose = tabs.getTabsExcept(tabId);
          for (const id of toClose) closeTab(id);
        }}
        onCloseTabsToRight={(tabId) => {
          const toClose = tabs.getTabsToRight(tabId);
          for (const id of toClose) closeTab(id);
        }}
      />
      <Show when={adoptProgress()}>
        {(progress) => (
          <div class="tab-adopt-progress">
            <span class="tab-adopt-progress-label">Rehydrating panes: {progress().label}</span>
            <span class="tab-adopt-progress-count">
              {progress().redrawn}/{progress().total}
            </span>
          </div>
        )}
      </Show>
      <div class="terminal-area">
        <For each={tabs.state.tabs}>
          {(tab, index) => (
            <div
              class="terminal-area-tab"
              style={{ display: index() === tabs.state.activeIndex ? "flex" : "none" }}
            >
              <Show
                when={tab.paneTree}
                fallback={<Settings />}
              >
                {(tree) => (
                  <PaneContainer
                    node={tree()}
                    stores={tabs.stores}
                    activePaneId={tab.activePaneId || tabs.getActivePaneId(tab.id)}
                    isTabActive={index() === tabs.state.activeIndex}
                    onPaneActivate={(paneId) => {
                      tabs.setActivePane(tab.id, paneId);
                      const paneStore = tabs.stores.get(paneId);
                      const tmuxPaneId = paneStore?.state.tmuxPaneId;
                      if (tmuxPaneId != null) {
                        tmuxSelectPane(tmuxPaneId).catch(console.error);
                      }
                    }}
                    onOpenSettings={openSettings}
                    onSplitRight={(paneId) => splitActivePane(tab.id, paneId, "horizontal")}
                    onSplitDown={(paneId) => splitActivePane(tab.id, paneId, "vertical")}
                  />
                )}
              </Show>
            </div>
          )}
        </For>
      </div>
      <Show when={config().showStatusBar}>
        <StatusBar store={tabs.activeStore()} />
      </Show>
      <Show when={showPalette()}>
        <CommandPalette
          actions={paletteActions()}
          onClose={() => setShowPalette(false)}
        />
      </Show>
      <Show when={showHistory()}>
        <HistoryBrowser
          snapshots={allSnapshots()}
          onClose={() => setShowHistory(false)}
          onRerun={handleHistoryRerun}
        />
      </Show>
      <ToastContainer />
    </div>
  );
};

export default App;
