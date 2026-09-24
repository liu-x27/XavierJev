import { useEffect, useState } from "react";
import type { FlappyArena as FlappyGame } from "../hooks/useFlappyArena";
import type { SnakeArena } from "../hooks/useSnakeArena";
import { Arena } from "./Arena";
import { FlappyArena } from "./FlappyArena";

type Game = "snake" | "flappy";

/**
 * The two games, one at a time. Snake is turn-based and shows what the judge
 * decides; Flappy runs on a clock and shows how fast it has to. Only the one
 * on screen runs: both ask the same judge.
 */
export function ArenaView({ snake, flappy, judge }: { snake: SnakeArena; flappy: FlappyGame; judge: string | undefined }) {
  const [game, setGame] = useState<Game>(() => (location.hash === "#arena/flappy" ? "flappy" : "snake"));
  const pauseSnake = snake.setRunning;
  const pauseFlappy = flappy.setRunning;
  useEffect(() => {
    if (game === "snake") pauseFlappy(false);
    else pauseSnake(false);
    history.replaceState(null, "", game === "flappy" ? "#arena/flappy" : "#arena");
  }, [game, pauseSnake, pauseFlappy]);

  return (
    <>
      <nav className="arena-tabs segmented" role="radiogroup" aria-label="Game">
        {(["snake", "flappy"] as const).map((g) => (
          <button key={g} type="button" role="radio" aria-checked={game === g} className="segment" onClick={() => setGame(g)}>
            {g === "snake" ? "Snake · choice of four" : "Flappy · yes or no, on a clock"}
          </button>
        ))}
      </nav>
      {game === "snake" ? <Arena game={snake} judge={judge} /> : <FlappyArena game={flappy} judge={judge} />}
    </>
  );
}
