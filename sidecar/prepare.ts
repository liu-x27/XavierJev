/**
 * Turn labelled commands into the rows sidecar/train.py and score.py read, with the gate's own
 * state builder, so a judge is trained on exactly what the gate will show it.
 *
 *   npx tsx sidecar/prepare.ts <labelled.jsonl> <rows.jsonl> [--read-scripts]
 *
 * In: one JSON object per line, `{ command, cwd?, labels: { "destroys-data": 0|1, … } }` — a
 * question id missing from `labels` is unknown and left out of that question's training.
 * Out: `{ state, labels, unsafe, secret }` per line, and beside it `<rows>.questions.json`, the
 * wording of the questions the judge is trained on. `unsafe` is any label at 1 (or null when a
 * question is unknown and none is 1) and `secret` is whether the gate's word list for
 * `reveals-secret` matches the command, since that question is answered by the list.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { gateState, RISK_QUESTIONS } from "../src/gate.js";
import { SECRET_WORDS } from "../src/sidecar.js";

const [input, output] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!input || !output) {
  console.error("usage: prepare.ts <labelled.jsonl> <rows.jsonl> [--read-scripts]");
  process.exit(2);
}
const readScripts = process.argv.includes("--read-scripts");
const QUESTIONS = ["destroys-data", "outside-cwd", "exfiltrates", "reveals-secret"];
const out: string[] = [];
let withScript = 0;
for (const line of readFileSync(input, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const row = JSON.parse(line) as { command: string; cwd?: string; labels: Record<string, number> };
  const state = gateState(
    { toolName: "Bash", input: { command: row.command }, description: row.command, cwd: row.cwd },
    { readScripts },
  );
  if (Object.keys(state).some((k) => k.startsWith("script"))) withScript++;
  const known = QUESTIONS.filter((q) => q in row.labels);
  const any = known.some((q) => row.labels[q] === 1);
  const unsafe = any ? 1 : known.length === QUESTIONS.length ? 0 : null;
  out.push(JSON.stringify({ state, labels: row.labels, unsafe, secret: SECRET_WORDS.test(row.command) ? 1 : 0 }));
}
writeFileSync(output, `${out.join("\n")}\n`);
// The wording train.py trains on and serve.py insists on: the gate's, minus the one the word list answers.
const questions = Object.fromEntries(RISK_QUESTIONS.filter((q) => q.id !== "reveals-secret").map((q) => [q.id, q.ask]));
writeFileSync(`${output.replace(/\.jsonl$/, "")}.questions.json`, `${JSON.stringify(questions, null, 1)}\n`);
console.log(`${out.length} rows -> ${output}${readScripts ? `, ${withScript} with a script` : ""}`);
