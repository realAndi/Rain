import { Component, createSignal, onMount, onCleanup } from "solid-js";

export const Scrollbar: Component<{
  totalHeight: number;
  viewportHeight: number;
  scrollTop: number;
  onScroll: (scrollTop: number) => void;
}> = (props) => {
  let trackRef!: HTMLDivElement;
  const [dragging, setDragging] = createSignal(false);
  const [dragStartY, setDragStartY] = createSignal(0);
  const [dragStartScroll, setDragStartScroll] = createSignal(0);

  const thumbHeight = () => {
    if (props.totalHeight <= 0) return 0;
    const ratio = props.viewportHeight / props.totalHeight;
    return Math.max(30, ratio * props.viewportHeight);
  };

  const thumbTop = () => {
    if (props.totalHeight <= props.viewportHeight) return 0;
    const scrollRange = props.totalHeight - props.viewportHeight;
    const ratio = props.scrollTop / scrollRange;
    return ratio * (props.viewportHeight - thumbHeight());
  };

  const handleMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    setDragStartY(e.clientY);
    setDragStartScroll(props.scrollTop);
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!dragging()) return;
    const delta = e.clientY - dragStartY();
    const scrollRange = props.totalHeight - props.viewportHeight;
    const trackRange = props.viewportHeight - thumbHeight();
    if (trackRange <= 0) return;
    const scrollDelta = (delta / trackRange) * scrollRange;
    const newScroll = Math.max(0, Math.min(scrollRange, dragStartScroll() + scrollDelta));
    props.onScroll(newScroll);
  };

  const handleMouseUp = () => {
    setDragging(false);
  };

  onMount(() => {
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  });

  onCleanup(() => {
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", handleMouseUp);
  });

  return (
    <div class="scrollbar-track" ref={trackRef}>
      <div
        class="scrollbar-thumb"
        style={{
          height: `${thumbHeight()}px`,
          transform: `translateY(${thumbTop()}px)`,
        }}
        onMouseDown={handleMouseDown}
      />
    </div>
  );
};
