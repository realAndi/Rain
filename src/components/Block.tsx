import { Component, For, Show } from "solid-js";
import type { Block as BlockType } from "../lib/types";
import { BlockHeader } from "./BlockHeader";
import { BlockFooter } from "./BlockFooter";
import { TerminalLine } from "./TerminalLine";
import { IconCopy, IconCommand } from "./icons";

export const Block: Component<{ block: BlockType; charWidth: number }> = (props) => {
  const statusClass = () => {
    switch (props.block.status) {
      case "running":
        return "block-running";
      case "complete":
        return props.block.exitCode === 0 ? "block-success" : "block-error";
      default:
        return "block-prompt";
    }
  };

  const copyCommand = (e: MouseEvent) => {
    e.stopPropagation();
    if (props.block.command) {
      navigator.clipboard.writeText(props.block.command).catch(console.error);
    }
  };

  const copyOutput = (e: MouseEvent) => {
    e.stopPropagation();
    const text = props.block.lines
      .map((line) => line.spans.map((s) => s.text).join("").trimEnd())
      .join("\n");
    navigator.clipboard.writeText(text).catch(console.error);
  };

  return (
    <div class={`command-block ${statusClass()}`}>
      {/* Floating action toolbar */}
      <div class="block-actions">
        <Show when={props.block.command}>
          <button class="block-action-btn" onClick={copyCommand} title="Copy command">
            <IconCommand size={12} />
          </button>
        </Show>
        <Show when={props.block.lines.length > 0}>
          <button class="block-action-btn" onClick={copyOutput} title="Copy output">
            <IconCopy size={12} />
          </button>
        </Show>
      </div>

      <BlockHeader block={props.block} />

      <div class="block-output">
        <For each={props.block.lines}>
          {(line) => <TerminalLine line={line} charWidth={props.charWidth} />}
        </For>
      </div>

      <Show when={props.block.status === "complete"}>
        <BlockFooter block={props.block} />
      </Show>
    </div>
  );
};
