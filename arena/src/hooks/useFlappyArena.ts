import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FLAP_THRESHOLD, type Flight, forcedFlap, newFlight, ruleFlap, tick } from "../../../games/flappy";
import { seededRandom } from "../../../games/snake";

/**
 * Flappy on a clock. Each tick has a budget; the judge's answer either comes
 * back inside it or the tick is a miss and the bird does nothing.
 *
 * One question in flight at a time. A late answer is not waited for — the
 * clock moves on without it — and no new question is sent until it lands,
 * because a queue of stale questions would make every later answer late
 * too. Those ticks count as misses as well. Like the snake arena, it lives
 * in App so a theme switch does not end the flight.
 */

export type FlapPolicy = "model" | "rule";
/** The tick is the budget: 60 ms is about 17 ticks a second, 20 ms fifty. */
export const BUDGETS = [60, 30, 20] as const;
export type Budget = (typeof BUDGETS)[number];

export interface Beat {
  /** P(flap) from the judge, when it answered in time. */
  p?: number;
  flap: boolean;
  rule: boolean;
  missed: boolean;
  /** Flapping would crash: the rule decided, nothing was asked. */
  forced?: boolean;
  /** How long the answer took, when there was one — late answers included. */
  ms?: number;
}

interface Tally {
  ticks: number;
  misses: number;
  asked: number;
  agreed: number;
  fallbacks: number;
  lastError?: string;
  flights: number[];
  latencies: number[];
}
const emptyTally = (): Tally => ({ ticks: 0, misses: 0, asked: 0, agreed: 0, fallbacks: 0, flights: [], latencies: [] });
const key = (p: FlapPolicy, b: Budget) => `${p}@${b}`;
const pct = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

type Answer = { p: number; ms: number } | { error: string; ms: number };

async function askFlap(flight: Flight): Promise<Answer> {
  const started = performance.now();
  try {
    const res = await fetch("/api/flappy/flap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flight }),
    });
    const data = (await res.json()) as { probability?: number; latencyMs?: number; error?: string };
    const ms = data.latencyMs ?? performance.now() - started;
    if (!res.ok || typeof data.probability !== "number") return { error: data.error ?? `HTTP ${res.status}`, ms };
    return { p: data.probability, ms };
  } catch (err) {
    return { error: String(err), ms: performance.now() - started };
  }
}

