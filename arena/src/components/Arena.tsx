import { type CSSProperties, useEffect } from "react";
import { DIRECTIONS, legalMoves, snakeQuestion } from "../../../games/snake";
import { type Policy, SIZE, type SnakeArena, type Speed } from "../hooks/useSnakeArena";
import { Icon } from "./Icon";

/**
 * Snake, played one decision at a time by the judge's `choice()`.
 *
 * The point is the decision layer, not the game: every move is one question
 * to the same local model the risk gate uses, answered from one token's
 * logprobs, and everything that comes back — the probability of each move,
 * how much of the token's mass landed on the options, how long it took — is
 * on screen as it happens. The hand-written rule over the same facts runs
 * beside it, so the model's moves can be compared with the rule's.
 */

const POLICIES: Array<{ value: Policy; label: string; hint: string }> = [
  { value: "model", label: "Model", hint: "The judge picks among the legal moves, told what each one does" },
  { value: "rule", label: "Rule", hint: "A hand-written rule over the same facts, no model" },
  { value: "raw", label: "Raw cells", hint: "The judge is told only what is next to the head, and offered all four moves" },
];
const SPEEDS: Speed[] = ["max", 12, 4];

/** The rule decides in microseconds; "0 ms" would read as a missing number. */
const fmtMs = (ms: number) => (ms < 1 ? "<1" : String(Math.round(ms)));

