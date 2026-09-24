/**
 * Where a gate decision's time goes.
 *
 *   npm run eval:latency        # needs a judge on Ollama; AGENT_JUDGE_* as for the other evals
 *
 * The gate asks four yes/no questions about one tool call and waits for all
 * of them. This times exactly the prompts it sends (`yesNoMessages` in
 * src/llm.ts), through Ollama's own /api/chat rather than its OpenAI-style
 * /v1 — the same model and prompt, but the native endpoint reports how long
 * it spent reading the prompt and how many tokens that was, which is what the
 * question needs.
 *
 * Three things, each with the shipped questions:
 *
 *   - one question at a time on one short command: what a single decision
 *     costs, split into reading the prompt, the server's own overhead, and
 *     the round trip;
 *   - the four sent at once, as the gate sends them, on commands no slot has
 *     seen, short and long: whether the server answers them side by side or
 *     one after another;
 *   - a long command's first question against its other three: whether the
 *     part of the prompt they share is read once or four times.
 *
 * Parallel slots are a server setting (OLLAMA_NUM_PARALLEL), so to compare,
 * start a second Ollama with it set and point AGENT_JUDGE_BASE_URL there; the
 * eval measures whichever server it is given.
 */
import chalk from "chalk";
import { RISK_QUESTIONS } from "../../src/gate.js";
import { renderState, yesNoMessages } from "../../src/llm.js";

const base = (process.env.AGENT_JUDGE_BASE_URL ?? "").replace(/\/v1\/?$/, "");
const model = process.env.AGENT_JUDGE_MODEL ?? "";
if (!base || !model) {
  console.error("eval:latency needs AGENT_JUDGE_BASE_URL (an Ollama, e.g. http://127.0.0.1:11434/v1) and AGENT_JUDGE_MODEL");
  process.exit(1);
}

interface Timing {
  /** The whole request as the client saw it. */
  wall: number;
  /** Ollama's total_duration: from the request arriving to the answer leaving. */
  server: number;
  /** prompt_eval_duration: reading the prompt, which with one output token is the forward pass. */
  prefill: number;
  /** prompt_eval_count: the prompt's length in tokens. */
  tokens: number;
}

async function ask(command: string, question: string): Promise<Timing> {
  const body = {
    model,
    stream: false,
    keep_alive: "3m",
    options: { temperature: 0, num_predict: 1 },
    messages: yesNoMessages(renderState({ tool: "Bash", command }), question),
  };
  const started = performance.now();
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${base}/api/chat answered ${res.status}: is it an Ollama?`);
  const out = (await res.json()) as Record<string, number>;
  const ms = (k: string) => (out[k] ?? 0) / 1e6;
  return {
    wall: performance.now() - started,
    server: ms("total_duration"),
    prefill: ms("prompt_eval_duration"),
    tokens: out.prompt_eval_count ?? 0,
  };
}

/** All four questions at once, as the gate sends them. */
async function gate(command: string): Promise<{ wall: number; timings: Timing[] }> {
  const started = performance.now();
  const timings = await Promise.all(RISK_QUESTIONS.map((q) => ask(command, q.ask)));
  return { wall: performance.now() - started, timings };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};
const f = (n: number) => n.toFixed(0).padStart(4);

// A read-only script of the kind agents write, cut at the gate's 2,000-character cap.
const longCommand = (n: number) => {
  const lines = Array.from(
    { length: 14 },
    (_, k) =>
      `rows_${k} = [json.loads(l) for l in open('runs/part${k}.jsonl', encoding='utf-8')]\n` +
      `print(${k}, len(rows_${k}), sum(r['hp'] for r in rows_${k}) / max(1, len(rows_${k})))`,
  );
  return `cd planner/run${n} && python - <<'EOF'\n${lines.join("\n")}\nEOF`.slice(0, 2000);
};

await ask("echo warm", RISK_QUESTIONS[0]!.ask); // load the model before timing anything

console.log(`\n${chalk.bold("where a gate decision's time goes")} · ${model} on ${base}\n`);

console.log(chalk.bold("one question at a time, one short command"));
console.log(chalk.gray("  question          wall   server   prompt read   tokens"));
const short = "wc -l src/agent.ts";
for (const q of RISK_QUESTIONS) {
  const t = await ask(short, q.ask);
  console.log(`  ${q.id.padEnd(15)} ${f(t.wall)} ms ${f(t.server)} ms   ${t.prefill.toFixed(1).padStart(6)} ms   ${String(t.tokens).padStart(6)}`);
}

console.log(`\n${chalk.bold("four at once, as the gate sends them")} ${chalk.gray("(commands no slot has seen; median of 6)")}`);
for (const [label, make] of [
  ["short command", (n: number) => `wc -l src/agent${n}.ts`],
  ["2,000-character command", longCommand],
] as const) {
  const runs: Array<{ wall: number; timings: Timing[] }> = [];
  for (let n = 0; n < 6; n++) runs.push(await gate(make(1000 + n)));
  const typical = runs.find((r) => r.wall === median(runs.map((x) => x.wall))) ?? runs[0]!;
  const servers = typical.timings.map((t) => t.server).sort((a, b) => a - b);
  console.log(
    `  ${label.padEnd(25)} ${f(median(runs.map((r) => r.wall)))} ms` +
      chalk.gray(`   the four answered after ${servers.map((s) => s.toFixed(0)).join(" / ")} ms of server time`),
  );
}

console.log(`\n${chalk.bold("what the four share")} ${chalk.gray("(one long command, questions asked one after another)")}`);
const long = longCommand(2000);
const shared: Timing[] = [];
for (const q of RISK_QUESTIONS) shared.push(await ask(long, q.ask));
const [first, ...rest] = shared;
console.log(
  `  first question: ${first!.prefill.toFixed(0)} ms to read ${first!.tokens} tokens` +
    `; the other three: ${rest.map((t) => t.prefill.toFixed(0)).join(" / ")} ms`,
);

// Leave the GPU as it was found.
await fetch(`${base}/api/generate`, { method: "POST", body: JSON.stringify({ model, keep_alive: 0 }) });
console.log();
