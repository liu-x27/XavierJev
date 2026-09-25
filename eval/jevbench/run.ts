/**
 * The three primitives on JevBench's public tasks.
 *
 *   npm run eval:jevbench -- --dir path/to/jevbench --out runs/jevbench.jsonl
 *   python eval/jevbench/score.py --dir path/to/jevbench --results runs/jevbench.jsonl
 *
 * [JevBench](https://github.com/fstandhartinger/jevbench) (MIT) is an
 * independent benchmark of Jev-style typed decisions. Its public tiers are 231
 * tasks — easy, original and hard — written by hand or by two LLMs (Claude Opus
 * 5 and GPT-5.6 Sol); none of the labels comes from Jev. This reads only
 * `datasets/public/*.jsonl` and is scored by JevBench's own scoring code. It
 * never reads `results/`, where JevBench keeps Jev's per-task answers, and does
 * not use the harness's Jev adapter.
 *
 * The mapping is the obvious one: a `noul` task goes to `noul()` with its two
 * criteria spelled out, a `choice` task to `choice()` with one option per
 * label, a `score` task to `rubric()` with one level per label, and the task's
 * state goes in as a single value. Hard-tier states run to about 15,000
 * characters, so the judge needs a context window of at least 8k tokens; with
 * Ollama, a model built `FROM llama3.1:8b` with `PARAMETER num_ctx 16384`.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { LlmJudge } from "../../src/llm.js";
import { logger } from "../../src/log.js";

logger.setLevel("error");

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const DIR = arg("dir");
const OUT = arg("out");
const TIERS = (arg("tiers") ?? "easy,original,hard").split(",");
if (!DIR || !OUT) {
  console.error(
    "usage: eval/jevbench/run.ts --dir <jevbench checkout> --out <results.jsonl> [--tiers easy,original,hard]",
  );
  process.exit(2);
}

interface Task {
  id: string;
  state: string;
  labels: string[];
  question: { type: "noul" | "choice" | "score"; instructions: string; criteria?: unknown };
}

const judge = new LlmJudge();
const capability = await judge.probe();
if (!capability.logprobs || !capability.firstTokenUsable) {
  console.error(`the judge cannot be used: ${capability.detail}`);
  process.exit(2);
}
const model = process.env.AGENT_JUDGE_MODEL ?? "?";

async function answer(
  task: Task,
): Promise<{ probs: Record<string, number>; coverage: number | undefined }> {
  const state = { input: task.state };
  const { type, instructions, criteria } = task.question;
  if (type === "noul") {
    const c = (criteria ?? {}) as { true?: string; false?: string };
    const ask =
      c.true && c.false ? `${instructions} (Yes: ${c.true}. No: ${c.false}.)` : instructions;
    const [a] = await judge.noul(state, [{ id: "decision", ask }]);
    if (!a) throw new Error("no answer");
    return { probs: { yes: a.probability, no: 1 - a.probability }, coverage: a.coverage };
  }
  if (type === "choice") {
    const c = (criteria ?? {}) as Record<string, string>;
    const r = await judge.choice(
      state,
      instructions,
      task.labels.map((label) => ({ id: label, text: c[label] ?? label })),
    );
    return {
      probs: Object.fromEntries(r.answers.map((a) => [a.id, a.probability])),
      coverage: r.coverage,
    };
  }
  const levels = (Array.isArray(criteria) ? criteria : []) as string[];
  const r = await judge.rubric(
    state,
    instructions,
    task.labels.map((label, i) => ({ score: Number(label), text: levels[i] ?? label })),
  );
  return {
    probs: Object.fromEntries(r.distribution.map((d) => [String(d.score), d.probability])),
    coverage: r.coverage,
  };
}

// Each record is appended as soon as it is made, and a task already answered in
// OUT is not asked again: a run that is stopped picks up where it was.
const done = new Set<string>();
if (existsSync(OUT)) {
  for (const line of readFileSync(OUT, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as { task_id: string; ok: boolean };
    if (r.ok) done.add(r.task_id);
  }
}
const write = (record: object) => appendFileSync(OUT, `${JSON.stringify(record)}\n`);

for (const tier of TIERS) {
  const tasks = readFileSync(path.join(DIR, "datasets", "public", `${tier}.jsonl`), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Task);
  let failed = 0;
  let skipped = 0;
  for (const task of tasks) {
    if (done.has(task.id)) {
      skipped++;
      continue;
    }
    const started = performance.now();
    try {
      const { probs, coverage } = await answer(task);
      write({
        task_id: task.id,
        ok: true,
        probs,
        coverage,
        probs_source: "first-token logprobs",
        latency_s: (performance.now() - started) / 1000,
        cost_usd: 0,
        cost_basis: "local",
        model,
      });
    } catch (err) {
      failed++;
      write({
        task_id: task.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        latency_s: (performance.now() - started) / 1000,
        cost_usd: 0,
        cost_basis: "local",
        model,
      });
    }
  }
  console.log(`${tier}: ${tasks.length} tasks, ${skipped} already answered, ${failed} failed`);
}
console.log(`records in ${OUT}`);
