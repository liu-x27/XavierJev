/**
 * What a count out of n can claim about the rate behind it.
 *
 * "0/76 false allows" is a count, not a rate. The largest false-allow rate
 * that still leaves a real chance of seeing none in 76 tries is about 3.9%,
 * so that is what the count supports, at 95% confidence, and no less. These
 * are exact binomial bounds — one-sided Clopper–Pearson — with no normal
 * approximation, which would say nothing at all about a zero.
 *
 * They assume every case is an independent draw from the traffic the rate is
 * about. The held-out sets are not quite that: test 3's commands were
 * generated a dozen tasks at a time, and commands from one task resemble each
 * other, so the true uncertainty is somewhat wider than these numbers.
 */

/** P(X ≤ k) for X ~ Binomial(n, p), summed in log space so n in the hundreds stays exact. */
export function binomialCdf(k: number, n: number, p: number): number {
  if (k >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  let logTerm = n * Math.log1p(-p); // log P(X = 0)
  let total = Math.exp(logTerm);
  for (let i = 1; i <= k; i++) {
    logTerm += Math.log((n - i + 1) / i) + Math.log(p) - Math.log1p(-p);
    total += Math.exp(logTerm);
  }
  return Math.min(1, total);
}

/**
 * The highest rate still consistent with seeing `k` or fewer in `n`, at the
 * given confidence: the p at which P(X ≤ k) = 1 − confidence.
 */
export function upperBound(k: number, n: number, confidence = 0.95): number {
  if (n <= 0) return 1;
  if (k >= n) return 1;
  const alpha = 1 - confidence;
  if (k === 0) return 1 - alpha ** (1 / n);
  let lo = k / n;
  let hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (binomialCdf(k, n, mid) > alpha) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** How many cases it takes, with at most `k` of them failing, to bound the rate by `target`. */
export function casesNeeded(target: number, k = 0, confidence = 0.95): number {
  let n = k + 1;
  while (upperBound(k, n, confidence) > target) n++;
  return n;
}

/** "0/76 — the rate is below 3.9% (95%)", for eval output. */
export function describeBound(k: number, n: number, confidence = 0.95): string {
  if (n === 0) return `${k}/${n}`;
  const pct = (upperBound(k, n, confidence) * 100).toFixed(1);
  return `${k}/${n} — the rate is below ${pct}% (${Math.round(confidence * 100)}% confidence)`;
}
