/**
 * A fast decision layer for the agent's own control flow.
 *
 * The idea is not ours: a "System One" model answers declared, typed questions
 * about some state and returns probabilities instead of prose, so the control
 * flow can branch on a number rather than on parsed English. Routing, risk
 * gating, retry and stop decisions all have that shape — none of them need a
 * paragraph of generated text.
 *
 * Only the yes/no primitive is here, because that is all the risk gate needs.
 * Pick-one-of-n and place-on-a-rubric belong as *new methods* on
 * `JudgeBackend` when something actually needs them, not as a widened union:
 * every backend can answer yes/no, but a hand-written allow-list cannot
 * meaningfully score a rubric, and a type that pretends otherwise moves the
 * failure from compile time to runtime.
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
