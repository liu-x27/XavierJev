/**
 * Measure the stop judges on the labelled runs in `cases.ts`.
 *
 * Two errors, weighted differently. A **wrong stop** ends a run that was
 * getting somewhere, and the user has to notice and start it again. A
 * **missed stop** lets a stuck run go on until `maxTurns`, which is bounded.
 * So the number to read first is wrong stops, and a judge with any is worse
 * than one that misses more.
 *
 * Run: npm run eval:stop
 *      npm run eval:stop -- --cases test     (held out: log the read in testset.ts)
 */

import chalk from "chalk";
import { LlmJudge } from "../../src/llm.js";
import { createRepeatStopJudge, createStopJudge } from "../../src/stop.js";
import type { RunTrace, StopJudge } from "../../src/decisions.js";
import { logger } from "../../src/log.js";
import { STOP_CASES, type StopCase, type StopKind } from "./cases.js";
import { STOP_TEST_CASES } from "./testset.js";

logger.setLevel("error");
const which = process.argv.includes("--cases") ? process.argv[process.argv.indexOf("--cases") + 1] : "dev";
const CASES = which === "test" ? STOP_TEST_CASES : STOP_CASES;
if (which === "test") console.log(chalk.yellow.bold("\n⚠  This run reads the held-out set. Log it in testset.ts."));

const primary = (input: Record<string, unknown>) =>
  String(input["command"] ?? input["file_path"] ?? input["pattern"] ?? input["url"] ?? JSON.stringify(input));

function traceOf(c: StopCase): RunTrace {
  return {
    prompt: c.prompt,
    turn: c.calls.length,
    recent: c.calls.map(([tool, input, ok, outcome]) => ({ tool, input, summary: `${tool}(${primary(input)})`, ok, outcome })),
  };
}

const judge = new LlmJudge();
const capability = await judge.probe();
if (!capability.logprobs) {
  console.error(`${judge.name}: ${capability.detail}`);
  process.exit(2);
}

const model = createStopJudge({ backend: judge });
const judges: Array<[string, StopJudge]> = [
  ["repeats", createRepeatStopJudge()],
  ["model", model],
  [
    "either",
    async (t) => {
      const a = await createRepeatStopJudge()(t);
      return a.stop ? a : model(t);
    },
  ],
];

const kinds: StopKind[] = ["exact", "variant", "explore", "fixed", "polling", "converging"];
console.log(chalk.bold(`\n${judge.name} · ${CASES.length} runs\n`));
console.log(`${"".padEnd(9)} ${kinds.map((k) => k.padStart(10)).join("")}   wrong stops  missed stops`);

for (const [name, j] of judges) {
  const stopped = new Map<StopKind, number>();
  let wrong = 0;
  let missed = 0;
  const notes: string[] = [];
  for (const c of CASES) {
    const v = await j(traceOf(c));
    if (v.stop) stopped.set(c.kind, (stopped.get(c.kind) ?? 0) + 1);
    if (v.stop && !c.stuck) {
      wrong++;
      notes.push(chalk.red(`  ${name} stopped "${c.name}" (${v.reason})`));
    }
    if (!v.stop && c.stuck) {
      missed++;
      if (name === "model") notes.push(chalk.gray(`  model kept going on "${c.name}" (${v.reason})`));
    }
  }
  const cells = kinds.map((k) => {
    const total = CASES.filter((c) => c.kind === k).length;
    return `${stopped.get(k) ?? 0}/${total}`.padStart(10);
  });
  console.log(`${name.padEnd(9)} ${cells.join("")}   ${String(wrong).padStart(11)}  ${String(missed).padStart(12)}`);
  for (const n of notes) console.log(n);
}
console.log(chalk.gray("\ncells: runs stopped, of that kind. exact and variant should stop; the rest should not.\n"));
