import { Component, For, Show, createMemo } from "solid-js";
import type { RenderedLine, StyledSpan, SerializableColor, SearchMatch } from "../lib/types";
import type { SelectionRange } from "../lib/selection";
import { normalizeRange, isCellSelected } from "../lib/selection";
import { useTheme, THEME_ANSI_PALETTES } from "../stores/theme";
import { colorToCSS } from "../lib/color";

// URL detection regex
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;

export interface TerminalLineProps {
  line: RenderedLine;
  charWidth: number;
  selectionRange?: SelectionRange | null;
  searchMatches?: SearchMatch[];
  searchCurrentIndex?: number;
}

export const TerminalLine: Component<TerminalLineProps> = (props) => {
  return (
    <div class="term-line" data-row={props.line.index}>
      <For each={props.line.spans}>
        {(span, spanIdx) => {
          // Compute the column offset for this span
          const colOffset = () => {
            let offset = 0;
            for (let i = 0; i < spanIdx(); i++) {
              offset += props.line.spans[i].text.length;
            }
            return offset;
          };

          return (
            <SpanElement
              span={span}
              row={props.line.index}
              colOffset={colOffset()}
              selectionRange={props.selectionRange}
              searchMatches={props.searchMatches}
              searchCurrentIndex={props.searchCurrentIndex}
            />
          );
        }}
      </For>
    </div>
  );
};

interface SpanElementProps {
  span: StyledSpan;
  row: number;
  colOffset: number;
  selectionRange?: SelectionRange | null;
  searchMatches?: SearchMatch[];
  searchCurrentIndex?: number;
}

