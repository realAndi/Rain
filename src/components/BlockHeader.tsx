import { Component, Show } from "solid-js";
import type { Block } from "../lib/types";
import { IconFolder } from "./icons";

export const BlockHeader: Component<{ block: Block }> = (props) => {
  const shortCwd = () => {
    const cwd = props.block.cwd;
    if (!cwd) return "";
    // Replace home directory with ~
    const home = "/Users/"; // on macOS
    if (cwd.startsWith(home)) {
      const rest = cwd.substring(home.length);
      const slashIdx = rest.indexOf("/");
      if (slashIdx >= 0) {
        return "~" + rest.substring(slashIdx);
      }
      return "~";
    }
    return cwd;
  };

  const timeStr = () => {
    const date = new Date(props.block.startTime);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div class="block-header">
      <span class="block-header-icon"><IconFolder size={11} /></span>
      <Show when={props.block.cwd}>
        <span class="block-cwd">{shortCwd()}</span>
      </Show>
      <Show when={props.block.command}>
        <span class="block-command">
          <span class="block-prompt-char">$</span> {props.block.command}
        </span>
      </Show>
      <span class="block-timestamp">{timeStr()}</span>
    </div>
  );
};
