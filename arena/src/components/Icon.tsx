/**
 * The handful of icons the UI uses, as inline SVG: 24-unit grid, 1.75 stroke,
 * currentColor, so each theme colours them through `color` alone.
 */
const PATHS = {
  menu: "M4 6h16M4 12h16M4 18h10",
  chat: "M4 5h16v11H9l-5 4Z",
  snake: "M4 18h7a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h9 M18 6h2",
  play: "M7 5l12 7-12 7Z",
  pause: "M8 5v14 M16 5v14",
  stepOver: "M6 5l9 7-9 7Z M18 5v14",
  reset: "M4 12a8 8 0 1 0 2.3-5.7 M4 4v4h4",
  plus: "M12 5v14M5 12h14",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z",
  terminal: "M4 17l6-5-6-5M12 19h8",
  panel: "M4 5h16v14H4z M9 5v14",
  arrowUp: "M12 19V5M5 12l7-7 7 7",
  stop: "M7 7h10v10H7z",
  chevron: "M9 6l6 6-6 6",
  close: "M6 6l12 12M18 6L6 18",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z M14 3v5h5",
  filePen: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4 M14 3v5h5 M19 8v2 M18.4 13.6a1.9 1.9 0 0 1 2.7 2.7L16 21.4l-3.5.6.6-3.5Z",
  pencil: "M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z M21 21l-4.3-4.3",
  folderSearch: "M20 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v3 M17 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M22 22l-2.8-2.8",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M3 12h18 M12 3a14 14 0 0 1 0 18 M12 3a14 14 0 0 0 0 18",
  tool: "M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.4-.4-2.4Z",
  sparkle: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8Z",
  brain: "M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a3 3 0 0 0-3-1Z M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1",
  shield: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6Z",
  key: "M15 7a4 4 0 1 1-3.9 5H8v3H5v-3H3v-3h8.1A4 4 0 0 1 15 7Z",
  check: "M5 12.5l4.5 4.5L19 7.5",
  alert: "M12 3l10 18H2Z M12 10v4 M12 17.5v.5",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name].split(" M").map((d, i) => (
        <path key={i} d={i === 0 ? d : `M${d}`} />
      ))}
    </svg>
  );
}

/** One icon per built-in tool; anything else gets the generic wrench. */
export const TOOL_ICONS: Record<string, IconName> = {
  Bash: "terminal",
  Read: "file",
  Write: "filePen",
  Edit: "pencil",
  Glob: "folderSearch",
  Grep: "search",
  WebFetch: "globe",
};
