import { Component, onMount } from "solid-js";

export const SearchBar: Component<{
  query: string;
  matchCount: number;
  currentIndex: number;
  useRegex?: boolean;
  regexError?: boolean;
  onQueryChange: (q: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  onToggleRegex?: () => void;
}> = (props) => {
  let inputRef!: HTMLInputElement;

  onMount(() => {
    inputRef?.focus();
  });

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        props.onPrev();
      } else {
        props.onNext();
      }
    }
  };

  return (
    <div class="search-bar">
      {props.onToggleRegex && (
        <button
          class={`search-btn search-regex-toggle${props.useRegex ? " search-regex-active" : ""}${props.regexError ? " search-regex-error" : ""}`}
          onClick={props.onToggleRegex}
          title={props.regexError ? "Invalid regex" : "Toggle regex search"}
          aria-pressed={props.useRegex}
        >
          .*
        </button>
      )}
      <input
        ref={inputRef}
        type="text"
        class={`search-input${props.regexError ? " search-input-error" : ""}`}
        placeholder={props.useRegex ? "Regex..." : "Search..."}
        aria-label="Search terminal"
        value={props.query}
        onInput={(e) => props.onQueryChange(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
      />
      <span class="search-count" role="status" aria-live="polite">
        {props.matchCount > 0 ? `${props.currentIndex + 1}/${props.matchCount}` : "no matches"}
      </span>
      <button class="search-btn" onClick={props.onPrev} title="Previous (Shift+Enter)">&#x25B2;</button>
      <button class="search-btn" onClick={props.onNext} title="Next (Enter)">&#x25BC;</button>
      <button class="search-btn search-close" onClick={props.onClose} title="Close (Esc)">&times;</button>
    </div>
  );
};
