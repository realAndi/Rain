import { Component, For, Show, createSignal } from "solid-js";
import type { CommandSnapshot } from "../../lib/types";
import { TerminalLine } from "../TerminalLine";
import { IconFolder, IconCopy, IconCommand } from "../icons";
import { formatCwdSimplified } from "./utils";

export const CommandBlock: Component<{
  snapshot: CommandSnapshot;
  charWidth: number;
  promptStyle: "default" | "simplified" | "blank";
}> = (props) => {
  const [copied, setCopied] = createSignal<"command" | "output" | null>(null);

  const displayCwd = () => {
    const cwd = props.snapshot.cwd;
    if (props.promptStyle === "blank") return "";
    if (props.promptStyle === "default") return cwd || "~";
    return formatCwdSimplified(cwd);
  };

  const duration = () => {
    const end = props.snapshot.endTime;
    if (!end) return null;
    const ms = end - props.snapshot.timestamp;
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(3)}s`;
  };

  const timeStr = () => {
    const d = new Date(props.snapshot.timestamp);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  const copyCommand = (e: MouseEvent) => {
    e.stopPropagation();
    if (props.snapshot.command) {
      navigator.clipboard.writeText(props.snapshot.command).catch(console.error);
      setCopied("command");
      setTimeout(() => setCopied(null), 1500);
    }
  };

  const copyOutput = (e: MouseEvent) => {
    e.stopPropagation();
    const text = props.snapshot.lines
      .map((line) =>
        line.spans
          .map((s) => s.text)
          .join("")
          .trimEnd(),
      )
      .join("\n");
    navigator.clipboard.writeText(text).catch(console.error);
    setCopied("output");
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div
      class="command-block"
      classList={{ "block-failed": props.snapshot.failed }}
    >
      {/* Floating action toolbar */}
      <div class="block-actions">
        <Show when={props.snapshot.command}>
          <button
            class="block-action-btn"
            onClick={copyCommand}
            title="Copy command"
          >
            <IconCommand size={12} />
          </button>
        </Show>
        <Show when={props.snapshot.lines.length > 0}>
          <button
            class="block-action-btn"
            onClick={copyOutput}
            title="Copy output"
          >
            <IconCopy size={12} />
          </button>
        </Show>
      </div>

      <div class="block-header">
        <span class="block-header-icon"><IconFolder size={11} /></span>
        <span class="block-cwd">{displayCwd()}</span>
        <Show when={duration()}>
          <span class="block-duration">{duration()}</span>
        </Show>
        <span class="block-timestamp">{timeStr()}</span>
      </div>

      <Show when={props.snapshot.command}>
        <div class="block-command">
          <span class="block-prompt-char">$</span>
          {props.snapshot.command}
        </div>
      </Show>

      <Show when={props.snapshot.lines.length > 0}>
        <div class="block-output">
          <For each={props.snapshot.lines}>
            {(line) => <TerminalLine line={line} charWidth={props.charWidth} />}
          </For>
        </div>
      </Show>

      {/* Footer for completed blocks with exit info */}
      <Show when={props.snapshot.endTime !== null && props.snapshot.endTime !== undefined}>
        <div class="block-footer">
          <span class={`block-exit-code ${props.snapshot.failed ? "exit-error" : "exit-success"}`}>
            {props.snapshot.failed ? "failed" : "ok"}
          </span>
          <Show when={duration()}>
            <span class="block-duration">{duration()}</span>
          </Show>
          <button class="block-action" onClick={copyOutput}>
            <IconCopy size={11} />
            {copied() === "output" ? "copied!" : "copy"}
          </button>
        </div>
      </Show>
    </div>
  );
};
