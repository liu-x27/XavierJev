/**
 * The risk gate as a Claude Code hook.
 *
 *   AGENT_JUDGE_API_KEY=ollama AGENT_JUDGE_BASE_URL=http://127.0.0.1:11434/v1 \
 *     AGENT_JUDGE_MODEL=llama3.1:8b npm run claude-code        # :3003
 *   npm run claude-code -- --observe                          # decide and log, never allow
 *
 * The plugin in plugins/xavierjev-gate points Claude Code's PermissionRequest
 * hook at this server over HTTP. Claude Code treats a hook it cannot reach,
 * or one that times out, as having no opinion and asks as usual, so a
 * stopped server, a crashed one and a slow one all fail the same safe way.
 *
 * Before it answers anything the server makes sure it should: the judge must
 * return logprobs (`probe`), and the gate must pass its self-check
 * (`checkGate`) — a gate whose canaries show its scores moved towards
 * allowing is not started at all.
 *
 * Every request is written to a local JSONL log, the command included, so
 * that what the gate did across real sessions can be read afterwards. It
 * stays on this machine; nothing here sends it anywhere.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import express from "express";
import { checkGate, createRiskGate } from "../../src/gate.js";
import { LlmJudge } from "../../src/llm.js";
import { localOnly } from "../local-only.js";
import { decide, type PermissionRequestInput } from "./decide.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const observe = process.argv.includes("--observe");
const port = Number(arg("port") ?? process.env.PORT ?? 3003);
const logPath = arg("log") ?? path.join(homedir(), ".xavierjev", "claude-code.jsonl");

if (!(process.env.AGENT_JUDGE_API_KEY || process.env.AGENT_JUDGE_BASE_URL)) {
  console.error("No judge: set AGENT_JUDGE_API_KEY, AGENT_JUDGE_BASE_URL and AGENT_JUDGE_MODEL (see .env.example).");
  process.exit(1);
}
const judge = new LlmJudge();
const capability = await judge.probe();
if (!capability.logprobs) {
  console.error(`${judge.name} cannot be a gate: ${capability.detail}`);
  process.exit(1);
}
const gate = createRiskGate({ backend: judge });
const check = await checkGate(gate);
if (check.unsafe) {
  console.error(`Refusing to start: the gate's self-check says it is unsafe with ${judge.name}.`);
  for (const problem of check.problems) console.error(`  ${problem}`);
  process.exit(1);
}

mkdirSync(path.dirname(logPath), { recursive: true });

const app = express();
app.use(localOnly);
app.use(express.json({ limit: "1mb" }));

app.post("/claude-code/permission-request", async (req, res) => {
  const input = (req.body ?? {}) as PermissionRequestInput;
  const started = Date.now();
  let decision: Awaited<ReturnType<typeof decide>>;
  try {
    decision = await decide(input, gate, { observe });
  } catch (err) {
    // The gate fails closed on its own; this is for anything around it.
    decision = { response: {}, skipped: `error: ${err instanceof Error ? err.message : String(err)}` };
  }
  const { verdict } = decision;
  appendFileSync(
    logPath,
    `${JSON.stringify({
      at: new Date().toISOString(),
      session: input.session_id,
      cwd: input.cwd,
      mode: input.permission_mode,
      tool: input.tool_name,
      command: decision.command,
      skipped: decision.skipped,
      action: verdict?.action,
      probability: verdict?.probability,
      answers: verdict?.answers,
      allowed: decision.response.hookSpecificOutput !== undefined,
      observe,
      ms: Date.now() - started,
    })}\n`,
  );
  res.json(decision.response);
});

app.listen(port, "127.0.0.1", () => {
  console.log(`\nXavierJev gate for Claude Code at http://127.0.0.1:${port} (this machine only)`);
  console.log(`   judge: ${judge.name} · threshold 0.2 · ${observe ? "observing: decides and logs, never allows" : "clears what it scores safe"}`);
  const moved = check.shift === undefined ? "" : `, scores ${check.shift >= 0 ? "+" : ""}${check.shift.toFixed(2)} in log-odds`;
  console.log(`   self-check: ${check.asMeasured ? "as measured" : "not the gate that was measured"}${moved}`);
  for (const problem of check.asMeasured ? [] : check.problems) console.log(`      ${problem}`);
  console.log(`   log: ${logPath}\n`);
});
