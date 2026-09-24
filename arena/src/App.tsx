import { useEffect, useState } from "react";
import { ArenaView } from "./components/ArenaView";
import { Icon } from "./components/Icon";
import { useFlappyArena } from "./hooks/useFlappyArena";
import { useSnakeArena } from "./hooks/useSnakeArena";
import { THEMES, type Theme, useTheme } from "./lib/theme";

const label = (t: Theme) => THEMES.find((x) => x.value === t)?.label ?? t;
const NEXT: Record<Theme, Theme> = { instrument: "editorial", editorial: "aurora", aurora: "instrument" };

/**
 * The arena on a page of its own.
 *
 * In mini-claude-code it was one view of the chat app, inside each theme's
 * frame; here the frame is a single header, and the page is the two games.
 * Which judge they play against is the server's to say — /api/health names
 * the model, or nothing, and then only the hand-written rules can play.
 */
export default function App() {
  const [theme, , cycleTheme] = useTheme();
  const [judge, setJudge] = useState<string | undefined>();
  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d: { choice?: string | null }) => {
        if (typeof d.choice === "string") setJudge(d.choice);
      })
      .catch(() => {});
  }, []);
  const snake = useSnakeArena(judge);
  const flappy = useFlappyArena(judge);

  return (
    <div className="app">
      {theme === "aurora" && (
        <>
          <div className="aurora" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <div className="grain" aria-hidden="true" />
        </>
      )}
      <div className="arena-page">
        <header className="arena-page-head">
          <h1>
            XavierJev <span className="eyebrow">arena</span>
          </h1>
          <span className="grow" />
          <span className="arena-page-judge">{judge ? `judge · ${judge}` : "no model judge · rules only"}</span>
          <button
            type="button"
            className="icon-btn"
            onClick={cycleTheme}
            title={`Switch to ${label(NEXT[theme])}`}
            aria-label={`Switch to ${label(NEXT[theme])} theme`}
          >
            <Icon name="sparkle" />
          </button>
        </header>
        <div className="arena-scroll">
          <ArenaView snake={snake} flappy={flappy} judge={judge} />
        </div>
      </div>
    </div>
  );
}
