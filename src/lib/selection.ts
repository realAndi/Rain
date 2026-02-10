// Text selection model for the terminal.
// Tracks selection state and converts to copyable text.

export interface SelectionPoint {
  row: number;
  col: number;
}

export interface SelectionRange {
  start: SelectionPoint;
  end: SelectionPoint;
}

export interface SelectionState {
  active: boolean;
  range: SelectionRange | null;
  selecting: boolean; // currently dragging
}

export function createSelectionState(): SelectionState {
  return {
    active: false,
    range: null,
    selecting: false,
  };
}

/**
 * Normalize a selection range so start is always before end.
 */
export function normalizeRange(range: SelectionRange): SelectionRange {
  const { start, end } = range;
  if (start.row < end.row || (start.row === end.row && start.col <= end.col)) {
    return range;
  }
  return { start: end, end: start };
}

/**
 * Check if a cell at (row, col) is within the selection range.
 */
export function isCellSelected(range: SelectionRange | null, row: number, col: number): boolean {
  if (!range) return false;

  const { start, end } = normalizeRange(range);

  if (row < start.row || row > end.row) return false;
  if (row === start.row && row === end.row) {
    return col >= start.col && col <= end.col;
  }
  if (row === start.row) return col >= start.col;
  if (row === end.row) return col <= end.col;
  return true;
}

/**
 * Extract selected text from terminal lines.
 * Lines are joined with newlines. Trailing whitespace on each line is trimmed.
 */
export function extractSelectedText(
  lines: Array<{ index: number; spans: Array<{ text: string }> }>,
  range: SelectionRange,
): string {
  const normalized = normalizeRange(range);
  const result: string[] = [];

  for (const line of lines) {
    if (line.index < normalized.start.row || line.index > normalized.end.row) {
      continue;
    }

    // Build the full line text from spans
    let fullText = "";
    for (const span of line.spans) {
      fullText += span.text;
    }

    if (line.index === normalized.start.row && line.index === normalized.end.row) {
      result.push(fullText.substring(normalized.start.col, normalized.end.col + 1));
    } else if (line.index === normalized.start.row) {
      result.push(fullText.substring(normalized.start.col));
    } else if (line.index === normalized.end.row) {
      result.push(fullText.substring(0, normalized.end.col + 1));
    } else {
      result.push(fullText);
    }
  }

  return result.map((l) => l.trimEnd()).join("\n");
}
