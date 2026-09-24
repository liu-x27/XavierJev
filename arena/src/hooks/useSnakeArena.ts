import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Board,
  type Direction,
  type Point,
  cellAhead,
  legalMoves,
  newBoard,
  ruleMove,
  seededRandom,
  step,
} from "../../../games/snake";

/**
 * The snake arena's game: board, loop, and every decision made so far.
 *
 * Lives in App rather than in the arena component, because each theme is a
 * different frame and switching theme mounts a new one — a game that lived
 * in the component would end every time the theme changed.
 */

export const SIZE = 12;

export type Policy = "model" | "rule" | "raw";
export type Speed = "max" | 12 | 4;

export interface Decision {
  /** When it finished, for the moves-per-second window. */
  at: number;
  pick: Direction;
  rule: Direction | undefined;
  /** Round trip as the browser saw it. */
  ms: number;
  /** The judge's own time, measured on the server around the call. */
  judgeMs?: number;
  probs?: Partial<Record<Direction, number>>;
  coverage?: number;
  /** Nothing to decide: one legal move, or none. */
  forced?: boolean;
  fallback?: string;
  policy: Policy;
  /** Where the head was, and which moves were legal, when it was decided. */
  from: Point;
  legal: Direction[];
}

export interface Game {
  score: number;
  moves: number;
  end: string;
}

/**
 * Running totals for one policy, kept apart from the decision window so that
 * a count does not quietly shrink once its decision scrolls out of it, and
 * apart from the other policies so switching mode does not blend their
 * numbers.
 */
interface Tally {
  asked: number;
  agreed: number;
  coverage: number;
  fallbacks: number;
  lastError?: string;
  games: Game[];
  /** The most recent decision times, for the percentiles and the sparkline. */
  latencies: number[];
}

const emptyTally = (): Tally => ({ asked: 0, agreed: 0, coverage: 0, fallbacks: 0, games: [], latencies: [] });
const emptyTallies = (): Record<Policy, Tally> => ({ model: emptyTally(), rule: emptyTally(), raw: emptyTally() });

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const argmax = (answers: Array<{ id: string; probability: number }>) =>
  answers.reduce((a, b) => (b.probability > a.probability ? b : a)).id as Direction;

async function decide(
  board: Board,
  policy: Policy,
  signal: AbortSignal,
): Promise<Omit<Decision, "at" | "policy" | "from" | "legal">> {
  const started = performance.now();
  const rule = ruleMove(board);
  // Boxed in: whatever happens next, it is not a question for anyone.
  if (!rule) return { pick: "up", rule, ms: 0, forced: true };
  if (policy === "rule") return { pick: rule, rule, ms: performance.now() - started };
  // One legal move is not a question either, and not worth a round trip.
  if (policy === "model" && legalMoves(board).length === 1) return { pick: rule, rule, ms: 0, forced: true };
  try {
    const res = await fetch("/api/snake/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ board, mode: policy === "raw" ? "raw" : "facts" }),
      signal,
    });
    const data = (await res.json()) as {
      answers?: Array<{ id: string; probability: number }>;
      coverage?: number;
      latencyMs?: number;
      forced?: boolean;
      error?: string;
    };
    const ms = performance.now() - started;
    if (!res.ok || !data.answers?.length) {
      // Fall back to the rule, visibly: the game should not stop for a judge
      // that did not answer, and the count should not hide that it didn't.
      return { pick: rule, rule, ms, fallback: data.error ?? `HTTP ${res.status}` };
    }
    return {
      pick: argmax(data.answers),
      rule,
      ms,
      ...(data.latencyMs !== undefined && { judgeMs: data.latencyMs }),
      probs: Object.fromEntries(data.answers.map((a) => [a.id, a.probability])),
      ...(data.coverage !== undefined && { coverage: data.coverage }),
      ...(data.forced && { forced: true }),
    };
  } catch (err) {
    if (signal.aborted) throw err;
    return { pick: rule, rule, ms: performance.now() - started, fallback: String(err) };
  }
}

