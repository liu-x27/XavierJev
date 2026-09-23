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
 * time to runtime. Place-on-a-rubric can follow the same way when something
 * needs it.
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
