import { Component, For, Show } from "solid-js";
import type { CommandSnapshot } from "../../lib/types";
import { TerminalLine } from "../TerminalLine";
import { extractUsername, getHostname, formatCwdDefault, formatCwdSimplified } from "./utils";

export const TraditionalBlock: Component<{
  snapshot: CommandSnapshot;
  charWidth: number;
  promptStyle: "default" | "simplified" | "blank";
}> = (props) => {
  const displayPrompt = () => {
    const cwd = props.snapshot.cwd;
    if (props.promptStyle === "blank") return null;
    if (props.promptStyle === "default") {
      const user = extractUsername(cwd);
      const host = getHostname();
      const dirName = formatCwdDefault(cwd);
      return `${user}@${host} ${dirName}`;
    }
    return formatCwdSimplified(cwd);
  };

  const promptChar = () => {
    if (props.promptStyle === "blank") return "";
    if (props.promptStyle === "default") return "%";
    return "$";
  };

  return (
    <div class="traditional-block">
      <Show when={props.snapshot.command}>
        <div class="term-line traditional-prompt-line">
          <Show when={displayPrompt()}>
            <span class="traditional-prompt-text">{displayPrompt()}</span>
            <span class="traditional-prompt-char"> {promptChar()} </span>
          </Show>
          <span class="traditional-command-text">{props.snapshot.command}</span>
        </div>
      </Show>
      <Show when={props.snapshot.lines.length > 0}>
        <For each={props.snapshot.lines}>
          {(line) => <TerminalLine line={line} charWidth={props.charWidth} />}
        </For>
      </Show>
    </div>
  );
};
