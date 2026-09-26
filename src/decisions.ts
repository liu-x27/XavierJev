/**
 * The four decisions an agent loop hands to the judge, as the loop sees them.
 *
 * `types.ts` is what the judge answers: typed questions about a flat state.
 * This file is what an agent asks: may this tool call run without a prompt,
 * which model should take this request, is this failure worth one more try,
 * is this run getting anywhere. `gate.ts`, `router.ts`, `retry.ts` and
 * `stop.ts` turn each of these into questions and back.
 *
 * They were written for, and are still used by, the agent loop in
 * mini-claude-code, where they sat in its `src/types.ts`. Two things changed
 * in the move: `ModelId`, a union of that framework's model names, is any
 * string here, and the gate's answers carry their coverage.
 */

/** A model identifier, in whatever form the caller's client takes. */
export type ModelId = string;

export type PermissionMode = "allow" | "ask" | "deny";

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  description: string;
  /**
   * The tool call being asked about, when there is one. The agent runs a
   * batch of calls concurrently, so a host that reports verdicts or shows
   * approval cards needs this to tell them apart.
   */
  toolUseId?: string | undefined;
  /**
   * The working directory the call would run in, when the host knows it. Used only to find the
   * scripts a command runs (`RiskGateOptions.readScripts`); the judge is not shown it.
   */
  cwd?: string | undefined;
}

/**
 * Decides a call that already resolved to "ask", so that the user only sees
 * the ones worth seeing.
 *
 * A gate is consulted *after* the static rules, never instead of them, and it
 * is never asked about a call the rules already settled — so it cannot widen
 * what runs, only narrow what gets asked about. Anything it is unsure of, and
 * every way it can fail, comes back as "ask".
 */
export type RiskGate = (request: PermissionRequest) => Promise<GateVerdict>;

export interface GateVerdict {
  action: PermissionMode;
  /**
   * The probability the decision was made on, or undefined when the gate
   * never got a usable answer out of its backend.
   */
  probability: number | undefined;
  /** Short explanation, for logs and eval output. */
  reason: string;
  /**
   * Every question's answer, in the order they were asked, when the backend
   * gave a complete and valid set. The decision is made on the worst of
   * them; the rest are there so a UI can show which harm held a call and
   * which ones were never in doubt.
   */
  answers?: Array<{ id: string; probability: number; coverage?: number }> | undefined;
  /** How long the backend took to answer, in milliseconds. */
  latencyMs?: number | undefined;
  /** The auto-allow threshold the verdict was made against. */
  threshold?: number | undefined;
}

/**
 * Picks the model for a run, once, from the user's prompt.
 *
 * The gate's sibling: same backend, same fail-closed rule, pointed at cost
 * instead of at safety. Every way it can fail resolves to the expensive
 * model — see `createModelRouter`.
 */
export type ModelRouter = (prompt: string) => Promise<RouteVerdict>;

export interface RouteVerdict {
  model: ModelId;
  /** True when the router picked the cheaper model. */
  downgraded: boolean;
  /** P(needs the strong model), or undefined when the judge gave no answer. */
  probability: number | undefined;
  reason: string;
}

/** A tool call that failed, as the retry judge is shown it. */
export interface ToolFailure {
  toolName: string;
  /** The call as a person would name it — the tool's own summary of its input. */
  summary: string;
  error: string;
}

export interface RetryVerdict {
  retry: boolean;
  /** P(the error is transient), or undefined when the judge gave no answer. */
  probability: number | undefined;
  reason: string;
  latencyMs?: number;
}

/**
 * Decides whether a failed call that changes nothing gets one more try
 * before the model sees the error — see `createRetryJudge`.
 */
export type RetryJudge = (failure: ToolFailure) => Promise<RetryVerdict>;

/** One recent call as the stop judge sees it. */
export interface TracedCall {
  tool: string;
  input: Record<string, unknown>;
  /** The call as a person would name it. */
  summary: string;
  ok: boolean;
  /** The start of its output or error. */
  outcome: string;
}

export interface RunTrace {
  prompt: string;
  turn: number;
  /** The most recent calls, oldest first. */
  recent: TracedCall[];
}

export interface StopVerdict {
  stop: boolean;
  /** P(stuck), or undefined when no model was asked. */
  probability: number | undefined;
  reason: string;
  latencyMs?: number;
}

/**
 * Decides, after each turn's tool calls, whether the run should end before
 * the model says it is done — see `createRepeatStopJudge`.
 */
export type StopJudge = (trace: RunTrace) => Promise<StopVerdict>;
