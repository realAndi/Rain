import { describe, it, expect } from "vitest";
import {
  createSelectionState,
  normalizeRange,
  isCellSelected,
  extractSelectedText,
  type SelectionRange,
} from "../selection";

describe("createSelectionState", () => {
  it("returns initial state", () => {
    const state = createSelectionState();
    expect(state.active).toBe(false);
    expect(state.range).toBeNull();
    expect(state.selecting).toBe(false);
  });
});

describe("normalizeRange", () => {
  it("keeps range as-is when start is before end", () => {
    const range: SelectionRange = {
      start: { row: 0, col: 0 },
      end: { row: 1, col: 5 },
    };
    const normalized = normalizeRange(range);
    expect(normalized.start).toEqual({ row: 0, col: 0 });
    expect(normalized.end).toEqual({ row: 1, col: 5 });
  });

  it("swaps start and end when reversed", () => {
    const range: SelectionRange = {
      start: { row: 3, col: 10 },
      end: { row: 1, col: 5 },
    };
    const normalized = normalizeRange(range);
    expect(normalized.start).toEqual({ row: 1, col: 5 });
    expect(normalized.end).toEqual({ row: 3, col: 10 });
  });

  it("swaps when on same row with reversed columns", () => {
    const range: SelectionRange = {
      start: { row: 2, col: 10 },
      end: { row: 2, col: 3 },
    };
    const normalized = normalizeRange(range);
    expect(normalized.start).toEqual({ row: 2, col: 3 });
    expect(normalized.end).toEqual({ row: 2, col: 10 });
  });

  it("keeps same-cell range as-is", () => {
    const range: SelectionRange = {
      start: { row: 1, col: 5 },
      end: { row: 1, col: 5 },
    };
    const normalized = normalizeRange(range);
    expect(normalized.start).toEqual({ row: 1, col: 5 });
  });
});

describe("isCellSelected", () => {
  it("returns false for null range", () => {
    expect(isCellSelected(null, 0, 0)).toBe(false);
  });

  it("selects cells within single-row range", () => {
    const range: SelectionRange = {
      start: { row: 2, col: 3 },
      end: { row: 2, col: 7 },
    };
    expect(isCellSelected(range, 2, 3)).toBe(true);
    expect(isCellSelected(range, 2, 5)).toBe(true);
    expect(isCellSelected(range, 2, 7)).toBe(true);
    expect(isCellSelected(range, 2, 2)).toBe(false);
    expect(isCellSelected(range, 2, 8)).toBe(false);
    expect(isCellSelected(range, 1, 5)).toBe(false);
  });

  it("selects cells across multiple rows", () => {
    const range: SelectionRange = {
      start: { row: 1, col: 5 },
      end: { row: 3, col: 10 },
    };
    expect(isCellSelected(range, 1, 5)).toBe(true);
    expect(isCellSelected(range, 1, 80)).toBe(true);
    expect(isCellSelected(range, 1, 4)).toBe(false);
    expect(isCellSelected(range, 2, 0)).toBe(true);
    expect(isCellSelected(range, 2, 50)).toBe(true);
    expect(isCellSelected(range, 3, 0)).toBe(true);
    expect(isCellSelected(range, 3, 10)).toBe(true);
    expect(isCellSelected(range, 3, 11)).toBe(false);
    expect(isCellSelected(range, 0, 0)).toBe(false);
    expect(isCellSelected(range, 4, 0)).toBe(false);
  });

  it("handles reversed range (normalizes internally)", () => {
    const range: SelectionRange = {
      start: { row: 3, col: 10 },
      end: { row: 1, col: 5 },
    };
    expect(isCellSelected(range, 2, 5)).toBe(true);
  });
});

describe("extractSelectedText", () => {
  const lines = [
    { index: 0, spans: [{ text: "Hello World" }] },
    { index: 1, spans: [{ text: "Line two  " }] },
    { index: 2, spans: [{ text: "Line three" }] },
  ];

  it("extracts single-row selection", () => {
    const range: SelectionRange = {
      start: { row: 0, col: 0 },
      end: { row: 0, col: 4 },
    };
    expect(extractSelectedText(lines, range)).toBe("Hello");
  });

  it("extracts multi-row selection", () => {
    const range: SelectionRange = {
      start: { row: 0, col: 6 },
      end: { row: 1, col: 3 },
    };
    expect(extractSelectedText(lines, range)).toBe("World\nLine");
  });

  it("trims trailing whitespace from each line", () => {
    const range: SelectionRange = {
      start: { row: 1, col: 0 },
      end: { row: 1, col: 9 },
    };
    expect(extractSelectedText(lines, range)).toBe("Line two");
  });

  it("extracts full multi-line selection", () => {
    const range: SelectionRange = {
      start: { row: 0, col: 0 },
      end: { row: 2, col: 9 },
    };
    const result = extractSelectedText(lines, range);
    expect(result).toBe("Hello World\nLine two\nLine three");
  });
});
