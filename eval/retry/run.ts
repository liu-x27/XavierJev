/**
 * Measure the retry judge on the labelled failures in `cases.ts`, beside
 * `patternRetryJudge`, the pattern list the server uses by default.
 *
 * Two errors, and they cost different things. A **wasted retry** — trying a
 * 404 again — costs one call that was always going to fail. A **missed
 * retry** — handing a 503 to the model — costs what the judge was meant to
 * save: a turn, in which the model usually retries it itself. Neither is
 * dangerous, because only calls that change nothing are ever retried; this
 * measures whether the judge saves anything, not whether it is safe.
 *
 * Run: npm run eval:retry
 */

import chalk from "chalk";
import { createRetryJudge, patternRetryJudge } from "../../src/retry.js";
import { LlmJudge } from "../../src/llm.js";
import { RETRY_CASES } from "./cases.js";

const judge = new LlmJudge();
const capability = await judge.probe();
if (!capability.logprobs) {
  console.error(`${judge.name}: ${capability.detail}`);
  process.exit(2);
}
const retry = createRetryJudge({ backend: judge });

type Tally = { right: number; wasted: string[]; missed: string[] };
const tally = (): Tally => ({ right: 0, wasted: [], missed: [] });
const byJudge = tally();
const byPattern = tally();
const ms: number[] = [];

for (const c of RETRY_CASES) {
  const v = await retry({ toolName: c.tool, summary: c.call, error: c.error });
  if (v.latencyMs !== undefined) ms.push(v.latencyMs);
  for (const [t, said] of [
    [byJudge, v.retry],
    [byPattern, (await patternRetryJudge({ toolName: c.tool, summary: c.call, error: c.error })).retry],
  ] as const) {
    if (said === c.transient) t.right++;
    else (said ? t.wasted : t.missed).push(c.error.slice(0, 90));
  }
  if (v.retry !== c.transient) {
    console.log(chalk.gray(`  judge ${v.retry ? "retried" : "did not retry"} at ${v.probability?.toFixed(3)}: ${c.error.slice(0, 80)}`));
  }
}

ms.sort((a, b) => a - b);
const n = RETRY_CASES.length;
const transient = RETRY_CASES.filter((c) => c.transient).length;
console.log(chalk.bold(`\n${judge.name} · ${n} failures, ${transient} transient\n`));
for (const [name, t] of [
  ["judge", byJudge],
  ["patterns", byPattern],
] as const) {
  console.log(
    `${name.padEnd(9)} right ${chalk.bold(`${t.right}/${n}`)}  wasted retries ${t.wasted.length}/${n - transient}  missed retries ${t.missed.length}/${transient}`,
  );
}
console.log(chalk.gray(`\njudge p50 ${ms[ms.length >> 1]} ms, p95 ${ms[Math.floor(ms.length * 0.95)]} ms`));
for (const [name, t] of [
  ["judge", byJudge],
  ["patterns", byPattern],
] as const) {
  for (const e of t.wasted) console.log(chalk.yellow(`  ${name} wasted: ${e}`));
  for (const e of t.missed) console.log(chalk.red(`  ${name} missed: ${e}`));
}
console.log();
