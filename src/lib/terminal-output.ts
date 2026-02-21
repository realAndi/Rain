import type { RenderedLine } from "./types";

function copyLine(line: RenderedLine, index: number): RenderedLine {
  return {
    index,
    spans: line.spans.map((sp) => ({ ...sp })),
  };
}

function isLineEmpty(line: RenderedLine): boolean {
  const text = line.spans.map((sp) => sp.text).join("");
  return text.trim() === "";
}

export function trimTrailingEmpty(lines: RenderedLine[]): RenderedLine[] {
  while (lines.length > 0 && isLineEmpty(lines[lines.length - 1])) {
    lines.pop();
  }
  return lines;
}

function bsearchScrollback(lines: RenderedLine[], targetIndex: number): RenderedLine | null {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const midIdx = lines[mid].index;
    if (midIdx === targetIndex) return lines[mid];
    if (midIdx < targetIndex) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

export function collectLinesForRange(
  scrollbackLines: RenderedLine[],
  visibleLinesByGlobal: Record<number, RenderedLine>,
  visibleBaseGlobal: number,
  startGlobal: number,
  endGlobalExclusive: number,
): RenderedLine[] {
  if (endGlobalExclusive <= startGlobal) return [];

  const result: RenderedLine[] = [];
  let outIndex = 0;

  for (let global = startGlobal; global < endGlobalExclusive; global++) {
    let line: RenderedLine | null = null;

    if (global < visibleBaseGlobal) {
      line = bsearchScrollback(scrollbackLines, global);
    } else {
      line = visibleLinesByGlobal[global] ?? null;
    }

    if (line) {
      result.push(copyLine(line, outIndex++));
    } else {
      result.push({ index: outIndex++, spans: [] });
    }
  }

  return result;
}