export function useSnakeArena(judge: string | undefined) {
  const canAsk = !!judge;
  const [policy, setPolicy] = useState<Policy>(canAsk ? "model" : "rule");
  const [speed, setSpeed] = useState<Speed>("max");
  const [running, setRunning] = useState(false);
  const [gameNo, setGameNo] = useState(1);
  const [board, setBoard] = useState<Board>(() => newBoard(SIZE, seededRandom(1)));
  const [crash, setCrash] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [tallies, setTallies] = useState(emptyTallies);
  const [moves, setMoves] = useState(0);

  // The loop reads these without restarting when they change.
  const boardRef = useRef(board);
  const randomRef = useRef(seededRandom(1));
  const policyRef = useRef(policy);
  const speedRef = useRef(speed);
  const movesRef = useRef(0);
  const gameRef = useRef(1);
  const crashedRef = useRef(false);
  policyRef.current = policy;
  speedRef.current = speed;

  // The judge is only known once /api/health answers; switch to it then,
  // unless the rule has already been chosen and played.
  const played = decisions.length > 0;
  useEffect(() => {
    if (canAsk && !played) setPolicy("model");
  }, [canAsk, played]);

  const startGame = useCallback((n: number) => {
    const random = seededRandom(n);
    randomRef.current = random;
    const b = newBoard(SIZE, random);
    boardRef.current = b;
    movesRef.current = 0;
    gameRef.current = n;
    crashedRef.current = false;
    setBoard(b);
    setMoves(0);
    setGameNo(n);
    setCrash(null);
  }, []);

  const tally = useCallback((p: Policy, change: (t: Tally) => Tally) => {
    setTallies((all) => ({ ...all, [p]: change(all[p]) }));
  }, []);

  /** One decision and one move. Returns false when the game ended. */
  const advance = useCallback(
    async (signal: AbortSignal): Promise<boolean> => {
      const b = boardRef.current;
      const p = policyRef.current;
      const d = await decide(b, p, signal);
      const decision: Decision = { ...d, at: performance.now(), policy: p, from: b.snake[0]!, legal: legalMoves(b) };
      setDecisions((prev) => [...prev.slice(-199), decision]);
      if (decision.fallback) {
        tally(p, (t) => ({ ...t, fallbacks: t.fallbacks + 1, lastError: decision.fallback! }));
      } else if (!decision.forced) {
        const ms = decision.judgeMs ?? decision.ms;
        tally(p, (t) => ({
          ...t,
          latencies: [...t.latencies.slice(-199), ms],
          ...(p !== "rule" && {
            asked: t.asked + 1,
            agreed: t.agreed + (decision.pick === decision.rule ? 1 : 0),
            coverage: t.coverage + (decision.coverage ?? 0),
          }),
        }));
      }

      const result = step(b, decision.pick, randomRef.current);
      movesRef.current++;
      setMoves(movesRef.current);
      if (result.dead || result.won) {
        const score = b.snake.length - 3;
        const end = result.won
          ? "filled the board"
          : legalMoves(b).length === 0
            ? "boxed in"
            : `hit ${cellAhead(b, decision.pick)}`;
        crashedRef.current = true;
        tally(p, (t) => ({ ...t, games: [...t.games, { score, moves: movesRef.current, end }] }));
        setCrash(result.won ? `Filled the board · ${score}` : `${end} · ${score}`);
        return false;
      }
      boardRef.current = result.board;
      setBoard(result.board);
      return true;
    },
    [tally],
  );

  useEffect(() => {
    if (!running) return;
    const abort = new AbortController();
    (async () => {
      while (!abort.signal.aborted) {
        // Paused on a crash and played again: that game is over.
        if (crashedRef.current) startGame(gameRef.current + 1);
        const started = performance.now();
        let alive: boolean;
        try {
          alive = await advance(abort.signal);
        } catch {
          return; // aborted mid-request
        }
        if (!alive) {
          await new Promise((r) => setTimeout(r, 1100));
          if (abort.signal.aborted) return;
          startGame(gameRef.current + 1);
          continue;
        }
        const s = speedRef.current;
        // At least a frame per move, so the board is drawn between moves
        // even when the rule decides in microseconds; a model call that
        // already took longer than that waits for nothing.
        const interval = Math.max(16, s === "max" ? 0 : 1000 / s);
        await new Promise((r) => setTimeout(r, Math.max(0, interval - (performance.now() - started))));
      }
    })();
    return () => abort.abort();
  }, [running, advance, startGame]);

  const stepOnce = useCallback(async () => {
    if (running) return;
    if (crashedRef.current) {
      startGame(gameRef.current + 1);
      return;
    }
    await advance(new AbortController().signal);
  }, [running, advance, startGame]);

  const reset = useCallback(() => {
    setRunning(false);
    setDecisions([]);
    setTallies(emptyTallies());
    startGame(1);
  }, [startGame]);

  const stats = useMemo(() => {
    const t = tallies[policy];
    const lat = [...t.latencies].sort((a, b) => a - b);
    const recent = decisions.filter((d) => d.policy === policy).slice(-30);
    const span = recent.length > 1 ? (recent.at(-1)!.at - recent[0]!.at) / 1000 : 0;
    const scores = t.games.map((g) => g.score);
    return {
      movesPerSec: span > 0 ? (recent.length - 1) / span : undefined,
      p50: lat.length ? pct(lat, 0.5) : undefined,
      p95: lat.length ? pct(lat, 0.95) : undefined,
      asked: t.asked,
      agree: t.asked ? t.agreed / t.asked : undefined,
      coverage: t.asked ? t.coverage / t.asked : undefined,
      fallbacks: t.fallbacks,
      lastError: t.lastError,
      games: t.games.length,
      meanScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : undefined,
      bestScore: scores.length ? Math.max(...scores) : 0,
      spark: t.latencies.slice(-40),
    };
  }, [decisions, tallies, policy]);

  return {
    canAsk,
    policy,
    setPolicy,
    speed,
    setSpeed,
    running,
    setRunning,
    gameNo,
    board,
    crash,
    decisions,
    moves,
    stats,
    stepOnce,
    reset,
  };
}

export type SnakeArena = ReturnType<typeof useSnakeArena>;
