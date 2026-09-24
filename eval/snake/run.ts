/**
 * Measure the judge's `choice()` on the snake arena's question.
 *
 * Two parts, because they answer different questions:
 *
 * - **Decisions.** Random boards with known-good answers, asked once each in
 *   both question modes. Does the move survive, is it the best available,
 *   does it walk into a dead end, how much of the first token's probability
 *   landed on the option labels, and how long one decision takes.
 * - **Games.** Whole games played to the end, by the model and by the
 *   hand-written rule over the same facts: score, length of game, how often
 *   the model agreed with the rule, decisions per second.
 *
 * The boards and the food come from a seeded generator, so a rerun asks the
 * same questions. The judge is not bit-deterministic across runs even at
 * temperature 0, so the numbers can move by a decision or two.
 *
 * Run: npm run eval:snake
 *      npm run eval:snake -- --boards 150 --games 5 --seed 7
 */

import chalk from "chalk";
import { LlmJudge } from "../../src/llm.js";
import {
  DIRECTIONS,
  type Board,
  type Direction,
  type Point,
  legalMoves,
  moveFacts,
  newBoard,
  ruleMove,
  seededRandom,
  snakeQuestion,
  step,
  type QuestionMode,
} from "../../games/snake.js";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
};

const BOARDS = Number(arg("boards", "150"));
const GAMES = Number(arg("games", "5"));
const SEED = Number(arg("seed", "7"));
const SIZE = Number(arg("size", "12"));
const MAX_STEPS = Number(arg("max-steps", "600"));

const judge = new LlmJudge();
const capability = await judge.probe();
if (!capability.logprobs) {
  console.error(`${judge.name}: ${capability.detail} — choice() needs logprobs`);
  process.exit(2);
}

