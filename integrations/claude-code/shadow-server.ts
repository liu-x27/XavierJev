/**
 * The gate beside Claude Code's auto mode, watching only.
 *
 *   npm run claude-code:shadow                         # :3004, the prompted judge (AGENT_JUDGE_* as for the hook)
 *   npm run claude-code:shadow -- --backend sidecar    # a trained judge (sidecar/README.md)
 *   npm run claude-code:shadow -- --all-modes          # score Bash calls in every permission mode, not just auto
 *
 * Two routes on one loopback port, both written to ~/.xavierjev/shadow/ (`--dir` to move it):
 *
 *   POST /claude-code/pre-tool-use   Claude Code's PreToolUse hook over HTTP. Answered at once with an
 *                                    empty 200 — no decision, so the call goes on as if there were no
 *                                    hook — and only then is the Bash command scored by the gate, off
 *                                    the hook's clock: scores.jsonl, command included.
 *   POST /v1/logs                    OTLP/HTTP logs in JSON, as Claude Code exports them with
 *                                    OTEL_EXPORTER_OTLP_PROTOCOL=http/json: its tool_decision events,
 *                                    cut down to verdicts and keys (`toolDecisions`): decisions.jsonl.
 *
 * `npm run claude-code:shadow-report` puts the two side by side by tool_use_id. Nothing here
 * allows, denies or holds up a call; the hook it answers is the one Claude Code never waits on
 * for a verdict. It never leaves this machine either: the socket is bound to loopback and the
 * logs, which hold every command scored, stay in that directory.
 *
 * The self-check runs at startup as it does for the PermissionRequest hook, and the shadow starts
 * whatever it says — it clears nothing — but every score records whether the judge was vouched
 * for, and which judge, digest and threshold it was, so a report never mixes two.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import express from "express";
import { checkGate, createRiskGate } from "../../src/gate.js";
import { localOnly } from "../local-only.js";
import { hookJudge } from "./judge.js";
import { type PreToolUseInput, type ShadowScore, toolDecisions } from "./shadow.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const port = Number(arg("port") ?? 3004);
const dir = arg("dir") ?? path.join(homedir(), ".xavierjev", "shadow");
const allModes = process.argv.includes("--all-modes");
const readScripts = process.argv.includes("--read-scripts");
const MAX_QUEUE = 20;

const { judge, threshold, canaries, recordedOn, setupProblems } = await hookJudge({
  backend: arg("backend"),
  sidecarUrl: arg("sidecar-url"),
  readScripts,
});
const gate = createRiskGate({ backend: judge, autoAllowBelow: threshold, readScripts });
const check = await checkGate(gate, canaries, recordedOn);
const selfCheck: ShadowScore["selfCheck"] = check.unsafe
  ? "unsafe"
  : !check.verified || setupProblems.length
    ? "unverified"
    : check.asMeasured
      ? "as measured"
      : "not as measured";

mkdirSync(dir, { recursive: true });
const scoresPath = path.join(dir, "scores.jsonl");
const decisionsPath = path.join(dir, "decisions.jsonl");
const append = (file: string, record: unknown) => appendFileSync(file, `${JSON.stringify(record)}\n`);

// One call at a time: the judge answers one request at a time anyway, and the shadow must never
// take a GPU or a server away from the session it is watching. Past MAX_QUEUE waiting, a call is
// recorded as dropped, unscored.
const queue: Array<() => Promise<void>> = [];
let busy = false;
async function drain() {
  if (busy) return;
  busy = true;
  while (queue.length) await queue.shift()!();
  busy = false;
}

function score(input: PreToolUseInput, receivedMs: number) {
  const command = input.tool_input?.command;
  if (typeof command !== "string" || !command.trim() || !input.tool_use_id) return;
  const base = {
    at: new Date(receivedMs).toISOString(),
    receivedMs,
    toolUseId: input.tool_use_id,
    session: input.session_id,
    prompt: input.prompt_id,
    agent: input.agent_id,
    mode: input.permission_mode,
    cwd: input.cwd,
    command,
    judge: judge.name,
    digest: check.identity?.digest,
    threshold,
    selfCheck,
  };
  if (queue.length >= MAX_QUEUE) {
    append(scoresPath, { ...base, waitedMs: 0, dropped: true } satisfies ShadowScore);
    return;
  }
  queue.push(async () => {
    const started = Date.now();
    const verdict = await gate({ toolName: "Bash", input: { command }, description: command, cwd: input.cwd }).catch(
      (err: unknown) => ({ action: "ask" as const, probability: undefined, reason: `error: ${err instanceof Error ? err.message : String(err)}` }),
    );
    append(scoresPath, {
      ...base,
      action: verdict.action === "allow" ? "allow" : "ask",
      probability: verdict.probability,
      reason: verdict.reason,
      answers: "answers" in verdict ? verdict.answers?.map((a) => ({ id: a.id, probability: a.probability })) : undefined,
      latencyMs: "latencyMs" in verdict ? verdict.latencyMs : undefined,
      waitedMs: started - receivedMs,
    } satisfies ShadowScore);
  });
  void drain();
}

const app = express();
app.use(localOnly);
app.use(express.json({ limit: "16mb" }));

app.post("/claude-code/pre-tool-use", (req, res) => {
  const receivedMs = Date.now();
  // Before anything else: an empty 2xx is no decision, and the call goes on.
  res.status(200).end();
  const input = (req.body ?? {}) as PreToolUseInput;
  if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") return;
  if (!allModes && input.permission_mode !== "auto") return;
  // Scored once the empty answer has gone out: nothing the scoring does can hold it up.
  res.on("finish", () => score(input, receivedMs));
});

app.post("/v1/logs", (req, res) => {
  const receivedAt = new Date().toISOString();
  for (const d of toolDecisions(req.body, receivedAt)) append(decisionsPath, d);
  res.json({});
});
// Exporters configured for every signal send these too; nothing in them is kept.
app.post(["/v1/metrics", "/v1/traces"], (_req, res) => {
  res.json({});
});

app.listen(port, "127.0.0.1", async () => {
  // The first JSON body an Express app parses loads its decoders; spend that here, on a route that
  // keeps nothing, rather than on the first hook.
  await fetch(`http://127.0.0.1:${port}/v1/metrics`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).catch(() => {});
  console.log(`\nXavierJev shadow beside auto mode at http://127.0.0.1:${port} (this machine only)`);
  console.log(`   hook:  POST /claude-code/pre-tool-use  — answered empty at once; Bash ${allModes ? "in every mode" : "in auto mode"} scored after`);
  console.log("   OTLP:  POST /v1/logs                    — tool_decision events, http/json");
  console.log(`   judge: ${judge.name} · threshold ${threshold} · self-check ${selfCheck}`);
  for (const problem of [...setupProblems, ...check.problems]) console.log(`      ${problem}`);
  console.log(`   logs:  ${dir}\n`);
});
