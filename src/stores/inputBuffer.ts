import { createSignal } from "solid-js";

const HISTORY_KEY = "rain-history";
const MAX_HISTORY = 500;

export interface InputBufferState {
  text: string;
  cursorPos: number;
  selectionStart: number | null;
  selectionEnd: number | null;
}

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.slice(-MAX_HISTORY);
  } catch {
    // ignore
  }
  return [];
}

function saveHistory(history: string[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-MAX_HISTORY)));
  } catch {
    // ignore
  }
}

export function createInputBuffer() {
  const [state, setState] = createSignal<InputBufferState>({
    text: "",
    cursorPos: 0,
    selectionStart: null,
    selectionEnd: null,
  });

  const [suggestion, setSuggestion] = createSignal<string | null>(null);
  const [allSuggestions, setAllSuggestions] = createSignal<string[]>([]);
  const [suggestionIndex, setSuggestionIndex] = createSignal(0);

  let history: string[] = loadHistory();
  let historyIndex = -1;
  let historyDraft = "";

  function hasSelection(): boolean {
    const s = state();
    return s.selectionStart !== null && s.selectionEnd !== null && s.selectionStart !== s.selectionEnd;
  }

  function selectionRange(): [number, number] | null {
    const s = state();
    if (s.selectionStart === null || s.selectionEnd === null) return null;
    const start = Math.min(s.selectionStart, s.selectionEnd);
    const end = Math.max(s.selectionStart, s.selectionEnd);
    if (start === end) return null;
    return [start, end];
  }

  function update(partial: Partial<InputBufferState>) {
    setState((prev) => ({ ...prev, ...partial }));
  }

  function insert(chars: string) {
    const s = state();
    const range = selectionRange();
    if (range) {
      const [start, end] = range;
      const newText = s.text.slice(0, start) + chars + s.text.slice(end);
      const newPos = start + chars.length;
      update({ text: newText, cursorPos: newPos, selectionStart: null, selectionEnd: null });
    } else {
      const newText = s.text.slice(0, s.cursorPos) + chars + s.text.slice(s.cursorPos);
      update({ text: newText, cursorPos: s.cursorPos + chars.length, selectionStart: null, selectionEnd: null });
    }
    resetHistory();
  }

  function deleteSelection(): boolean {
    const range = selectionRange();
    if (!range) return false;
    const [start, end] = range;
    const s = state();
    update({
      text: s.text.slice(0, start) + s.text.slice(end),
      cursorPos: start,
      selectionStart: null,
      selectionEnd: null,
    });
    resetHistory();
    return true;
  }

  function backspace() {
    if (deleteSelection()) return;
    const s = state();
    if (s.cursorPos <= 0) return;
    update({
      text: s.text.slice(0, s.cursorPos - 1) + s.text.slice(s.cursorPos),
      cursorPos: s.cursorPos - 1,
    });
    resetHistory();
  }

  function deleteForward() {
    if (deleteSelection()) return;
    const s = state();
    if (s.cursorPos >= s.text.length) return;
    update({
      text: s.text.slice(0, s.cursorPos) + s.text.slice(s.cursorPos + 1),
    });
    resetHistory();
  }

  function moveCursor(pos: number) {
    const s = state();
    const clamped = Math.max(0, Math.min(s.text.length, pos));
    update({ cursorPos: clamped, selectionStart: null, selectionEnd: null });
  }

  function moveCursorLeft(shift: boolean) {
    const s = state();
    if (s.cursorPos <= 0 && !shift) {
      update({ selectionStart: null, selectionEnd: null });
      return;
    }
    const newPos = Math.max(0, s.cursorPos - 1);
    if (shift) {
      const anchor = s.selectionStart ?? s.cursorPos;
      update({ cursorPos: newPos, selectionStart: anchor, selectionEnd: newPos });
    } else {
      const range = selectionRange();
      if (range) {
        update({ cursorPos: range[0], selectionStart: null, selectionEnd: null });
      } else {
        update({ cursorPos: newPos, selectionStart: null, selectionEnd: null });
      }
    }
  }

  function moveCursorRight(shift: boolean) {
    const s = state();
    if (s.cursorPos >= s.text.length && !shift) {
      update({ selectionStart: null, selectionEnd: null });
      return;
    }
    const newPos = Math.min(s.text.length, s.cursorPos + 1);
    if (shift) {
      const anchor = s.selectionStart ?? s.cursorPos;
      update({ cursorPos: newPos, selectionStart: anchor, selectionEnd: newPos });
    } else {
      const range = selectionRange();
      if (range) {
        update({ cursorPos: range[1], selectionStart: null, selectionEnd: null });
      } else {
        update({ cursorPos: newPos, selectionStart: null, selectionEnd: null });
      }
    }
  }

  function moveToStart(shift: boolean) {
    const s = state();
    if (shift) {
      const anchor = s.selectionStart ?? s.cursorPos;
      update({ cursorPos: 0, selectionStart: anchor, selectionEnd: 0 });
    } else {
      update({ cursorPos: 0, selectionStart: null, selectionEnd: null });
    }
  }

  function moveToEnd(shift: boolean) {
    const s = state();
    const end = s.text.length;
    if (shift) {
      const anchor = s.selectionStart ?? s.cursorPos;
      update({ cursorPos: end, selectionStart: anchor, selectionEnd: end });
    } else {
      update({ cursorPos: end, selectionStart: null, selectionEnd: null });
    }
  }

  function selectAll() {
    const s = state();
    update({ selectionStart: 0, selectionEnd: s.text.length, cursorPos: s.text.length });
  }

  function getSelectedText(): string {
    const range = selectionRange();
    if (!range) return "";
    return state().text.slice(range[0], range[1]);
  }

  function submit(): string {
    const s = state();
    const text = s.text;
    if (text.trim().length > 0) {
      // Don't add duplicates of the last entry
      if (history.length === 0 || history[history.length - 1] !== text) {
        history.push(text);
        if (history.length > MAX_HISTORY) {
          history = history.slice(-MAX_HISTORY);
        }
        saveHistory(history);
      }
    }
    update({ text: "", cursorPos: 0, selectionStart: null, selectionEnd: null });
    historyIndex = -1;
    historyDraft = "";
    return text;
  }

  function resetHistory() {
    historyIndex = -1;
    historyDraft = "";
  }

  function historyUp() {
    if (history.length === 0) return;
    if (historyIndex === -1) {
      historyDraft = state().text;
      historyIndex = history.length - 1;
    } else if (historyIndex > 0) {
      historyIndex--;
    } else {
      return; // at the oldest entry
    }
    const entry = history[historyIndex];
    update({ text: entry, cursorPos: entry.length, selectionStart: null, selectionEnd: null });
  }

  function historyDown() {
    if (historyIndex === -1) return;
    if (historyIndex < history.length - 1) {
      historyIndex++;
      const entry = history[historyIndex];
      update({ text: entry, cursorPos: entry.length, selectionStart: null, selectionEnd: null });
    } else {
      // Restore draft
      historyIndex = -1;
      update({ text: historyDraft, cursorPos: historyDraft.length, selectionStart: null, selectionEnd: null });
    }
  }

  // Word boundary helpers
  function findWordBoundaryLeft(pos: number): number {
    const t = state().text;
    let i = pos - 1;
    // Skip whitespace
    while (i > 0 && /\s/.test(t[i])) i--;
    // Skip word chars
    while (i > 0 && !/\s/.test(t[i - 1])) i--;
    return Math.max(0, i);
  }

  function findWordBoundaryRight(pos: number): number {
    const t = state().text;
    let i = pos;
    // Skip word chars
    while (i < t.length && !/\s/.test(t[i])) i++;
    // Skip whitespace
    while (i < t.length && /\s/.test(t[i])) i++;
    return i;
  }

  function deleteWordBackward() {
    if (deleteSelection()) return;
    const s = state();
    if (s.cursorPos <= 0) return;
    const boundary = findWordBoundaryLeft(s.cursorPos);
    update({
      text: s.text.slice(0, boundary) + s.text.slice(s.cursorPos),
      cursorPos: boundary,
      selectionStart: null,
      selectionEnd: null,
    });
    resetHistory();
  }

  function moveWordLeft(shift: boolean) {
    const s = state();
    const newPos = findWordBoundaryLeft(s.cursorPos);
    if (shift) {
      const anchor = s.selectionStart ?? s.cursorPos;
      update({ cursorPos: newPos, selectionStart: anchor, selectionEnd: newPos });
    } else {
      update({ cursorPos: newPos, selectionStart: null, selectionEnd: null });
    }
  }

  function moveWordRight(shift: boolean) {
    const s = state();
    const newPos = findWordBoundaryRight(s.cursorPos);
    if (shift) {
      const anchor = s.selectionStart ?? s.cursorPos;
      update({ cursorPos: newPos, selectionStart: anchor, selectionEnd: newPos });
    } else {
      update({ cursorPos: newPos, selectionStart: null, selectionEnd: null });
    }
  }

  function selectWord(pos: number) {
    const t = state().text;
    const clamped = Math.max(0, Math.min(t.length, pos));
    // Find word boundaries around position
    let start = clamped;
    let end = clamped;
    while (start > 0 && !/\s/.test(t[start - 1])) start--;
    while (end < t.length && !/\s/.test(t[end])) end++;
    if (start === end) return; // clicked on whitespace, no word
    update({ selectionStart: start, selectionEnd: end, cursorPos: end });
  }

  function setText(text: string) {
    update({ text, cursorPos: text.length, selectionStart: null, selectionEnd: null });
    resetHistory();
  }

  function clear() {
    update({ text: "", cursorPos: 0, selectionStart: null, selectionEnd: null });
    resetHistory();
  }

  function getHistory(): string[] {
    return history;
  }

  function acceptSuggestion(): boolean {
    const s = suggestion();
    if (!s) return false;
    update({ text: s, cursorPos: s.length, selectionStart: null, selectionEnd: null });
    setSuggestion(null);
    setAllSuggestions([]);
    setSuggestionIndex(0);
    resetHistory();
    return true;
  }

  function dismissSuggestion(): boolean {
    if (!suggestion()) return false;
    setSuggestion(null);
    setAllSuggestions([]);
    setSuggestionIndex(0);
    return true;
  }

  function acceptSuggestionWord(): boolean {
    const s = suggestion();
    if (!s) return false;
    const current = state().text;
    const remaining = s.slice(current.length);
    if (!remaining) return false;

    // Accept up to the next word boundary: space, or the end of a path segment (/)
    // "checkout " -> accept "checkout "
    // "src/components/" -> accept "src/"
    // "/foo" -> accept "/foo" (leading slash + word)
    const match = remaining.match(/^[^\s/]*[/\s]?/);
    const chunk = match && match[0] ? match[0] : remaining;
    const newText = current + chunk;
    update({ text: newText, cursorPos: newText.length, selectionStart: null, selectionEnd: null });
    if (newText === s) {
      setSuggestion(null);
      setAllSuggestions([]);
      setSuggestionIndex(0);
    }
    return true;
  }

  function cycleSuggestion(direction: 1 | -1): boolean {
    const all = allSuggestions();
    if (all.length <= 1) return false;
    const idx = suggestionIndex();
    const newIdx = (idx + direction + all.length) % all.length;
    setSuggestionIndex(newIdx);
    setSuggestion(all[newIdx]);
    return true;
  }

  return {
    state,
    suggestion,
    setSuggestion,
    allSuggestions,
    setAllSuggestions,
    suggestionIndex,
    setSuggestionIndex,
    acceptSuggestion,
    dismissSuggestion,
    acceptSuggestionWord,
    cycleSuggestion,
    getHistory,
    insert,
    deleteSelection,
    backspace,
    deleteForward,
    moveCursor,
    moveCursorLeft,
    moveCursorRight,
    moveToStart,
    moveToEnd,
    selectAll,
    getSelectedText,
    submit,
    historyUp,
    historyDown,
    setText,
    clear,
    hasSelection,
    selectionRange,
    deleteWordBackward,
    moveWordLeft,
    moveWordRight,
    selectWord,
  };
}

export type InputBuffer = ReturnType<typeof createInputBuffer>;
