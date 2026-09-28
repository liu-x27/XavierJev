import type { GateCanary } from "./gate.js";
import { renderState } from "./llm.js";
import type { JudgeBackend, JudgeIdentity, JudgeState, NoulAnswer, NoulOptions, NoulQuestion } from "./types.js";

/**
 * Words that make `reveals-secret` a yes without asking any model: a command that names a key
 * file, a password or token, prints the environment, carries a password or user:password in its
 * arguments, or names the shape a credential itself has.
 *
 * A trained judge has almost no examples of this harm to learn from — three in the 4,000
 * commands labelled for the judge in docs/measurements.md — so SidecarJudge answers it from
 * this list. It asks about 2% of the safe commands in that training data. Two rounds have been
 * added to it, both after a measurement, not before:
 *
 * - a `-p` password to a MySQL client, `sshpass`, `curl -u user:pass` and `scheme://user:pass@`,
 *   after `testset3.ts` showed the first two kinds missed;
 * - the credential shapes in {@link SECRET_SHAPES}, after a blind audit of a trained judge's
 *   clears found one command the list missed: it scanned stored text for credential patterns and
 *   printed the lines that matched. This list only reads the command, so what it can be given is
 *   the vocabulary of secrets, not a way of recognising a scan.
 *
 * What it still cannot do is see a secret a command reveals without naming one — through a
 * script it runs, or a pattern spelled some other way. The list is a floor under
 * `reveals-secret`, not an answer to it.
 */
export const SECRET_WORDS =
  /\.env\b|id_rsa|id_ed25519|\.ssh\/|credential|password|passwd|secret|token|api[_-]?key|printenv|\benv\b|\.aws\/|\.npmrc|\.netrc|git-credentials|\b(?:mysql|mariadb|mysqldump|mysqladmin)\b[^|;&\n]*\s-p\S|\bsshpass\b|\bcurl\b[^|;&\n]*\s(?:-u|--user)\s*\S+:\S+|:\/\/[^/\s:@]+:[^/\s@]+@|\bsk-|\bgh[pousr]_[A-Za-z0-9]|github_pat_|\bxox[baprs]-|AKIA[0-9A-Z]{16}|\bbearer\b|\bauthorization\b|passphrase|private[_-]?key|access[_-]?key|client[_-]?secret|\.pem\b|\.p12\b|\.pfx\b|\.keystore\b|\.jks\b|\.htpasswd\b|\.pgpass\b|keychain|sessdata|\bbcookie\b|session[_-]?cookies?|\bcookies?\.(?:txt|json|sqlite|db|jar)\b/i;

/**
 * The shapes added to {@link SECRET_WORDS} in the second round, kept separately so a build can
 * say which vocabulary it has: the prefixes of keys that providers issue (`sk-`, GitHub's
 * `ghp_`/`github_pat_`, Slack's `xox*-`, AWS's `AKIA…`), the words a credential is carried or
 * named by (`bearer`, `authorization`, `passphrase`, private/access key, client secret), the
 * files one is kept in (`.pem`, `.p12`, `.pfx`, `.keystore`, `.jks`, `.htpasswd`, `.pgpass`,
 * keychain), and session cookies. Matching is over the command text, so a command that merely
 * mentions one of these — a scan looking for them, a fixture using an invalid placeholder — is
 * a yes as well; the gate's answer to a yes is to ask, so the cost is a question.
 *
 * Cookies are the one shape here that is not taken as a word on its own: `cookie` also names
 * things that are not credentials (an archive's magic cookie, a browser flag), and on the
 * commands this was measured on the bare word was most of what the round cost. A cookie jar by
 * name, `bcookie`, and `session cookie` are matched instead.
 */
export const SECRET_SHAPES = [
  "sk-",
  "ghp_/gho_/ghu_/ghs_/ghr_",
  "github_pat_",
  "xoxb-/xoxa-/xoxp-/xoxr-/xoxs-",
  "AKIA…",
  "bearer",
  "authorization",
  "passphrase",
  "private key / access key / client secret",
  ".pem/.p12/.pfx/.keystore/.jks/.htpasswd/.pgpass",
  "keychain",
  "sessdata",
  "session cookies (a cookie jar by name, not the word on its own)",
] as const;

/**
 * The gate's canaries as scored by one trained judge (`npm run sidecar:canaries`), and what they
 * were scored on, so that a later start can tell whether they still describe the judge in front
 * of it. Files written before 0.7.0 are a bare array; the sidecar serves those as
 * `{ canaries }` alone, and they no longer verify.
 */
export interface CanaryRecording {
  /** The judge's `/identify` when the canaries were scored. */
  recordedOn?: { model: string; digest: string };
  /** The threshold they were scored at. */
  threshold?: number;
  /** `SECRET_WORDS.source` of the build that scored them, since that list answers `reveals-secret`. */
  secretWords?: string;
  canaries: GateCanary[];
}

/** What the sidecar says about itself at `GET /identify`. */
export interface SidecarInfo {
  model: string;
  /** Changes whenever the base model's revision, the adapter or the calibration do. */
  digest: string;
  detail: string;
  /** The question ids it was trained on and will answer. */
  questions: string[];
  /** The gate threshold its training chose, on its own calibrated scale. */
  threshold: number;
  /**
   * Whether it was trained on states with the scripts a command runs (`prepare.ts
   * --read-scripts`). Null or absent for runs before 0.7.0, which did not record it.
   */
  readScripts?: boolean | null;
  /** The base model's revision: the hub snapshot, or a hash of a local model's files. */
  modelRevision?: string;
  /** The canaries it serves, with what they were recorded on. */
  recording?: CanaryRecording;
}

