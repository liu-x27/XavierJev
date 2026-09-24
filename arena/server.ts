/**
 * The arena's server: one route per game, each asking the judge one question.
 *
 * These two routes used to sit in mini-claude-code's web server, beside the
 * chat API. What came with them: the judge built once from AGENT_JUDGE_* and
 * probed before anything depends on it, and the rule that only this machine
 * is answered. What did not: sessions, tools, approvals. This server runs no
 * tools, but it does put a model behind a port, so it keeps the rule.
 *
 *   AGENT_JUDGE_API_KEY=ollama AGENT_JUDGE_BASE_URL=http://127.0.0.1:11434/v1 \
 *     AGENT_JUDGE_MODEL=llama3.1:8b npm run arena     # :3002
 *   npm run arena:client                             # :5175
 *
 * Without a judge both games still run, on their hand-written rules.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { FLAP_QUESTION, flapState, forcedFlap, isFlight } from "../games/flappy.js";
import { isBoard, snakeQuestion } from "../games/snake.js";
import { LlmJudge } from "../src/llm.js";
import type { ChoiceBackend, JudgeBackend } from "../src/types.js";

/**
 * Build the judge once, at boot, and probe it.
 *
 * A browser tab gives no hint that a judge is silently failing every
 * question, so one that cannot answer is reported here and left out, and
 * the games fall back to their rules.
 */
async function buildJudge(): Promise<LlmJudge | undefined> {
  if (!(process.env.AGENT_JUDGE_API_KEY || process.env.AGENT_JUDGE_BASE_URL)) return undefined;
  try {
    const judge = new LlmJudge();
    const capability = await judge.probe();
    if (capability.logprobs) return judge;
    console.warn(`   judge ${judge.name} returned no logprobs (${capability.detail})`);
  } catch (err) {
    console.warn(`   judge unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  return undefined;
}

const judge = await buildJudge();
/** Snake asks it to pick one of four; Flappy asks it yes or no. */
const chooser: ChoiceBackend | undefined = judge;
const flapJudge: JudgeBackend | undefined = judge;

/**
 * Only this machine may ask.
 *
 * The socket is bound to loopback, so nothing on the network can connect; a
 * Host header that is not a loopback name is refused, which is what a
 * DNS-rebinding page would send; and an Origin from anywhere but a loopback
 * page is refused, which is what any other website's fetch would send. The
 * client reaches the API through the Vite proxy, same-origin, so there are
 * no CORS headers at all.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopback(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

function localOnly(req: Request, res: Response, next: NextFunction): void {
  const { host, origin } = req.headers;
  if (!host || !isLoopback(`http://${host}`) || (origin !== undefined && !isLoopback(origin))) {
    res.status(403).json({ ok: false, reason: "this API only answers pages served from this machine" });
    return;
  }
  next();
}

const app = express();
app.use(localOnly);
app.use(express.json());

const NO_JUDGE = "No model judge — start the server with AGENT_JUDGE_BASE_URL and AGENT_JUDGE_MODEL set.";

app.get("/api/health", (_req, res) => {
  // Whether the arena can ask a model, or only run its rules.
  res.json({ status: "ok", choice: chooser ? chooser.name : null });
});

/** Longer than any answer the local judge gives, short enough that a stuck one does not hold the game. */
const SNAKE_TIMEOUT_MS = 3000;

/**
 * One move in the snake arena, decided by the judge's `choice()`.
 *
 * Takes a board rather than a prompt. The question is built here, from
 * games/snake.ts, so the browser can ask for a move and nothing else — this
 * is not a way to put arbitrary text in front of the judge model.
 */
app.post("/api/snake/move", async (req, res) => {
  if (!chooser) {
    res.status(503).json({ error: NO_JUDGE });
    return;
  }
  const { board, mode } = (req.body ?? {}) as { board?: unknown; mode?: unknown };
  if (!isBoard(board)) {
    res.status(400).json({ error: "not a valid board" });
    return;
  }
  const question = snakeQuestion(board, mode === "raw" ? "raw" : "facts");
  if (question.options.length === 0) {
    res.status(422).json({ error: "no legal move" });
    return;
  }
  if (question.options.length === 1) {
    // Nothing to decide, and not worth a round trip to say so.
    res.json({ answers: [{ id: question.options[0]!.id, probability: 1 }], coverage: 1, latencyMs: 0, forced: true });
    return;
  }

  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      chooser.choice(question.state, question.ask, question.options),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer in ${SNAKE_TIMEOUT_MS} ms`)), SNAKE_TIMEOUT_MS);
      }),
    ]);
    res.json({ ...result, latencyMs: Math.round(performance.now() - started), judge: chooser.name });
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Math.round(performance.now() - started),
    });
  } finally {
    clearTimeout(timer);
  }
});

/**
 * One tick of Flappy: flap or not, as P(yes) from the judge.
 *
 * No deadline here. The browser owns the clock — it decides whether an
 * answer came back in time, and does not send the next question while this
 * one is still being answered — so the server's only job is to answer, and
 * to say how long the judge took.
 */
app.post("/api/flappy/flap", async (req, res) => {
  if (!flapJudge) {
    res.status(503).json({ error: NO_JUDGE });
    return;
  }
  const { flight } = (req.body ?? {}) as { flight?: unknown };
  if (!isFlight(flight)) {
    res.status(400).json({ error: "not a valid flight" });
    return;
  }
  const forced = forcedFlap(flight);
  if (forced !== undefined) {
    // Flapping would crash: the rule's call, not a question.
    res.json({ probability: forced ? 1 : 0, latencyMs: 0, forced: true });
    return;
  }
  const started = performance.now();
  try {
    const [answer] = await flapJudge.noul(flapState(flight), [FLAP_QUESTION]);
    const p = answer?.probability;
    if (typeof p !== "number" || !(p >= 0 && p <= 1)) throw new Error("the judge gave no probability");
    res.json({ probability: p, latencyMs: Math.round(performance.now() - started), judge: flapJudge.name });
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Math.round(performance.now() - started),
    });
  }
});

const PORT = Number(process.env.PORT ?? 3002);
app.listen(PORT, "127.0.0.1", () => {
  console.log(`\nArena API at http://127.0.0.1:${PORT} (this machine only)`);
  console.log(`   judge: ${judge ? judge.name : "none — the games play their rules"}\n`);
});