export function Arena({ game, judge }: { game: SnakeArena; judge: string | undefined }) {
  const { canAsk, policy, setPolicy, speed, setSpeed, running, setRunning } = game;
  const { gameNo, board, crash, decisions, moves, stats, stepOnce, reset } = game;

  // Space plays and pauses, → steps, R resets — unless something is being typed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === " ") {
        e.preventDefault();
        setRunning((r) => !r);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        void stepOnce();
      } else if (e.key === "r" || e.key === "R") {
        reset();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stepOnce, reset]);

  const last = decisions.at(-1);
  const score = board.snake.length - 3;
  const best = Math.max(score, stats.bestScore);
  const question = snakeQuestion(board, policy === "raw" ? "raw" : "facts");
  // The last decision is drawn against the board it was made on, not the
  // one its move produced: the halos sit round where the head was, and
  // "illegal" means illegal then.
  const legal = new Set(last ? last.legal : legalMoves(board));
  const sparkMax = Math.max(60, ...stats.spark);

  return (
    <div className="arena">
      <section className="arena-stage">
        <header className="arena-head">
          <div>
            <p className="arena-kicker">Snake arena</p>
            <h2 className="arena-title">One question per move</h2>
          </div>
          <span className="arena-judge">{judge ?? "no model judge"}</span>
        </header>

        <div
          className="board"
          style={{ "--n": SIZE } as CSSProperties}
          data-crashed={crash ? true : undefined}
          data-running={running || undefined}
          aria-label={`Snake board, score ${score}`}
          role="img"
        >
          <i
            className="food"
            style={{ "--x": board.food.x, "--y": board.food.y } as CSSProperties}
            aria-hidden="true"
          />
          {board.snake.map((s, i) => (
            <i
              key={i}
              className={i === 0 ? "seg head" : "seg"}
              style={{ "--x": s.x, "--y": s.y, "--i": i / board.snake.length } as CSSProperties}
              aria-hidden="true"
            />
          ))}
          {/* What the judge thought of each neighbouring cell, last move. */}
          {last?.probs &&
            !crash &&
            DIRECTIONS.map((d) => {
              const p = last.probs?.[d];
              if (p === undefined) return null;
              const h = last.from;
              const x = h.x + (d === "right" ? 1 : d === "left" ? -1 : 0);
              const y = h.y + (d === "down" ? 1 : d === "up" ? -1 : 0);
              if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return null;
              return (
                <i
                  key={d}
                  className="halo"
                  style={{ "--x": x, "--y": y, "--p": p } as CSSProperties}
                  aria-hidden="true"
                />
              );
            })}
          {crash && (
            <div className="board-crash">
              <b>{crash}</b>
              <span>game {gameNo + 1} next</span>
            </div>
          )}
        </div>

        <div className="arena-controls">
          <button
            type="button"
            className="arena-play"
            onClick={() => setRunning((r) => !r)}
            aria-label={running ? "Pause" : "Play"}
          >
            <Icon name={running ? "pause" : "play"} size={16} />
            {running ? "Pause" : "Play"}
            <kbd>Space</kbd>
          </button>
          <button type="button" className="arena-btn" onClick={() => void stepOnce()} disabled={running} aria-label="Step">
            <Icon name="stepOver" size={15} />
            <kbd>→</kbd>
          </button>
          <button type="button" className="arena-btn" onClick={reset} aria-label="Reset">
            <Icon name="reset" size={15} />
          </button>
          <span className="grow" />
          <div className="segmented" role="radiogroup" aria-label="Speed">
            {SPEEDS.map((s) => (
              <button key={s} type="button" role="radio" aria-checked={speed === s} className="segment" onClick={() => setSpeed(s)}>
                {s === "max" ? "Max" : `${s}/s`}
              </button>
            ))}
          </div>
        </div>
      </section>

      <aside className="arena-hud" aria-label="Decisions">
        <div className="segmented arena-policy" role="radiogroup" aria-label="Who decides">
          {POLICIES.map((p) => (
            <button
              key={p.value}
              type="button"
              role="radio"
              aria-checked={policy === p.value}
              className="segment"
              disabled={p.value !== "rule" && !canAsk}
              title={p.hint}
              onClick={() => setPolicy(p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className="arena-hint">{POLICIES.find((p) => p.value === policy)!.hint}.</p>

        <div className="hud-kpis">
          <div className="hud-kpi" data-tone="ok">
            <b>{stats.movesPerSec !== undefined ? stats.movesPerSec.toFixed(1) : "—"}</b>
            <span>moves / s</span>
          </div>
          <div className="hud-kpi">
            <b>
              {stats.p50 !== undefined ? fmtMs(stats.p50) : "—"}
              {stats.p50 !== undefined && <small>ms</small>}
            </b>
            <span>decision p50</span>
          </div>
          <div className="hud-kpi">
            <b>{score}</b>
            <span>score · best {best}</span>
          </div>
        </div>

        <div className="hud-block">
          <div className="hud-label">
            <span>Last decision</span>
            <span>
              {last
                ? last.fallback
                  ? "fell back to the rule"
                  : last.forced
                    ? "only one legal move"
                    : last.policy === "rule"
                      ? "rule"
                      : `${fmtMs(last.judgeMs ?? last.ms)} ms · coverage ${last.coverage?.toFixed(3) ?? "—"}`
                : "none yet"}
            </span>
          </div>
          <div className="probs">
            {DIRECTIONS.map((d) => {
              const p = last?.probs?.[d];
              const offered = policy === "raw" || legal.has(d) || p !== undefined;
              return (
                <div
                  key={d}
                  className="prob"
                  data-picked={last?.pick === d || undefined}
                  data-rule={last?.rule === d || undefined}
                  data-illegal={!legal.has(d) || undefined}
                  data-offered={offered || undefined}
                >
                  <span className="prob-dir">{d}</span>
                  <span className="prob-bar" style={{ "--p": p ?? (last?.pick === d ? 1 : 0) } as CSSProperties} />
                  <span className="prob-p">{p !== undefined ? p.toFixed(3) : last?.pick === d ? "pick" : ""}</span>
                  <span className="prob-rule">{last?.rule === d ? "rule" : ""}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="hud-block">
          <div className="hud-label">
            <span>Judge latency</span>
            <span>{stats.p95 !== undefined ? `p95 ${Math.round(stats.p95)} ms` : "no decisions yet"}</span>
          </div>
          <div className="hud-spark">
            {Array.from({ length: 40 - stats.spark.length }, (_, i) => (
              <i key={`idle-${i}`} className="idle" />
            ))}
            {stats.spark.map((ms, i) => (
              <i key={i} style={{ "--h": ms / sparkMax } as CSSProperties} />
            ))}
          </div>
        </div>

        <dl className="hud-facts">
          <div>
            <dt>Agrees with the rule</dt>
            <dd>{stats.agree !== undefined ? `${Math.round(stats.agree * 100)}%` : "—"}</dd>
          </div>
          <div>
            <dt>Mean coverage</dt>
            <dd>{stats.coverage !== undefined ? stats.coverage.toFixed(3) : "—"}</dd>
          </div>
          <div>
            <dt>Model decisions</dt>
            <dd>{stats.asked}</dd>
          </div>
          <div data-tone={stats.fallbacks ? "hot" : undefined} title={stats.lastError}>
            <dt>Fell back to the rule</dt>
            <dd>{stats.fallbacks}</dd>
          </div>
          <div>
            <dt>Games · mean score</dt>
            <dd>
              {stats.games} · {stats.meanScore !== undefined ? stats.meanScore.toFixed(1) : "—"}
            </dd>
          </div>
          <div>
            <dt>Game {gameNo} · moves</dt>
            <dd>{moves}</dd>
          </div>
        </dl>

        <details className="hud-prompt">
          <summary>What the model is asked</summary>
          <pre>
            {policy === "rule"
              ? "Nothing: the rule decides on its own."
              : `${Object.entries(question.state)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join("\n")}\n\nQuestion: ${question.ask}\n${question.options
                  .map((o, i) => `${"ABCD"[i]}. ${o.text}`)
                  .join("\n")}`}
          </pre>
        </details>
      </aside>
    </div>
  );
}
