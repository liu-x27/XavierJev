import type { ModelId, ModelRouter, RouteVerdict } from "../types.js";
import { logger } from "../utils/logger.js";
import type { JudgeBackend, NoulQuestion } from "./types.js";

/**
 * The question the router asks about a request.
 *
 * Phrased so that "yes" is the expensive answer, matching the gate's
 * convention that yes is the costly direction — it keeps one threshold rule
 * in the head instead of two.
 */
export const ROUTING_QUESTION: NoulQuestion = {
  id: "needs-strong-model",
  ask:
    "Does answering this request need the strongest available model, rather than " +
    "a smaller and faster one? Answer yes for multi-step reasoning, subtle " +
    "debugging, architectural judgement, or careful writing; no for lookups, " +
    "summaries, file listings, mechanical edits, and single-command questions.",
};

export interface ModelRouterOptions {
  backend: JudgeBackend;
  /** The model to use when the request looks like it needs one. */
  strong: ModelId;
  /** The model to use when it does not. */
  cheap: ModelId;
  /**
   * Use `cheap` when P(needs-strong) is below this. Default 0.2.
   *
   * This started at 0.5, reasoned from the harm asymmetry: the gate's failure
   * mode is a destructive command nobody saw, while this one's is a worse
   * answer the user reads and can retry, so it looked like it could afford a
   * looser threshold. `eval/routing` disagreed. At 0.5 the router downgrades
   * 26 of 40 requests and sends **6 of the 20 hard ones** to the cheap model
   * — "migrate this codebase from Express to Fastify" scored 0.286, "design a
   * caching layer" 0.075. llama3.1:8b's probabilities on this question simply
   * sit low, and no amount of reasoning about harm fixes a miscalibrated
   * input.
   *
   * At 0.2 it downgrades 15 of 40 with one wrong downgrade: 30% off the bill
   * instead of 52%, for a sixth of the errors. The argument from harm was not
   * wrong, it was answering a different question than the one that decides
   * the number.
   *
   * Worth noting that the gate's threshold went the same way — reasoned at
   * 0.05, measured to 0.20. Both times the reasoning picked the wrong value
   * and the labelled set picked the right one.
   */
  preferCheapBelow?: number;
  /** Fall back to `strong` if the judge takes longer than this. Default 2000ms. */
  timeoutMs?: number;
  /** Cap on how much of the prompt is handed to the judge. Default 2000 chars. */
  maxPromptChars?: number;
}

/**
 * Route a request to a cheap or a strong model before the loop starts.
 *
 * The second thing a decision layer is for, after the risk gate: ask a
 * question, get a probability, branch on it, and never pay a frontier model
 * to decide something a threshold can decide. Same backend interface, same
 * failure discipline.
 *
 * Three deliberate limits:
 *
 * **It decides once, on the user's prompt, before turn one.** Routing every
 * turn would save more — most turns are "read this tool output and continue" —
 * but it would also hand one model's half-finished reasoning to another
 * mid-conversation. That is a real behavioural risk and this version does not
 * take it; per-turn routing is the next step, and it wants measuring before
 * it ships.
 *
 * **Two tiers, so the question is a yes/no.** A pick-one-of-n primitive is
 * the right shape for three or more, and exists now as `ChoiceBackend` — the
 * snake arena needed four outcomes. Two tiers need only one question; a third
 * is what would move the router onto it.
 *
 * **Every failure lands on the strong model.** A judge that throws, times
 * out, or returns something that is not a probability gets the expensive
 * model, not the cheap one — the same fail-closed rule as the gate, pointed
 * at cost instead of at safety.
 */
export function createModelRouter(options: ModelRouterOptions): ModelRouter {
  const { backend, strong, cheap } = options;
  const preferCheapBelow = options.preferCheapBelow ?? 0.2;
  const timeoutMs = options.timeoutMs ?? 2000;
  const maxPromptChars = options.maxPromptChars ?? 2000;

  return async (prompt: string): Promise<RouteVerdict> => {
    const state = {
      request:
        prompt.length > maxPromptChars
          ? `${prompt.slice(0, maxPromptChars)}… (${prompt.length} chars total)`
          : prompt,
    };

    let probability: number;
    try {
      probability = await withTimeout(
        backend.noul(state, [ROUTING_QUESTION]).then(readRoutingProbability),
        timeoutMs,
      );
    } catch (err) {
      const reason = `${backend.name} router unavailable: ${err instanceof Error ? err.message : String(err)}`;
      logger.warn(`Model router falling back to ${strong} — ${reason}`);
      return { model: strong, downgraded: false, probability: undefined, reason };
    }

    if (probability < preferCheapBelow) {
      return {
        model: cheap,
        downgraded: true,
        probability,
        reason: `P(needs-strong)=${probability.toFixed(3)} < ${preferCheapBelow}`,
      };
    }

    return {
      model: strong,
      downgraded: false,
      probability,
      reason: `P(needs-strong)=${probability.toFixed(3)} is not below ${preferCheapBelow}`,
    };
  };
}

function readRoutingProbability(answers: readonly { id: string; probability: number }[]): number {
  const answer = answers.find((a) => a.id === ROUTING_QUESTION.id);
  if (!answer) {
    throw new Error(`no answer for "${ROUTING_QUESTION.id}"`);
  }
  const { probability } = answer;
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error(`probability out of range: ${probability}`);
  }
  return probability;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