/** A snake grown by a random self-avoiding walk, with food somewhere free. */
function randomBoard(random: () => number): Board {
  for (;;) {
    const length = 3 + Math.floor(random() * 20);
    const snake: Point[] = [{ x: 1 + Math.floor(random() * (SIZE - 2)), y: 1 + Math.floor(random() * (SIZE - 2)) }];
    while (snake.length < length) {
      const last = snake[snake.length - 1]!;
      const next = DIRECTIONS.map((d) => ({ x: last.x + (d === "right" ? 1 : d === "left" ? -1 : 0), y: last.y + (d === "down" ? 1 : d === "up" ? -1 : 0) })).filter(
        (p) => p.x >= 0 && p.y >= 0 && p.x < SIZE && p.y < SIZE && !snake.some((s) => s.x === p.x && s.y === p.y),
      );
      if (next.length === 0) break;
      snake.push(next[Math.floor(random() * next.length)]!);
    }
    if (snake.length < length) continue;
    snake.reverse(); // head first
    const free: Point[] = [];
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (!snake.some((s) => s.x === x && s.y === y)) free.push({ x, y });
    const board = { size: SIZE, snake, food: free[Math.floor(random() * free.length)]! };
    if (legalMoves(board).length >= 2) return board; // one legal move is not a decision
  }
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
const argmax = (answers: { id: string; probability: number }[]) =>
  answers.reduce((a, b) => (b.probability > a.probability ? b : a)).id as Direction;

// ─────────────────────────────────────────────
// Decisions
// ─────────────────────────────────────────────
console.log(chalk.bold(`\n${judge.name} · ${BOARDS} boards, ${SIZE}×${SIZE}, seed ${SEED}\n`));

const random = seededRandom(SEED);
const boards = Array.from({ length: BOARDS }, () => randomBoard(random));

for (const mode of ["facts", "raw"] as QuestionMode[]) {
  let survives = 0;
  let best = 0;
  let bestPossible = 0;
  let deadEnd = 0;
  let deadEndPossible = 0;
  let coverage = 0;
  let failures = 0;
  const ms: number[] = [];

  for (const board of boards) {
    const q = snakeQuestion(board, mode);
    const t0 = performance.now();
    let pick: Direction;
    try {
      const r = await judge.choice(q.state, q.ask, q.options);
      ms.push(performance.now() - t0);
      coverage += r.coverage;
      pick = argmax(r.answers);
    } catch {
      failures++;
      continue;
    }
    const facts = moveFacts(board);
    const chosen = facts.find((f) => f.dir === pick);
    if (chosen) survives++;
    const roomy = facts.filter((f) => !f.deadEnd);
    const good = roomy.filter((f) => f.eats || f.closer);
    if (good.length) {
      bestPossible++;
      if (good.some((f) => f.dir === pick)) best++;
    }
    if (roomy.length && roomy.length < facts.length) {
      deadEndPossible++;
      if (chosen?.deadEnd) deadEnd++;
    }
  }

  ms.sort((a, b) => a - b);
  const n = ms.length;
  console.log(
    `${chalk.bold(mode.padEnd(5))}  survives ${chalk.bold(`${((100 * survives) / n).toFixed(0)}%`)}` +
      `  best move ${best}/${bestPossible}` +
      `  into a dead end ${deadEnd}/${deadEndPossible}` +
      `  coverage ${(coverage / n).toFixed(3)}` +
      `  p50 ${pct(ms, 0.5).toFixed(0)} ms  p95 ${pct(ms, 0.95).toFixed(0)} ms` +
      (failures ? chalk.red(`  ${failures} failed`) : ""),
  );
}

// ─────────────────────────────────────────────
// Games
// ─────────────────────────────────────────────
console.log(chalk.bold(`\n${GAMES} games each, up to ${MAX_STEPS} moves\n`));

async function play(policy: "model" | "rule", seed: number) {
  const random = seededRandom(seed);
  let board = newBoard(SIZE, random);
  let score = 0;
  let steps = 0;
  let asked = 0;
  let agreed = 0;
  let fallbacks = 0;
  let decisionMs = 0;
  let end = "move limit";

  while (steps < MAX_STEPS) {
    const legal = legalMoves(board);
    if (legal.length === 0) {
      end = "boxed in";
      break;
    }
    const rule = ruleMove(board)!;
    let dir = rule;
    if (policy === "model" && legal.length > 1) {
      const q = snakeQuestion(board, "facts");
      const t0 = performance.now();
      try {
        const r = await judge.choice(q.state, q.ask, q.options);
        dir = argmax(r.answers);
        asked++;
        if (dir === rule) agreed++;
      } catch {
        fallbacks++;
      }
      decisionMs += performance.now() - t0;
    }
    const next = step(board, dir, random);
    steps++;
    if (next.dead) {
      end = "crashed";
      break;
    }
    if (next.ate) score++;
    board = next.board;
    if (next.won) {
      end = "filled the board";
      break;
    }
  }
  return { score, steps, end, asked, agreed, fallbacks, decisionMs };
}

for (const policy of ["rule", "model"] as const) {
  const results = [];
  for (let g = 0; g < GAMES; g++) results.push(await play(policy, SEED * 1000 + g));
  const scores = results.map((r) => r.score);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const asked = results.reduce((a, r) => a + r.asked, 0);
  const agreed = results.reduce((a, r) => a + r.agreed, 0);
  const fallbacks = results.reduce((a, r) => a + r.fallbacks, 0);
  const ms = results.reduce((a, r) => a + r.decisionMs, 0);
  const ends = results.map((r) => r.end).join(", ");
  console.log(
    `${chalk.bold(policy.padEnd(5))}  mean score ${chalk.bold(mean.toFixed(1))}  scores ${scores.join(" ")}` +
      `  (${ends})` +
      (policy === "model"
        ? `\n       ${asked} decisions, agreed with the rule on ${((100 * agreed) / Math.max(1, asked)).toFixed(0)}%` +
          `, ${(asked / (ms / 1000)).toFixed(1)} decisions/s` +
          (fallbacks ? chalk.red(`, ${fallbacks} fell back to the rule`) : "")
        : ""),
  );
}
console.log();
