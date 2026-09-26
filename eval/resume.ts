import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { JudgeBackend } from "../src/types.js";

/**
 * Bind a results file that an eval appends to and resumes from to the run that wrote it.
 *
 * A resumed run keeps the answers already in the file and asks only for the rest. Started
 * with one judge and finished with another, the file holds two judges' answers under one
 * name and nothing in it says so — the answers are just rows. So beside it, `<file>.run.json`
 * records what decides an answer: the eval, the backend, the model and the digest the
 * endpoint reports, this package's version and the eval's own settings. A later run that
 * describes itself differently is refused before it asks anything.
 *
 * A prompt edited without a version bump is not caught; neither is a model that reports no
 * digest being swapped for another under the same name.
 */
export async function bindRun(
  file: string,
  evalName: string,
  backend: JudgeBackend,
  settings: Record<string, unknown> = {},
): Promise<void> {
  const identity = await backend.identify?.().catch(() => undefined);
  const run = {
    eval: evalName,
    backend: backend.name,
    model: identity?.model ?? null,
    digest: identity?.digest ?? null,
    xavierjev: packageVersion(),
    ...settings,
  };
  const problem = runMismatch(file, run);
  if (problem) {
    console.error(problem);
    process.exit(2);
  }
}

/**
 * Why `file` cannot be resumed as `run`, or undefined — after writing `<file>.run.json` when
 * the file is new. Exported for the mock suite.
 */
export function runMismatch(file: string, run: Record<string, unknown>): string | undefined {
  const manifest = `${file}.run.json`;
  const started = existsSync(file) && statSync(file).size > 0;
  if (!started) {
    writeFileSync(manifest, `${JSON.stringify(run, null, 1)}\n`);
    return undefined;
  }
  if (!existsSync(manifest)) {
    return `${file} already has answers, and no ${manifest} to say what gave them (written before 0.7.0?). Start a new file.`;
  }
  const then = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
  const show = (value: unknown) => JSON.stringify(value ?? null);
  const differs = [...new Set([...Object.keys(then), ...Object.keys(run)])].filter((k) => show(then[k]) !== show(run[k]));
  if (!differs.length) return undefined;
  const lines = differs.map((k) => `  ${k}: ${show(then[k])} then, ${show(run[k])} now`);
  return `${file} was started by a different run; resuming would mix two judges' answers.\n${lines.join("\n")}\nStart a new file.`;
}

function packageVersion(): string {
  return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
}
