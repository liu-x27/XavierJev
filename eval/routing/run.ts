/**
 * Measure the model router on the labelled requests in `cases.ts`.
 *
 * Three numbers, and unlike the risk gate's two they are all allowed to move:
 *
 * - **downgraded** — requests sent to the cheap model. The benefit.
 * - **wrong downgrades** — requests my labels say need the strong model and
 *   the router sent cheap anyway. A worse answer, which the user reads.
 * - **wrong escalations** — cheap requests sent to the strong model. Money.
 *
 * The gate's report treats its two numbers asymmetrically because one of its
 * failures is silent and permanent. Neither of these is, so this one reports
 * a saving alongside both error rates and lets the reader weigh them.
 *
 * The saving is computed from the price table in `src/utils/cost.ts` against
 * a fixed token profile, not from real runs. That makes it a statement about
 * the price list and the routing decisions — not a measurement of what a
 * month of use would cost, which depends on turn counts this does not model.
 *
 * Run: npm run eval:routing
 *      npm run eval:routing -- --strong claude-opus-5 --cheap claude-haiku-4-5
 */

import chalk from "chalk";
import { AllowlistJudge } from "../../src/judge/allowlist.js";
import { LlmJudge } from "../../src/judge/llm.js";
import { createModelRouter, ROUTING_QUESTION } from "../../src/judge/router.js";
import type { JudgeBackend } from "../../src/judge/types.js";
import type { ModelId } from "../../src/types.js";
import { estimateCost, formatCost } from "../../src/utils/cost.js";
import { logger } from "../../src/utils/logger.js";
import { ROUTING_CASES, type Tier } from "./cases.js";
import { ROUTING_TEST_CASES } from "./testset.js";

/**
 * A single representative run, used only to turn routing decisions into
 * money. Roughly what a short tool-using turn costs in this project: a few
 * thousand prompt tokens once the system prompt and tool schemas are in, a
 * few hundred out.
 */
const TOKEN_PROFILE = { input: 4000, output: 600 };

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
};

const backendName = arg("backend", "llm");
const strong = arg("strong", "claude-opus-5") as ModelId;
const cheap = arg("cheap", "claude-haiku-4-5") as ModelId;
const threshold = Number(arg("threshold", "0.2"));
const which = arg("cases", "dev");
if (which !== "dev" && which !== "test") {
  console.error(`--cases must be dev or test, got ${which}`);
  process.exit(2);
}
const CASES = which === "test" ? ROUTING_TEST_CASES : ROUTING_CASES;
if (which === "test") {
  console.log(chalk.yellow.bold("\n⚠  This run reads the held-out set. Log it in testset.ts."));
}

function buildBackend(name: string): JudgeBackend {
  switch (name) {
    case "allowlist":
      // Included only to show what it does here, which is nothing: it judges
      // shell commands and has no opinion about prose.
      return new AllowlistJudge();
    case "llm":
      return new LlmJudge({ allowHardLabels: true });
    default:
      console.error(`unknown backend "${name}"`);
      process.exit(2);
  }
}

logger.setLevel("error");

const backend = buildBackend(backendName);
if (backend instanceof LlmJudge) {
  const capability = await backend.probe();
  const mark = capability.logprobs ? chalk.green("✓") : chalk.yellow("!");
  console.log(`\n${mark} ${backend.name} — ${capability.detail}`);
}

const router = createModelRouter({
  backend,
  strong,
  cheap,
  preferCheapBelow: threshold,
  timeoutMs: 20_000,
});

interface Scored {
  prompt: string;
  label: Tier;
  chose: Tier;
  probability: number | undefined;
  ms: number;
}

const scored: Scored[] = [];
for (const testCase of CASES) {
  const started = Date.now();
  const verdict = await router(testCase.prompt);
  scored.push({
    prompt: testCase.prompt,
    label: testCase.label,
    chose: verdict.downgraded ? "cheap" : "strong",
    probability: verdict.probability,
    ms: Date.now() - started,
  });
}

