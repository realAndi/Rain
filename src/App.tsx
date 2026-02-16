import {
  Component,
  For,
  onMount,
  onCleanup,
  Show,
  createEffect,
  createMemo,
} from "solid-js";
import { PaneContainer } from "./components/PaneContainer";
import { TabBar } from "./components/TabBar";
import { StatusBar } from "./components/StatusBar";
import { Settings } from "./components/Settings";
import { createTabsStore } from "./stores/tabs";
import { useConfig } from "./stores/config";
import {
  computeBlurProfile,
  computeGlassSurfaceOpacities,
  deriveBackgroundPalette,
  opacityUnitToPercent,
} from "./lib/glass";
import { useTheme, THEME_LIST } from "./stores/theme";
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
} from "./lib/ipc";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { RenderFramePayload } from "./lib/types";

const THEME_BG_MAP = new Map(THEME_LIST.map((entry) => [entry.name, entry.bg]));
const THEME_ACCENT_MAP = new Map(
  THEME_LIST.map((entry) => [entry.name, entry.accent]),
);

const App: Component = () => {
  const tabs = createTabsStore();
  const { config } = useConfig();
  const { theme } = useTheme();
  const unlisteners: UnlistenFn[] = [];
  // Buffer for frames that arrive before their store is registered.
  // This closes the race between createSession() resolving and addTab() running.
  const pendingFrames = new Map<string, RenderFramePayload[]>();

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

  function openSettings() {
    tabs.addSettingsTab();
  }

  async function spawnTab() {
    try {
      const activeStore = tabs.activeStore();
      const rows = activeStore?.state.rows ?? 24;
      const cols = activeStore?.state.cols ?? 80;

      const sessionId = await createSession(undefined, undefined, rows, cols);
      console.log("[Rain] Session created:", sessionId);

      const tab = tabs.addTab(sessionId, "Shell");
      flushPendingFrames(sessionId);

      await requestFullRedraw(sessionId);
      return tab;
    } catch (err) {
      console.error("[Rain] Failed to create tab:", err);
      return undefined;
    }
  }

  async function closeTab(tabId: string) {
    const tabData = tabs.state.tabs.find((t) => t.id === tabId);
    if (!tabData) return;

    // If this is the last terminal tab, spawn a fresh one before closing
    const terminalTabs = tabs.state.tabs.filter((t) => t.type === "terminal");
    const isLastTerminal = tabData.type === "terminal" && terminalTabs.length <= 1;
    if (isLastTerminal) {
      await spawnTab();
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

  // Global keyboard shortcuts for tabs
  function handleGlobalKeyDown(e: KeyboardEvent) {
    if (e.metaKey && e.key === ",") {
      e.preventDefault();
      openSettings();
      return;
    }

    if (e.metaKey && e.key === "t") {
      e.preventDefault();
      spawnTab();
      return;
    }

    if (e.metaKey && e.key === "w") {
      e.preventDefault();
      const active = tabs.activeTab();
      if (active) closeTab(active.id);
      return;
    }

    // Cmd+1-9 switch tabs
    if (e.metaKey && e.key >= "1" && e.key <= "9") {
      e.preventDefault();
      const idx = parseInt(e.key) - 1;
      tabs.switchTab(idx);
      return;
    }

    // Cmd+Shift+[ and Cmd+Shift+] for prev/next tab
    if (e.metaKey && e.shiftKey && e.key === "[") {
      e.preventDefault();
      tabs.prevTab();
      return;
    }
    if (e.metaKey && e.shiftKey && e.key === "]") {
      e.preventDefault();
      tabs.nextTab();
      return;
    }

    // Cmd+D: split vertical, Cmd+Shift+D: split horizontal
    if (e.metaKey && e.key === "d") {
      e.preventDefault();
      const tab = tabs.activeTab();
      if (tab && tab.type === "terminal") {
        const direction = e.shiftKey ? "horizontal" : "vertical";
        const activePaneId = tabs.getActivePaneId(tab.id);
        splitActivePane(tab.id, activePaneId, direction);
      }
      return;
    }
  }

  async function splitActivePane(tabId: string, paneId: string, direction: "horizontal" | "vertical") {
    try {
      const activeStore = tabs.activeStore();
      const rows = activeStore?.state.rows ?? 24;
      const cols = activeStore?.state.cols ?? 80;
      const sessionId = await createSession(undefined, undefined, rows, cols);
      tabs.splitPane(tabId, paneId, direction, sessionId);
      flushPendingFrames(sessionId);
      await requestFullRedraw(sessionId);
    } catch (err) {
      console.error("[Rain] Failed to split pane:", err);
    }
  }

  onMount(async () => {
    document.addEventListener("keydown", handleGlobalKeyDown);

    // Register event listeners BEFORE creating any sessions
    const unFrame = await onRenderFrame((payload) => {
      // Route to the correct tab's store by session_id
      const store = tabs.getStoreBySessionId(payload.session_id);
      if (store) {
        // Flush any frames that were buffered before the store existed
        flushPendingFrames(payload.session_id);
        store.applyRenderFrame(payload);
      } else {
        // Store doesn't exist yet (race between createSession and addTab).
        // Buffer the frame so events like BlockStarted aren't lost.
        let buf = pendingFrames.get(payload.session_id);
        if (!buf) {
          buf = [];
          pendingFrames.set(payload.session_id, buf);
        }
        buf.push(payload);
      }
    });
    unlisteners.push(unFrame);

    const unEnd = await onSessionEnded((payload) => {
      const store = tabs.getStoreBySessionId(payload.session_id);
      if (store) {
        store.setState({ connected: false });
      }
    });
    unlisteners.push(unEnd);

    const unResizeAck = await onResizeAck((payload) => {
      const store = tabs.getStoreBySessionId(payload.session_id);
      if (store) {
        store.applyResizeAck(payload);
      }
    });
    unlisteners.push(unResizeAck);

    // Create the first tab
    await spawnTab();
  });

  onCleanup(() => {
    document.removeEventListener("keydown", handleGlobalKeyDown);
    for (const unlisten of unlisteners) {
      unlisten();
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

  // On macOS, use CGSSetWindowBackgroundBlurRadius for native window-level blur.
  // This gives pixel-level control and persists through Space transitions.
  // On other platforms, CSS backdrop-filter handles blur.
  const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

  createEffect(() => {
    if (isMac) {
      const blur = blurProfile();
      setWindowBlurRadius(Math.round(blur.blurPx)).catch((e) =>
        console.warn("[Rain] Failed to set blur radius:", e),
      );
    }
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
      // On Mac, native CGS handles blur so CSS backdrop-filter is disabled.
      // On other platforms, CSS handles everything.
      "--glass-backdrop-filter": blur.enabled && !isMac
        ? `blur(${blur.blurPx.toFixed(2)}px) saturate(${blur.saturationPercent.toFixed(1)}%) contrast(${blur.contrastPercent.toFixed(1)}%)`
        : "none",
      "--glass-backdrop-overlay": blur.enabled && !isMac
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
      class="rain-app"
      style={rootStyle()}
    >
      <TabBar
        tabsStore={tabs}
        onNewTab={spawnTab}
        onCloseTab={closeTab}
        onOpenSettings={openSettings}
      />
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
                    onPaneActivate={(paneId) => tabs.setActivePane(tab.id, paneId)}
                    onOpenSettings={openSettings}
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
    </div>
  );
};

export default App;
