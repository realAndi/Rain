import { Component, Show, createSignal } from "solid-js";
import type { Block } from "../lib/types";
import { IconCopy, IconCheck } from "./icons";

export const BlockFooter: Component<{ block: Block }> = (props) => {
  const [copied, setCopied] = createSignal(false);

  const duration = () => {
    if (!props.block.startTime || !props.block.endTime) return null;
    const ms = props.block.endTime - props.block.startTime;
    if (ms < 1000) return `${ms}ms`;
    const seconds = (ms / 1000).toFixed(1);
    return `${seconds}s`;
  };

  const exitCodeClass = () => {
    return props.block.exitCode === 0 ? "exit-success" : "exit-error";
  };

  const handleCopy = () => {
    const text = props.block.lines
      .map((line) =>
        line.spans
          .map((s) => s.text)
          .join("")
          .trimEnd(),
      )
      .join("\n");

    navigator.clipboard.writeText(text).catch(console.error);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div class="block-footer">
      <Show when={props.block.exitCode !== null}>
        <span class={`block-exit-code ${exitCodeClass()}`}>
          {props.block.exitCode === 0 ? "ok" : `exit ${props.block.exitCode}`}
        </span>
      </Show>
      <Show when={duration()}>
        <span class="block-duration">{duration()}</span>
      </Show>
      <button class="block-action" onClick={handleCopy} title="Copy output">
        {copied() ? <IconCheck size={11} /> : <IconCopy size={11} />}
        {copied() ? "copied!" : "copy"}
      </button>
    </div>
  );
};
