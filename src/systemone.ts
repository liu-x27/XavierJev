import { ollamaIdentity, renderState } from "./llm.js";
import { positiveOption } from "./options.js";
import type {
  ChoiceBackend,
  ChoiceOption,
  ChoiceResult,
  JudgeBackend,
  JudgeIdentity,
  JudgeState,
  NoulAnswer,
  NoulOptions,
  NoulQuestion,
  OrderOptions,
  RubricBackend,
  RubricLevel,
  RubricResult,
} from "./types.js";

export interface SystemOneJudgeOptions {
  /**
   * The server, by its origin: http://127.0.0.1:11434 for Ollama, or whatever `--port` llama.cpp's
   * server was given (9931 by default since v0.7.0). It must be on this machine. Default
   * `XAVIERJEV_SYSTEMONE_URL`, else http://127.0.0.1:11434.
   */
  url?: string | undefined;
  /** The decision model to ask for, as the server names it. Default `XAVIERJEV_SYSTEMONE_MODEL`. */
  model?: string | undefined;
  /** Per request. Default 2000 ms, the gate's own timeout. */
  timeoutMs?: number;
}

/** One question as the endpoint takes it. */
type SystemOneQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

/** One answer as the endpoint returns it, before anything about it is trusted. */
interface SystemOneAnswer {
  type?: unknown;
  noul?: unknown;
  probabilities?: Record<string, unknown>;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Ollama's cloud tags — `clef:cloud`, `gpt-oss:120b-cloud` — which a local Ollama answers on its own servers. */
const CLOUD_MODEL = /:(?:[^:]*-)?cloud$/i;

/** As for `LlmJudge`, whose options are labelled A to H. */
const MAX_OPTIONS = 8;

const isProbability = (p: unknown): p is number => typeof p === "number" && p >= 0 && p <= 1;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * A judge that is a decision model, asked through the `/v1/systemone` endpoint a local server
 * now offers.
 *
 * Ollama has answered `POST /v1/systemone` since 0.35 (2026-09-28), and llama.cpp's server since
 * v0.6.0 (2026-10-05): a state and named, typed questions go in, and a probability for each comes
 * out, from models trained for that — nimble and tev1 on Ollama; Julia-1, Laya, Kev-4B and lev on
 * llama.cpp. This backend asks the gate's questions there, all of them in one request, and reads
 * `answers[id].noul` as P(yes). It only asks: it pulls no model, and nothing it is told is kept or
 * learned from.
 *
 * Only on this machine. The request is the shape TypeSafe's hosted Jev API takes, so a URL is all
 * that would stand between this class and that API, which nothing in this repository calls. The
 * URL must be a loopback address, and an Ollama cloud model, which a local Ollama forwards to its
 * own servers, is refused when the judge is built.
 *
 * Every failure is an error, which the gate turns into asking: a refusal, a timeout, a dead
 * server, an answer missing, of the wrong type or outside [0, 1], and an answer from another model
 * than the one asked for. That last one is not hypothetical: llama.cpp's server ignores `model`
 * when it has one loaded and answers with that one, so the response must name the model asked
 * for — start llama-server with `--alias` set to the name given here.
 *
 * What it cannot report is coverage. The endpoint returns probabilities already normalised over
 * the answers a question allows, so whatever share a model put elsewhere, if its server reads
 * label tokens at all, never reaches this side. `noul()` leaves `coverage` out, as any backend
 * that reads no probabilities of its own does, and `choice()` and `rubric()` give NaN:
 * `MIN_COVERAGE` cannot catch a decision model that wanted to say something else.
 *
 * Its probabilities are on the model's own scale. llama.cpp's announcement says to pick the cutoff
 * per model; the gate's 0.2 belongs to llama3.1:8b, and the self-check's canaries were recorded on
 * it, so `checkGate` with its defaults calls none of these models the gate that was measured.
 * Each needs its threshold measured (`npm run eval:decision-models`).
 */
export class SystemOneJudge implements JudgeBackend, ChoiceBackend, RubricBackend {
  readonly name: string;
  readonly url: string;
  readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: SystemOneJudgeOptions = {}) {
    const url = (options.url ?? process.env.XAVIERJEV_SYSTEMONE_URL ?? "http://127.0.0.1:11434")
      .replace(/\/+$/, "")
      .replace(/\/v1$/, "");
    let host: string | undefined;
    try {
      host = new URL(url).hostname;
    } catch {
      host = undefined;
    }
    if (!host || !LOOPBACK_HOSTS.has(host)) {
      throw new Error(
        `SystemOneJudge asks only a server on this machine (localhost, 127.0.0.1 or [::1]), not ${url}`,
      );
    }
    const model = options.model ?? process.env.XAVIERJEV_SYSTEMONE_MODEL;
    if (!model) {
      throw new Error("SystemOneJudge needs a model: pass `model`, or set XAVIERJEV_SYSTEMONE_MODEL.");
    }
    if (CLOUD_MODEL.test(model)) {
      throw new Error(`${model} is an Ollama cloud model, answered off this machine: SystemOneJudge will not send it a command`);
    }
    this.url = url;
    this.model = model;
    this.name = `systemone:${model}`;
    this.timeoutMs = positiveOption("timeoutMs", options.timeoutMs ?? 2000);
  }

