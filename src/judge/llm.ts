import OpenAI from "openai";
import { logger } from "../utils/logger.js";
import type { JudgeBackend, JudgeState, NoulAnswer, NoulQuestion } from "./types.js";

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
}

/**
 * What a yes/no gets mapped to when the endpoint will not return logprobs.
 *
 * Deliberately inside (0.05, 0.95): with the gate's default `autoAllowBelow`
 * of 0.05, a degraded backend auto-allows *nothing* and every call falls
 * through to the user. A hard 0 would instead mean "one token of output, from
 * one sample, at temperature 0, is enough to run this without asking" — which
 * is not a thing this backend is in a position to promise. Raising
 * `autoAllowBelow` past this floor is how a caller says they accept that
 * trade; it should not happen by accident because a provider ignored a flag.
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

export class LlmJudge implements JudgeBackend {
  readonly name: string;

  private readonly client: OpenAI;
  private readonly model: string;
  private readonly topLogprobs: number;
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
    this.name = `llm:${this.model}`;
    this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  }

  async noul(state: JudgeState, questions: NoulQuestion[]): Promise<NoulAnswer[]> {
    const rendered = renderState(state);
    // One call per question: each answer is a single token, so they cannot
    // share a completion, and they have no reason to wait for each other.
    return Promise.all(
      questions.map(async (question) => ({
        id: question.id,
        probability: await this.askOne(rendered, question.ask),
      })),
    );
  }

  private async askOne(state: string, ask: string): Promise<number> {
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
    if (YES_TOKENS.has(first)) return DEGRADED_YES;
    if (NO_TOKENS.has(first)) return DEGRADED_NO;
    throw new Error(`judge answered ${JSON.stringify(text.slice(0, 20))}, expected Y or N`);
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
  ): Promise<OpenAI.Chat.ChatCompletion> {
    const base = { model: this.model, messages, max_tokens: 1, temperature: 0 } as const;

    if (this.logprobsUnsupported) {
      return this.client.chat.completions.create(base);
    }

    try {
      return await this.client.chat.completions.create({
        ...base,
        logprobs: true,
        top_logprobs: this.topLogprobs,
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
      `Judge ${this.name} returned no logprobs — falling back to hard yes/no at ` +
        `P=${DEGRADED_NO}/${DEGRADED_YES}, which auto-allows nothing at the default threshold.`,
    );
  }
}

/**
 * P(yes) over the yes/no mass only.
 *
 * Renormalising over just the two is on purpose: at temperature 0 with a
 * one-character instruction the rest of the distribution is whitespace and
 * stray punctuation, and counting it as evidence for "no" would make every
 * answer look safer than it is.
 */
function probabilityFromLogprobs(top: readonly { token: string; logprob: number }[]): number {
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
  return yes / total;
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
