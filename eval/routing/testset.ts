/**
 * Held-out requests for the model router — generated, then labelled by hand.
 *
 * ## Why
 *
 * `cases.ts` chose the router's threshold, so it is a dev set and its 30%
 * saving is a number about a decision already made. This set was written
 * after that decision, from a generator that was never told what it was being
 * sampled for.
 *
 * `glm4:9b` was asked what a developer might ask a coding assistant across
 * ten *situations* rather than ten difficulty levels — your first hour in an
 * unfamiliar codebase, a test that fails only on CI, a 3am alert, a
 * dependency that shipped a breaking major. Framing by situation matters:
 * asking for "hard requests" and "easy requests" would have leaked the label
 * straight into the sample. It is not the judge's model, for the same reason
 * as the risk-gate sets.
 *
 * 120 candidates came back, none overlapping `cases.ts`. The 65 below are the
 * ones I could label without hedging; the rest were dropped, along with one
 * that arrived with mojibake in it. Real requests skew heavily toward
 * substantial work, which is why this set does not sit at 50/50 and should
 * not be made to.
 *
 * ## Rules
 *
 * 1. **Do not tune on these numbers.** Fix against `cases.ts`.
 * 2. **Log every evaluation below.**
 * 3. Labels change only by argument from the criterion.
 *
 * ### Evaluation log
 *
 * - **2026-09-21, run 1.** Shipped default: llama3.1:8b at 0.20,
 *   claude-haiku-4-5 against claude-opus-5.
 *
 *   |  | dev (40) | here (65) |
 *   |---|---|---|
 *   | downgraded | 15/40 (38%) | 22/65 (34%) |
 *   | wrong downgrades | 1/20 (5%) | **7/37 (19%)** |
 *   | wrong escalations | 6/20 | 13/28 |
 *   | cost saved | 30% | 27% |
 *
 *   **Nearly four times the wrong-downgrade rate out of sample.** One hard
 *   request in five gets the small model, including "can you refactor this
 *   code to improve performance and maintainability?" at 0.047 and "how can
 *   we implement caching to improve performance?" at 0.075. The dev set said
 *   5% and it was wrong by a factor of four, the same direction the risk
 *   gate's dev numbers were wrong in.
 *
 *   Measured across all 105 labelled requests, the router's answers correlate
 *   with my labels at r = 0.555, with raw prompt length at 0.372; length
 *   itself predicts my labels at 0.332, so controlling for the label leaves
 *   roughly 0.24 of residual length sensitivity. There is some — shorter
 *   requests do score lower than their difficulty warrants — but it is not
 *   the main problem. The main problem is that 0.555 is simply weak
 *   agreement, and 19% follows from it directly.
 *
 *   Why weaker than the gate, which reaches zero false allows on held-out
 *   commands: a shell command carries its own hazard on its face, and
 *   `rm -rf /` means the same thing in every repository. The difficulty of
 *   "optimize the database query performance" depends entirely on a codebase
 *   the judge is never shown. Same interface, same threshold discipline,
 *   and a question that a one-line state cannot answer.
 *
 * ## The label criterion
 *
 * Unchanged from `cases.ts`. `strong` if answering well needs reasoning
 * across several steps or files, judgement about design or trade-offs,
 * finding something subtly wrong rather than plainly absent, or writing that
 * someone will read carefully. `cheap` otherwise.
 *
 * Carried over: **a request is `cheap` when it names its own method**, because
 * the deciding has already been done by whoever typed it.
 *
 * One boundary this set added: **"check X" is cheap, "review X" is strong.**
 * Checking whether the test data changed is a `git diff`; reviewing the
 * database configuration is an opinion. The generator produced both phrasings
 * for what could be the same underlying work, and the verb is the only thing
 * separating them — which is a fair reflection of how much routing depends on
 * how a request happens to be worded.
 */

import type { RoutingCase } from "./cases.js";

