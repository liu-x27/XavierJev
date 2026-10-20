/**
 * The shadow run, read: the gate's scores beside auto mode's decisions, joined by tool_use_id.
 *
 *   npm run claude-code:shadow-report                          # ~/.xavierjev/shadow, summarised
 *   npm run claude-code:shadow-report -- --blind [--seed 20261020] [--controls N]
 *                                                              # draw the disagreements to label, blind
 *   npm run claude-code:shadow-report -- --json summary.json   # counts, rates and quantiles only
 *
 * `--blind` writes blind/items.json (what the labelling page shows: command, working directory,
 * where a leading cd goes), blind/key.json (each item's stratum and scores — not to be opened
 * before the labels are in) and blind/plan.json (counts and a hash of the draw). It mixes the
 * disagreements with as many calls the two agreed on, so the labeller cannot tell one from the
 * other, and it will not draw over a set that already has labels. Label with
 * `npm run claude-code:label`; run this again and it adds what the labels say, stratum by stratum.
 *
 * `--json` is the part fit to publish: no command, no session, no path, no tool_use_id.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { blindSet, labelResult, type ShadowScore, shadowReport, type ToolDecision } from "./shadow.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const dir = arg("dir") ?? path.join(homedir(), ".xavierjev", "shadow");
const blindDir = path.join(dir, "blind");

const jsonl = <T>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as T)
    : [];
const scores = jsonl<ShadowScore>(path.join(dir, "scores.jsonl"));
const decisions = jsonl<ToolDecision>(path.join(dir, "decisions.jsonl"));
if (!scores.length) {
  console.error(`No scores in ${dir}: start the shadow (npm run claude-code:shadow) and work in an auto mode session.`);
  process.exit(1);
}
const report = shadowReport(scores, decisions);
const { calls, table, agreement, clears, latencyMs } = report;

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const ms = (x: number | undefined) => (x === undefined ? "—" : `${Math.round(x).toLocaleString("en-US")} ms`);
const j = report.judge;
console.log(
  `\n${calls.scored} Bash calls scored by ${j?.judge} at ${j?.threshold} (self-check: ${j?.selfCheck}), ` +
    `${calls.unscored} without a usable answer, ${calls.dropped} dropped${calls.otherJudges ? `, ${calls.otherJudges} by another judge left out` : ""}`,
);
console.log(
  `  with a tool_decision event: ${calls.withEvent}; classifier verdicts: ${Object.entries(calls.classifierVerdicts)
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ")}`,
);
console.log(`  Claude Code: ${report.claudeCode.join(", ") || "version not reported"}`);
if (!calls.compared) {
  console.log("\n  Nothing to compare yet: no call has both a gate score and a classifier allow or block.");
  console.log("  classifier_verdict needs Claude Code 2.1.301 or later, and is only there for calls auto mode asked it about.\n");
} else {
  console.log(`\n  compared, both answered: ${calls.compared}`);
  console.log("                       classifier allows   classifier blocks");
  console.log(`    gate clears        ${String(table.bothAllow).padStart(10)}          ${String(table.gateAllowsClassifierBlocks).padStart(10)}`);
  console.log(`    gate asks          ${String(table.gateAsksClassifierAllows).padStart(10)}          ${String(table.bothHold).padStart(10)}`);
  if (agreement) {
    const [lo, hi] = agreement.interval;
    console.log(
      `  agreement ${pct(agreement.rate)} (${pct(lo)}–${pct(hi)}, exact 95%) · kappa ${agreement.kappa?.toFixed(2) ?? "—"}` +
        ` · clears: gate ${pct(clears.gate)}, classifier ${pct(clears.classifier)}`,
    );
  }
  console.log(
    `  time: gate p50 ${ms(latencyMs.gate.p50)}, p95 ${ms(latencyMs.gate.p95)}; hook to decision p50 ${ms(latencyMs.hookToDecision.p50)},` +
      ` p95 ${ms(latencyMs.hookToDecision.p95)} (at most what the classifier took)`,
  );
}

if (process.argv.includes("--blind")) {
  if (existsSync(path.join(blindDir, "labels.json"))) {
    console.error(`\n${blindDir} already has labels; move it aside to draw another set.`);
    process.exit(1);
  }
  const seed = Number(arg("seed") ?? 20261020);
  const controls = arg("controls") === undefined ? undefined : Number(arg("controls"));
  const { items, key, plan } = blindSet(report.rows, seed, controls);
  mkdirSync(blindDir, { recursive: true });
  writeFileSync(path.join(blindDir, "items.json"), `${JSON.stringify({ title: "Shadow disagreements, blind", items }, null, 1)}\n`);
  writeFileSync(path.join(blindDir, "key.json"), `${JSON.stringify(key, null, 1)}\n`);
  writeFileSync(path.join(blindDir, "plan.json"), `${JSON.stringify(plan, null, 1)}\n`);
  console.log(`\n${items.length} items to label in ${blindDir} (${Object.entries(plan.strata).map(([k, v]) => `${k} ${v}`).join(", ")})`);
  console.log("Label them with `npm run claude-code:label`; key.json says which is which and stays closed until then.");
}

let labels: ReturnType<typeof labelResult> | undefined;
const labelsFile = path.join(blindDir, "labels.json");
if (existsSync(labelsFile) && existsSync(path.join(blindDir, "key.json"))) {
  const key = JSON.parse(readFileSync(path.join(blindDir, "key.json"), "utf8"));
  const given = (JSON.parse(readFileSync(labelsFile, "utf8")) as { labels?: Record<string, { flags: string[] }> }).labels ?? {};
  const total = Object.keys(key).length;
  if (Object.keys(given).length < total) {
    console.log(`\n${Object.keys(given).length} of ${total} labelled; the strata are counted once all are.`);
  } else {
    labels = labelResult(key, given);
    console.log("\n  labelled, unsafe by the strict reading (O) · by the cd reading (Ocd):");
    for (const [stratum, r] of Object.entries(labels) as Array<[string, { unsafeStrict: { count: number; of: number }; unsafeCd: { count: number; of: number }; cannotTell: number }]>) {
      console.log(`    ${stratum.padEnd(32)} ${r.unsafeStrict.count}/${r.unsafeStrict.of} · ${r.unsafeCd.count}/${r.unsafeCd.of}${r.cannotTell ? ` · ${r.cannotTell} could not tell` : ""}`);
    }
  }
}

const out = arg("json");
if (out) {
  const summary = {
    generated: new Date().toISOString(),
    judge: j && { name: j.judge, threshold: j.threshold, selfCheck: j.selfCheck },
    claudeCode: report.claudeCode,
    calls,
    table,
    agreement,
    clears,
    latencyMs,
    ...(labels ? { labels } : {}),
  };
  writeFileSync(out, `${JSON.stringify(summary, null, 1)}\n`);
  console.log(`\nsummary (counts, rates and quantiles only) -> ${out}`);
}
console.log();
