/**
 * Score the gate's canary commands with a trained judge and write them for its sidecar to serve.
 *
 *   npm run sidecar:canaries -- --out sidecar/run/canaries.json [--sidecar-url http://127.0.0.1:8765]
 *
 * Run once after training (sidecar/train.py) with the sidecar up, then restart it with
 * `--canaries <that file>`. The file records what the canaries were scored on — the judge's
 * identity and digest, its threshold, and this build's `reveals-secret` word list — so that
 * every later start compares the judge in front of it with that, the way the shipped gate is
 * compared with what llama3.1:8b scored, rather than with whatever the sidecar says it is now.
 * A canary whose recorded action is not the one it expects is written anyway and printed: that
 * judge will never pass as measured, and it is better to know now.
 */
import { writeFileSync } from "node:fs";
import { createRiskGate, GATE_CANARIES, type GateCanary } from "../../src/gate.js";
import { type CanaryRecording, SECRET_WORDS, SidecarJudge } from "../../src/sidecar.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const out = arg("out");
if (!out) {
  console.error("usage: record-canaries.ts --out <canaries.json> [--sidecar-url <url>]");
  process.exit(2);
}
const judge = new SidecarJudge({ url: arg("sidecar-url") ?? process.env.XAVIERJEV_SIDECAR_URL });
const info = await judge.info();
const gate = createRiskGate({ backend: judge, autoAllowBelow: info.threshold, readScripts: info.readScripts === true });
const canaries: GateCanary[] = [];
for (const c of GATE_CANARIES) {
  const v = await gate({ toolName: "Bash", input: { command: c.command }, description: c.command });
  if (v.probability === undefined) throw new Error(`no answer for ${c.command}: ${v.reason}`);
  const flag = v.action === c.expect ? "" : `   <- expected ${c.expect}`;
  console.log(`${v.action.padEnd(5)} ${v.probability.toFixed(4)}  ${c.command}${flag}`);
  canaries.push({ command: c.command, expect: c.expect, recorded: v.probability });
}
const recording: CanaryRecording = {
  recordedOn: { model: info.model, digest: info.digest },
  threshold: info.threshold,
  secretWords: SECRET_WORDS.source,
  canaries,
};
writeFileSync(out, `${JSON.stringify(recording, null, 1)}\n`);
console.log(
  `\n${info.model} (${info.digest.slice(0, 12)}), threshold ${info.threshold}: written to ${out}`,
);
