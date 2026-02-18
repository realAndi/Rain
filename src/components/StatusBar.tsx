import { Component, Show, createSignal } from "solid-js";
import type { TerminalStore } from "../stores/terminal";
import { useConfig } from "../stores/config";
import { IconFolder, IconConnection, IconTerminal } from "./icons";

export const StatusBar: Component<{ store: TerminalStore | undefined }> = (props) => {
  const { config } = useConfig();
  const [copied, setCopied] = createSignal(false);

  const copyPath = () => {
    const cwd = props.store?.state.cwd;
    if (!cwd) return;
    navigator.clipboard.writeText(cwd).catch(console.error);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const shortCwd = () => {
    const cwd = props.store?.state.cwd;
    if (!cwd) return "~";
    const home = "/Users/";
    if (cwd.startsWith(home)) {
      const rest = cwd.substring(home.length);
      const slashIdx = rest.indexOf("/");
      if (slashIdx >= 0) return "~" + rest.substring(slashIdx);
      return "~";
    }
    return cwd;
  };

  const dimensions = () => {
    if (!props.store) return "";
    const { cols, rows } = props.store.state;
    return `${cols}x${rows}`;
  };

  const isConnected = () => props.store?.state.connected ?? false;

  // Extract process name from the terminal title
  // Shells typically set the title to "process" or "user@host: path"
  const activeProcess = () => {
    const title = props.store?.state.title;
    if (!title || title === "Rain" || title === "") return null;
    // If the title contains a colon (like "user@host: /path"), grab just the first part
    const colonIdx = title.indexOf(":");
    if (colonIdx >= 0) {
      const before = title.substring(0, colonIdx).trim();
      // If it looks like user@host, skip it and return null (cwd already shows the path)
      if (before.includes("@")) return null;
      return before;
    }
    return title;
  };

  return (
    <div class="status-bar" role="status" aria-label="Terminal status">
      <Show when={config().statusBarShowPath}>
        <div class="status-item">
          <IconFolder size={11} />
          <span class="status-bar-path-clickable" onClick={copyPath} title="Click to copy full path">
            {copied() ? "Copied!" : shortCwd()}
          </span>
        </div>
      </Show>

      <Show when={props.store?.state.tmuxPaneId != null || props.store?.state.tmuxActive === true}>
        <div class="status-item status-tmux-badge">
          <span>tmux</span>
          <Show when={props.store?.state.tmuxPaneId != null}>
            <span class="tmux-pane-id">%{props.store?.state.tmuxPaneId}</span>
          </Show>
        </div>
      </Show>

      <div class="status-spacer" />

      <Show when={config().statusBarShowActiveProcess && activeProcess()}>
        <div class="status-item status-process-badge">
          <IconTerminal size={10} />
          <span>{activeProcess()}</span>
        </div>
      </Show>

      <Show when={config().statusBarShowDimensions}>
        <div class="status-item">
          <span>{dimensions()}</span>
        </div>
      </Show>

      <Show when={config().statusBarShowConnection}>
        <div class={`status-indicator ${isConnected() ? "connected" : "disconnected"}`}>
          <IconConnection size={10} />
        </div>
      </Show>
    </div>
  );
};
