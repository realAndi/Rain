import { Component, For, Show, createSignal, createMemo, onMount } from "solid-js";

export interface PaletteAction {
  id: string;
  label: string;
  shortcut?: string;
  category?: string;
  action: () => void;
}

export const CommandPalette: Component<{
  actions: PaletteAction[];
  onClose: () => void;
}> = (props) => {
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  let inputRef!: HTMLInputElement;

  onMount(() => {
    inputRef?.focus();
  });

  const filtered = createMemo(() => {
    const q = query().toLowerCase().trim();
    if (!q) return props.actions;
    return props.actions.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        (a.category?.toLowerCase().includes(q) ?? false),
    );
  });

  createMemo(() => {
    filtered();
    setSelectedIndex(0);
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
      case "Enter": {
        e.preventDefault();
        const item = filtered()[selectedIndex()];
        if (item) {
          props.onClose();
          item.action();
        }
        break;
      }
    }
  };

  const handleBackdropClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).classList.contains("palette-overlay")) {
      props.onClose();
    }
  };

  return (
    <div class="palette-overlay" onClick={handleBackdropClick}>
      <div class="palette-container">
        <div class="palette-input-wrap">
          <span class="palette-search-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </span>
          <input
            ref={inputRef}
            type="text"
            class="palette-input"
            placeholder="Type a command..."
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div class="palette-results">
          <Show
            when={filtered().length > 0}
            fallback={<div class="palette-no-results">No matching commands</div>}
          >
            <For each={filtered()}>
              {(action, index) => (
                <button
                  class={`palette-item ${index() === selectedIndex() ? "palette-item-selected" : ""}`}
                  onClick={() => {
                    props.onClose();
                    action.action();
                  }}
                  onMouseEnter={() => setSelectedIndex(index())}
                >
                  <div class="palette-item-content">
                    <span class="palette-item-label">{action.label}</span>
                  </div>
                  <Show when={action.shortcut}>
                    <span class="palette-item-shortcut">{action.shortcut}</span>
                  </Show>
                </button>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
};
