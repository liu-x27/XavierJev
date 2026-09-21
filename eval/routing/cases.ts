/**
 * Labelled requests for evaluating the model router — the dev set.
 *
 * ## Why this is a weaker measurement than the gate's, and how
 *
 * The risk gate had a ground truth that does not depend on any model: a
 * criterion, applied to a command, yielding safe or unsafe. Routing has no
 * such thing. The real question is "would the cheap model have produced an
 * acceptable answer", and answering it properly means running both models and
 * comparing outputs — which needs a judge to score the comparison, and
 * scoring a judge with a judge measures nothing.
 *
 * So this set measures something narrower and says so: **agreement with my
 * own judgement about which tier a request needs.** That is a real signal —
 * it catches a router that downgrades a refactor or escalates a file listing
 * — and it is not the same as "the cheap model was good enough". A router
 * could match every label here and still route badly if my labels are wrong
 * about what a small model can do.
 *
 * ## The label criterion
 *
 * `strong` if answering the request well needs any of:
 *
 * a. reasoning across several steps or files before acting,
 * b. judgement about design, correctness, or trade-offs,
 * c. finding something subtly wrong rather than plainly absent, or
 * d. writing prose or code that someone will read carefully.
 *
 * `cheap` otherwise: lookups, listings, counts, format conversions,
 * mechanical single-step edits, and anything whose answer is checkable at a
 * glance.
 *
 * The boundary that took the most thought: **a request is `cheap` when it
 * names its own method.** "Run wc -l on src/agent.ts" is cheap — the thinking
 * has already been done by whoever wrote the prompt. "Which files are too
 * long?" is `strong`, because deciding what counts as too long is the task.
 * The same work, moved across the boundary by who does the deciding.
 *
 * ## The asymmetry that matters
 *
 * The gate's two numbers are not equally weighted: a false allow is a silent
 * unrecoverable failure and a missed save costs a keystroke. Here they are
 * much closer. A wrong downgrade produces a worse answer the user reads and
 * can retry; a wrong escalation just costs money. Neither is silent.
 *
 * That argued for a looser threshold than the gate's, and the default was set
 * to 0.5 on the strength of it. Running this set moved it back to 0.2: at 0.5
 * the router downgrades 6 of the 20 hard requests, because llama3.1:8b's
 * probabilities on this question sit low. The harm asymmetry is real and it
 * was answering a different question than the one that fixes the number —
 * which is recorded here rather than quietly overwritten, because the wrong
 * reasoning is the more useful half of the story.
 */

export type Tier = "cheap" | "strong";

export interface RoutingCase {
  prompt: string;
  label: Tier;
  note?: string;
}

export const ROUTING_CASES: RoutingCase[] = [
  // ── cheap: the answer is a lookup ──
  { prompt: "How many lines are in src/agent.ts?", label: "cheap" },
  { prompt: "List the files in the src directory.", label: "cheap" },
  { prompt: "What version of Node is installed?", label: "cheap" },
  { prompt: "Show me the first 20 lines of README.md.", label: "cheap" },
  { prompt: "What does the `dangerous` field on the Tool class do?", label: "cheap" },
  { prompt: "Which npm scripts does this project define?", label: "cheap" },
  { prompt: "Print the current git branch.", label: "cheap" },
  { prompt: "How many TypeScript files are under eval/?", label: "cheap" },
  { prompt: "What is the default value of maxTurns?", label: "cheap" },
  { prompt: "Show the last 5 commit messages.", label: "cheap" },
  {
    prompt: "Run wc -l on src/agent.ts and tell me the number.",
    label: "cheap",
    note: "names its own method, so the thinking is already done",
  },
  { prompt: "Convert this JSON snippet to YAML.", label: "cheap" },
  { prompt: "What's the TypeScript type of PermissionDecision?", label: "cheap" },
  { prompt: "Reformat eval/routing/cases.ts with prettier.", label: "cheap" },
  { prompt: "Rename the variable `foo` to `bar` in src/utils/logger.ts.", label: "cheap" },
  { prompt: "Add a trailing newline to .env.example.", label: "cheap" },
  { prompt: "Summarise what src/judge/types.ts declares.", label: "cheap" },
  { prompt: "Is there a test script in package.json?", label: "cheap" },
  { prompt: "Grep for TODO comments and list the files.", label: "cheap" },
  { prompt: "What port does the dev server run on?", label: "cheap" },

  // ── strong: the deciding is the task ──
  {
    prompt: "Which source files in this repo are too long, and what would you split out?",
    label: "strong",
    note: "deciding what counts as too long is the work",
  },
  { prompt: "Why is the risk gate clearing rm -rf node_modules?", label: "strong" },
  { prompt: "Refactor the permission system so rules can match on arguments.", label: "strong" },
  { prompt: "Is the fail-closed behaviour in createRiskGate actually airtight?", label: "strong" },
  {
    prompt: "The eval reports 0 false allows but I do not trust it. Find the flaw.",
    label: "strong",
  },
  {
    prompt: "Design a caching layer for the judge so repeated commands are free.",
    label: "strong",
  },
  { prompt: "Review my last commit for correctness problems.", label: "strong" },
  { prompt: "Why does the second test set score worse than the dev set?", label: "strong" },
  { prompt: "Write the README section explaining the threshold choice.", label: "strong" },
  { prompt: "Migrate this codebase from Express to Fastify.", label: "strong" },
  {
    prompt: "There is a race condition somewhere in the SSE approval flow. Find it.",
    label: "strong",
  },
  { prompt: "Should the gate be allowed to auto-deny? Argue both sides.", label: "strong" },
  { prompt: "Add per-turn model routing and explain the risks.", label: "strong" },
  { prompt: "The tests pass but the feature is broken in the browser. Debug it.", label: "strong" },
  {
    prompt: "Rewrite the exfiltrates question to lower its floor without losing teeth.",
    label: "strong",
  },
  {
    prompt: "Explain why in-distribution temperature scaling made calibration worse.",
    label: "strong",
  },
  {
    prompt: "Find every place this repo assumes a POSIX shell and list the consequences.",
    label: "strong",
  },
  { prompt: "Is the allow-list's inverted path check sound? Try to break it.", label: "strong" },
  {
    prompt: "Plan the work to support three model tiers instead of two.",
    label: "strong",
  },
  {
    prompt: "Something in the streaming path drops the last chunk. Track it down.",
    label: "strong",
  },
];
