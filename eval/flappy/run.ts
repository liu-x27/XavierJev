/**
 * Measure the judge flying Flappy against a clock.
 *
 * - **Decisions.** Ticks sampled from flights the rule flies, asked once
 *   each: how often the judge's P(flap) ≥ FLAP_THRESHOLD agrees with the
 *   rule, and how long one decision takes. Ticks where flapping would crash
 *   are the rule's to decide and are not asked.
 * - **Games under a deadline.** Whole flights where each tick has a budget.
 *   An answer slower than the budget is a miss: the bird does nothing that
 *   tick, and the ticks the request was still in flight for are misses too,
 *   because the browser asks one question at a time and a queue of stale
 *   ones would only make every later answer late.
 *
 * Run: npm run eval:flappy
 *      npm run eval:flappy -- --ticks 150 --games 3 --budgets 1000,60,40
 */

import chalk from "chalk";
import { LlmJudge } from "../../src/llm.js";
import {
  FLAP_QUESTION,
  FLAP_THRESHOLD,
  type Flight,
  flapState,
  forcedFlap,
  newFlight,
  ruleFlap,
  tick,
} from "../../games/flappy.js";
import { seededRandom } from "../../games/snake.js";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
};

const TICKS = Number(arg("ticks", "200"));
const GAMES = Number(arg("games", "3"));
const SEED = Number(arg("seed", "7"));
const MAX_TICKS = Number(arg("max-ticks", "900"));
const BUDGETS = arg("budgets", "1000,60,40").split(",").map(Number);

const judge = new LlmJudge();
const capability = await judge.probe();
if (!capability.logprobs) {
  console.error(`${judge.name}: ${capability.detail} — the judge needs logprobs`);
  process.exit(2);
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;

async function ask(f: Flight): Promise<{ flap: boolean; p: number; ms: number }> {
  const forced = forcedFlap(f);
  if (forced !== undefined) return { flap: forced, p: forced ? 1 : 0, ms: 0 };
  const t0 = performance.now();
  const [answer] = await judge.noul(flapState(f), [FLAP_QUESTION]);
  const p = answer?.probability ?? 0;
  return { flap: p >= FLAP_THRESHOLD, p, ms: performance.now() - t0 };
}

// ─────────────────────────────────────────────
// Decisions
// ─────────────────────────────────────────────
console.log(chalk.bold(`\n${judge.name} · ${TICKS} ticks sampled from the rule's flights, seed ${SEED}\n`));

const samples: Flight[] = [];
{
  const random = seededRandom(SEED);
  const pick = seededRandom(SEED + 1);
  let f = newFlight(random);
  while (samples.length < TICKS) {
    if (pick() < 0.25) samples.push(f);
    const r = tick(f, ruleFlap(f), random);
    f = r.dead ? newFlight(random) : r.flight;
  }
}

let agree = 0;
let flapsWanted = 0;
let flapsCaught = 0;
const ms: number[] = [];
for (const f of samples) {
  const r = await ask(f);
  ms.push(r.ms);
  const rule = ruleFlap(f);
  if (r.flap === rule) agree++;
  if (rule) {
    flapsWanted++;
    if (r.flap) flapsCaught++;
  }
}
ms.sort((a, b) => a - b);
console.log(
  `agrees with the rule ${chalk.bold(`${((100 * agree) / samples.length).toFixed(0)}%`)}` +
    `  flaps the rule wanted ${flapsCaught}/${flapsWanted}` +
    `  p50 ${pct(ms, 0.5).toFixed(0)} ms  p95 ${pct(ms, 0.95).toFixed(0)} ms  max ${ms.at(-1)!.toFixed(0)} ms`,
);

// ─────────────────────────────────────────────
// Games under a deadline
// ─────────────────────────────────────────────
console.log(chalk.bold(`\n${GAMES} flights per budget, up to ${MAX_TICKS} ticks\n`));

async function fly(budget: number, seed: number) {
  const random = seededRandom(seed);
  let f = newFlight(random);
  let misses = 0;
  let busyFor = 0; // ticks still covered by a late answer
  for (let t = 0; t < MAX_TICKS; t++) {
    let flap = false;
    if (busyFor > 0) {
      busyFor--;
      misses++;
    } else {
      const r = await ask(f);
      if (r.ms <= budget) flap = r.flap;
      else {
        misses++;
        busyFor = Math.ceil(r.ms / budget) - 1;
      }
    }
    const next = tick(f, flap, random);
    if (next.dead) return { score: next.flight.score, ticks: t + 1, misses, crashed: true };
    f = next.flight;
  }
  return { score: f.score, ticks: MAX_TICKS, misses, crashed: false };
}

for (const budget of BUDGETS) {
  const runs = [];
  for (let g = 0; g < GAMES; g++) runs.push(await fly(budget, SEED * 100 + g));
  const ticks = runs.reduce((a, r) => a + r.ticks, 0);
  const misses = runs.reduce((a, r) => a + r.misses, 0);
  console.log(
    `budget ${String(budget).padStart(4)} ms  pipes ${runs.map((r) => `${r.score}${r.crashed ? "" : "+"}`).join(" ")}` +
      `  missed ${((100 * misses) / ticks).toFixed(1)}% of ${ticks} ticks`,
  );
}
console.log(chalk.gray("\n+ = still flying at the tick limit\n"));
