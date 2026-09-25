/**
 * The gate beside a rule-based guard, on the same labelled commands.
 *
 *   npm run eval:compare              # cc-safety-net and the allow-list, offline
 *   npm run eval:compare -- --llm     # and the llm gate — a read of the held-out sets; log it
 *
 * [cc-safety-net](https://github.com/kenryu42/cc-safety-net) (MIT, pinned as a
 * dev dependency) is a PreToolUse guard: it blocks what its rules recognise and
 * lets everything else through to the usual flow. This gate does the opposite
 * job — it clears what it is sure of and leaves everything else to the prompt.
 * So they are compared on the two numbers both have: of the unsafe commands,
 * how many each one stops (blocked, or left to the user), and of the safe ones,
 * how many pass without friction. Strings only: no command is run.
 *
 * Its rules are the defaults of its `checkCommand` API, with a fresh empty
 * directory as the working directory.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import chalk from "chalk";
import { checkCommand } from "cc-safety-net/api";
import { AllowlistJudge } from "../../src/allowlist.js";
import { createRiskGate } from "../../src/gate.js";
import { LlmJudge } from "../../src/llm.js";
import { logger } from "../../src/log.js";
import type { RiskGate } from "../../src/decisions.js";
import { CASES, type RiskCase } from "../risk-gate/cases.js";
import { TEST_CASES } from "../risk-gate/testset.js";
import { TEST_CASES_2 } from "../risk-gate/testset2.js";
import { TEST_CASES_3 } from "../risk-gate/testset3.js";

logger.setLevel("error");

const SETS: Array<[string, RiskCase[]]> = [
  ["dev", CASES],
  ["test 1", TEST_CASES],
  ["test 2", TEST_CASES_2],
  ["test 3", TEST_CASES_3],
];
const HARMS = ["destroys-data", "outside-cwd", "exfiltrates", "reveals-secret"] as const;
const cwd = mkdtempSync(path.join(tmpdir(), "compare-project-"));

type Stops = (c: RiskCase) => Promise<boolean>;
const guard: Stops = async (c) => checkCommand({ command: c.command, cwd }).kind === "deny";
const gateStops =
  (gate: RiskGate): Stops =>
  async (c) =>
    (await gate({ toolName: "Bash", input: { command: c.command }, description: c.command })).action !== "allow";

const systems: Array<[string, Stops]> = [
  ["cc-safety-net 2.4.7", guard],
  ["allowlist gate", gateStops(createRiskGate({ backend: new AllowlistJudge() }))],
];
if (process.argv.includes("--llm")) {
  const judge = new LlmJudge();
  const capability = await judge.probe();
  if (!capability.logprobs || !capability.firstTokenUsable) {
    console.error(`the judge cannot be used: ${capability.detail}`);
    process.exit(2);
  }
  systems.push([`llm gate (${process.env.AGENT_JUDGE_MODEL ?? "?"})`, gateStops(createRiskGate({ backend: judge }))]);
}

for (const [name, cases] of SETS) {
  const safe = cases.filter((c) => c.label === "safe");
  const unsafe = cases.filter((c) => c.label === "unsafe");
  console.log(chalk.bold(`\n${name}: ${unsafe.length} unsafe, ${safe.length} safe`));
  for (const [system, stops] of systems) {
    const stopped = new Set<RiskCase>();
    for (const c of cases) if (await stops(c)) stopped.add(c);
    const harms = HARMS.map((h) => {
      const tagged = unsafe.filter((c) => c.harms?.includes(h));
      return tagged.length ? `${h} ${tagged.filter((c) => stopped.has(c)).length}/${tagged.length}` : undefined;
    }).filter(Boolean);
    const unsafeStopped = unsafe.filter((c) => stopped.has(c)).length;
    const safePassed = safe.filter((c) => !stopped.has(c)).length;
    console.log(
      `  ${system.padEnd(24)} unsafe stopped ${`${unsafeStopped}/${unsafe.length}`.padEnd(6)} · safe passed ${`${safePassed}/${safe.length}`.padEnd(6)}` +
        (harms.length ? chalk.gray(`  ${harms.join(", ")}`) : ""),
    );
  }
}
console.log(
  chalk.gray(
    "\n  'stopped' is blocked for the guard and left to the prompt for the gate: the same count, not the same act.\n",
  ),
);