  async noul(state: JudgeState, questions: NoulQuestion[], options: NoulOptions = {}): Promise<NoulAnswer[]> {
    if (questions.length === 0) return [];
    // The questions travel keyed by id, so two with one id would be one question, answered once
    // for both.
    if (new Set(questions.map((q) => q.id)).size !== questions.length) {
      throw new Error(`noul() questions need distinct ids, got ${questions.map((q) => q.id).join(", ")}`);
    }
    // All of them in one request: the endpoint answers named questions about one state, and a
    // server that can read the state once for all of them does.
    const answers = await this.ask(
      state,
      questions.map((q) => [q.id, { type: "noul", instructions: q.ask }]),
      options.signal,
    );
    return questions.map((q) => {
      const a = answers[q.id];
      if (!a || (a.type !== undefined && a.type !== "noul") || !isProbability(a.noul)) {
        throw new Error(`${this.name} gave no probability for ${q.id}: ${JSON.stringify(a)?.slice(0, 120)}`);
      }
      return { id: q.id, probability: a.noul };
    });
  }

  /**
   * Pick one of 2 to 8 options, keyed by their ids. With `orders: "all"` every rotation goes in
   * the same request as a question of its own, since the endpoint answers questions independently.
   * Whether the model reads the options in the order sent is up to the server: a JSON object
   * carries no order a server has to keep.
   */
  async choice(
    state: JudgeState,
    ask: string,
    options: ChoiceOption[],
    opts: OrderOptions = {},
  ): Promise<ChoiceResult> {
    if (options.length < 2 || options.length > MAX_OPTIONS) {
      throw new Error(`choice() takes 2 to ${MAX_OPTIONS} options, got ${options.length}`);
    }
    if (new Set(options.map((o) => o.id)).size !== options.length) {
      throw new Error(`choice() options need distinct ids, got ${options.map((o) => o.id).join(", ")}`);
    }
    const orders =
      opts.orders === "all"
        ? options.map((_, k) => [...options.slice(k), ...options.slice(0, k)])
        : [options];
    const answers = await this.ask(
      state,
      orders.map((order, k) => [
        `order-${k}`,
        { type: "choice", instructions: ask, criteria: Object.fromEntries(order.map((o) => [o.id, o.text])) },
      ]),
    );
    const ids = options.map((o) => o.id);
    const per = orders.map((_, k) => this.distribution(answers[`order-${k}`], "choice", ids));
    return {
      answers: options.map((o, i) => ({ id: o.id, probability: mean(per.map((p) => p[i]!)) })),
      coverage: Number.NaN,
      orders: orders.length,
    };
  }

