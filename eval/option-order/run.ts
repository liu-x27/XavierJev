/**
 * Does the order options are listed in move the answer? For all three primitives.
 *
 *   npm run eval:option-order -- --dir path/to/jevbench --out runs/option-order.jsonl
 *   npm run eval:option-order -- --dir path/to/jevbench --out runs/option-order.jsonl --json docs/data/option-order.json
 *
 * `eval:order` found that naming N before Y moved every gate question by 1.6 to
 * 2.9 in log-odds. `choice()` and `rubric()` list their options in the prompt
 * too, so the same question stands for them, on JevBench's public tasks (the
 * ones `eval:jevbench` scores; see there for what is and is not read):
 *
 *   - choice: every task asked once per cyclic rotation of its options, so each
 *     option is shown at every position exactly once. How often the answer is
 *     the same option under every rotation, how accuracy moves, and which
 *     positions get picked against the 1-in-n that no preference would give;
 *   - score: the levels listed low to high, as given, and high to low;
 *   - noul: "Y for yes, N for no" and the other way round.
 *
 * For each type it also scores the distribution averaged over the orderings,
 * label by label: what a caller who paid for every ordering would get.
 * `--scored <prefix>` writes the as-listed and the averaged answers in the shape
 * `eval/jevbench/score.py` reads, so JevBench's own scoring grades both.
 *
 * Nothing is tuned on this: it measures the shipped prompts. Each answer is
 * appended to --out as it comes, and a run that is stopped picks up where it was.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import chalk from "chalk";
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
    "usage: eval/option-order/run.ts --dir <jevbench checkout> --out <answers.jsonl> [--tiers …] [--json <summary.json>] [--scored <prefix>]",
  );
  process.exit(2);
}

interface Task {
  id: string;
  state: string;
  labels: string[];
  expected: string | number;
  question: { type: "noul" | "choice" | "score"; instructions: string; criteria?: unknown };
}

/** One answer: the task, which ordering, and the probability of each label (by label, not position). */
interface Row {
  task: string;
  type: Task["question"]["type"];
  ordering: string;
  /** The label shown first, second, … in this ordering. */
  shown: string[];
  probs: Record<string, number>;
  expected: string;
}

const judge = new LlmJudge();
const noFirst = new LlmJudge({ yesNoOrder: "no-first" });
const capability = await judge.probe();
if (!capability.logprobs || !capability.firstTokenUsable) {
  console.error(`the judge cannot be used: ${capability.detail}`);
  process.exit(2);
}

const rotate = <T>(xs: T[], k: number) => [...xs.slice(k), ...xs.slice(0, k)];

/** Every ordering to ask a task in, as the label order to show. */
function orderings(task: Task): Array<{ name: string; shown: string[] }> {
  const { type } = task.question;
  if (type === "choice")
    return task.labels.map((_, k) => ({ name: `rot${k}`, shown: rotate(task.labels, k) }));
  if (type === "score")
    return [
      { name: "ascending", shown: [...task.labels] },
      { name: "descending", shown: [...task.labels].reverse() },
    ];
  return [
    { name: "yes-first", shown: ["yes", "no"] },
    { name: "no-first", shown: ["no", "yes"] },
  ];
}

async function ask(
  task: Task,
  ordering: { name: string; shown: string[] },
): Promise<Record<string, number>> {
  const state = { input: task.state };
  const { type, instructions, criteria } = task.question;
  if (type === "choice") {
    const c = (criteria ?? {}) as Record<string, string>;
    const r = await judge.choice(
      state,
      instructions,
      ordering.shown.map((label) => ({ id: label, text: c[label] ?? label })),
    );
    return Object.fromEntries(r.answers.map((a) => [a.id, a.probability]));
  }
  if (type === "score") {
    const levels = (Array.isArray(criteria) ? criteria : []) as string[];
    const text = new Map(task.labels.map((label, i) => [label, levels[i] ?? label]));
    const r = await judge.rubric(
      state,
      instructions,
      ordering.shown.map((label) => ({ score: Number(label), text: text.get(label) ?? label })),
    );
    return Object.fromEntries(r.distribution.map((d) => [String(d.score), d.probability]));
  }
  const c = (criteria ?? {}) as { true?: string; false?: string };
  const q = c.true && c.false ? `${instructions} (Yes: ${c.true}. No: ${c.false}.)` : instructions;
  const [a] = await (ordering.name === "no-first" ? noFirst : judge).noul(state, [
    { id: "decision", ask: q },
  ]);
  if (!a) throw new Error("no answer");
  return { yes: a.probability, no: 1 - a.probability };
}