const wantCheap = scored.filter((s) => s.label === "cheap");
const wantStrong = scored.filter((s) => s.label === "strong");
const downgraded = scored.filter((s) => s.chose === "cheap");
const wrongDowngrades = wantStrong.filter((s) => s.chose === "cheap");
const wrongEscalations = wantCheap.filter((s) => s.chose === "strong");

const perRun = (model: ModelId) => estimateCost(model, TOKEN_PROFILE.input, TOKEN_PROFILE.output);
const baseline = scored.length * perRun(strong);
const routed = scored.reduce((sum, s) => sum + perRun(s.chose === "cheap" ? cheap : strong), 0);

console.log(
  `\n${chalk.bold("model router")} · backend ${chalk.cyan(backend.name)} · ` +
    `${chalk.cyan(cheap)} when P(needs-strong) < ${chalk.cyan(threshold)}, else ${chalk.cyan(strong)}`,
);
console.log(
  chalk.gray(`${CASES.length} requests — ${wantCheap.length} cheap, ${wantStrong.length} strong\n`),
);

const pct = (n: number, d: number) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(0)}%`);
console.log(
  `  ${chalk.green("downgraded")}          ${downgraded.length}/${scored.length} requests sent to ${cheap} (${pct(downgraded.length, scored.length)})`,
);
console.log(
  `  ${wrongDowngrades.length === 0 ? chalk.green("wrong downgrades") : chalk.red("wrong downgrades")}    ${wrongDowngrades.length}/${wantStrong.length} of the requests I labelled strong`,
);
console.log(
  `  ${chalk.yellow("wrong escalations")}   ${wrongEscalations.length}/${wantCheap.length} of the requests I labelled cheap`,
);

const latencies = scored.map((s) => s.ms).sort((a, b) => a - b);
const mean = latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1);
console.log(`  ${chalk.gray("judge latency")}       mean ${mean.toFixed(0)}ms`);

console.log(
  `\n  ${chalk.gray("cost of these")} ${scored.length} ${chalk.gray("requests at")} ` +
    `${TOKEN_PROFILE.input} ${chalk.gray("in /")} ${TOKEN_PROFILE.output} ${chalk.gray("out each")}`,
);
console.log(`    all ${strong}: ${formatCost(baseline)}`);
console.log(
  `    routed:         ${formatCost(routed)}  ${chalk.green(
    `(${pct(baseline - routed, baseline)} less)`,
  )}`,
);

if (wrongDowngrades.length > 0) {
  console.log(`\n${chalk.red.bold("sent cheap, labelled strong")}`);
  for (const s of wrongDowngrades) {
    console.log(`  ${chalk.red(s.prompt)}`);
    console.log(chalk.gray(`      P(needs-strong)=${s.probability?.toFixed(3) ?? "n/a"}`));
  }
}

if (wrongEscalations.length > 0) {
  console.log(
    `\n${chalk.yellow.bold("sent strong, labelled cheap")} ${chalk.gray("(costs money, not correctness)")}`,
  );
  for (const s of wrongEscalations) {
    console.log(`  ${chalk.yellow(s.prompt)}`);
    console.log(chalk.gray(`      P(needs-strong)=${s.probability?.toFixed(3) ?? "n/a"}`));
  }
}

const distinct = new Set(scored.map((s) => s.probability)).size;
if (distinct > 3) {
  console.log(`\n${chalk.bold("threshold sweep")}`);
  console.log(chalk.gray("  threshold   downgraded   wrong downgrades   wrong escalations"));
  for (const t of [0.1, 0.2, 0.3, 0.5, 0.7, 0.9]) {
    const below = (s: Scored) => s.probability !== undefined && s.probability < t;
    const d = scored.filter(below).length;
    const wd = wantStrong.filter(below).length;
    const we = wantCheap.filter((s) => !below(s)).length;
    console.log(
      `  ${String(t).padEnd(11)} ${`${d}/${scored.length}`.padEnd(12)} ` +
        `${`${wd}/${wantStrong.length}`.padEnd(18)} ${we}/${wantCheap.length}`,
    );
  }
}

console.log(`\n${chalk.gray("question asked:")} ${ROUTING_QUESTION.ask.slice(0, 72)}…\n`);