/**
 * Reasons the canaries a sidecar serves may not describe the judge it is now, beyond the digest
 * comparison `checkGate` makes against `recording.recordedOn`: recorded without saying on which
 * judge, at another threshold, with another word list, or for a judge trained with scripts shown
 * and now run without them, or the other way round. An empty list means nothing here stands in
 * the way; a host that clears commands should treat anything else as unverified.
 */
export function recordingProblems(
  info: SidecarInfo,
  live: { readScripts: boolean; secretWords?: RegExp },
): string[] {
  const recording = info.recording;
  if (!recording?.canaries?.length) return ["the sidecar serves no recorded canaries"];
  if (!recording.recordedOn) {
    return ["its canaries were recorded without the judge's identity (before 0.7.0): record them again"];
  }
  const problems: string[] = [];
  if (recording.threshold !== info.threshold) {
    problems.push(`its canaries were recorded at threshold ${recording.threshold}, and it now serves ${info.threshold}`);
  }
  if (recording.secretWords !== (live.secretWords ?? SECRET_WORDS).source) {
    problems.push("its canaries were recorded with a different reveals-secret word list from this build's");
  }
  if (typeof info.readScripts !== "boolean") {
    problems.push(
      'its calibration.json does not say whether scripts were shown in training (before 0.7.0): add "read_scripts"',
    );
  } else if (info.readScripts !== live.readScripts) {
    problems.push(
      info.readScripts
        ? "it was trained with the scripts a command runs in its state, and they are not being shown"
        : "it was trained without scripts in its state, and they are being shown (--read-scripts)",
    );
  }
  return problems;
}

export interface SidecarJudgeOptions {
  /** Default `XAVIERJEV_SIDECAR_URL`, else http://127.0.0.1:8765. */
  url?: string | undefined;
  /** Per request. Default 2000 ms, the gate's own timeout. */
  timeoutMs?: number;
  /** For `reveals-secret`. Default {@link SECRET_WORDS}. */
  secretWords?: RegExp;
}

/**
 * A judge that is a model trained for the gate's questions, served on this machine.
 *
 * The sidecar (sidecar/serve.py) holds a small language model with a fine-tuned adapter and
 * answers `POST /noul` with a calibrated probability per question for the questions it was
 * trained on; anything else it refuses, and a refusal, like a timeout or a dead sidecar, is a
 * judge failure the gate turns into asking. `reveals-secret` never goes to it: it is answered
 * here from {@link SECRET_WORDS} over the command, 1 on a match and 0 otherwise. The list reads
 * the command only, not the `script` entries `readScripts` adds, so a script that prints a
 * credential is left to the three trained questions, which were not trained for that harm.
 *
 * Its probabilities are on its own scale, so the gate needs the sidecar's threshold, not 0.2,
 * and its canaries, not the ones recorded for llama3.1:8b — `info()` returns both.
 */
export class SidecarJudge implements JudgeBackend {
  readonly name = "sidecar";
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly secretWords: RegExp;

  constructor(options: SidecarJudgeOptions = {}) {
    this.url = (
      options.url ??
      process.env.XAVIERJEV_SIDECAR_URL ??
      "http://127.0.0.1:8765"
    ).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 2000;
    // A global or sticky RegExp keeps lastIndex between test() calls, so the same command
    // would alternate between matching and not.
    const words = options.secretWords ?? SECRET_WORDS;
    this.secretWords = /[gy]/.test(words.flags) ? new RegExp(words.source, words.flags.replace(/[gy]/g, "")) : words;
  }

  /** The sidecar's description of itself, asked afresh each time: it may have been restarted on other weights. */
  async info(): Promise<SidecarInfo> {
    const i = await this.request<SidecarInfo>("/identify");
    if (typeof i.threshold !== "number" || !Array.isArray(i.questions)) {
      throw new Error("the sidecar's /identify has no threshold or questions");
    }
    return i;
  }

  async identify(): Promise<JudgeIdentity> {
    const i = await this.info();
    return { model: i.model, digest: i.digest, detail: i.detail };
  }

  async noul(state: JudgeState, questions: NoulQuestion[], options: NoulOptions = {}): Promise<NoulAnswer[]> {
    const text = typeof state.command === "string" ? state.command : renderState(state);
    const local = new Map<string, number>();
    const remote: NoulQuestion[] = [];
    for (const q of questions) {
      if (q.id === "reveals-secret") local.set(q.id, this.secretWords.test(text) ? 1 : 0);
      else remote.push(q);
    }
    const got = new Map<string, number>();
    if (remote.length) {
      const body = await this.request<{ answers?: Array<{ id: string; probability: number }> }>(
        "/noul",
        {
          state,
          questions: remote.map((q) => ({ id: q.id, ask: q.ask })),
        },
        options.signal,
      );
      for (const a of body.answers ?? []) got.set(a.id, a.probability);
    }
    return questions.map((q) => {
      const p = local.get(q.id) ?? got.get(q.id);
      if (typeof p !== "number" || !(p >= 0 && p <= 1))
        throw new Error(`the sidecar gave no probability for ${q.id}`);
      return { id: q.id, probability: p };
    });
  }

  private async request<T>(route: string, body?: unknown, caller?: AbortSignal): Promise<T> {
    const own = AbortSignal.timeout(this.timeoutMs);
    const signal = caller ? AbortSignal.any([own, caller]) : own;
    const init: RequestInit =
      body === undefined
        ? { method: "GET", signal }
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal,
          };
    const res = await fetch(`${this.url}${route}`, init);
    if (!res.ok)
      throw new Error(`sidecar ${route}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }
}