export function useFlappyArena(judge: string | undefined) {
  const canAsk = !!judge;
  const [policy, setPolicy] = useState<FlapPolicy>(canAsk ? "model" : "rule");
  const [budget, setBudget] = useState<Budget>(30);
  const [running, setRunning] = useState(false);
  const [flightNo, setFlightNo] = useState(1);
  const [flight, setFlight] = useState<Flight>(() => newFlight(seededRandom(1)));
  const [crash, setCrash] = useState<string | null>(null);
  const [beats, setBeats] = useState<Beat[]>([]);
  const [tallies, setTallies] = useState<Record<string, Tally>>({});

  const flightRef = useRef(flight);
  const randomRef = useRef(seededRandom(1));
  const policyRef = useRef(policy);
  const budgetRef = useRef(budget);
  const noRef = useRef(1);
  const crashedRef = useRef(false);
  const inFlight = useRef<Promise<Answer> | null>(null);
  policyRef.current = policy;
  budgetRef.current = budget;

  const played = beats.length > 0;
  useEffect(() => {
    if (canAsk && !played) setPolicy("model");
  }, [canAsk, played]);

  const bump = useCallback((k: string, change: (t: Tally) => Tally) => {
    setTallies((all) => ({ ...all, [k]: change(all[k] ?? emptyTally()) }));
  }, []);

  const startFlight = useCallback((n: number) => {
    const random = seededRandom(n);
    randomRef.current = random;
    const f = newFlight(random);
    flightRef.current = f;
    noRef.current = n;
    crashedRef.current = false;
    setFlight(f);
    setFlightNo(n);
    setCrash(null);
  }, []);

  /** One tick: ask (or not), wait at most the budget, move the bird. */
  const advance = useCallback(async (): Promise<boolean> => {
    const f = flightRef.current;
    const p = policyRef.current;
    const b = budgetRef.current;
    const k = key(p, b);
    const rule = ruleFlap(f);
    let beat: Beat;

    const forced = forcedFlap(f);
    if (p === "rule") {
      beat = { flap: rule, rule, missed: false };
    } else if (forced !== undefined) {
      beat = { flap: forced, rule, missed: false, forced: true };
    } else if (inFlight.current) {
      beat = { flap: false, rule, missed: true }; // still waiting on an earlier question
    } else {
      const question = askFlap(f);
      inFlight.current = question;
      question.then((a) => {
        inFlight.current = null;
        if ("error" in a) bump(k, (t) => ({ ...t, fallbacks: t.fallbacks + 1, lastError: a.error }));
        else bump(k, (t) => ({ ...t, latencies: [...t.latencies.slice(-199), a.ms] }));
      });
      const timer = new Promise<null>((r) => setTimeout(() => r(null), b));
      const a = await Promise.race([question, timer]);
      if (a && !("error" in a)) {
        const flap = a.p >= FLAP_THRESHOLD;
        beat = { p: a.p, flap, rule, missed: false, ms: a.ms };
        bump(k, (t) => ({ ...t, asked: t.asked + 1, agreed: t.agreed + (flap === rule ? 1 : 0) }));
      } else {
        beat = { flap: false, rule, missed: true, ...(a && { ms: a.ms }) };
      }
    }

    bump(k, (t) => ({ ...t, ticks: t.ticks + 1, misses: t.misses + (beat.missed ? 1 : 0) }));
    setBeats((prev) => [...prev.slice(-239), beat]);

    const r = tick(f, beat.flap, randomRef.current);
    if (r.dead) {
      crashedRef.current = true;
      bump(k, (t) => ({ ...t, flights: [...t.flights, r.flight.score] }));
      setCrash(`crashed · ${r.flight.score} ${r.flight.score === 1 ? "pipe" : "pipes"}`);
      setFlight(r.flight);
      return false;
    }
    flightRef.current = r.flight;
    setFlight(r.flight);
    return true;
  }, [bump]);

  useEffect(() => {
    if (!running) return;
    let stopped = false;
    (async () => {
      while (!stopped) {
        if (crashedRef.current) startFlight(noRef.current + 1);
        const started = performance.now();
        const alive = await advance();
        if (stopped) return;
        if (!alive) {
          await new Promise((r) => setTimeout(r, 1100));
          if (stopped) return;
          startFlight(noRef.current + 1);
          continue;
        }
        // The clock: one tick per budget, however quickly this one was answered.
        const wait = budgetRef.current - (performance.now() - started);
        await new Promise((r) => setTimeout(r, Math.max(0, wait)));
      }
    })();
    return () => {
      stopped = true;
    };
  }, [running, advance, startFlight]);

  const reset = useCallback(() => {
    setRunning(false);
    setBeats([]);
    setTallies({});
    startFlight(1);
  }, [startFlight]);

  const stats = useMemo(() => {
    const t = tallies[key(policy, budget)] ?? emptyTally();
    const lat = [...t.latencies].sort((a, b) => a - b);
    return {
      ticks: t.ticks,
      missRate: t.ticks ? t.misses / t.ticks : undefined,
      p50: lat.length ? pct(lat, 0.5) : undefined,
      p95: lat.length ? pct(lat, 0.95) : undefined,
      overBudget: lat.length ? lat.filter((ms) => ms > budget).length / lat.length : undefined,
      agree: t.asked ? t.agreed / t.asked : undefined,
      asked: t.asked,
      fallbacks: t.fallbacks,
      lastError: t.lastError,
      flights: t.flights.length,
      meanPipes: t.flights.length ? t.flights.reduce((a, b) => a + b, 0) / t.flights.length : undefined,
      bestPipes: t.flights.length ? Math.max(...t.flights) : 0,
      spark: t.latencies.slice(-48),
    };
  }, [tallies, policy, budget]);

  return {
    canAsk,
    policy,
    setPolicy,
    budget,
    setBudget,
    running,
    setRunning,
    flightNo,
    flight,
    crash,
    beats,
    stats,
    reset,
  };
}

export type FlappyArena = ReturnType<typeof useFlappyArena>;
