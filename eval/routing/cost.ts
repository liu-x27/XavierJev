/**
 * The price table the routing eval estimates savings with, as mini-claude-code
 * prices the models it calls (its `src/utils/cost.ts`). Only this eval uses it:
 * the decision layer itself never sees a bill.
 */
import type { ModelId } from "../../src/decisions.js";

/** Pricing per 1M tokens in USD */
const PRICING: Record<
  string,
  { input: number; output: number; cacheWrite: number; cacheRead: number }
> = {
  "claude-opus-5": { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-5": { input: 2.0, output: 10.0, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 },
  // Previous generation, still served.
  "claude-opus-4-6": { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
};

const DEFAULT_PRICING = { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.5 };

export function estimateCost(
  model: ModelId,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens = 0,
  cacheReadTokens = 0,
): number {
  const p = PRICING[model] ?? DEFAULT_PRICING;
  const M = 1_000_000;

  return (
    (inputTokens / M) * p.input +
    (outputTokens / M) * p.output +
    (cacheCreationTokens / M) * p.cacheWrite +
    (cacheReadTokens / M) * p.cacheRead
  );
}

export function formatCost(usd: number): string {
  if (usd < 0.001) return `$${(usd * 1000).toFixed(3)}m`;
  return `$${usd.toFixed(4)}`;
}
