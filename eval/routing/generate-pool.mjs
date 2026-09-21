/**
 * Ask a model for requests a developer would make of a coding agent.
 *
 * Same discipline as `eval/risk-gate/generate-pool.mjs`, and the same two
 * rules: the generator is never told about tiers, cheap, strong, or cost, and
 * it is never the model that will be judged. Only the labels are mine.
 *
 * The scenarios are framed by *situation* rather than by difficulty, because
 * naming difficulty is exactly what would leak the label into the sample.
 *
 * Usage:
 *   POOL_BASE_URL=http://localhost:11434/v1 POOL_API_KEY=ollama \
 *     node eval/routing/generate-pool.mjs --model glm4:9b > pool.json
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

const SITUATIONS = [
  "your first hour in an unfamiliar codebase",
  "a test started failing on CI but passes locally",
  "a teammate left a half-finished feature branch behind",
  "the product owner asked for a small copy change",
  "you are preparing a pull request for review",
  "an alert fired at 3am and you are still half asleep",
  "you inherited a service with no documentation",
  "a dependency published a breaking major version",
  "you are cleaning up after a rushed release",
  "someone reported the app is slow, with no other detail",
];

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
};
const model = arg("model", "glm4:9b");

const base = process.env.POOL_BASE_URL;
const ask = base
  ? (() => {
      const c = new OpenAI({ apiKey: process.env.POOL_API_KEY ?? "unused", baseURL: base });
      return async (content) =>
        (
          await c.chat.completions.create({
            model,
            max_tokens: 5000,
            messages: [{ role: "user", content }],
          })
        ).choices[0]?.message.content ?? "";
    })()
  : (() => {
      const c = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
        baseURL: process.env.ANTHROPIC_BASE_URL,
      });
      return async (content) =>
        (
          await c.messages.create({
            model,
            max_tokens: 5000,
            messages: [{ role: "user", content }],
          })
        ).content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n");
    })();

const all = [];
for (const situation of SITUATIONS) {
  const prompt =
    `A developer is working with an AI coding assistant. The situation: ${situation}.\n\n` +
    `Write 12 things the developer might ask the assistant to do, as they would type them. ` +
    `Vary them: some are quick questions, some are substantial pieces of work. Each on one line.\n\n` +
    `Output ONLY the requests, one per line, no numbering, no quotes, no commentary.`;
  let text = "";
  try {
    text = await ask(prompt);
  } catch (err) {
    console.error(`  ! ${situation.slice(0, 36)}… ${err.message}`);
    continue;
  }
  const lines = text
    .split("\n")
    .map((l) =>
      l
        .trim()
        .replace(/^[-*\d.)\s]+/, "")
        .replace(/^["'`]|["'`]$/g, "")
        .trim(),
    )
    .filter((l) => l.length > 12 && l.length < 130 && /^[A-Za-z]/.test(l));
  console.error(`${situation.slice(0, 40)}… → ${lines.length}`);
  all.push(...lines);
}
console.log(JSON.stringify([...new Set(all)], null, 1));
