import { Component, Show } from "solid-js";
import type { TerminalStore } from "../stores/terminal";
import { IconFolder, IconConnection } from "./icons";

export const StatusBar: Component<{ store: TerminalStore | undefined }> = (props) => {
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
  const hasShellIntegration = () => props.store?.state.shellIntegrationActive ?? false;

  return (
    <div class="status-bar">
      <div class="status-item">
        <IconFolder size={11} />
        <span>{shortCwd()}</span>
      </div>

      <div class="status-spacer" />

      <Show when={hasShellIntegration()}>
        <div class="status-item">
          <span>shell integration</span>
        </div>
      </Show>

      <div class="status-item">
        <span>{dimensions()}</span>
      </div>

      <div class={`status-indicator ${isConnected() ? "connected" : "disconnected"}`}>
        <IconConnection size={10} />
      </div>
    </div>
  );
};
