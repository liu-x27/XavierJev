import { useCallback, useEffect, useState } from "react";

/**
 * The three themes of mini-claude-code's web client. There each one had a
 * layout of its own around the chat transcript; here they only paint the
 * arena, through the tokens in themes.css and the rules at the bottom of
 * arena.css.
 */
export type Theme = "instrument" | "editorial" | "aurora";

export const THEMES: Array<{ value: Theme; label: string; hint: string }> = [
  { value: "instrument", label: "Instrument", hint: "Dark, dense, built around the numbers" },
  { value: "editorial", label: "Editorial", hint: "Paper and serif" },
  { value: "aurora", label: "Aurora", hint: "Glass over a slow gradient" },
];

const NEXT: Record<Theme, Theme> = { instrument: "editorial", editorial: "aurora", aurora: "instrument" };

/** Same rule as the inline script in index.html, which applies it before first paint. */
export function initialTheme(): Theme {
  const saved = localStorage.getItem("theme");
  if (saved === "instrument" || saved === "editorial" || saved === "aurora") return saved;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "instrument" : "editorial";
}

export function useTheme(): [Theme, (t: Theme) => void, () => void] {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  const cycle = useCallback(() => setTheme((t) => NEXT[t]), []);
  return [theme, setTheme, cycle];
}

export const nextTheme = (t: Theme) => NEXT[t];
