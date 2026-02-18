import type { Component } from "solid-js";

// Shared lightweight SVG icon components for Rain terminal UI.
// All icons default to 1em size and currentColor fill.

const iconProps = {
  xmlns: "http://www.w3.org/2000/svg",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2",
  "stroke-linecap": "round" as const,
  "stroke-linejoin": "round" as const,
};

export const IconClose: Component<{ size?: number }> = (props) => {
  const s = () => props.size ?? 12;
  return (
    <svg {...iconProps} width={s()} height={s()} viewBox="0 0 24 24">
      <path d="M18 6L6 18" />
      <path d="M6 6l12 12" />
    </svg>
  );
};

export const IconPlus: Component<{ size?: number }> = (props) => {
  const s = () => props.size ?? 14;
  return (
    <svg {...iconProps} width={s()} height={s()} viewBox="0 0 24 24">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
};

export const IconFolder: Component<{ size?: number }> = (props) => {
  const s = () => props.size ?? 12;
  return (
    <svg {...iconProps} width={s()} height={s()} viewBox="0 0 24 24">
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    </svg>
  );
};

export const IconTerminal: Component<{ size?: number }> = (props) => {
  const s = () => props.size ?? 12;
  return (
    <svg {...iconProps} width={s()} height={s()} viewBox="0 0 24 24">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
};

export const IconCopy: Component<{ size?: number }> = (props) => {
  const s = () => props.size ?? 14;
  return (
    <svg {...iconProps} width={s()} height={s()} viewBox="0 0 24 24">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
};

export const IconArrowDown: Component<{ size?: number }> = (props) => {
  const s = () => props.size ?? 16;
  return (
    <svg {...iconProps} width={s()} height={s()} viewBox="0 0 24 24">
      <path d="M12 5v14" />
      <path d="M19 12l-7 7-7-7" />
    </svg>
  );
};

export const IconSearch: Component<{ size?: number }> = (props) => {
  const s = () => props.size ?? 14;
  return (
    <svg {...iconProps} width={s()} height={s()} viewBox="0 0 24 24">
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  );
};

export const IconChevronDown: Component<{ size?: number }> = (props) => {
  const s = () => props.size ?? 14;
  return (
    <svg {...iconProps} width={s()} height={s()} viewBox="0 0 24 24">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
};

export const IconCheck: Component<{ size?: number }> = (props) => {
  const s = () => props.size ?? 12;
  return (
    <svg {...iconProps} width={s()} height={s()} viewBox="0 0 24 24">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
};

export const IconCommand: Component<{ size?: number }> = (props) => {
  const s = () => props.size ?? 14;
  return (
    <svg {...iconProps} width={s()} height={s()} viewBox="0 0 24 24">
      <polyline points="4 17 10 11 4 5" />
    </svg>
  );
};

export const IconPalette: Component<{ size?: number }> = (props) => {
  const s = () => props.size ?? 14;
  return (
    <svg {...iconProps} width={s()} height={s()} viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="8" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="8" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="16" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="16" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
};

export const IconFont: Component<{ size?: number }> = (props) => {
  const s = () => props.size ?? 14;
  return (
    <svg {...iconProps} width={s()} height={s()} viewBox="0 0 24 24">
      <path d="M4 20h16" />
      <path d="M7 4l5 16" />
      <path d="M17 4l-5 16" />
      <path d="M9 12h6" />
    </svg>
  );
};

export const IconRefresh: Component<{ size?: number }> = (props) => {
  const s = () => props.size ?? 14;
  return (
    <svg {...iconProps} width={s()} height={s()} viewBox="0 0 24 24">
      <path d="M1 4v6h6" />
      <path d="M23 20v-6h-6" />
      <path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15" />
    </svg>
  );
};

export const IconConnection: Component<{ size?: number }> = (props) => {
  const s = () => props.size ?? 12;
  return (
    <svg {...iconProps} width={s()} height={s()} viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
    </svg>
  );
};

export const IconSettings: Component<{ size?: number }> = (props) => {
  const s = () => props.size ?? 14;
  return (
    <svg {...iconProps} width={s()} height={s()} viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  );
};

export const IconKeyboard: Component<{ size?: number }> = (props) => {
  const s = () => props.size ?? 14;
  return (
    <svg {...iconProps} width={s()} height={s()} viewBox="0 0 24 24">
      <rect x="2" y="4" width="20" height="16" rx="2" ry="2" />
      <path d="M6 8h.01" />
      <path d="M10 8h.01" />
      <path d="M14 8h.01" />
      <path d="M18 8h.01" />
      <path d="M6 12h.01" />
      <path d="M10 12h.01" />
      <path d="M14 12h.01" />
      <path d="M18 12h.01" />
      <path d="M8 16h8" />
    </svg>
  );
};

export const IconMonitor: Component<{ size?: number }> = (props) => {
  const s = () => props.size ?? 14;
  return (
    <svg {...iconProps} width={s()} height={s()} viewBox="0 0 24 24">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
};

export const IconSun: Component<{ size?: number }> = (props) => {
  const s = () => props.size ?? 14;
  return (
    <svg {...iconProps} width={s()} height={s()} viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
};

export const IconMoon: Component<{ size?: number }> = (props) => {
  const s = () => props.size ?? 14;
  return (
    <svg {...iconProps} width={s()} height={s()} viewBox="0 0 24 24">
      <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
    </svg>
  );
};

export const IconUser: Component<{ size?: number }> = (props) => {
  const s = () => props.size ?? 14;
  return (
    <svg {...iconProps} width={s()} height={s()} viewBox="0 0 24 24">
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
};
