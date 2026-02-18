import { Component, Show, createSignal, onCleanup } from "solid-js";
import type { PaneNode } from "../lib/types";
import type { TerminalStore } from "../stores/terminal";
import { Terminal } from "./Terminal";
import { CanvasTerminal } from "./CanvasTerminal";
import { useConfig } from "../stores/config";
import { canUseCanvasRenderer } from "../lib/canvasRenderer";

export interface PaneContainerProps {
  node: PaneNode;
  stores: Map<string, TerminalStore>;
  activePaneId: string;
  onPaneActivate: (paneId: string) => void;
  onOpenSettings?: () => void;
  onSplitRight?: (paneId: string) => void;
  onSplitDown?: (paneId: string) => void;
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
          onSplitRight={() => props.onSplitRight?.(props.node.id)}
          onSplitDown={() => props.onSplitDown?.(props.node.id)}
        />
      }
    >
      <PaneSplitView
        node={props.node as import("../lib/types").PaneSplit}
        stores={props.stores}
        activePaneId={props.activePaneId}
        onPaneActivate={props.onPaneActivate}
        onOpenSettings={props.onOpenSettings}
        onSplitRight={props.onSplitRight}
        onSplitDown={props.onSplitDown}
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
  onSplitRight?: () => void;
  onSplitDown?: () => void;
}> = (props) => {
  const { config } = useConfig();
  const useCanvasPreview = () =>
    config().renderer === "canvas" &&
    !props.isActive &&
    !!props.store?.state.altScreen &&
    canUseCanvasRenderer();

  return (
    <div
      class="pane-leaf"
      classList={{ "pane-leaf-active": props.isActive && props.isSplit }}
      role="group"
      aria-label={`Terminal pane${props.isActive ? " (active)" : ""}`}
      onMouseDown={() => props.onActivate()}
    >
      <Show when={props.store}>
        {(s) => (
          <Show
            when={useCanvasPreview()}
            fallback={
              <Terminal
                store={s()}
                active={true}
                onOpenSettings={props.onOpenSettings}
                onSplitRight={props.onSplitRight}
                onSplitDown={props.onSplitDown}
              />
            }
          >
            <CanvasTerminal store={s()} active={false} />
          </Show>
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
  onSplitRight?: (paneId: string) => void;
  onSplitDown?: (paneId: string) => void;
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
      return { width: `${r * 100}%`, height: "100%", display: "flex", position: "relative" as const };
    }
    return { width: "100%", height: `${r * 100}%`, display: "flex", position: "relative" as const };
  };

  const secondStyle = () => {
    const r = ratio();
    if (isHorizontal()) {
      return { width: `${(1 - r) * 100}%`, height: "100%", display: "flex", position: "relative" as const };
    }
    return { width: "100%", height: `${(1 - r) * 100}%`, display: "flex", position: "relative" as const };
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
          onSplitRight={props.onSplitRight}
          onSplitDown={props.onSplitDown}
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
        role="separator"
        aria-orientation={isHorizontal() ? "vertical" : "horizontal"}
        aria-label="Resize panes"
        tabIndex={0}
        onMouseDown={handleDividerMouseDown}
      />
      <div style={secondStyle()}>
        <PaneContainer
          node={props.node.second}
          stores={props.stores}
          activePaneId={props.activePaneId}
          onPaneActivate={props.onPaneActivate}
          onOpenSettings={props.onOpenSettings}
          onSplitRight={props.onSplitRight}
          onSplitDown={props.onSplitDown}
          isSplit={true}
        />
      </div>
    </div>
  );
};
