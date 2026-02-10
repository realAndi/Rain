import { Component, onMount, onCleanup, Show, createEffect } from "solid-js";
import { Terminal } from "./components/Terminal";
import { TabBar } from "./components/TabBar";
import { StatusBar } from "./components/StatusBar";
import { Settings } from "./components/Settings";
import { createTabsStore } from "./stores/tabs";
import { useConfig } from "./stores/config";
import {
  createSession,
  destroySession,
  onRenderFrame,
  onSessionEnded,
  requestFullRedraw,
  setWindowVibrancy,
  setWindowOpacity,
} from "./lib/ipc";
import type { UnlistenFn } from "@tauri-apps/api/event";

const App: Component = () => {
  const tabs = createTabsStore();
  const { config } = useConfig();
  const unlisteners: UnlistenFn[] = [];

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
  }

  onMount(async () => {
    document.addEventListener("keydown", handleGlobalKeyDown);

    // Register event listeners BEFORE creating any sessions
    const unFrame = await onRenderFrame((payload) => {
      // Route to the correct tab's store by session_id
      const store = tabs.getStoreBySessionId(payload.session_id);
      if (store) {
        store.applyRenderFrame(payload);
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

    // Create the first tab
    await spawnTab();
  });

  onCleanup(() => {
    document.removeEventListener("keydown", handleGlobalKeyDown);
    for (const unlisten of unlisteners) {
      unlisten();
    }
  });

  // Enable vibrancy (macOS frosted glass base) when blur > 0 and opacity < 100%.
  createEffect(() => {
    const blurOn = config().backgroundBlur > 0 && config().windowOpacity < 1.0;
    setWindowVibrancy(blurOn).catch((e) =>
      console.warn("[Rain] Failed to set vibrancy:", e),
    );
  });

  // Set OS-level window opacity via NSWindow.alphaValue.
  // When blur is active, keep alphaValue at 1.0 so the vibrancy + backdrop-filter
  // aren't washed out. Opacity slider drives CSS background transparency instead.
  // When blur is off, alphaValue handles the full window fade.
  createEffect(() => {
    const blur = config().backgroundBlur;
    const opacity = config().windowOpacity;
    const effectiveAlpha = blur > 0 && opacity < 1.0 ? 1.0 : opacity;
    setWindowOpacity(effectiveAlpha).catch((e) =>
      console.warn("[Rain] Failed to set window opacity:", e),
    );
  });

  return (
    <div
      class="rain-app"
      style={{
        "--bg-blur": `${config().backgroundBlur}px`,
        "--bg-alpha": config().backgroundBlur > 0 && config().windowOpacity < 1.0
          ? `${Math.round(config().windowOpacity * 100)}%`
          : "100%",
        ...(config().customBgColor ? { "--bg": config().customBgColor as string } : {}),
        ...(config().customFgColor ? { "--fg": config().customFgColor as string } : {}),
        ...(config().customAccentColor ? { "--accent": config().customAccentColor as string } : {}),
        ...(config().customCursorColor ? { "--cursor-color": config().customCursorColor as string } : {}),
      }}
    >
      <TabBar
        tabsStore={tabs}
        onNewTab={spawnTab}
        onCloseTab={closeTab}
        onOpenSettings={openSettings}
      />
      <div class="terminal-area">
        {tabs.state.tabs.map((tab, index) => {
          if (tab.type === "settings") {
            return (
              <div
                class="terminal-area-tab"
                style={{ display: index === tabs.state.activeIndex ? "flex" : "none" }}
              >
                <Settings />
              </div>
            );
          }
          const store = tabs.stores.get(tab.id);
          return (
            <Show when={store}>
              {(s) => (
                <Terminal
                  store={s()}
                  active={index === tabs.state.activeIndex}
                  onOpenSettings={openSettings}
                />
              )}
            </Show>
          );
        })}
      </div>
      <StatusBar store={tabs.activeStore()} />
    </div>
  );
};

export default App;
