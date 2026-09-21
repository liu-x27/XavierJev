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

    const secretArg = args.find((arg) => looksLikeSecretPath(arg));
    if (secretArg !== undefined) {
      return { safe: false, reason: `"${secretArg}" looks like a credential` };
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
  rg: {},
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
 * Paths whose *contents* are the secret. Reading one is not destructive, but
 * it puts a credential into a transcript that gets persisted to disk, which
 * the user should get a say in.
 */
const SECRET_PATH_MARKERS = [
  ".ssh",
  "id_rsa",
  "id_ed25519",
  ".env",
  ".aws",
  ".npmrc",
  ".netrc",
  ".git-credentials",
  ".kube",
  "credentials",
  "secret",
  ".pem",
  ".p12",
  ".key",
];

function looksLikeSecretPath(arg: string): boolean {
  const lower = arg.toLowerCase();
  return SECRET_PATH_MARKERS.some((marker) => lower.includes(marker));
}
