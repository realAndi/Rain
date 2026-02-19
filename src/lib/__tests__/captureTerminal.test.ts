import { describe, it, expect, vi } from "vitest";
import type { RenderedLine, CommandSnapshot } from "../types";

vi.mock("../ipc", () => ({
  saveTextToFile: vi.fn(),
}));

import {
  linesToPlainText,
  snapshotToText,
  snapshotsToText,
  visibleLinesToText,
} from "../captureTerminal";

function line(text: string, index = 0): RenderedLine {
  return { index, spans: [{ text, fg: { type: "Default" }, bg: { type: "Default" }, bold: false, dim: false, italic: false, underline: false, strikethrough: false }] };
}

function multiSpanLine(texts: string[], index = 0): RenderedLine {
  return {
    index,
    spans: texts.map((text) => ({ text, fg: { type: "Default" } as const, bg: { type: "Default" } as const, bold: false, dim: false, italic: false, underline: false, strikethrough: false })),
  };
}

describe("linesToPlainText", () => {
  it("joins single-span lines with newlines", () => {
    const lines = [line("hello", 0), line("world", 1)];
    expect(linesToPlainText(lines)).toBe("hello\nworld");
  });

  it("concatenates multiple spans within a line", () => {
    const lines = [multiSpanLine(["foo", "bar"], 0)];
    expect(linesToPlainText(lines)).toBe("foobar");
  });

  it("handles empty lines", () => {
    const lines = [line("a", 0), line("", 1), line("b", 2)];
    expect(linesToPlainText(lines)).toBe("a\n\nb");
  });

  it("handles empty array", () => {
    expect(linesToPlainText([])).toBe("");
  });
});

describe("snapshotToText", () => {
  it("formats snapshot with command", () => {
    const snapshot: CommandSnapshot = {
      id: "1",
      command: "ls -la",
      lines: [line("file.txt", 0)],
      timestamp: new Date("2025-01-15T12:00:00Z").getTime(),
      endTime: null,
      cwd: "/home/user",
      failed: false,
    };
    const result = snapshotToText(snapshot);
    expect(result).toContain("$ ls -la");
    expect(result).toContain("cwd: /home/user");
    expect(result).toContain("file.txt");
  });

  it("shows (no command) when command is empty", () => {
    const snapshot: CommandSnapshot = {
      id: "2",
      command: "",
      lines: [],
      timestamp: Date.now(),
      endTime: null,
      cwd: "/tmp",
      failed: false,
    };
    const result = snapshotToText(snapshot);
    expect(result).toContain("(no command)");
  });
});

describe("snapshotsToText", () => {
  it("joins multiple snapshots with separator", () => {
    const snapshots: CommandSnapshot[] = [
      { id: "1", command: "echo a", lines: [line("a", 0)], timestamp: Date.now(), endTime: null, cwd: "/", failed: false },
      { id: "2", command: "echo b", lines: [line("b", 0)], timestamp: Date.now(), endTime: null, cwd: "/", failed: false },
    ];
    const result = snapshotsToText(snapshots);
    expect(result).toContain("---");
    expect(result).toContain("$ echo a");
    expect(result).toContain("$ echo b");
  });

  it("handles empty array", () => {
    expect(snapshotsToText([])).toBe("");
  });
});

describe("visibleLinesToText", () => {
  it("extracts visible lines in order", () => {
    const visible: Record<number, RenderedLine> = {
      10: line("line-10", 0),
      11: line("line-11", 1),
      12: line("line-12", 2),
    };
    const result = visibleLinesToText(visible, 10, 3);
    expect(result).toBe("line-10\nline-11\nline-12");
  });

  it("fills missing lines with empty strings", () => {
    const visible: Record<number, RenderedLine> = {
      5: line("present", 0),
    };
    const result = visibleLinesToText(visible, 5, 3);
    expect(result).toBe("present\n\n");
  });

  it("handles zero rows", () => {
    expect(visibleLinesToText({}, 0, 0)).toBe("");
  });
});
