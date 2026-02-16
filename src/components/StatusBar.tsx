import { Component, Show } from "solid-js";
import type { TerminalStore } from "../stores/terminal";
import { useConfig } from "../stores/config";
import { IconFolder, IconConnection, IconTerminal } from "./icons";

export const StatusBar: Component<{ store: TerminalStore | undefined }> = (props) => {
  const { config } = useConfig();

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
    <div class="status-bar">
      <Show when={config().statusBarShowPath}>
        <div class="status-item">
          <IconFolder size={11} />
          <span>{shortCwd()}</span>
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
