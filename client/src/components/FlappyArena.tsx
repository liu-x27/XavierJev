import { type CSSProperties, useEffect } from "react";
import { BIRD_RADIUS, BIRD_X, FIELD, FLAP_THRESHOLD, PIPE, flapFacts, flapState } from "../../../shared/flappy";
import { BUDGETS, type FlapPolicy, type FlappyArena as Game } from "../hooks/useFlappyArena";
import { Icon } from "./Icon";

/**
 * Flappy against a clock: the judge answers yes or no every tick, inside a
 * budget, or the bird does nothing. What the snake arena cannot show — that
 * a decision layer has to be fast, not just cheap — this one can.
 */

const POLICIES: Array<{ value: FlapPolicy; label: string; hint: string }> = [
  { value: "model", label: "Model", hint: "The judge answers yes or no every tick; a late answer is a miss and the bird does nothing" },
  { value: "rule", label: "Rule", hint: "A hand-written rule over the same two facts, no model, never late" },
];

const pctX = (x: number) => `${(x / FIELD.width) * 100}%`;
const pctY = (y: number) => `${(y / FIELD.height) * 100}%`;

export function FlappyArena({ game, judge }: { game: Game; judge: string | undefined }) {
  const { canAsk, policy, setPolicy, budget, setBudget, running, setRunning } = game;
  const { flightNo, flight, crash, beats, stats, reset } = game;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === " ") {
        e.preventDefault();
        setRunning((r) => !r);
      } else if (e.key === "r" || e.key === "R") reset();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setRunning, reset]);

  const last = beats.at(-1);
  const recent = beats.slice(-60);
  const recentMiss = recent.length ? recent.filter((b) => b.missed).length / recent.length : undefined;
  const facts = flapFacts(flight);
  const sparkMax = Math.max(budget * 2, ...stats.spark);

  return (
    <div className="arena" data-game="flappy">
      <section className="arena-stage">
        <header className="arena-head">
          <div>
            <p className="arena-kicker">Flappy · {Math.round(1000 / budget)} ticks a second</p>
            <h2 className="arena-title">Answer inside {budget} ms, or do nothing</h2>
          </div>
          <span className="arena-judge">{judge ?? "no model judge"}</span>
        </header>

        <div className="board sky" data-crashed={crash ? true : undefined} role="img" aria-label={`Flappy, ${flight.score} pipes`}>
          {flight.pipes.map((p, i) => (
            <span key={i}>
              <i className="pipe" style={{ left: pctX(p.x), width: pctX(PIPE.width), top: 0, height: pctY(p.gapTop) }} />
              <i
                className="pipe"
                style={{ left: pctX(p.x), width: pctX(PIPE.width), top: pctY(p.gapTop + PIPE.gap), bottom: 0 }}
              />
            </span>
          ))}
          <i
            className="bird"
            data-flap={last?.flap || undefined}
            data-missed={last?.missed || undefined}
            style={
              {
                left: pctX(BIRD_X - BIRD_RADIUS),
                top: pctY(flight.y - BIRD_RADIUS),
                width: pctX(BIRD_RADIUS * 2),
                "--tilt": `${Math.max(-25, Math.min(60, flight.vy * 90))}deg`,
              } as CSSProperties
            }
          />
          <b className="sky-score">{flight.score}</b>
          {crash && (
            <div className="board-crash">
              <b>{crash}</b>
              <span>flight {flightNo + 1} next</span>
            </div>
          )}
        </div>

        {/* The last answer against its budget. Past the line, it was too late. */}
        <div className="deadline" data-late={last?.missed || undefined} aria-label="Last answer against the budget">
          <span
            className="deadline-bar"
            style={{ "--v": last?.ms !== undefined ? Math.min(1, last.ms / (budget * 2)) : last?.missed ? 1 : 0 } as CSSProperties}
          />
          <span className="deadline-line" />
          <span className="deadline-label">
            {last?.missed
              ? last.ms !== undefined
                ? `${Math.round(last.ms)} ms — too late`
                : "still waiting — missed"
              : last?.ms !== undefined
                ? `${Math.round(last.ms)} ms`
                : policy === "rule"
                  ? "rule: instant"
                  : ""}
          </span>
          <span className="deadline-budget">{budget} ms</span>
        </div>

        <div className="arena-controls">
          <button type="button" className="arena-play" onClick={() => setRunning((r) => !r)} aria-label={running ? "Pause" : "Play"}>
            <Icon name={running ? "pause" : "play"} size={16} />
            {running ? "Pause" : "Play"}
            <kbd>Space</kbd>
          </button>
          <button type="button" className="arena-btn" onClick={reset} aria-label="Reset">
            <Icon name="reset" size={15} />
          </button>
          <span className="grow" />
          <div className="segmented" role="radiogroup" aria-label="Budget">
            {BUDGETS.map((b) => (
              <button key={b} type="button" role="radio" aria-checked={budget === b} className="segment" onClick={() => setBudget(b)}>
                {b} ms
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
          <div className="hud-kpi" data-tone={recentMiss !== undefined && recentMiss > 0.1 ? "hot" : "ok"}>
            <b>{recentMiss !== undefined ? `${Math.round(recentMiss * 100)}%` : "—"}</b>
            <span>missed, last 60</span>
          </div>
          <div className="hud-kpi">
            <b>
              {stats.p50 !== undefined ? Math.round(stats.p50) : "—"}
              {stats.p50 !== undefined && <small>ms</small>}
            </b>
            <span>answer p50</span>
          </div>
          <div className="hud-kpi">
            <b>{flight.score}</b>
            <span>pipes · best {Math.max(flight.score, stats.bestPipes)}</span>
          </div>
        </div>

        <div className="hud-block">
          <div className="hud-label">
            <span>This tick</span>
            <span>
              {last
                ? last.missed
                  ? "missed — no flap"
                  : last.forced
                    ? "flapping would crash — rule"
                    : last.p !== undefined
                      ? `P(yes) ${last.p.toFixed(3)} · flaps at ${FLAP_THRESHOLD}`
                      : "rule"
                : "not started"}
            </span>
          </div>
          <div className="probs">
            <div className="prob" data-offered data-picked={last?.flap || undefined} data-rule={last?.rule || undefined}>
              <span className="prob-dir">flap</span>
              <span className="prob-bar" style={{ "--p": last?.p ?? (last?.flap ? 1 : 0) } as CSSProperties} />
              <span className="prob-p">{last?.p !== undefined ? last.p.toFixed(3) : ""}</span>
              <span className="prob-rule">{last?.rule ? "rule" : ""}</span>
            </div>
          </div>
          <dl className="flap-facts">
            <div>
              <dt>the judge is told</dt>
              <dd>{facts.flapCrashes ? "nothing — the rule decides" : `if it does not flap: ${flapState(flight)["if it does not flap"]}`}</dd>
            </div>
            <div>
              <dt>if it flaps</dt>
              <dd>{facts.flapCrashes ? "it crashes into the pipe above" : "it stays in the gap"}</dd>
            </div>
          </dl>
        </div>

        <div className="hud-block">
          <div className="hud-label">
            <span>Answer time vs budget</span>
            <span>
              {stats.overBudget !== undefined ? `${Math.round(stats.overBudget * 100)}% over · p95 ${Math.round(stats.p95!)} ms` : "no answers yet"}
            </span>
          </div>
          <div className="hud-spark" style={{ "--budget": budget / sparkMax } as CSSProperties} data-budget>
            {Array.from({ length: 48 - stats.spark.length }, (_, i) => (
              <i key={`idle-${i}`} className="idle" />
            ))}
            {stats.spark.map((ms, i) => (
              <i key={i} data-over={ms > budget || undefined} style={{ "--h": ms / sparkMax } as CSSProperties} />
            ))}
          </div>
        </div>

        <dl className="hud-facts">
          <div>
            <dt>Missed, this budget</dt>
            <dd>{stats.missRate !== undefined ? `${(stats.missRate * 100).toFixed(1)}%` : "—"}</dd>
          </div>
          <div>
            <dt>Agrees with the rule</dt>
            <dd>{stats.agree !== undefined ? `${Math.round(stats.agree * 100)}%` : "—"}</dd>
          </div>
          <div>
            <dt>Ticks</dt>
            <dd>{stats.ticks}</dd>
          </div>
          <div data-tone={stats.fallbacks ? "hot" : undefined} title={stats.lastError}>
            <dt>Judge errors</dt>
            <dd>{stats.fallbacks}</dd>
          </div>
          <div>
            <dt>Flights · mean pipes</dt>
            <dd>
              {stats.flights} · {stats.meanPipes !== undefined ? stats.meanPipes.toFixed(1) : "—"}
            </dd>
          </div>
          <div>
            <dt>Flight</dt>
            <dd>{flightNo}</dd>
          </div>
        </dl>
      </aside>
    </div>
  );
}
