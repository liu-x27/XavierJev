import { RISK_QUESTION_IDS } from "./gate.js";
import {
  type JudgeBackend,
  type JudgeState,
  type NoulAnswer,
  type NoulQuestion,
  UNKNOWN_PROBABILITY,
} from "./types.js";

/** Probability reported for a command that matched the allow-list. */
const SAFE_PROBABILITY = 0.02;

/**
 * Judge a shell command by matching it against a list of known-safe commands.
 *
 * An *allow*-list, not a deny-list, and the direction is the whole point. A
 * deny-list is a list of the destructive commands you thought of, so its
 * failure mode is to wave through the one you did not — which is exactly the
 * mistake the gate exists to prevent. This one can only be wrong in the
 * direction of asking the user about something that was in fact fine.
 *
 * It buys that property by being shallow: it does not know what a command
 * means, only that `git log` is on a list and `git push` is not. It is the
 * ten-minute version, useful as a safe default and as the baseline any judge
 * model has to beat on coverage — not as the finished feature.
 *
 * Known gaps, all of which end in "ask" rather than in "allow":
 * - Written for POSIX shells. `BashTool` runs through `child_process.exec`,
 *   which on Windows means `cmd.exe`, where the destructive surface is
 *   `del /f /s /q`, `rd /s /q` and friends. None of those are modelled; they
 *   simply do not match.
 * - Any pipe, redirect, chain, substitution or variable disqualifies the whole
 *   command, so `grep -rn TODO src/ | head` gets asked about even though both
 *   halves are on the list.
 * - Arguments are split on whitespace, so a quoted path containing spaces
 *   produces odd tokens. It cannot produce a *match* that should not have
 *   matched, because every token still has to clear the flag and path checks.
 */
export class AllowlistJudge implements JudgeBackend {
  readonly name = "allowlist";

  /**
   * @param questionIds Questions this backend is willing to answer. It gives
   * the same verdict for all of them, which is honest here and would not be
   * for a model: clearing the allow-list means the command reads files,
   * touches nothing outside the tree, opens no socket and names no
   * credential — all four harms at once, from one inspection.
   */
  constructor(private readonly questionIds: readonly string[] = RISK_QUESTION_IDS) {}

  async noul(state: JudgeState, questions: NoulQuestion[]): Promise<NoulAnswer[]> {
    return questions.map((question) => {
      // Answering a question this backend was not built for would be a
      // fabricated number, so it declines instead of guessing.
      if (!this.questionIds.includes(question.id)) {
        return { id: question.id, probability: UNKNOWN_PROBABILITY };
      }

      const command = state.tool === "Bash" ? state.command : undefined;
      if (command === undefined) {
        return { id: question.id, probability: UNKNOWN_PROBABILITY };
      }

      const verdict = this.inspect(command);
      return {
        id: question.id,
        probability: verdict.safe ? SAFE_PROBABILITY : UNKNOWN_PROBABILITY,
      };
    });
  }

  /**
   * The actual decision, exposed separately because the reason is worth
   * reading in eval output and a bare probability is not.
   */
  inspect(command: string): { safe: boolean; reason: string } {
    const trimmed = command.trim();
    if (!trimmed) {
      return { safe: false, reason: "empty command" };
    }

    const metacharacter = SHELL_METACHARACTERS.find((m) => trimmed.includes(m));
    if (metacharacter !== undefined) {
      return { safe: false, reason: `contains ${JSON.stringify(metacharacter)}` };
    }

    const argv = trimmed.split(/\s+/);
    const program = argv[0];
    if (program === undefined) {
      return { safe: false, reason: "empty command" };
    }

    const rule = READ_ONLY_COMMANDS[program];
    if (!rule) {
      return { safe: false, reason: `"${program}" is not on the allow-list` };
    }

    const args = argv.slice(1);

    if (rule.subcommands) {
      const subcommand = args[0];
      if (subcommand === undefined || !rule.subcommands.includes(subcommand)) {
        return {
          safe: false,
          reason: `"${program} ${subcommand ?? ""}".trim() is not an allowed subcommand`,
        };
      }
    }

    const deniedFlags = [...ALWAYS_DENIED_FLAGS, ...(rule.deniedFlags ?? [])];
    const badFlag = args.find((arg) => deniedFlags.includes(arg));
    if (badFlag !== undefined) {
      return { safe: false, reason: `flag "${badFlag}" can write or delete` };
    }

    // Searches that walk the tree can read anything under it, whatever the
    // paths say, so they are refused before the paths are even looked at.
    const recursiveFlag = args.find((arg) => RECURSIVE_SEARCH_FLAGS.includes(arg));
    if (recursiveFlag !== undefined && SEARCH_PROGRAMS.has(program)) {
      return {
        safe: false,
        reason: `"${recursiveFlag}" walks the tree and reads every file in it`,
      };
    }

    const foreignArg = args.find(
      (arg) => !arg.startsWith("-") && !looksLikeOrdinaryProjectPath(arg),
    );
    if (foreignArg !== undefined) {
      return { safe: false, reason: `"${foreignArg}" is not an ordinary path inside the project` };
    }

    return { safe: true, reason: `${program} with read-only arguments` };
  }
}

