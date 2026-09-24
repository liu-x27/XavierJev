import type { RetryJudge, RetryVerdict, ToolFailure } from "./decisions.js";
import { logger } from "./log.js";
import type { JudgeBackend, NoulQuestion } from "./types.js";

/**
 * The question, phrased so that "yes" is the claim that earns a retry.
 *
 * Measured on `eval/retry` with llama3.1:8b, four wordings: "Is this error
 * temporary, so that the exact same call could succeed if it were simply
 * tried again?" missed 11 of 17 transient errors — it called every socket
 * reset and timeout permanent — and wasted none; this one misses 1 and
 * wastes 6 of 19. That is the right way round for this decision: a wasted
 * retry costs one call that fails again, a missed one costs the turn the
 * judge was meant to save.
 */
export const RETRY_QUESTION: NoulQuestion = {
  id: "transient",
  ask: "Is this a temporary network, server or resource error, rather than a problem with the request itself?",
};

/**
 * What an error message says about itself, when it says it in a code.
 *
 * The default judge, because on `eval/retry` it beats the model: 36 of 36 to
 * the model's 29. That is no surprise once stated — ECONNRESET and 503 mean
 * the same thing in every message they appear in, so there is nothing for a
 * model to read that a pattern cannot — and it is written by the same hand,
 * in the same hour, as the cases it is scored on, so read 36/36 as an upper
 * bound. The model earns its keep on the risk gate's commands, where
 * `rmdir /s /q dist` is dangerous with no keyword saying so; an error code is
 * a keyword.
 */
export const TRANSIENT_ERROR_PATTERNS: readonly RegExp[] = [
  /\b(5\d\d|429)\b/,
  /\b(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|EBUSY|EMFILE|EAGAIN|UND_ERR_SOCKET)\b/,
  // \b so that "Unterminated group", in a regex error, does not count as a dropped connection
  /timeout|timed out|hang up|\bterminated\b|temporarily/i,
];

/** A retry judge with no model: `TRANSIENT_ERROR_PATTERNS`, and nothing else. */
export const patternRetryJudge: RetryJudge = async (failure) => {
  const hit = TRANSIENT_ERROR_PATTERNS.find((p) => p.test(failure.error));
  return hit
    ? { retry: true, probability: undefined, reason: `matches ${hit.source}`, latencyMs: 0 }
    : { retry: false, probability: undefined, reason: "no transient pattern matched", latencyMs: 0 };
};

export interface RetryJudgeOptions {
  backend: JudgeBackend;
  /**
   * Retry at or above this P(transient). Default 0.6 — above the 0.5 a
   * backend returns when it has no opinion, so an allow-list judge that does
   * not know the question never triggers a retry by abstaining.
   */
  retryAt?: number;
  /** Give up on the judge after this long, and do not retry. Default 2000 ms. */
  timeoutMs?: number;
  /** Error text beyond this is cut. Default 600 characters. */
  maxErrorChars?: number;
}

/**
 * Decide, with a model, whether a failed tool call is worth trying once
 * more before the model sees the error. Not what the server uses: on
 * `eval/retry` it loses to `patternRetryJudge`, 29 to 36 of 36.
 *
 * The third use of the decision layer, and the smallest. A timeout or a 503
 * on a read is usually gone a second later, and retrying it costs one call;
 * handing it to the model costs a turn, in which the model mostly decides to
 * retry. A missing file or a 404 is not going to change, and retrying it only
 * wastes the call. That is a judgement about an error message, which is the
 * shape this layer is for.
 *
 * Three limits, set by the agent rather than here:
 *
 * - **Only calls that change nothing.** A `dangerous` tool — Bash, Write,
 *   Edit — is never retried: whether running a command twice is safe is not
 *   something an error message can tell you.
 * - **Once.** A second failure goes to the model as it is.
 * - **Every failure of the judge means no retry.** The model then sees the
 *   error exactly as it would without a judge, so a broken judge costs the
 *   saving and nothing else — fail-closed, pointed at "change nothing".
 */
export function createRetryJudge(options: RetryJudgeOptions): RetryJudge {
  const { backend } = options;
  const retryAt = options.retryAt ?? 0.6;
  const timeoutMs = options.timeoutMs ?? 2000;
  const maxErrorChars = options.maxErrorChars ?? 600;

  return async (failure: ToolFailure): Promise<RetryVerdict> => {
    const started = Date.now();
    // The error alone: with the tool and the call beside it, the judge did
    // slightly worse (25/36 against 26/36 on the older wording).
    const state = { error: failure.error.slice(0, maxErrorChars) };
    let timer: NodeJS.Timeout | undefined;
    try {
      const answers = await Promise.race([
        backend.noul(state, [RETRY_QUESTION]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer in ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
      const p = answers.find((a) => a.id === RETRY_QUESTION.id)?.probability;
      const latencyMs = Date.now() - started;
      if (typeof p !== "number" || !(p >= 0 && p <= 1)) {
        return { retry: false, probability: undefined, reason: "the judge gave no probability", latencyMs };
      }
      return p >= retryAt
        ? { retry: true, probability: p, reason: `P(transient)=${p.toFixed(3)} ≥ ${retryAt}`, latencyMs }
        : { retry: false, probability: p, reason: `P(transient)=${p.toFixed(3)} < ${retryAt}`, latencyMs };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Retry judge ${backend.name} failed: ${message}`);
      return { retry: false, probability: undefined, reason: `judge failed: ${message}`, latencyMs: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  };
}
