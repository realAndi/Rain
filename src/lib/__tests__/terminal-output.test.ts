import { describe, it, expect } from "vitest";
import { trimTrailingEmpty, collectLinesForRange } from "../terminal-output";
import type { RenderedLine } from "../types";

function line(text: string, index = 0): RenderedLine {
  return { index, spans: [{ text, fg: { type: "Default" }, bg: { type: "Default" }, bold: false, dim: false, italic: false, underline: false, strikethrough: false }] };
}

function emptyLine(index = 0): RenderedLine {
  return { index, spans: [{ text: "   ", fg: { type: "Default" }, bg: { type: "Default" }, bold: false, dim: false, italic: false, underline: false, strikethrough: false }] };
}

describe("trimTrailingEmpty", () => {
  it("removes trailing whitespace-only lines", () => {
    const lines = [line("foo", 0), emptyLine(1), emptyLine(2)];
    const result = trimTrailingEmpty(lines);
    expect(result).toHaveLength(1);
    expect(result[0].spans[0].text).toBe("foo");
  });

  it("returns empty array when all lines are empty", () => {
    const lines = [emptyLine(0), emptyLine(1)];
    expect(trimTrailingEmpty(lines)).toHaveLength(0);
  });

  it("handles already-empty array", () => {
    expect(trimTrailingEmpty([])).toHaveLength(0);
  });

  it("keeps non-empty trailing lines", () => {
    const lines = [line("first", 0), line("second", 1)];
    const result = trimTrailingEmpty(lines);
    expect(result).toHaveLength(2);
  });

  it("mutates the input array in-place", () => {
    const lines = [line("keep", 0), emptyLine(1)];
    const result = trimTrailingEmpty(lines);
    expect(result).toBe(lines);
    expect(lines).toHaveLength(1);
  });

  it("preserves non-trailing empty lines", () => {
    const lines = [emptyLine(0), line("middle", 1), emptyLine(2)];
    const result = trimTrailingEmpty(lines);
    expect(result).toHaveLength(2);
    expect(result[0].spans[0].text).toBe("   ");
    expect(result[1].spans[0].text).toBe("middle");
  });
});

describe("collectLinesForRange", () => {
  const scrollback: RenderedLine[] = [
    line("scroll-0", 0),
    line("scroll-1", 1),
    line("scroll-2", 2),
    line("scroll-3", 3),
    line("scroll-4", 4),
  ];

  const visibleMap: Record<number, RenderedLine> = {
    5: line("visible-5", 0),
    6: line("visible-6", 1),
    7: line("visible-7", 2),
  };

  const visibleBase = 5;

  it("returns empty for reversed range", () => {
    expect(collectLinesForRange(scrollback, visibleMap, visibleBase, 5, 3)).toEqual([]);
  });

  it("returns empty for equal start and end", () => {
    expect(collectLinesForRange(scrollback, visibleMap, visibleBase, 3, 3)).toEqual([]);
  });

  it("collects from scrollback only", () => {
    const result = collectLinesForRange(scrollback, visibleMap, visibleBase, 1, 4);
    expect(result).toHaveLength(3);
    expect(result[0].spans[0].text).toBe("scroll-1");
    expect(result[1].spans[0].text).toBe("scroll-2");
    expect(result[2].spans[0].text).toBe("scroll-3");
  });

  it("collects from visible only", () => {
    const result = collectLinesForRange(scrollback, visibleMap, visibleBase, 5, 8);
    expect(result).toHaveLength(3);
    expect(result[0].spans[0].text).toBe("visible-5");
    expect(result[1].spans[0].text).toBe("visible-6");
    expect(result[2].spans[0].text).toBe("visible-7");
  });

  it("spans the scrollback/visible boundary", () => {
    const result = collectLinesForRange(scrollback, visibleMap, visibleBase, 3, 7);
    expect(result).toHaveLength(4);
    expect(result[0].spans[0].text).toBe("scroll-3");
    expect(result[1].spans[0].text).toBe("scroll-4");
    expect(result[2].spans[0].text).toBe("visible-5");
    expect(result[3].spans[0].text).toBe("visible-6");
  });

  it("re-indexes output lines from 0", () => {
    const result = collectLinesForRange(scrollback, visibleMap, visibleBase, 3, 7);
    expect(result[0].index).toBe(0);
    expect(result[1].index).toBe(1);
    expect(result[2].index).toBe(2);
    expect(result[3].index).toBe(3);
  });

  it("fills gaps with empty spans when lines are missing", () => {
    const sparseVisible: Record<number, RenderedLine> = {
      10: line("found", 0),
    };
    const result = collectLinesForRange([], sparseVisible, 8, 8, 12);
    expect(result).toHaveLength(4);
    expect(result[0].spans).toEqual([]);
    expect(result[1].spans).toEqual([]);
    expect(result[2].spans[0].text).toBe("found");
    expect(result[3].spans).toEqual([]);
  });

  it("produces deep copies (does not alias input)", () => {
    const result = collectLinesForRange(scrollback, visibleMap, visibleBase, 0, 1);
    result[0].spans[0].text = "mutated";
    expect(scrollback[0].spans[0].text).toBe("scroll-0");
  });
});
