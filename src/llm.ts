import OpenAI from "openai";
import { logger } from "./log.js";
import type {
  ChoiceBackend,
  ChoiceOption,
  ChoiceResult,
  JudgeBackend,
  JudgeState,
  NoulAnswer,
  NoulQuestion,
  RubricBackend,
  RubricLevel,
  RubricResult,
} from "./types.js";

/**
 * Judge by asking a small model for one token and reading the logprobs.
 *
 * The point of the single token is that the number comes from the model's own
 * distribution rather than from the model's opinion about its own confidence.
 * Asked to emit JSON like `{"confident": 0.9}`, a model writes whichever
 * number reads well; asked for one token, the ratio between P("Y") and P("N")
 * is a quantity it did not choose.
 *
 * This is the OpenAI-compatible Chat Completions path rather than the
 * Anthropic path, for one reason: the Anthropic Messages API does not return
 * logprobs. The rest of the framework talks to Anthropic and any
 * Anthropic-compatible endpoint; this one file needs a provider that exposes
 * token probabilities, and so takes its own base URL and key.
 */
export interface LlmJudgeOptions {
  /** Defaults to `AGENT_JUDGE_API_KEY`, then `OPENAI_API_KEY`. */
  apiKey?: string;
  /** OpenAI-compatible base URL. Defaults to `AGENT_JUDGE_BASE_URL`. */
  baseURL?: string;
  /** Defaults to `AGENT_JUDGE_MODEL`, then "gpt-4o-mini". */
  model?: string;
  /** How many top tokens to ask for. Default 5. */
  topLogprobs?: number;
  /**
   * Accept a bare yes/no when the endpoint returns no logprobs. Default false.
   *
   * Off by default because a hard label is not a probability and the gate
   * cannot tell the difference. This used to be handled by mapping "no" to
   * 0.15 — below the old default threshold of 0.05, so a degraded judge
   * auto-allowed nothing. The default threshold is now 0.2, which that number
   * clears, so the same fallback would have started waving commands through on
   * the strength of one token sampled at temperature 0. Throwing instead makes
   * the gate fail closed and say why.
   *
   * Turn it on to *measure* a hard-label judge, which is what
   * `eval/risk-gate` does. Do not turn it on to run one.
   */
  allowHardLabels?: boolean;
}

/**
 * What a yes/no maps to when `allowHardLabels` is on and the endpoint will
 * not return logprobs.
 *
 * These are not calibrated and are not claimed to be: they exist so that a
 * hard-label judge can be *measured* against a threshold, which is what
 * `eval/risk-gate --threshold 0.5` does. They are reachable only behind an
 * explicit opt-in, because "one token of output, from one sample, at
 * temperature 0" is not evidence enough to run something without asking.
 */
const DEGRADED_NO = 0.15;
const DEGRADED_YES = 0.85;

const YES_TOKENS = new Set(["y", "yes", "true", "1"]);
const NO_TOKENS = new Set(["n", "no", "false", "0"]);

/** What `LlmJudge.probe()` found out about the configured endpoint. */
export interface JudgeCapability {
  /** Whether the endpoint returned token probabilities when asked for them. */
  logprobs: boolean;
  /** Whether the model's first token was a usable yes/no. */
  firstTokenUsable: boolean;
  detail: string;
}

const SYSTEM_PROMPT =
  "You answer a single yes/no question about a tool call. " +
  "Reply with exactly one character: Y for yes, N for no. " +
  "No punctuation, no explanation, no other text.";

/** Option labels for `choice()`: single letters, one token in every tokenizer. */
const CHOICE_LABELS = "ABCDEFGH";

/** "A, B or C" */
function listLabels(labels: string[]): string {
  return labels.length <= 2 ? labels.join(" or ") : `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}`;
}

export class LlmJudge implements JudgeBackend, ChoiceBackend, RubricBackend {
  readonly name: string;

  private readonly client: OpenAI;
  private readonly model: string;
  private readonly topLogprobs: number;
  private readonly allowHardLabels: boolean;
  /** Set once the endpoint has proven it will not return logprobs. */
  private logprobsUnsupported = false;

