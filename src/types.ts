/**
 * A fast decision layer for the agent's own control flow.
 *
 * The idea is not ours: a "System One" model answers declared, typed questions
 * about some state and returns probabilities instead of prose, so the control
 * flow can branch on a number rather than on parsed English. Routing, risk
 * gating, retry and stop decisions all have that shape — none of them need a
 * paragraph of generated text.
 *
 * Two primitives so far. Yes/no (`noul`) is what the risk gate and the router
 * need, and every backend can answer it. Pick-one-of-n (`choice`) arrived with
 * the first decision that had more than two outcomes — the snake arena's four
 * moves — and is a separate interface rather than a method on `JudgeBackend`:
 * a hand-written allow-list has no opinion on which way a snake should turn,
 * and a type that pretended otherwise would move that failure from compile
 * time to runtime. Place-on-a-rubric (`rubric`) followed the same way.
 */

/**
 * The facts a question is asked about.
 *
 * Deliberately a flat map of short strings rather than free text or the raw
 * tool input: a prompted backend renders it as `key: value` lines, and a
 * pattern backend reads the fields it understands. Neither has to parse the
 * other's format.
 *
 * Keep it tight. Decision models of this kind are documented to lose accuracy
 * when the state is padded with irrelevant context, so the caller's job is to
 * hand over the few fields the question is actually about.
 */
export type JudgeState = Record<string, string>;

/** A yes/no proposition to evaluate against some state. */
export interface NoulQuestion {
  /** Stable key, used to pair answers back to questions. */
  id: string;
  /** The proposition, phrased so that "yes" is the thing being measured. */
  ask: string;
}

export interface NoulAnswer {
  id: string;
  /** P(yes), in [0, 1]. */
  probability: number;
  /**
   * How much of the first token's probability landed on a yes or a no at all,
   * before renormalising over the two — what `choice()` and `rubric()` call
   * coverage. Set by backends that read probabilities; absent otherwise.
   */
  coverage?: number;
}

/**
 * Below this coverage an answer is not an answer.
 *
 * A model that put most of its first token on "The" or "Since" meant to write
 * a sentence, and renormalising what little it left on Y and N turns that
 * into a confident-looking number. So the four decisions treat such an answer
 * as a judge failure and fall back the way each one fails. llama3.1:8b puts
 * all of it on Y or N (1.000 on every call measured); the limit is for a
 * model that does not.
 *
 * It was a half until 0.2.0, which let through an answer that was mostly
 * something else. The usual advice for reading a decision off a label's
 * logprob is that the labels should hold 95–99% of the token; the judge
 * clears that with room to spare, so the stricter line costs it nothing.
 */
export const MIN_COVERAGE = 0.95;

/** A usable P(yes) from an answer: a probability in [0, 1] with enough of the token behind it. */
export function usableProbability(answer: NoulAnswer | undefined): number | undefined {
  const p = answer?.probability;
  if (typeof p !== "number" || !(p >= 0 && p <= 1)) return undefined;
  if (answer?.coverage !== undefined && !(answer.coverage >= MIN_COVERAGE)) return undefined;
  return p;
}

export interface JudgeBackend {
  /** Short identifier, used in logs and eval output. */
  readonly name: string;

  /**
   * Answer each proposition against `state`.
   *
   * Must return one answer per question. Callers pair by `id` and treat a
   * missing or out-of-range answer as a backend failure rather than as a
   * "no" — see `createRiskGate`, which fails closed.
   */
  noul(state: JudgeState, questions: NoulQuestion[]): Promise<NoulAnswer[]>;

  /**
   * Which model is answering, as exactly as the endpoint can say. Optional:
   * `checkGate` compares the digest with the one its canaries were recorded
   * on, when there is one to compare.
   */
  identify?(): Promise<JudgeIdentity>;
}

/** What a backend can say about exactly which model answers its questions. */
export interface JudgeIdentity {
  /** The model name the backend asks for. */
  model: string;
  /**
   * A digest of what serves that name, when the endpoint reports one. For
   * Ollama this is the manifest digest, which covers the weights, the chat
   * template and the parameters together, so a new template under the same
   * name changes it.
   */
  digest?: string;
  /** Where the digest came from, or why there is none. */
  detail: string;
}

/**
 * The answer to give when a backend has no opinion — not "no".
 *
 * A backend that cannot judge something must say so with a probability the
 * gate will not auto-allow, rather than returning 0 and passing an unknown
 * command through as safe.
 */
export const UNKNOWN_PROBABILITY = 0.5;

/** One of the outcomes a choice question offers. */
export interface ChoiceOption {
  /** Stable key, used to pair answers back to options. */
  id: string;
  /** What the option is, as the model reads it. */
  text: string;
}

export interface ChoiceResult {
  /** P(option), one per option in the order given, summing to 1. */
  answers: NoulAnswer[];
  /**
   * How much of the model's first-token probability landed on the option
   * labels at all, before renormalising over them. Near 1 means the model
   * answered the question it was asked; low means it wanted to say something
   * else, and the renormalised answers are a guess about a guess.
   */
  coverage: number;
}

export interface ChoiceBackend {
  readonly name: string;

  /**
   * Pick one of `options` for `ask` against `state`.
   *
   * Offer only the options that are allowed. A rule that can rule a move out
   * should do so before the question is asked, the way the gate's static deny
   * list runs before the judge: the model's job is to choose among legal
   * options, not to rediscover which ones are legal.
   */
  choice(state: JudgeState, ask: string, options: ChoiceOption[]): Promise<ChoiceResult>;
}

/** One point on a rubric: a score and what it means. */
export interface RubricLevel {
  score: number;
  text: string;
}

export interface RubricResult {
  /** P(each level), in the order given, summing to 1. */
  distribution: Array<{ score: number; probability: number }>;
  /** The mean score under that distribution. */
  expected: number;
  /** Its standard deviation: how sure the judge is of the score, in score units. */
  spread: number;
  /** How much of the first token's probability landed on a level at all. */
  coverage: number;
}

export interface RubricBackend {
  readonly name: string;

  /**
   * Place `state` on a rubric of up to nine levels, scored 1 to n.
   *
   * The third primitive, for a question whose answer is a degree rather than
   * a yes or a choice. A whole distribution comes back, not one score, so a
   * caller can tell "a confident 3" from "a 1 or a 5, and the model cannot
   * decide" — the same mean, and not the same answer.
   */
  rubric(state: JudgeState, ask: string, levels: RubricLevel[]): Promise<RubricResult>;
}