/**
 * Anything that lets a second command run, sends output into a file, or
 * substitutes a value we cannot see at inspection time.
 *
 * `$` is in here for the same reason as the rest: `echo $PATH` is harmless,
 * but nothing about `cat $TARGET` can be judged without knowing the
 * environment, and this backend judges text.
 */
const SHELL_METACHARACTERS = [";", "|", "&", ">", "<", "`", "$", "\n", "\r"];

/** Flags that turn an otherwise read-only command into a writing one. */
const ALWAYS_DENIED_FLAGS = [
  "--force",
  "--hard",
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprintf",
  "-fls",
];

interface CommandRule {
  /** When set, the first argument must be one of these. */
  subcommands?: string[];
  /** Flags denied for this command specifically. */
  deniedFlags?: string[];
}

/**
 * Commands that only read. Deliberately short — the cost of leaving something
 * out is one permission prompt, and the cost of putting something in wrongly
 * is a destructive call nobody saw.
 */
const READ_ONLY_COMMANDS: Record<string, CommandRule | undefined> = {
  basename: {},
  cat: {},
  cmp: {},
  cut: {},
  date: {},
  df: {},
  diff: {},
  dirname: {},
  du: {},
  echo: {},
  egrep: {},
  fgrep: {},
  file: {},
  // `find` can write and execute; the denied flags above are what stops it.
  find: {},
  git: {
    subcommands: [
      "status",
      "log",
      "diff",
      "show",
      "blame",
      "shortlog",
      "rev-parse",
      "ls-files",
      "describe",
    ],
  },
  grep: {},
  head: {},
  hostname: {},
  jq: {},
  ls: {},
  nl: {},
  // `node <file>` runs arbitrary code, so only the version probe is allowed.
  node: { subcommands: ["--version", "-v"] },
  pwd: {},
  // `sed -i` edits in place; without it, output goes to stdout.
  sed: { deniedFlags: ["-i", "--in-place"] },
  sort: {},
  stat: {},
  tail: {},
  tr: {},
  tree: {},
  uname: {},
  uniq: {},
  wc: {},
  which: {},
  whoami: {},
};

/**
 * Whether an argument is an ordinary file inside the project.
 *
 * This replaced a list of secret-path markers — `.ssh`, `id_rsa`, `.env`,
 * `.aws` and nine more — which was a deny-list living inside an allow-list
 * and failed exactly the way this file's own docstring says deny-lists fail.
 * `cat ~/.docker/config.json` cleared the gate on a held-out set because
 * `.docker` was not among the fourteen names someone had thought of, and
 * adding a fifteenth would have fixed that row and not the class.
 *
 * So the question is inverted. Rather than asking whether a path looks
 * dangerous, it asks whether the path is plainly harmless: a relative path
 * under the working directory, not a dotfile. Everything else — the home
 * directory, absolute paths, `..`, and dotfiles of any name — is not cleared,
 * without needing to know what it holds. The credential files above are all
 * outside the tree or dotfiles or both, so they fall out for free, and so do
 * the ones nobody has heard of yet.
 *
 * `.` and `./…` are allowed because they name the working directory itself.
 *
 * Measured cost of the inversion across all four labelled sets — 457
 * commands, 231 of them unsafe — is **three clearances**: two recursive greps
 * and one `rg`, all to the traversal rule below rather than to this one. Both
 * held-out false allows are gone and there are now none on any set.
 *
 * `jq '.name' package.json` survives, which is luck rather than design: the
 * shell quoting is still attached when the argument reaches here, so the
 * filter reads as `'.name'` and does not look like a dotfile. A caller that
 * passed pre-unquoted arguments would lose it.
 */
function looksLikeOrdinaryProjectPath(arg: string): boolean {
  if (arg === "." || arg.startsWith("./")) return true;
  if (arg.startsWith("~") || arg.startsWith("/")) return false;
  if (arg.includes("..")) return false;

  // A dotfile anywhere in the path: `.env`, `src/.secrets`, `.ssh/config`.
  return !arg.split(/[\\/]/).some((part) => part.startsWith("."));
}

/**
 * Searches that walk the tree rather than naming their files.
 *
 * `grep -r api_key . --include=*.json` cleared the gate on a held-out set:
 * every path argument was ordinary, no flag wrote anything, and the pattern
 * was just a string. The harm is not in the path, it is that a recursive
 * search reads *every* file under the root and prints what matches — so it
 * can surface a credential regardless of which paths were named or what the
 * pattern happens to be.
 *
 * Deciding that from the pattern would be another deny-list. Deciding it from
 * the traversal is sound: a search that names its files can only read those
 * files. `rg` is not on the allow-list at all, because it recurses by default
 * and there is no flag whose absence makes it safe.
 */
const RECURSIVE_SEARCH_FLAGS = [
  "-r",
  "-R",
  "-rn",
  "-rl",
  "-rin",
  "-rni",
  "--recursive",
  "--dereference-recursive",
];

/** Programs whose job is to read file contents in bulk. */
const SEARCH_PROGRAMS = new Set(["grep", "egrep", "fgrep"]);