  constructor(options: LlmJudgeOptions = {}) {
    const apiKey = options.apiKey ?? process.env.AGENT_JUDGE_API_KEY ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "LlmJudge needs an API key: pass `apiKey`, or set AGENT_JUDGE_API_KEY / OPENAI_API_KEY.",
      );
    }

    const baseURL = options.baseURL ?? process.env.AGENT_JUDGE_BASE_URL;
    this.model = options.model ?? process.env.AGENT_JUDGE_MODEL ?? "gpt-4o-mini";
    this.topLogprobs = options.topLogprobs ?? 5;
    this.allowHardLabels = options.allowHardLabels ?? false;
    this.name = `llm:${this.model}`;
    this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  }

  async noul(state: JudgeState, questions: NoulQuestion[]): Promise<NoulAnswer[]> {
    const rendered = renderState(state);
    // One call per question: each answer is a single token, so they cannot
    // share a completion, and they have no reason to wait for each other.
    return Promise.all(
      questions.map(async (question) => ({ id: question.id, ...(await this.askOne(rendered, question.ask)) })),
    );
  }

  /**
   * Pick one of up to eight options, from one token.
   *
   * The options are labelled A, B, C… and the model answers with a label, so
   * the whole distribution over the options comes out of a single forward
   * pass: P(A), P(B), P(C) are read off the same top logprobs, and no option
   * waits for another the way separate yes/no questions would.
   *
   * Renormalised over the labels, like the yes/no path, and for the same
   * reason — but unlike yes/no, how much mass the labels had is returned as
   * `coverage` rather than thrown away. With four options there is room for
   * a model to put most of its mass on "To" or "Since", the start of a
   * sentence it wanted to write, and a caller should be able to see that.
   *
   * No hard-label fallback: a single letter with no probability behind it is
   * not a distribution, so an endpoint without logprobs throws here even when
   * `allowHardLabels` is on.
   */
  async choice(state: JudgeState, ask: string, options: ChoiceOption[]): Promise<ChoiceResult> {
    if (options.length < 2 || options.length > CHOICE_LABELS.length) {
      throw new Error(`choice() takes 2 to ${CHOICE_LABELS.length} options, got ${options.length}`);
    }
    const labels = [...CHOICE_LABELS.slice(0, options.length)];
    const said = listLabels(labels);
    const listed = options.map((o, i) => `${labels[i]}. ${o.text}`).join("\n");

    const completion = await this.complete(
      [
        {
          role: "system",
          content: `You choose one option. Reply with exactly one letter: ${said}. No punctuation, no explanation, no other text.`,
        },
        { role: "user", content: `${renderState(state)}\n\nQuestion: ${ask}\n${listed}\nAnswer (${said}):` },
      ],
      // Room for every label plus the tokens a model reaches for instead.
      Math.min(20, Math.max(this.topLogprobs, options.length + 4)),
    );

    const top = completion.choices[0]?.logprobs?.content?.[0]?.top_logprobs;
    if (!top || top.length === 0) {
      this.noteDegraded();
      throw new Error(`${this.model} returned no logprobs, so there is no distribution over the options`);
    }

    const mass = labels.map(() => 0);
    for (const entry of top) {
      const i = labels.indexOf(entry.token.trim().toUpperCase());
      if (i >= 0) mass[i]! += Math.exp(entry.logprob);
    }
    const coverage = mass.reduce((a, b) => a + b, 0);
    if (coverage <= 0) {
      throw new Error(`no option label in the top logprobs (first token ${JSON.stringify(top[0]?.token)})`);
    }
    return {
      answers: options.map((o, i) => ({ id: o.id, probability: mass[i]! / coverage })),
      coverage: Math.min(1, coverage),
    };
  }

  /**
   * Place a state on a rubric of up to nine levels, from one token.
   *
   * The levels are numbered 1 to n and the model answers with a digit, so the
   * whole distribution over the rubric is read off one forward pass, the way
   * `choice()` reads its options. What comes back is the distribution, its
   * mean and its spread — a model torn between 1 and 5 has a mean of 3 and a
   * spread that says not to believe it.
   */
  async rubric(state: JudgeState, ask: string, levels: RubricLevel[]): Promise<RubricResult> {
    if (levels.length < 2 || levels.length > 9) {
      throw new Error(`rubric() takes 2 to 9 levels, got ${levels.length}`);
    }
    const digits = levels.map((_, i) => String(i + 1));
    const said = `${digits[0]} to ${digits.at(-1)}`;
    const listed = levels.map((l, i) => `${digits[i]} = ${l.text}`).join("\n");

    const completion = await this.complete(
      [
        {
          role: "system",
          content: `You rate on a scale. Reply with exactly one digit from ${said}. No punctuation, no explanation, no other text.`,
        },
        { role: "user", content: `${renderState(state)}\n\nQuestion: ${ask}\n${listed}\nAnswer (${said}):` },
      ],
      Math.min(20, Math.max(this.topLogprobs, levels.length + 4)),
    );

    const top = completion.choices[0]?.logprobs?.content?.[0]?.top_logprobs;
    if (!top || top.length === 0) {
      this.noteDegraded();
      throw new Error(`${this.model} returned no logprobs, so there is no distribution over the rubric`);
    }
    const mass = levels.map(() => 0);
    for (const entry of top) {
      const i = digits.indexOf(entry.token.trim());
      if (i >= 0) mass[i]! += Math.exp(entry.logprob);
    }
    const coverage = mass.reduce((a, b) => a + b, 0);
    if (coverage <= 0) {
      throw new Error(`no rubric level in the top logprobs (first token ${JSON.stringify(top[0]?.token)})`);
    }
    const distribution = levels.map((l, i) => ({ score: l.score, probability: mass[i]! / coverage }));
    const expected = distribution.reduce((a, d) => a + d.score * d.probability, 0);
    const spread = Math.sqrt(distribution.reduce((a, d) => a + d.probability * (d.score - expected) ** 2, 0));
    return { distribution, expected, spread, coverage: Math.min(1, coverage) };
  }

  private async askOne(state: string, ask: string): Promise<{ probability: number; coverage?: number }> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `${state}\n\nQuestion: ${ask}\nAnswer (Y or N):` },
    ];

    const completion = await this.complete(messages);
    const choice = completion.choices[0];
    if (!choice) {
      throw new Error("judge returned no choices");
    }

    const top = choice.logprobs?.content?.[0]?.top_logprobs;
    if (top && top.length > 0) {
      return probabilityFromLogprobs(top);
    }

    // No logprobs came back even though we asked. Fall back to the token
    // itself, at a confidence that will not clear the gate's threshold.
    this.noteDegraded();
    const text = choice.message.content?.trim().toLowerCase() ?? "";

    // A reasoning model spends its first tokens thinking, so with
    // `max_tokens: 1` the answer is never in the response at all. Worth its
    // own error: "expected Y or N" sends you looking at the prompt, when the
    // thing to change is the model.
    if (text.startsWith("<think")) {
      throw new Error(
        `${this.model} emits reasoning tokens first, so the answer is never the first token — the judge needs a non-reasoning model`,
      );
    }

    const first = text.slice(0, 1);
    const isYes = YES_TOKENS.has(first);
    const isNo = NO_TOKENS.has(first);
    if (!isYes && !isNo) {
      throw new Error(`judge answered ${JSON.stringify(text.slice(0, 20))}, expected Y or N`);
    }
    if (!this.allowHardLabels) {
      throw new Error(
        `${this.model} answered but returned no logprobs, so there is no probability to threshold — pass allowHardLabels to measure it anyway`,
      );
    }
    return { probability: isYes ? DEGRADED_YES : DEGRADED_NO };
  }

  /**
   * Ask a question with a known answer, to find out what this endpoint and
   * model can actually do before anything starts depending on them.
   *
   * Worth its own round trip because both ways this backend degrades are
   * invisible from the outside. An endpoint that accepts `logprobs: true` and
   * returns no logprobs is indistinguishable, at the call site, from one that
   * honours it — and the gate keeps working either way, just without the
   * numbers that made it worth having. Third-party OpenAI-compatible
   * endpoints do this routinely.
   */
  async probe(): Promise<JudgeCapability> {
    const control = "Is 2 + 2 equal to 4?";
    let completion: OpenAI.Chat.ChatCompletion;
    try {
      completion = await this.complete([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Question: ${control}\nAnswer (Y or N):` },
      ]);
    } catch (err) {
      return {
        logprobs: false,
        firstTokenUsable: false,
        detail: `request failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const choice = completion.choices[0];
    const top = choice?.logprobs?.content?.[0]?.top_logprobs;
    const text = choice?.message.content?.trim().toLowerCase() ?? "";
    const firstTokenUsable = YES_TOKENS.has(text.slice(0, 1)) || NO_TOKENS.has(text.slice(0, 1));

    if (top && top.length > 0) {
      return { logprobs: true, firstTokenUsable, detail: `${top.length} top logprobs returned` };
    }

    return {
      logprobs: false,
      firstTokenUsable,
      detail: text.startsWith("<think")
        ? "no logprobs, and the model emits reasoning tokens before answering"
        : `no logprobs; answer came back as ${JSON.stringify(text.slice(0, 20))}`,
    };
  }

  private async complete(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    topLogprobs = this.topLogprobs,
  ): Promise<OpenAI.Chat.ChatCompletion> {
    const base = { model: this.model, messages, max_tokens: 1, temperature: 0 } as const;

    if (this.logprobsUnsupported) {
      return this.client.chat.completions.create(base);
    }

    try {
      return await this.client.chat.completions.create({
        ...base,
        logprobs: true,
        top_logprobs: topLogprobs,
      });
    } catch (err) {
      // Some compatible endpoints reject the parameter outright rather than
      // ignoring it. Retry once without it, and stop asking.
      if (!isBadRequest(err)) throw err;
      this.noteDegraded();
      this.logprobsUnsupported = true;
      return this.client.chat.completions.create(base);
    }
  }

  private noteDegraded(): void {
    if (this.logprobsUnsupported) return;
    this.logprobsUnsupported = true;
    logger.warn(
      this.allowHardLabels
        ? `Judge ${this.name} returned no logprobs — using hard yes/no at P=${DEGRADED_NO}/${DEGRADED_YES}, which are not calibrated.`
        : `Judge ${this.name} returned no logprobs. Every call will fail closed to asking the user.`,
    );
  }
}

/**
 * P(yes) over the yes/no mass only, and how much mass that was.
 *
 * Renormalising over just the two is on purpose: at temperature 0 with a
 * one-character instruction the rest of the distribution is whitespace and
 * stray punctuation, and counting it as evidence for "no" would make every
 * answer look safer than it is. What the renormalising hides is returned
 * beside it as `coverage`, as `choice()` does, so a caller can tell a model
 * that answered from one that wanted to say something else.
 */
function probabilityFromLogprobs(top: readonly { token: string; logprob: number }[]): { probability: number; coverage: number } {
  let yes = 0;
  let no = 0;

  for (const entry of top) {
    const token = entry.token.trim().toLowerCase();
    if (!token) continue;
    const mass = Math.exp(entry.logprob);
    if (YES_TOKENS.has(token)) yes += mass;
    else if (NO_TOKENS.has(token)) no += mass;
  }

  const total = yes + no;
  if (total <= 0) {
    throw new Error("no yes/no token in the top logprobs");
  }
  return { probability: yes / total, coverage: Math.min(1, total) };
}

/** `key: value` lines — short, ordered, and the same shape every time. */
function renderState(state: JudgeState): string {
  return Object.entries(state)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

function isBadRequest(err: unknown): boolean {
  return err instanceof OpenAI.APIError && err.status === 400;
}
