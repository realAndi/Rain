import { Component, For, Show, createSignal, createMemo } from "solid-js";
import type { CommandSnapshot } from "../lib/types";

export const HistoryBrowser: Component<{
  snapshots: CommandSnapshot[];
  onClose: () => void;
  onRerun: (command: string) => void;
}> = (props) => {
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);

  const filtered = createMemo(() => {
    const q = query().toLowerCase().trim();
    const all = props.snapshots.filter((s) => s.command && s.command.trim());
    if (!q) return all.slice().reverse(); // Most recent first
    return all.filter((s) => s.command.toLowerCase().includes(q)).reverse();
  });

  const handleKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        props.onClose();
        break;
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered().length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        const item = filtered()[selectedIndex()];
        if (item) {
          props.onClose();
          props.onRerun(item.command);
        }
        break;
    }
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div class="palette-overlay" onClick={(e) => {
      if ((e.target as HTMLElement).classList.contains("palette-overlay")) props.onClose();
    }}>
      <div class="palette-container">
        <input
          type="text"
          class="palette-input"
          placeholder="Search command history..."
          value={query()}
          onInput={(e) => { setQuery(e.currentTarget.value); setSelectedIndex(0); }}
          onKeyDown={handleKeyDown}
          ref={(el) => requestAnimationFrame(() => el.focus())}
        />
        <div class="palette-results">
          <Show when={filtered().length > 0} fallback={
            <div class="palette-no-results">No matching commands</div>
          }>
            <For each={filtered()}>
              {(snap, index) => (
                <button
                  class="palette-item"
                  classList={{ "palette-item-selected": index() === selectedIndex() }}
                  onClick={() => {
                    props.onClose();
                    props.onRerun(snap.command);
                  }}
                  onMouseEnter={() => setSelectedIndex(index())}
                >
                  <div class="history-item-content">
                    <span class="history-item-cmd">$ {snap.command}</span>
                    <span class="history-item-meta">
                      {snap.cwd ? snap.cwd.split("/").pop() : ""} · {formatTime(snap.timestamp)}
                      {snap.failed ? " · failed" : ""}
                    </span>
                  </div>
                </button>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
};