const key = (task: string, ordering: string) => `${task}\t${ordering}`;
const rows: Row[] = [];
const done = new Set<string>();
if (existsSync(OUT)) {
  for (const line of readFileSync(OUT, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as Row;
    rows.push(r);
    done.add(key(r.task, r.ordering));
  }
}

let failed = 0;
for (const tier of TIERS) {
  const tasks = readFileSync(path.join(DIR, "datasets", "public", `${tier}.jsonl`), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Task);
  for (const task of tasks) {
    for (const ordering of orderings(task)) {
      if (done.has(key(task.id, ordering.name))) continue;
      try {
        const row: Row = {
          task: task.id,
          type: task.question.type,
          ordering: ordering.name,
          shown: ordering.shown,
          probs: await ask(task, ordering),
          expected: String(task.expected),
        };
        rows.push(row);
        appendFileSync(OUT, `${JSON.stringify(row)}\n`);
      } catch (err) {
        failed++;
        console.error(
          chalk.yellow(
            `${task.id} ${ordering.name}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    }
  }
}

// ── the summary ────────────────────────────────────────────────────────────
const argmax = (p: Record<string, number>) =>
  Object.entries(p).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
const byTask = new Map<string, Row[]>();
for (const r of rows) byTask.set(r.task, [...(byTask.get(r.task) ?? []), r]);
const complete = [...byTask.values()].filter((rs) => {
  const n = rs[0]!.type === "choice" ? rs[0]!.shown.length : 2;
  return rs.length === n;
});
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "—");
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
/** Each label's probability averaged over a task's orderings. */
const averaged = (rs: Row[]) =>
  Object.fromEntries(
    Object.keys(rs[0]!.probs).map((l) => [l, mean(rs.map((r) => r.probs[l] ?? 0))]),
  );
const accuracyOfAverage = (tasks: Row[][]) =>
  mean(tasks.map((rs) => (argmax(averaged(rs)) === rs[0]!.expected ? 1 : 0)));
const summary: Record<string, unknown> = {
  measured: new Date().toISOString().slice(0, 10),
  model: process.env.AGENT_JUDGE_MODEL ?? "?",
};

console.log(
  `\n${chalk.bold("does the order of the options move the answer?")} · JevBench public, ${TIERS.join(", ")}\n`,
);

// choice
{
  const tasks = complete.filter((rs) => rs[0]!.type === "choice");
  const asGiven = tasks.map((rs) => rs.find((r) => r.ordering === "rot0")!);
  const accGiven = asGiven.filter((r) => argmax(r.probs) === r.expected).length;
  const accAll = tasks.flatMap((rs) => rs.map((r) => (argmax(r.probs) === r.expected ? 1 : 0)));
  const perRotationAcc = tasks.map((rs) =>
    mean(rs.map((r) => (argmax(r.probs) === r.expected ? 1 : 0))),
  );
  const stable = tasks.filter((rs) => new Set(rs.map((r) => argmax(r.probs))).size === 1).length;
  const flippedAny = tasks.length - stable;
  // Total variation between each rotation's distribution and the as-given one, by label.
  const tv = tasks.flatMap((rs) => {
    const base = rs.find((r) => r.ordering === "rot0")!.probs;
    return rs
      .filter((r) => r.ordering !== "rot0")
      .map(
        (r) =>
          0.5 *
          Object.keys(base).reduce((s, l) => s + Math.abs((r.probs[l] ?? 0) - (base[l] ?? 0)), 0),
      );
  });
  // Position picked: with every option at every position once, no preference means 1/n at each.
  let first = 0;
  let last = 0;
  let picks = 0;
  let firstChance = 0;
  let lastChance = 0;
  for (const rs of tasks)
    for (const r of rs) {
      const pos = r.shown.indexOf(argmax(r.probs));
      picks++;
      if (pos === 0) first++;
      if (pos === r.shown.length - 1) last++;
      firstChance += 1 / r.shown.length;
      lastChance += 1 / r.shown.length;
    }
  const byCount: Record<string, { tasks: number; firstPicked: number; chance: number }> = {};
  for (const rs of tasks) {
    const n = rs[0]!.shown.length;
    byCount[n] ??= { tasks: 0, firstPicked: 0, chance: 1 / n };
    const b = byCount[n];
    b.tasks++;
    b.firstPicked += rs.filter((r) => r.shown.indexOf(argmax(r.probs)) === 0).length / n;
  }
  for (const b of Object.values(byCount)) b.firstPicked /= b.tasks;
  const c = {
    tasks: tasks.length,
    asks: picks,
    accuracyAsGiven: accGiven / (tasks.length || 1),
    meanAccuracyOverRotations: mean(accAll),
    accuracyOfAveragedDistribution: accuracyOfAverage(tasks),
    sameAnswerUnderEveryRotation: stable,
    answerMovedUnderSomeRotation: flippedAny,
    meanTotalVariation: mean(tv),
    firstPositionPicked: first / (picks || 1),
    lastPositionPicked: last / (picks || 1),
    positionChance: firstChance / (picks || 1),
    tasksRightUnderSomeRotationWrongUnderAnother: perRotationAcc.filter((a) => a > 0 && a < 1)
      .length,
    firstPositionByOptionCount: byCount,
  };
  summary.choice = c;
  console.log(
    chalk.bold("choice") +
      chalk.gray(
        ` — each task once per rotation of its options (${c.tasks} tasks, ${c.asks} answers)`,
      ),
  );
  console.log(
    `  accuracy as listed ${pct(accGiven, tasks.length)} · mean over rotations ${(100 * c.meanAccuracyOverRotations).toFixed(1)}% · of the distribution averaged over rotations ${(100 * c.accuracyOfAveragedDistribution).toFixed(1)}%`,
  );
  console.log(
    `  same answer under every rotation ${stable}/${tasks.length} · moved under some rotation ${flippedAny} · right under one and wrong under another ${c.tasksRightUnderSomeRotationWrongUnderAnother}`,
  );
  console.log(
    `  mean total variation from the as-listed distribution ${c.meanTotalVariation.toFixed(3)}`,
  );
  console.log(
    `  picked the first position ${(100 * c.firstPositionPicked).toFixed(1)}% · the last ${(100 * c.lastPositionPicked).toFixed(1)}% · no preference would be ${(100 * c.positionChance).toFixed(1)}% each`,
  );
}

// score
{
  const tasks = complete.filter((rs) => rs[0]!.type === "score");
  const pairs = tasks.map(
    (rs) =>
      [
        rs.find((r) => r.ordering === "ascending")!,
        rs.find((r) => r.ordering === "descending")!,
      ] as const,
  );
  const expectation = (p: Record<string, number>) =>
    Object.entries(p).reduce((s, [l, q]) => s + Number(l) * q, 0);
  const same = pairs.filter(([a, d]) => argmax(a.probs) === argmax(d.probs)).length;
  const s = {
    tasks: tasks.length,
    sameLevel: same,
    accuracyAscending: mean(pairs.map(([a]) => (argmax(a.probs) === a.expected ? 1 : 0))),
    accuracyDescending: mean(pairs.map(([, d]) => (argmax(d.probs) === d.expected ? 1 : 0))),
    meanExpectedLevelShift: mean(
      pairs.map(([a, d]) => expectation(d.probs) - expectation(a.probs)),
    ),
    meanAbsExpectedLevelShift: mean(
      pairs.map(([a, d]) => Math.abs(expectation(d.probs) - expectation(a.probs))),
    ),
    accuracyOfAveragedDistribution: accuracyOfAverage(tasks),
  };
  summary.score = s;
  console.log(
    `\n${chalk.bold("score")}${chalk.gray(` — levels low to high, then high to low (${s.tasks} tasks)`)}`,
  );
  console.log(
    `  same level both ways ${same}/${s.tasks} · accuracy ${(100 * s.accuracyAscending).toFixed(1)}% → ${(100 * s.accuracyDescending).toFixed(1)}% · of the average ${(100 * s.accuracyOfAveragedDistribution).toFixed(1)}%`,
  );
  console.log(
    `  expected level moved ${s.meanExpectedLevelShift >= 0 ? "+" : ""}${s.meanExpectedLevelShift.toFixed(2)} on average, ${s.meanAbsExpectedLevelShift.toFixed(2)} in size`,
  );
}

// noul
{
  const tasks = complete.filter((rs) => rs[0]!.type === "noul");
  const logit = (p: number) => Math.log(Math.max(p, 1e-6) / Math.max(1 - p, 1e-6));
  const pairs = tasks.map(
    (rs) =>
      [
        rs.find((r) => r.ordering === "yes-first")!,
        rs.find((r) => r.ordering === "no-first")!,
      ] as const,
  );
  const n = {
    tasks: tasks.length,
    decisionsChanged: pairs.filter(([y, o]) => y.probs.yes! >= 0.5 !== o.probs.yes! >= 0.5).length,
    accuracyYesFirst: mean(
      pairs.map(([y]) => ((y.probs.yes! >= 0.5 ? "yes" : "no") === y.expected ? 1 : 0)),
    ),
    accuracyNoFirst: mean(
      pairs.map(([, o]) => ((o.probs.yes! >= 0.5 ? "yes" : "no") === o.expected ? 1 : 0)),
    ),
    meanLogOddsShift: mean(pairs.map(([y, o]) => logit(o.probs.yes!) - logit(y.probs.yes!))),
    accuracyOfAveragedDistribution: accuracyOfAverage(tasks),
  };
  summary.noul = n;
  console.log(
    `\n${chalk.bold("noul")}${chalk.gray(` — "Y for yes, N for no", then "N for no, Y for yes" (${n.tasks} tasks)`)}`,
  );
  console.log(
    `  decisions changed at 0.5 ${n.decisionsChanged}/${n.tasks} · accuracy ${(100 * n.accuracyYesFirst).toFixed(1)}% → ${(100 * n.accuracyNoFirst).toFixed(1)}% · of the average ${(100 * n.accuracyOfAveragedDistribution).toFixed(1)}%`,
  );
  console.log(
    `  P(yes) moved ${n.meanLogOddsShift >= 0 ? "+" : ""}${n.meanLogOddsShift.toFixed(2)} in log-odds on average`,
  );
}

if (failed) console.log(chalk.yellow(`\n${failed} answers failed; run again to fill them in`));
const scored = arg("scored");
if (scored) {
  // One record per task, as eval/jevbench/run.ts writes them: the ordering JevBench lists, then the average.
  const asListed = new Set(["rot0", "ascending", "yes-first"]);
  const record = (task: string, probs: Record<string, number>) =>
    `${JSON.stringify({ task_id: task, ok: true, probs })}\n`;
  writeFileSync(
    `${scored}-as-listed.jsonl`,
    complete
      .map((rs) => record(rs[0]!.task, rs.find((r) => asListed.has(r.ordering))!.probs))
      .join(""),
  );
  writeFileSync(
    `${scored}-averaged.jsonl`,
    complete.map((rs) => record(rs[0]!.task, averaged(rs))).join(""),
  );
  console.log(
    chalk.gray(
      `\nfor eval/jevbench/score.py: ${scored}-as-listed.jsonl and ${scored}-averaged.jsonl`,
    ),
  );
}
const json = arg("json");
if (json) {
  writeFileSync(json, `${JSON.stringify(summary, null, 1)}\n`);
  console.log(chalk.gray(`\nwritten to ${json}`));
}
console.log();
