import { Component, For, Show, onMount, onCleanup, createSignal, createEffect, createMemo, on } from "solid-js";
import type { TerminalStore } from "../stores/terminal";
import type { CommandSnapshot } from "../lib/types";
import { useConfig } from "../stores/config";
import { writeInput, resizeTerminal } from "../lib/ipc";
import { keyEventToBytes } from "../lib/input";
import { measureFontMetrics, calculateTerminalSize, type FontMetrics } from "../lib/font";
import { collectLinesForRange } from "../lib/terminal-output";
import { TerminalLine } from "./TerminalLine";
import { Cursor } from "./Cursor";
import { IconFolder, IconCopy, IconCommand, IconArrowDown } from "./icons";

// Render a completed command block as a card
const CommandBlock: Component<{
  snapshot: CommandSnapshot;
  charWidth: number;
}> = (props) => {
  const [copied, setCopied] = createSignal<"command" | "output" | null>(null);

  const shortCwd = () => {
    const cwd = props.snapshot.cwd;
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
        <span class="block-cwd">{shortCwd()}</span>
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

// Welcome screen for empty terminals
const WelcomeState: Component = () => {
  return (
    <div class="welcome-state">
      <div class="welcome-title">Rain</div>
      <div class="welcome-subtitle">terminal emulator</div>
      <div class="welcome-shortcuts">
        <div class="welcome-shortcut">
          <span class="welcome-key">Cmd+T</span>
          <span>New tab</span>
        </div>
        <div class="welcome-shortcut">
          <span class="welcome-key">Cmd+K</span>
          <span>Clear</span>
        </div>
        <div class="welcome-shortcut">
          <span class="welcome-key">Cmd+,</span>
          <span>Settings</span>
        </div>
      </div>
    </div>
  );
};

export const Terminal: Component<{ store: TerminalStore; active: boolean; onOpenSettings?: () => void }> = (props) => {
  let containerRef!: HTMLDivElement;
  let scrollRef!: HTMLDivElement;
  const { config } = useConfig();
  const [metrics, setMetrics] = createSignal<FontMetrics | null>(null);
  const [isScrolledUp, setIsScrolledUp] = createSignal(false);
  const [containerHeight, setContainerHeight] = createSignal(600);

  onMount(() => {
    const cfg = config();
    const m = measureFontMetrics(cfg.fontFamily, cfg.fontSize, cfg.lineHeight);
    setMetrics(m);

    containerRef.focus();

    const w = containerRef.clientWidth;
    const h = containerRef.clientHeight;
    setContainerHeight(h);
    const { rows, cols } = calculateTerminalSize(w, h, m);
    props.store.setState({ rows, cols });

    const observer = new ResizeObserver(() => {
      const met = metrics();
      if (!met) return;
      setContainerHeight(containerRef.clientHeight);
      const { rows, cols } = calculateTerminalSize(
        containerRef.clientWidth,
        containerRef.clientHeight,
        met,
      );
      if (rows !== props.store.state.rows || cols !== props.store.state.cols) {
        props.store.setState({ rows, cols });
        const sid = props.store.state.sessionId;
        if (sid) {
          resizeTerminal(sid, rows, cols).catch(console.error);
        }
      }
    });
    observer.observe(containerRef);

    onCleanup(() => observer.disconnect());
  });

  // Track where the prompt starts so multiline input stays visible.
  // promptRow is set to the cursor row when a new prompt appears.
  const [promptRow, setPromptRow] = createSignal(0);

  // Reset promptRow when a command completes (snapshot count changes)
  createEffect(on(
    () => props.store.state.snapshots.length,
    () => {
      setPromptRow(props.store.state.cursor.row);
    }
  ));

  // Also reset promptRow when pendingBlock appears (OSC 133;A prompt start)
  createEffect(on(
    () => props.store.state.pendingBlock,
    (pending) => {
      if (pending) {
        setPromptRow(props.store.state.cursor.row);
      }
    }
  ));

  // Track scroll position for FAB
  const handleScroll = () => {
    if (!scrollRef) return;
    const threshold = 50;
    const isAtBottom = scrollRef.scrollHeight - scrollRef.scrollTop - scrollRef.clientHeight < threshold;
    setIsScrolledUp(!isAtBottom);
  };

  const scrollToBottom = () => {
    if (scrollRef) {
      scrollRef.scrollTo({ top: scrollRef.scrollHeight, behavior: "smooth" });
    }
  };

  // Input area lines: start from promptRow so multiline paste stays visible.
  // Captures all rows from the prompt start through to the cursor row.
  const inputLines = createMemo(() => {
    const cursorRow = props.store.state.cursor.row;
    const pr = promptRow();
    // If promptRow is beyond cursor (e.g. after clear), clamp to cursor
    const startRow = Math.min(pr, cursorRow);
    const scrollbackCount = props.store.state.scrollbackLines.length;

    // Collect visible grid lines directly for robustness
    const result: import("../lib/types").RenderedLine[] = [];
    const visibleMap = new Map<number, import("../lib/types").RenderedLine>();
    for (const line of props.store.state.fallbackLines) {
      visibleMap.set(line.index, line);
    }
    for (let row = startRow; row <= cursorRow; row++) {
      const globalIdx = scrollbackCount + row;
      if (globalIdx < scrollbackCount) {
        const line = props.store.state.scrollbackLines[globalIdx];
        if (line) result.push({ index: result.length, spans: [...line.spans] });
        else result.push({ index: result.length, spans: [] });
      } else {
        const line = visibleMap.get(row);
        if (line) result.push({ index: result.length, spans: [...line.spans] });
        else result.push({ index: result.length, spans: [] });
      }
    }
    return result;
  });

  // Cursor position offset relative to the input area's start row
  const inputCursor = createMemo(() => {
    const c = props.store.state.cursor;
    const startRow = Math.min(promptRow(), c.row);
    return { ...c, row: c.row - startRow };
  });

  // Keep input area scrolled to bottom when lines change (e.g. after paste)
  createEffect(() => {
    const _ = inputLines().length;
    requestAnimationFrame(() => {
      const inputContent = containerRef?.querySelector(".input-content");
      if (inputContent) {
        inputContent.scrollTop = inputContent.scrollHeight;
      }
    });
  });

  const activeOutputLines = createMemo(() => {
    const active = props.store.state.activeBlock;
    if (!active) return [];
    const scrollbackCount = props.store.state.scrollbackLines.length;
    const endGlobal = scrollbackCount + props.store.state.cursor.row;
    if (endGlobal <= active.outputStart) return [];
    return collectLinesForRange(
      props.store.state.scrollbackLines,
      props.store.state.fallbackLines,
      props.store.state.rows,
      active.outputStart,
      endGlobal,
    );
  });

  const fallbackOutputLines = createMemo(() => {
    if (props.store.state.shellIntegrationActive) return [];
    const scrollbackCount = props.store.state.scrollbackLines.length;
    const endGlobal = scrollbackCount + props.store.state.cursor.row;
    if (endGlobal <= 0) return [];
    return collectLinesForRange(
      props.store.state.scrollbackLines,
      props.store.state.fallbackLines,
      props.store.state.rows,
      0,
      endGlobal,
    );
  });

  const activeSnapshot = createMemo<CommandSnapshot | null>(() => {
    const active = props.store.state.activeBlock;
    if (!active) return null;
    const lines = activeOutputLines();
    if (!active.command && lines.length === 0) return null;
    return {
      id: `active-${active.id}`,
      command: active.command,
      lines,
      timestamp: active.startTime || Date.now(),
      endTime: null,
      cwd: active.cwd || props.store.state.cwd,
      failed: false,
    };
  });

  const isEmpty = createMemo(() => {
    return (
      props.store.state.snapshots.length === 0 &&
      !activeSnapshot() &&
      fallbackOutputLines().length === 0
    );
  });

  // Auto-scroll to bottom
  createEffect(() => {
    const _ = activeOutputLines().length;
    const __ = props.store.state.snapshots.length;
    const ___ = fallbackOutputLines().length;
    if (scrollRef) {
      requestAnimationFrame(() => {
        scrollRef.scrollTop = scrollRef.scrollHeight;
      });
    }
  });

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey && e.key === "k") {
      e.preventDefault();
      props.store.clearHistory();
      return;
    }

    if (e.metaKey && e.key === ",") {
      e.preventDefault();
      props.onOpenSettings?.();
      return;
    }

    if (e.metaKey && e.key === "c") {
      const selection = window.getSelection();
      if (selection && selection.toString().length > 0) {
        return;
      }
    }

    if (e.metaKey && e.key === "v") {
      return;
    }

    if (e.metaKey && (e.key === "t" || e.key === "w" || (e.key >= "1" && e.key <= "9"))) {
      return;
    }
    if (e.metaKey && e.shiftKey && (e.key === "[" || e.key === "]")) {
      return;
    }

    e.preventDefault();

    const sid = props.store.state.sessionId;
    if (!sid) return;

    const cfg = config();
    const bytes = keyEventToBytes(e, cfg.optionAsMeta);
    if (bytes.length > 0) {
      writeInput(sid, Array.from(bytes)).catch(console.error);
    }
  };

  const handlePaste = (e: ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData?.getData("text");
    if (!text) return;

    const sid = props.store.state.sessionId;
    if (!sid) return;

    const encoder = new TextEncoder();
    const pasteStart = new Uint8Array([0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e]);
    const pasteEnd = new Uint8Array([0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]);
    const textBytes = encoder.encode(text);

    const data = new Uint8Array(pasteStart.length + textBytes.length + pasteEnd.length);
    data.set(pasteStart, 0);
    data.set(textBytes, pasteStart.length);
    data.set(pasteEnd, pasteStart.length + textBytes.length);

    writeInput(sid, Array.from(data)).catch(console.error);

    // Scroll the input content area to bottom so cursor is visible
    requestAnimationFrame(() => {
      const inputContent = containerRef.querySelector(".input-content");
      if (inputContent) {
        inputContent.scrollTop = inputContent.scrollHeight;
      }
    });
  };

  // Click-to-position cursor in the input area
  const handleInputClick = (e: MouseEvent) => {
    const sid = props.store.state.sessionId;
    if (!sid) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const targetCol = Math.floor(x / charWidth());
    const targetRow = Math.floor(y / lineHeight());
    const startRow = Math.min(promptRow(), props.store.state.cursor.row);
    const curRow = props.store.state.cursor.row - startRow;
    const curCol = props.store.state.cursor.col;

    const bytes: number[] = [];
    // Vertical movement
    const rowDiff = targetRow - curRow;
    const vertKey = rowDiff > 0 ? [0x1b, 0x5b, 0x42] : [0x1b, 0x5b, 0x41];
    for (let i = 0; i < Math.abs(rowDiff); i++) bytes.push(...vertKey);
    // Horizontal movement
    const colDiff = targetCol - curCol;
    const horizKey = colDiff > 0 ? [0x1b, 0x5b, 0x43] : [0x1b, 0x5b, 0x44];
    for (let i = 0; i < Math.abs(colDiff); i++) bytes.push(...horizKey);

    if (bytes.length > 0) {
      writeInput(sid, bytes).catch(console.error);
    }
  };

  const shortCwd = () => {
    const cwd = props.store.state.cwd;
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

  const m = () => metrics();
  const lineHeight = () => m()?.lineHeight ?? 20;
  const fontFamily = () => m()?.fontFamily ?? "monospace";
  const fontSize = () => m()?.fontSize ?? 14;
  const charWidth = () => m()?.charWidth ?? 8;

  return (
    <div
      ref={containerRef}
      class="terminal-container"
      classList={{ "terminal-hidden": !props.active }}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      style={{
        "font-family": fontFamily(),
        "font-size": `${fontSize()}px`,
        "line-height": `${lineHeight()}px`,
      }}
    >
      <Show when={props.store.state.altScreen}>
        <div class="alt-screen">
          <div class="terminal-content" style={{ position: "relative" }}>
            <For each={props.store.state.altScreenLines}>
              {(line) => <TerminalLine line={line} charWidth={charWidth()} />}
            </For>
            <Cursor
              cursor={props.store.state.cursor}
              charWidth={charWidth()}
              lineHeight={lineHeight()}
            />
          </div>
        </div>
      </Show>

      <Show when={!props.store.state.altScreen}>
        {/* Scrollable history: completed blocks + active output */}
        <div class="terminal-scroll" ref={scrollRef} onScroll={handleScroll}>
          <div class="terminal-history">
            <Show when={isEmpty()}>
              <WelcomeState />
            </Show>

            {/* Completed command blocks as cards */}
            <For each={props.store.state.snapshots}>
              {(snap) => (
                <CommandBlock
                  snapshot={snap}
                  charWidth={charWidth()}
                />
              )}
            </For>

            <Show when={!props.store.state.shellIntegrationActive && fallbackOutputLines().length > 0}>
              <div class="active-output">
                <For each={fallbackOutputLines()}>
                  {(line) => <TerminalLine line={line} charWidth={charWidth()} />}
                </For>
              </div>
            </Show>

            <Show when={activeSnapshot()}>
              {(snap) => (
                <CommandBlock
                  snapshot={snap()}
                  charWidth={charWidth()}
                />
              )}
            </Show>
          </div>
        </div>

        {/* Scroll-to-bottom FAB */}
        <button
          class="scroll-fab"
          classList={{ "scroll-fab-visible": isScrolledUp() }}
          onClick={scrollToBottom}
          title="Scroll to bottom"
        >
          <IconArrowDown size={16} />
        </button>

        {/* Input area at bottom as elevated card */}
        <div class="terminal-active">
          <div class="input-card">
            <div class="input-prompt-bar">
              <span class="input-prompt-icon"><IconFolder size={11} /></span>
              <span class="input-prompt-cwd">{shortCwd()}</span>
              <span class="input-prompt-dollar">$</span>
            </div>
            <div class="input-content" style={{ "max-height": `${Math.floor(containerHeight() * 0.3)}px` }} onClick={handleInputClick}>
              <div class="terminal-content" style={{ position: "relative" }}>
                <For each={inputLines()}>
                  {(line) => <TerminalLine line={line} charWidth={charWidth()} />}
                </For>
                <Cursor
                  cursor={inputCursor()}
                  charWidth={charWidth()}
                  lineHeight={lineHeight()}
                />
              </div>
            </div>
          </div>
        </div>
      </Show>

    </div>
  );
};
