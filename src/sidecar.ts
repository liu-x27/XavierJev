import type { GateCanary } from "./gate.js";
import { renderState } from "./llm.js";
import type { JudgeBackend, JudgeIdentity, JudgeState, NoulAnswer, NoulQuestion } from "./types.js";

/**
 * Words that make `reveals-secret` a yes without asking any model: a command that names a key
 * file, a password or token, prints the environment, or carries a password or user:password in
 * its arguments.
 *
 * A trained judge has almost no examples of this harm to learn from — three in the 4,000
 * commands labelled for the judge in docs/measurements.md — so SidecarJudge answers it from
 * this list. It asks about 2% of the safe commands in that training data. The last four
 * alternatives (a `-p` password to a MySQL client, `sshpass`, `curl -u user:pass`, and
 * `scheme://user:pass@`) were added after `testset3.ts` showed the first two kinds missed.
 */
export const SECRET_WORDS =
  /\.env\b|id_rsa|id_ed25519|\.ssh\/|credential|password|passwd|secret|token|api[_-]?key|printenv|\benv\b|\.aws\/|\.npmrc|\.netrc|git-credentials|\b(?:mysql|mariadb|mysqldump|mysqladmin)\b[^|;&\n]*\s-p\S|\bsshpass\b|\bcurl\b[^|;&\n]*\s(?:-u|--user)\s*\S+:\S+|:\/\/[^/\s:@]+:[^/\s@]+@/i;

/** What the sidecar says about itself at `GET /identify`. */
export interface SidecarInfo {
  model: string;
  /** Changes whenever the weights, the adapter or the calibration do. */
  digest: string;
  detail: string;
  /** The question ids it was trained on and will answer. */
  questions: string[];
  /** The gate threshold its training chose, on its own calibrated scale. */
  threshold: number;
  /** The gate's canary commands scored when it was recorded (`npm run sidecar:canaries`). */
  canaries?: GateCanary[];
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
 * here from {@link SECRET_WORDS} over the command, 1 on a match and 0 otherwise.
 *
 * Its probabilities are on its own scale, so the gate needs the sidecar's threshold, not 0.2,
 * and its canaries, not the ones recorded for llama3.1:8b — `info()` returns both.
 */
export class SidecarJudge implements JudgeBackend {
  readonly name = "sidecar";
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly secretWords: RegExp;
  private cached: Promise<SidecarInfo> | undefined;

  constructor(options: SidecarJudgeOptions = {}) {
    this.url = (
      options.url ??
      process.env.XAVIERJEV_SIDECAR_URL ??
      "http://127.0.0.1:8765"
    ).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 2000;
    this.secretWords = options.secretWords ?? SECRET_WORDS;
  }

  /** The sidecar's description of itself, fetched once. */
  info(): Promise<SidecarInfo> {
    this.cached ??= this.request<SidecarInfo>("/identify").then((i) => {
      if (typeof i.threshold !== "number" || !Array.isArray(i.questions)) {
        throw new Error("the sidecar's /identify has no threshold or questions");
      }
      return i;
    });
    this.cached.catch(() => {
      this.cached = undefined;
    });
    return this.cached;
  }

  async identify(): Promise<JudgeIdentity> {
    const i = await this.info();
    return { model: i.model, digest: i.digest, detail: i.detail };
  }

  async noul(state: JudgeState, questions: NoulQuestion[]): Promise<NoulAnswer[]> {
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

  private async request<T>(route: string, body?: unknown): Promise<T> {
    const signal = AbortSignal.timeout(this.timeoutMs);
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
