import { Component, For, Show } from "solid-js";
import type { CommandSnapshot, TimeGroupData } from "../lib/types";
import { TerminalLine } from "./TerminalLine";

export function groupSnapshotsByTime(snapshots: CommandSnapshot[]): TimeGroupData[] {
  if (snapshots.length === 0) return [];

  const groups: TimeGroupData[] = [];
  let current: TimeGroupData = {
    timestamp: snapshots[0].timestamp,
    snapshots: [snapshots[0]],
  };

  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const snap = snapshots[i];
    const gap = snap.timestamp - prev.timestamp;

    if (gap > 60_000) {
      groups.push(current);
      current = { timestamp: snap.timestamp, snapshots: [snap] };
    } else {
      current.snapshots.push(snap);
    }
  }

  groups.push(current);
  return groups;
}

export const SnapshotBlock: Component<{
  snapshot: CommandSnapshot;
  charWidth: number;
  showSeparator: boolean;
}> = (props) => {
  return (
    <div class="snapshot-block">
      <Show when={props.showSeparator}>
        <div class="snapshot-separator" />
      </Show>
      <div class="snapshot-output">
        <For each={props.snapshot.lines}>
          {(line) => <TerminalLine line={line} charWidth={props.charWidth} />}
        </For>
      </div>
    </div>
  );
};

export const TimeGroup: Component<{
  group: TimeGroupData;
  charWidth: number;
  isFirst: boolean;
}> = (props) => {
  return (
    <div class="time-group" classList={{ "time-group-spaced": !props.isFirst }}>
      <Show when={!props.isFirst}>
        <div class="time-group-divider">
          <span class="time-group-divider-line" />
          <span class="time-group-divider-label">
            {new Date(props.group.timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          <span class="time-group-divider-line" />
        </div>
      </Show>
      <For each={props.group.snapshots}>
        {(snap, index) => (
          <SnapshotBlock
            snapshot={snap}
            charWidth={props.charWidth}
            showSeparator={index() > 0 || (index() === 0 && props.isFirst && props.group.snapshots.length > 0)}
          />
        )}
      </For>
    </div>
  );
};