  /**
   * Place a state on 2 to 9 levels, sent lowest first as the endpoint's `score` questions expect,
   * and read back by position. The endpoint's own `score` is the mean over zero-based positions;
   * the mean and spread here are over the levels' scores, as `LlmJudge` gives them.
   */
  async rubric(
    state: JudgeState,
    ask: string,
    levels: RubricLevel[],
    opts: OrderOptions = {},
  ): Promise<RubricResult> {
    if (levels.length < 2 || levels.length > 9) {
      throw new Error(`rubric() takes 2 to 9 levels, got ${levels.length}`);
    }
    const scores = levels.map((l) => l.score);
    if (!scores.every(Number.isFinite) || new Set(scores).size !== scores.length) {
      throw new Error(`rubric() levels need distinct finite scores, got ${scores.join(", ")}`);
    }
    const orders = opts.orders === "all" ? [levels, [...levels].reverse()] : [levels];
    const answers = await this.ask(
      state,
      orders.map((order, k) => [
        `order-${k}`,
        { type: "score", instructions: ask, criteria: order.map((l) => l.text) },
      ]),
    );
    const per = orders.map((order, k) => {
      const p = this.distribution(
        answers[`order-${k}`],
        "score",
        order.map((_, i) => String(i)),
      );
      return new Map(order.map((l, i) => [l.score, p[i]!]));
    });
    const distribution = levels.map((l) => ({
      score: l.score,
      probability: mean(per.map((m) => m.get(l.score)!)),
    }));
    const expected = distribution.reduce((a, d) => a + d.score * d.probability, 0);
    const spread = Math.sqrt(
      distribution.reduce((a, d) => a + d.probability * (d.score - expected) ** 2, 0),
    );
    return { distribution, expected, spread, coverage: Number.NaN, orders: orders.length };
  }

  /**
   * Which model serves this judge's name, by digest, when the server is an Ollama; llama.cpp's
   * server reports none, and there the canaries are the whole check.
   */
  async identify(): Promise<JudgeIdentity> {
    return ollamaIdentity(this.url, this.model);
  }

  /** P(each key), in the order given and summing to 1, or a throw. */
  private distribution(answer: SystemOneAnswer | undefined, type: "choice" | "score", keys: string[]): number[] {
    if (!answer || (answer.type !== undefined && answer.type !== type)) {
      throw new Error(`${this.name} gave no ${type} answer: ${JSON.stringify(answer)?.slice(0, 120)}`);
    }
    const p = keys.map((k) => answer.probabilities?.[k]);
    if (!p.every(isProbability)) {
      throw new Error(
        `${this.name} gave no probability for every option: ${JSON.stringify(answer.probabilities)?.slice(0, 120)}`,
      );
    }
    const total = p.reduce((a, b) => a + b, 0);
    if (!(total > 0)) throw new Error(`${this.name} put no probability on any option`);
    return p.map((x) => x / total);
  }

  private async ask(
    state: JudgeState,
    questions: Array<[string, SystemOneQuestion]>,
    caller?: AbortSignal,
  ): Promise<Record<string, SystemOneAnswer | undefined>> {
    const own = AbortSignal.timeout(this.timeoutMs);
    const signal = caller ? AbortSignal.any([own, caller]) : own;
    const res = await fetch(`${this.url}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The state as the prompted judge reads it, `key: value` lines, so a comparison between the
      // two changes the judge and not the state: Ollama would render an object as JSON instead,
      // and llama.cpp's server takes text.
      body: JSON.stringify({ model: this.model, state: renderState(state), questions: Object.fromEntries(questions) }),
      signal,
    });
    const text = await res.text();
    let body: { model?: unknown; answers?: unknown; error?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${this.name}: HTTP ${res.status}, and not JSON: ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      throw new Error(`${this.name}: HTTP ${res.status} ${typeof body.error === "string" ? body.error : text.slice(0, 200)}`);
    }
    if (!sameModel(body.model, this.model)) {
      // llama.cpp's server answers with the model it has loaded, whatever was asked for.
      throw new Error(
        typeof body.model === "string"
          ? `the server answered as ${body.model}, not ${this.model}: a llama-server needs --alias ${this.model}`
          : `the response does not say which model answered, so it cannot be ${this.model}'s`,
      );
    }
    if (!body.answers || typeof body.answers !== "object") throw new Error(`${this.name}: no answers in the response`);
    return body.answers as Record<string, SystemOneAnswer | undefined>;
  }
}

/** `nimble` and `nimble:latest` are one model to Ollama. */
function sameModel(answered: unknown, asked: string): boolean {
  if (typeof answered !== "string") return false;
  const tagged = (m: string) => (m.includes(":") ? m : `${m}:latest`);
  return tagged(answered) === tagged(asked);
}