export const ROUTING_TEST_CASES: RoutingCase[] = [
  // ── cheap ──
  { prompt: "Is there a testing suite already set up?", label: "cheap" },
  { prompt: "What version of the package is used in CI versus locally?", label: "cheap" },
  {
    prompt: "Do we have access to logs and error reports from the CI environment?",
    label: "cheap",
  },
  { prompt: "Can you run the failed test on your end?", label: "cheap" },
  { prompt: "Can you check if the test data has been modified?", label: "cheap" },
  { prompt: "Can you find an example of object creation for the main model?", label: "cheap" },
  { prompt: "Please check the latest changes on the feature branch.", label: "cheap" },
  {
    prompt: "Can you list all the files modified in the feature branch since the last commit?",
    label: "cheap",
  },
  { prompt: "List the functions added/removed in the feature branch.", label: "cheap" },
  {
    prompt:
      'Can you check the spelling in the sentence "feature x has become a vital part of the application"?',
    label: "cheap",
  },
  {
    prompt: 'Can you replace "useless" with "non-essential" in the description of the new feature?',
    label: "cheap",
  },
  {
    prompt: 'Could you provide an example of how to import module "json" correctly?',
    label: "cheap",
  },
  {
    prompt: 'Can you help me come up with a more concise name for the variable "current_month"?',
    label: "cheap",
  },
  { prompt: "Update the version of the UI library used in the new feature", label: "cheap" },
  { prompt: "Can you apply code formatting for consistency throughout the PR?", label: "cheap" },
  { prompt: "check latest crash reports", label: "cheap" },
  {
    prompt: "review commit history of recent deploy",
    label: "cheap",
    note: "a log, despite the verb",
  },
  { prompt: "find documentation on handling critical errors", label: "cheap" },
  { prompt: "List all the external services integrated", label: "cheap" },
  { prompt: "Find any open-source code dependencies", label: "cheap" },
  { prompt: "Identify existing code that uses the deprecated function", label: "cheap" },
  { prompt: "Search for the latest stable version of the library", label: "cheap" },
  { prompt: "What changes were made to the payment gateway API?", label: "cheap" },
  {
    prompt: "Search through code for any leftover references to deprecated libraries",
    label: "cheap",
  },
  {
    prompt: "Check the application's adherence to the coding standards",
    label: "cheap",
    note: "run the linter",
  },
  { prompt: "Can you check the memory usage during the slowdown?", label: "cheap" },
  { prompt: "Document the database schema", label: "cheap", note: "read it out, not design it" },
  {
    prompt: 'Can you create a unittest for the new "validate_email_address" method?',
    label: "cheap",
  },

  // ── strong ──
  { prompt: "Can you explain the flow of the user authentication process?", label: "strong" },
  { prompt: "Walk me through the code paths for handling payment transactions.", label: "strong" },
  {
    prompt: "Is there any setting that could cause the CI environment to behave differently?",
    label: "strong",
  },
  { prompt: "Can you trace the code execution flow around the point of failure?", label: "strong" },
  {
    prompt: "Can you analyze the differences in system configurations between CI and local env?",
    label: "strong",
  },
  { prompt: "Can you set up a local environment that mirrors the CI setup?", label: "strong" },
  {
    prompt: "Let's review the database configurations and query optimizations.",
    label: "strong",
    note: "review, not check",
  },
  { prompt: "Merge Conflicts detected - can you assist with resolving them?", label: "strong" },
  {
    prompt: "Can you rebase the feature branch to incorporate the latest main branch changes?",
    label: "strong",
  },
  {
    prompt: "Can you refactor this code to improve performance and maintainability?",
    label: "strong",
  },
  {
    prompt: 'Can you suggest a better approach to handle errors in the "upload_image" function?',
    label: "strong",
  },
  {
    prompt: 'Can you extract the method "calculate_shipping_cost" from the "send_order" class?',
    label: "strong",
  },
  {
    prompt:
      'Can you integrate the "generate_report" functionality into the "generate_summary" method?',
    label: "strong",
  },
  { prompt: "Can you refactor this function to use higher-order components?", label: "strong" },
  {
    prompt: "Look for possible improvements in the error handling across the codebase",
    label: "strong",
  },
  {
    prompt: "What is the performance impact of this new algorithm implementation?",
    label: "strong",
  },
  { prompt: "Suggest optimizations for database queries in the user profile API", label: "strong" },
  { prompt: "Integrate the latest security patches into our dependencies", label: "strong" },
  { prompt: "Provide a step-by-step guide for deploying this feature in staging", label: "strong" },
  { prompt: "implement a fallback feature for alert system", label: "strong" },
  { prompt: "review the algorithm used in time-series forecasting", label: "strong" },
  { prompt: "analyze the impact of recent API changes on performance", label: "strong" },
  { prompt: "provide guidance on upgrading database schema", label: "strong" },
  { prompt: "Create a diagram of the service's architecture", label: "strong" },
  { prompt: "Analyze the possible causes for recent crashes", label: "strong" },
  { prompt: "Identify the key algorithms used", label: "strong" },
  { prompt: "Create snippets to debug the authentication system", label: "strong" },
  { prompt: "Summarize the security measures implemented", label: "strong" },
  { prompt: "Develop a test plan for the API endpoints", label: "strong" },
  { prompt: "Propose a strategy to migrate to the new version", label: "strong" },
  { prompt: "Outline a rollback plan in case of issues", label: "strong" },
  { prompt: "Conduct a code review of the migration process", label: "strong" },
  { prompt: "Refactor the login process to improve security", label: "strong" },
  { prompt: "Update documentation to reflect the latest features", label: "strong" },
  { prompt: "Optimize the database query performance", label: "strong" },
  { prompt: "Can you help identify potential bottlenecks in our AI algorithms?", label: "strong" },
  { prompt: "How can we implement caching to improve performance?", label: "strong" },
];
