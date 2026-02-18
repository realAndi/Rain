import { Component, Show, onCleanup } from "solid-js";

export interface ContextMenuProps {
  x: number;
  y: number;
  onCopy: () => void;
  onPaste: () => void;
  onClear: () => void;
  onSelectAll: () => void;
  onExport?: () => void;
  onClose: () => void;
  hasSelection: boolean;
  selectedText?: string;
  linkUrl?: string;
  onSearchSelection?: () => void;
  onOpenLink?: () => void;
  onSplitRight?: () => void;
  onSplitDown?: () => void;
}

export const ContextMenu: Component<ContextMenuProps> = (props) => {
  const isMac = navigator.platform.toUpperCase().includes("MAC");
  const mod = isMac ? "\u2318" : "Ctrl+";

  // Close on any click outside or Escape
  function handleClickOutside() {
    props.onClose();
  }
  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    }
  }

  document.addEventListener("mousedown", handleClickOutside);
  document.addEventListener("keydown", handleKeyDown);
  onCleanup(() => {
    document.removeEventListener("mousedown", handleClickOutside);
    document.removeEventListener("keydown", handleKeyDown);
  });

  return (
    <div
      class="context-menu"
      role="menu"
      aria-label="Terminal context menu"
      style={{ position: "fixed", left: `${props.x}px`, top: `${props.y}px` }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button class="context-menu-item" role="menuitem" disabled={!props.hasSelection} onClick={props.onCopy}>
        Copy
        <span class="context-menu-shortcut">{mod}C</span>
      </button>
      <button class="context-menu-item" role="menuitem" onClick={props.onPaste}>
        Paste
        <span class="context-menu-shortcut">{mod}V</span>
      </button>
      <button class="context-menu-item" role="menuitem" onClick={props.onSelectAll}>
        Select All
        <span class="context-menu-shortcut">{mod}A</span>
      </button>
      <Show when={props.selectedText}>
        <div class="context-menu-separator" />
        <button class="context-menu-item" role="menuitem" onClick={props.onSearchSelection}>
          Search Selection
        </button>
      </Show>
      <Show when={props.linkUrl}>
        <div class="context-menu-separator" />
        <button class="context-menu-item" role="menuitem" onClick={props.onOpenLink}>
          Open Link
        </button>
        <button
          class="context-menu-item"
          role="menuitem"
          onClick={() => {
            if (props.linkUrl) navigator.clipboard.writeText(props.linkUrl).catch(console.error);
            props.onClose();
          }}
        >
          Copy Link
        </button>
      </Show>
      <div class="context-menu-separator" />
      <button class="context-menu-item" role="menuitem" onClick={props.onSplitRight}>
        Split Pane Right
      </button>
      <button class="context-menu-item" role="menuitem" onClick={props.onSplitDown}>
        Split Pane Down
      </button>
      <div class="context-menu-separator" />
      <button class="context-menu-item" role="menuitem" onClick={props.onClear}>
        Clear
        <span class="context-menu-shortcut">{mod}K</span>
      </button>
      <Show when={props.onExport}>
        <button class="context-menu-item" role="menuitem" onClick={props.onExport!}>
          Export
          <span class="context-menu-shortcut">{mod}S</span>
        </button>
      </Show>
    </div>
  );
};
