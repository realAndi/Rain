import { Component, Show, createSignal, onCleanup } from "solid-js";
import type { PaneNode } from "../lib/types";
import type { TerminalStore } from "../stores/terminal";
import { Terminal } from "./Terminal";

export interface PaneContainerProps {
  node: PaneNode;
  stores: Map<string, TerminalStore>;
  activePaneId: string;
  onPaneActivate: (paneId: string) => void;
  onOpenSettings?: () => void;
  /** True when this container is inside a split (has sibling panes) */
  isSplit?: boolean;
}

export const PaneContainer: Component<PaneContainerProps> = (props) => {
  return (
    <Show
      when={props.node.type === "split"}
      fallback={
        <PaneLeafView
          node={props.node as import("../lib/types").PaneLeaf}
          store={props.stores.get(props.node.id)}
          isActive={props.activePaneId === props.node.id}
          isSplit={!!props.isSplit}
          onActivate={() => props.onPaneActivate(props.node.id)}
          onOpenSettings={props.onOpenSettings}
        />
      }
    >
      <PaneSplitView
        node={props.node as import("../lib/types").PaneSplit}
        stores={props.stores}
        activePaneId={props.activePaneId}
        onPaneActivate={props.onPaneActivate}
        onOpenSettings={props.onOpenSettings}
      />
    </Show>
  );
};

const PaneLeafView: Component<{
  node: import("../lib/types").PaneLeaf;
  store: TerminalStore | undefined;
  isActive: boolean;
  isSplit: boolean;
  onActivate: () => void;
  onOpenSettings?: () => void;
}> = (props) => {
  return (
    <div
      class="pane-leaf"
      classList={{ "pane-leaf-active": props.isActive && props.isSplit }}
      onMouseDown={() => props.onActivate()}
    >
      <Show when={props.store}>
        {(s) => (
          <Terminal
            store={s()}
            active={props.isActive}
            onOpenSettings={props.onOpenSettings}
          />
        )}
      </Show>
    </div>
  );
};

const PaneSplitView: Component<{
  node: import("../lib/types").PaneSplit;
  stores: Map<string, TerminalStore>;
  activePaneId: string;
  onPaneActivate: (paneId: string) => void;
  onOpenSettings?: () => void;
}> = (props) => {
  const [ratio, setRatio] = createSignal(props.node.ratio);
  const [dragging, setDragging] = createSignal(false);
  let containerRef!: HTMLDivElement;

  const isHorizontal = () => props.node.direction === "horizontal";

  const handleDividerMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    setDragging(true);

    const startPos = isHorizontal() ? e.clientX : e.clientY;
    const startRatio = ratio();

    const onMove = (moveEvent: MouseEvent) => {
      const rect = containerRef.getBoundingClientRect();
      const totalSize = isHorizontal() ? rect.width : rect.height;
      const currentPos = isHorizontal() ? moveEvent.clientX : moveEvent.clientY;
      const delta = (currentPos - startPos) / totalSize;
      const newRatio = Math.max(0.1, Math.min(0.9, startRatio + delta));
      setRatio(newRatio);
      // Update the node ratio (mutating is fine since it's not in solid store)
      props.node.ratio = newRatio;
    };

    const onUp = () => {
      setDragging(false);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const firstStyle = () => {
    const r = ratio();
    if (isHorizontal()) {
      return { width: `${r * 100}%`, height: "100%" };
    }
    return { width: "100%", height: `${r * 100}%` };
  };

  const secondStyle = () => {
    const r = ratio();
    if (isHorizontal()) {
      return { width: `${(1 - r) * 100}%`, height: "100%" };
    }
    return { width: "100%", height: `${(1 - r) * 100}%` };
  };

  return (
    <div
      ref={containerRef}
      class="pane-container"
      classList={{
        "pane-container-horizontal": isHorizontal(),
        "pane-container-vertical": !isHorizontal(),
      }}
    >
      <div style={firstStyle()}>
        <PaneContainer
          node={props.node.first}
          stores={props.stores}
          activePaneId={props.activePaneId}
          onPaneActivate={props.onPaneActivate}
          onOpenSettings={props.onOpenSettings}
          isSplit={true}
        />
      </div>
      <div
        class="pane-divider"
        classList={{
          "pane-divider-horizontal": isHorizontal(),
          "pane-divider-vertical": !isHorizontal(),
          "pane-divider-dragging": dragging(),
        }}
        onMouseDown={handleDividerMouseDown}
      />
      <div style={secondStyle()}>
        <PaneContainer
          node={props.node.second}
          stores={props.stores}
          activePaneId={props.activePaneId}
          onPaneActivate={props.onPaneActivate}
          onOpenSettings={props.onOpenSettings}
          isSplit={true}
        />
      </div>
    </div>
  );
};
