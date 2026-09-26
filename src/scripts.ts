import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The local script files a shell command runs, so a judge can be shown what they do.
 *
 * A command like `python /tmp/patch.py` says nothing about its effect; the script does. Reading
 * this machine's agent traffic by hand, the harm that no command-only judge could see was
 * almost always of this kind — a scratch script that rewrote a tracked file in another
 * repository — so the gate can put the start of each script into the state beside the command
 * (`RiskGateOptions.readScripts`).
 *
 * Recognised: an interpreter (python, py, node, tsx, deno, bun, bash, sh, zsh) followed, after
 * any flags, by a path ending in .py, .js, .mjs, .cjs, .ts, .mts or .sh. `NAME=value`
 * assignments earlier in the command are substituted into `$NAME/…` paths; a relative path is
 * taken from a leading `cd` if there is one, else from the working directory. On Windows, Git
 * Bash's `/c/…` becomes `C:/…`. Anything else — `npm run`, a module name, a script generated
 * in the same command — is not a file to read, and is left to the command text.
 */
export function scriptsRun(command: string, cwd?: string): string[] {
  const env = new Map<string, string>();
  for (const m of command.matchAll(
    /(?:^|[;&\s])(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&]+)/g,
  )) {
    env.set(m[1]!, unquote(m[2]!));
  }
  const cd = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/.exec(command);
  const base = cd ? toNative(unquote(cd[1]!)) : cwd;
  const found: string[] = [];
  const runner =
    /(?:^|[\s;&|(`])(?:python3?|py|node|tsx|deno(?:\s+run)?|bun|bash|sh|zsh)(?:\.exe)?((?:\s+-[-\w=]+)*)\s+("[^"]+"|'[^']+'|[^\s;&|)`<>]+)/g;
  for (const m of command.matchAll(runner)) {
    let p = unquote(m[2]!);
    if (!/\.(py|js|mjs|cjs|ts|mts|sh)$/i.test(p)) continue;
    p = p.replace(
      /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g,
      (whole, name: string) => env.get(name) ?? whole,
    );
    if (p.includes("$")) continue;
    p = toNative(p);
    if (!path.isAbsolute(p)) {
      if (!base || !path.isAbsolute(base)) continue;
      p = path.join(base, p);
    }
    if (!found.includes(p)) found.push(p);
  }
  return found;
}

/** A script's text for the state, or undefined when there is no readable file there. */
export function readScript(file: string, maxChars: number): string | undefined {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > 1_000_000) return undefined;
    const text = readFileSync(file, "utf8");
    return text.length <= maxChars
      ? `${file}\n${text}`
      : `${file} (first ${maxChars} of ${text.length} characters)\n${text.slice(0, maxChars)}`;
  } catch {
    return undefined;
  }
}

function unquote(s: string): string {
  return /^(["']).*\1$/s.test(s) ? s.slice(1, -1) : s;
}

function toNative(p: string): string {
  if (process.platform === "win32") {
    const m = /^\/([a-zA-Z])\/(.*)$/.exec(p);
    if (m) return `${m[1]!.toUpperCase()}:/${m[2]}`;
  }
  return p;
}
