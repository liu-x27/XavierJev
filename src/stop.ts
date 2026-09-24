import type { StopJudge, StopVerdict, TracedCall } from "./decisions.js";
import { logger } from "./log.js";
import type { JudgeBackend, NoulQuestion } from "./types.js";

/**
 * Deciding that a run should stop before the model says it is done.
 *
 * The loop already stops when the model ends its turn, and at `maxTurns`.
 * What is left to catch is the run that will reach `maxTurns` without getting
 * anywhere — the same failing call made again and again, or the same failing
 * approach in a slightly different form each time — because every turn of it
 * is paid for.
 *
 * The two errors are not equal. A missed stop costs turns until `maxTurns`,
 * which is bounded. A wrong stop interrupts a run that was working, and the
 * user has to notice and start it again. So both judges here are built to
 * stop late: they need several calls of evidence, and every failure of the
 * judge itself means "keep going".
 */

/** Stable key for a call: tool plus its input with keys in order. */
function callKey(c: TracedCall): string {
  const sorted = Object.keys(c.input)
    .sort()
    .map((k) => [k, c.input[k]]);
  return `${c.tool} ${JSON.stringify(sorted)}`;
}

export interface RepeatStopOptions {
  /** Stop once the same call has failed the same way this many times. Default 3. */
  repeats?: number;
}

/**
 * Stop when one call — same tool, same input — has failed the same way
 * `repeats` times among the recent calls. No model: comparing calls is what
 * finds this, and it cannot be wrong about what it compared.
 */
export function createRepeatStopJudge(options: RepeatStopOptions = {}): StopJudge {
  const repeats = options.repeats ?? 3;
  return async (trace) => {
    const counts = new Map<string, { n: number; call: TracedCall }>();
    for (const c of trace.recent) {
      if (c.ok) continue;
      const k = `${callKey(c)} → ${c.outcome}`;
      const entry = counts.get(k) ?? { n: 0, call: c };
      entry.n++;
      counts.set(k, entry);
    }
    for (const { n, call } of counts.values()) {
      if (n >= repeats) {
        return { stop: true, probability: undefined, reason: `${call.summary} failed ${n} times the same way`, latencyMs: 0 };
      }
    }
    return { stop: false, probability: undefined, reason: "no call has failed repeatedly the same way", latencyMs: 0 };
  };
}

/**
 * The question, and what it is shown, as measured on `eval/stop` (dev set,
 * 27 runs, llama3.1:8b). The first version showed the request and the calls
 * and asked whether the agent was "stuck … rather than making progress":
 * the stuck runs scored 0.90–1.00, but so did runs whose failures were
 * shrinking — 5 failing tests, then 3, then 1, at 0.95 — and one whose last
 * call had passed. It read "failed" and answered "stuck". Asking whether the
 * *results are changing*, and saying outright whether the last call
 * succeeded, put every progressing run at or below 0.71 and every stuck one
 * at or above 0.87.
 */
export const STOP_QUESTION: NoulQuestion = {
  id: "stuck",
  ask: "Do the recent calls keep ending in the same failure, with nothing in their results changing from one to the next?",
};

export interface StopJudgeOptions {
  backend: JudgeBackend;
  /**
   * Stop at or above this P(stuck). Default 0.8, in the gap the dev set left
   * between progressing runs (≤ 0.71) and stuck ones (≥ 0.87) — high, because
   * a wrong stop costs more than a missed one.
   */
  stopAt?: number;
  /** Do not ask until there are this many recent calls to judge. Default 4. */
  minCalls?: number;
  timeoutMs?: number;
}

/**
 * Ask a model whether the run is stuck, given the recent calls and their
 * outcomes. Meant for what comparing calls cannot see: the same failing
 * approach in a different form each time. Use it beside
 * `createRepeatStopJudge`, through `anyStopJudge` — see `eval/stop`.
 */
export function createStopJudge(options: StopJudgeOptions): StopJudge {
  const { backend } = options;
  const stopAt = options.stopAt ?? 0.8;
  const minCalls = options.minCalls ?? 4;
  const timeoutMs = options.timeoutMs ?? 2000;

  return async (trace): Promise<StopVerdict> => {
    if (trace.recent.length < minCalls) {
      return { stop: false, probability: undefined, reason: `fewer than ${minCalls} calls to judge`, latencyMs: 0 };
    }
    const started = Date.now();
    const state = {
      "recent calls": trace.recent
        .map((c, i) => `${i + 1}. ${c.summary} → ${c.ok ? "ok" : "failed"}: ${c.outcome.slice(0, 120)}`)
        .join("\n"),
      "last call": trace.recent.at(-1)!.ok ? "succeeded" : "failed",
    };
    let timer: NodeJS.Timeout | undefined;
    try {
      const answers = await Promise.race([
        backend.noul(state, [STOP_QUESTION]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer in ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
      const p = answers.find((a) => a.id === STOP_QUESTION.id)?.probability;
      const latencyMs = Date.now() - started;
      if (typeof p !== "number" || !(p >= 0 && p <= 1)) {
        return { stop: false, probability: undefined, reason: "the judge gave no probability", latencyMs };
      }
      return p >= stopAt
        ? { stop: true, probability: p, reason: `P(stuck)=${p.toFixed(3)} ≥ ${stopAt}`, latencyMs }
        : { stop: false, probability: p, reason: `P(stuck)=${p.toFixed(3)} < ${stopAt}`, latencyMs };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Stop judge ${backend.name} failed: ${message}`);
      return { stop: false, probability: undefined, reason: `judge failed: ${message}`, latencyMs: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Stop when any of `judges` says to, asking them in order and stopping at the
 * first yes — so a cheap judge that is sure goes before one that costs a
 * model call.
 *
 * On `eval/stop` the pair `createRepeatStopJudge` then `createStopJudge`
 * made no wrong stops and missed none, on the dev set (27 runs, where the
 * model's wording was chosen) and on a held-out set of 12 read once. Either
 * alone missed some: the repeat check every run that fails the same way in a
 * different form (4 of 12 held out), the model every run too short for it to
 * be asked (1 of 12).
 */
export function anyStopJudge(...judges: StopJudge[]): StopJudge {
  return async (trace) => {
    let last: StopVerdict = { stop: false, probability: undefined, reason: "no judge", latencyMs: 0 };
    for (const judge of judges) {
      last = await judge(trace);
      if (last.stop) return last;
    }
    return last;
  };
}