const SpanElement: Component<SpanElementProps> = (props) => {
  const { theme } = useTheme();
  const ansiPalette = createMemo(() => THEME_ANSI_PALETTES[theme()] ?? THEME_ANSI_PALETTES["dark"]);

  const style = () => {
    const s: Record<string, string> = { opacity: "1" };
    const fg = colorToCSS(props.span.fg, ansiPalette());
    const bg = colorToCSS(props.span.bg, ansiPalette());

    if (fg) s.color = fg;
    if (bg) s["background-color"] = bg;
    if (props.span.bold) s["font-weight"] = "bold";
    if (props.span.dim) {
      s.color = fg
        ? `color-mix(in srgb, ${fg} 62%, var(--bg))`
        : "var(--fg-muted)";
    }
    if (props.span.italic) s["font-style"] = "italic";

    const decorations: string[] = [];
    if (props.span.underline) decorations.push("underline");
    if (props.span.strikethrough) decorations.push("line-through");
    if (decorations.length > 0) {
      s["text-decoration"] = decorations.join(" ");
    }

    return s;
  };

  // Check if we have any selection or search highlighting to do
  const segments = createMemo(() => {
    const text = props.span.text;
    const row = props.row;
    const baseCol = props.colOffset;

    // Build highlight ranges for this span
    type Highlight = { start: number; end: number; type: "selection" | "search" | "search-current" };
    const highlights: Highlight[] = [];

    // Selection highlighting
    if (props.selectionRange) {
      const norm = normalizeRange(props.selectionRange);
      for (let i = 0; i < text.length; i++) {
        const col = baseCol + i;
        if (isCellSelected(norm, row, col)) {
          // Find the run of selected chars
          let end = i;
          while (end + 1 < text.length && isCellSelected(norm, row, baseCol + end + 1)) {
            end++;
          }
          highlights.push({ start: i, end, type: "selection" });
          i = end;
        }
      }
    }

    // Search match highlighting
    if (props.searchMatches && props.searchMatches.length > 0) {
      for (let mi = 0; mi < props.searchMatches.length; mi++) {
        const match = props.searchMatches[mi];
        if (match.globalRow !== row) continue;

        const spanStart = Math.max(0, match.startCol - baseCol);
        const spanEnd = Math.min(text.length - 1, match.endCol - baseCol);

        if (spanStart <= text.length - 1 && spanEnd >= 0 && spanStart <= spanEnd) {
          const isCurrent = mi === props.searchCurrentIndex;
          highlights.push({
            start: spanStart,
            end: spanEnd,
            type: isCurrent ? "search-current" : "search",
          });
        }
      }
    }

    if (highlights.length === 0) {
      return null; // No highlighting, render simple span
    }

    // Split text into segments with their highlight types
    type Segment = { text: string; highlights: Set<string> };
    const segs: Segment[] = [];
    let pos = 0;

    // Sort highlights by start position
    highlights.sort((a, b) => a.start - b.start);

    // Build breakpoints
    const breakpoints = new Set<number>();
    breakpoints.add(0);
    breakpoints.add(text.length);
    for (const h of highlights) {
      breakpoints.add(h.start);
      breakpoints.add(h.end + 1);
    }
    const sorted = Array.from(breakpoints).sort((a, b) => a - b);

    for (let i = 0; i < sorted.length - 1; i++) {
      const segStart = sorted[i];
      const segEnd = sorted[i + 1];
      if (segStart >= text.length) break;

      const segText = text.substring(segStart, Math.min(segEnd, text.length));
      if (!segText) continue;

      const activeHighlights = new Set<string>();
      for (const h of highlights) {
        if (h.start <= segStart && h.end >= segEnd - 1) {
          activeHighlights.add(h.type);
        }
      }
      segs.push({ text: segText, highlights: activeHighlights });
    }

    return segs;
  });

  // URL detection for clickable links
  const urls = createMemo(() => {
    if (props.span.url) return [{ start: 0, end: props.span.text.length, url: props.span.url }];

    const matches: Array<{ start: number; end: number; url: string }> = [];
    let match: RegExpExecArray | null;
    const regex = new RegExp(URL_REGEX.source, "g");
    while ((match = regex.exec(props.span.text)) !== null) {
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        url: match[0],
      });
    }
    return matches;
  });

  return (
    <Show when={segments()} fallback={
      <Show when={urls().length > 0} fallback={
        <span class="term-span" style={style()}>{props.span.text}</span>
      }>
        <UrlSpan text={props.span.text} urls={urls()} style={style()} />
      </Show>
    }>
      {(segs) => (
        <span class="term-span" style={style()}>
          <For each={segs()}>
            {(seg) => {
              let cls = "";
              if (seg.highlights.has("selection")) cls += " term-selected";
              if (seg.highlights.has("search")) cls += " term-search-match";
              if (seg.highlights.has("search-current")) cls += " term-search-current";

              if (cls) {
                return <span class={cls.trim()}>{seg.text}</span>;
              }
              return <>{seg.text}</>;
            }}
          </For>
        </span>
      )}
    </Show>
  );
};

// Renders text with clickable URL portions
const UrlSpan: Component<{
  text: string;
  urls: Array<{ start: number; end: number; url: string }>;
  style: Record<string, string>;
}> = (props) => {
  const parts = createMemo(() => {
    const result: Array<{ text: string; url?: string }> = [];
    let pos = 0;
    for (const u of props.urls) {
      if (u.start > pos) {
        result.push({ text: props.text.substring(pos, u.start) });
      }
      result.push({ text: props.text.substring(u.start, u.end), url: u.url });
      pos = u.end;
    }
    if (pos < props.text.length) {
      result.push({ text: props.text.substring(pos) });
    }
    return result;
  });

  const handleUrlClick = (url: string, e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      // Open URL using window.open as fallback (Tauri intercepts and opens in system browser)
      window.open(url, "_blank");
    }
  };

  return (
    <span class="term-span" style={props.style}>
      <For each={parts()}>
        {(part) => (
          <Show when={part.url} fallback={<>{part.text}</>}>
            <span
              class="term-url"
              title={`${part.url} (Cmd+Click to open)`}
              onClick={(e) => handleUrlClick(part.url!, e)}
            >
              {part.text}
            </span>
          </Show>
        )}
      </For>
    </span>
  );
};

