/**
 * How many decisions a second one local judge can make, and what waiting
 * costs, as more callers ask at once.
 *
 * Every arena game asks one question at a time; the risk gate asks four at
 * once, for one tool call. This measures what happens in between and past
 * that: c callers, each sending its next question as soon as the last one
 * returns, the snake arena's `choice()` question on boards from real games.
 * Throughput is decisions finished per wall-clock second; latency is each
 * question's own round trip, queueing included, because a caller waiting in
 * line is waiting.
 *
 * Run: npm run eval:throughput
 *      npm run eval:throughput -- --concurrency 1,2,4,8 --requests 96 --json a.json
 *      npm run eval:throughput -- --render a.json,b.json --svg docs/throughput.svg
 */

import chalk from "chalk";
import { readFileSync, writeFileSync } from "node:fs";
import { LlmJudge } from "../../src/llm.js";
import { type Board, newBoard, ruleMove, seededRandom, snakeQuestion, step } from "../../games/snake.js";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
};

interface Level {
  concurrency: number;
  perSecond: number;
  p50: number;
  p95: number;
}
interface Series {
  label: string;
  levels: Level[];
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;

// ─────────────────────────────────────────────
// Chart
// ─────────────────────────────────────────────
function renderSvg(series: Series[]): string {
  const W = 760;
  const H = 300;
  const pad = { l: 56, r: 56, t: 34, b: 44 };
  const xs = series[0]!.levels.map((l) => l.concurrency);
  const maxRate = Math.max(...series.flatMap((s) => s.levels.map((l) => l.perSecond))) * 1.15;
  const maxLat = Math.max(...series.flatMap((s) => s.levels.map((l) => l.p95))) * 1.15;
  const x = (i: number) => pad.l + (i * (W - pad.l - pad.r)) / Math.max(1, xs.length - 1);
  const yRate = (v: number) => H - pad.b - (v / maxRate) * (H - pad.t - pad.b);
  const yLat = (v: number) => H - pad.b - (v / maxLat) * (H - pad.t - pad.b);
  const colours = ["#8fb4ff", "#c4f24c", "#ff9f6e"];
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="11">`);
  parts.push(`<rect width="${W}" height="${H}" rx="10" fill="#0f1013"/>`);
  for (let k = 0; k <= 4; k++) {
    const y = pad.t + (k * (H - pad.t - pad.b)) / 4;
    parts.push(`<line x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}" stroke="#1e2127"/>`);
    parts.push(`<text x="${pad.l - 8}" y="${y + 4}" text-anchor="end" fill="#9096a0">${Math.round(maxRate * (1 - k / 4))}</text>`);
    parts.push(`<text x="${W - pad.r + 8}" y="${y + 4}" fill="#5b616b">${Math.round(maxLat * (1 - k / 4))}</text>`);
  }
  xs.forEach((c, i) => parts.push(`<text x="${x(i)}" y="${H - pad.b + 18}" text-anchor="middle" fill="#9096a0">${c}</text>`));
  parts.push(`<text x="${(pad.l + W - pad.r) / 2}" y="${H - 8}" text-anchor="middle" fill="#9096a0">callers asking at once</text>`);
  parts.push(`<text x="14" y="20" fill="#ecedee">decisions/s</text>`);
  parts.push(`<text x="${W - 14}" y="20" text-anchor="end" fill="#5b616b">p95 ms (dashed)</text>`);
  series.forEach((s, si) => {
    const colour = colours[si % colours.length]!;
    const rate = s.levels.map((l, i) => `${x(i)},${yRate(l.perSecond)}`).join(" ");
    const lat = s.levels.map((l, i) => `${x(i)},${yLat(l.p95)}`).join(" ");
    parts.push(`<polyline points="${rate}" fill="none" stroke="${colour}" stroke-width="2.5"/>`);
    parts.push(`<polyline points="${lat}" fill="none" stroke="${colour}" stroke-width="1.5" stroke-dasharray="5 4" opacity="0.7"/>`);
    s.levels.forEach((l, i) => parts.push(`<circle cx="${x(i)}" cy="${yRate(l.perSecond)}" r="3.5" fill="${colour}"/>`));
    parts.push(`<rect x="${pad.l + 12}" y="${pad.t + 6 + si * 18}" width="12" height="3" fill="${colour}"/>`);
    parts.push(`<text x="${pad.l + 30}" y="${pad.t + 11 + si * 18}" fill="#ecedee">${s.label}</text>`);
  });
  parts.push("</svg>");
  return parts.join("\n");
}

const render = arg("render", "");
if (render) {
  const series = render.split(",").map((f) => JSON.parse(readFileSync(f, "utf8")) as Series);
  const out = arg("svg", "docs/throughput.svg");
  writeFileSync(out, renderSvg(series) + "\n");
  console.log(`wrote ${out}`);
  process.exit(0);
}

// ─────────────────────────────────────────────
// Measure
// ─────────────────────────────────────────────
const LEVELS = arg("concurrency", "1,2,4,8,16").split(",").map(Number);
const REQUESTS = Number(arg("requests", "96"));
const LABEL = arg("label", `${process.env.AGENT_JUDGE_BASE_URL ?? "default"}`);

const judge = new LlmJudge();
const capability = await judge.probe();
if (!capability.logprobs) {
  console.error(`${judge.name}: ${capability.detail}`);
  process.exit(2);
}

// Boards from a game the rule plays, so the questions are the arena's own.
const boards: Board[] = [];
{
  const random = seededRandom(11);
  let board = newBoard(12, random);
  while (boards.length < REQUESTS) {
    const q = snakeQuestion(board);
    if (q.options.length >= 2) boards.push(board);
    const r = step(board, ruleMove(board) ?? "up", random);
    board = r.dead || r.won ? newBoard(12, random) : r.board;
  }
}

async function level(concurrency: number): Promise<Level> {
  const latencies: number[] = [];
  let next = 0;
  const worker = async () => {
    while (next < boards.length) {
      const q = snakeQuestion(boards[next++]!);
      const t0 = performance.now();
      await judge.choice(q.state, q.ask, q.options);
      latencies.push(performance.now() - t0);
    }
  };
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const seconds = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  return { concurrency, perSecond: boards.length / seconds, p50: pct(latencies, 0.5), p95: pct(latencies, 0.95) };
}

console.log(chalk.bold(`\n${judge.name} at ${LABEL} · ${REQUESTS} snake decisions per level\n`));
await level(1); // warm the model and the cache
const levels: Level[] = [];
for (const c of LEVELS) {
  const l = await level(c);
  levels.push(l);
  console.log(
    `${String(c).padStart(3)} at once  ${chalk.bold(l.perSecond.toFixed(1).padStart(6))} decisions/s` +
      `  ×${(l.perSecond / levels[0]!.perSecond).toFixed(2)}` +
      `  p50 ${l.p50.toFixed(0).padStart(4)} ms  p95 ${l.p95.toFixed(0).padStart(4)} ms`,
  );
}
const json = arg("json", "");
if (json) {
  writeFileSync(json, JSON.stringify({ label: LABEL, levels } satisfies Series, null, 2));
  console.log(chalk.gray(`\nwrote ${json}`));
}
console.log();
