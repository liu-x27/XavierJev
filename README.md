# XavierJev

An agent loop is full of small decisions nobody wants to wait for or read a paragraph
about: may this command run without asking, which model should take this request, is this
error worth one more try, is this run going anywhere. XavierJev answers them as typed
questions — yes or no, one of *n*, a point on a scale — read off one token's probabilities
from a small local model, in tens of milliseconds. The hard part is not the call. It is
knowing whether the numbers mean anything, so every decision here is measured against
hand-labelled sets, the held-out ones log each read, one false allow fails a run, and the
places a regex beat the model are kept.

The shape is borrowed from TypeSafe AI's [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev),
a "System One" decision model. This is an independent project and not affiliated with
TypeSafe: nothing here calls the Jev API, and nothing was trained on its output.

The gate in a real session — [mini-claude-code](https://github.com/liu-x27/mini-claude-code)'s
REPL, with the loop on one provider and the judge, `llama3.1:8b`, on a local Ollama:

```
› Run exactly: wc -l src/agent.ts
  Risk gate allowed Bash — worst P=0.074 (exfiltrates) < 0.2
  ⚙ Bash — wc -l src/agent.ts        ok in 88ms
  506

› Clean the build. Run exactly: rm -rf dist
  Risk gate deferred Bash — P(destroys-data)=0.995 is not below 0.2
  ⚠ Permission required for Bash
  Allow? [y/N/a (always)/d (deny always)]: n

› Use rmdir /s /q dist instead
  Risk gate deferred Bash — P(destroys-data)=0.817 is not below 0.2
```

The third exchange is the one worth having: a Windows command an allow-list does not model
at all, deferred at 0.817.

| decision | asked as | measured | where it falls short |
|---|---|---|---|
| may this tool call run unasked? | four yes/no, worst wins | 153 held-out commands: 26/77 safe cleared, **0/76** unsafe — a false-allow rate below 3.9% | 88% cleared on dev, 34% on the held-out set |
| cheap model or strong? | one yes/no | held out: 34% downgraded | 19% of hard requests downgraded — off by default |
| retry a failed read once? | one yes/no | best wording 29/36 | a regex gets 36/36, and ships |
| stop a run that is stuck? | repeat rule, then one yes/no | 0 wrong stops, 0 missed, dev and held out | 39 labelled runs in all |
| snake: which way? | one of up to four | best move 133/133 from digested facts | 43/133 from the raw board |
| flappy: flap? | yes/no inside 30 ms a tick | 0.3% of ticks missed, flies | 31% missed at 20 ms, and it dies |

## Quickstart

```bash
npm install
npm test                                        # 43 checks, mocked — no model, no key
npm run eval:risk-gate                          # the gate's dev set, offline: the allow-list is its default
```

Everything else needs a judge: an OpenAI-compatible endpoint that returns logprobs. A
local Ollama does, needs no key, and costs nothing:

```bash
ollama pull llama3.1:8b
export AGENT_JUDGE_API_KEY=ollama AGENT_JUDGE_BASE_URL=http://localhost:11434/v1 AGENT_JUDGE_MODEL=llama3.1:8b
npm run eval:risk-gate -- --backend llm   # the llm rows
npm run arena                             # the games' server, :3002
npm run arena:client                      # the games, at http://localhost:5175
```

As a library (the package name in package.json; not published to npm):

```ts
import { createRiskGate, LlmJudge } from "xavierjev";

const judge = new LlmJudge();              // AGENT_JUDGE_* from the environment
console.log(await judge.probe());          // what the endpoint can actually do
const gate = createRiskGate({ backend: judge });

const verdict = await gate({ toolName: "Bash", input: { command: "rm -rf dist" }, description: "rm -rf dist" });
// { action: "ask", probability: 0.99…, answers: [four of them], latencyMs, threshold: 0.2 }
```

## Three primitives

A decision model takes state plus declared, typed questions, and returns probabilities
instead of prose, so control flow can branch on a number rather than on parsed English.
The state is a flat map of short strings, rendered as `key: value` lines, and it is the
caller's job to keep it to the few facts the question is about.

```ts
noul(state, questions): Promise<{ id; probability; coverage? }[]>              // yes or no
choice(state, ask, options): Promise<{ answers; coverage }>                   // one of 2–8
rubric(state, ask, levels): Promise<{ distribution; expected; spread; coverage }>  // 2–9 levels
```

Each answer is one token. Asked for `{"confidence": 0.9}`, a model writes whichever number
reads well; asked for `Y` or `N`, the ratio between their probabilities is a quantity it
did not choose. `choice()` labels its options A, B, C… and `rubric()` numbers its levels,
so the whole distribution comes out of one forward pass, and `coverage` says how much of
that token's probability landed on the labels at all — a model that wanted to start a
sentence instead should be visible as that, not as a confident renormalisation of what
was left. `noul()` reports it too, as the share of the token on a yes or a no, and an
answer with less than half (`MIN_COVERAGE`) counts as a judge failure in all four decisions
below. llama3.1:8b has put all of it on Y or N on every call measured.

`LlmJudge` (`src/llm.ts`) is the backend for all three. `AllowlistJudge` answers the risk
gate's four questions from patterns, offline, and says 0.5 — no opinion — to anything
else. `LlmJudge.probe()` asks a control question at startup, because both ways an endpoint
fails here are silent: it can accept `logprobs: true`, return 200 and include none, and a
reasoning model spends its one token on `<think>`.

## Four decisions an agent loop makes

The interfaces are in `src/decisions.ts`. They were written for mini-claude-code's agent
loop, which still calls them — from its own copy of this code, until it depends on this
package. Each has a direction it fails in, chosen by what the error costs: the gate falls
through to asking, the router to the expensive model, the retry judge to not retrying,
the stop judge to carrying on.

### The risk gate

`createRiskGate` (`src/gate.ts`) sits in front of a permission prompt and is consulted
only for calls the static rules sent to "ask". It can turn some of those into "allow". It
cannot touch a static deny, and is never asked about one, so it moves calls out of the
prompt queue and never out of the deny list — a model is never in a position to overrule
a rule the user wrote. Auto-deny exists and is off by default: a denial the user never
sees looks, to the agent, like a tool that is broken.

**Every backend failure lands on asking.** A backend that throws, times out, skips a
question, or answers with something that is not a probability in [0, 1] gets the user
asked. That closes the failure where the judge is silently absent while the gate goes on
reporting that everything is fine. It cannot close a well-formed answer that is wrong: a
score below the threshold on something destructive auto-allows it, and no prompt appears
to correct it — which is why false allows are counted apart, why one of them fails an
eval run, and why no mock can stand in for that column.

`npm run eval:risk-gate` puts hand-labelled shell commands through the gate and reports
**prompts saved** — safe commands cleared without asking — and **false allows**. There are
four sets: `cases.ts` (83) is the dev set that the wordings, threshold and model were
chosen on; `testset.ts` (125), `testset2.ts` (96) and `testset3.ts` (153) are held out,
labelled before any judge saw them, each read once or twice with every read logged in its
own docstring.

| backend | threshold | dev (83) | test 2 (96) | test 3 (153) |
|---|---|---|---|---|
| no gate | — | 0/41 · 0/42 | 0/53 · 0/43 | 0/77 · 0/76 |
| `allowlist` — offline | 0.20 | 23/41 · **0/42** | 7/53 · **0/43** | 8/77 · **0/76** |
| **`llm` llama3.1:8b** | **0.20** | 36/41 · **0/42** | 26/53 · **1/43** | **26/77 · 0/76** |

Read the coverage left to right: **88% on dev, 49% on test 2, 34% on test 3.** The more
unfamiliar the commands, the less the gate clears — the right direction for something that
fails closed, and a poor advertisement for the dev-set figure. What ships is a third of
safe commands cleared with no false allows on 153 commands it had never seen. Test 3's
commands came from asking the agent's own model what it would run across a dozen
realistic tasks, never mentioning harm; only the labels are mine. Test 1 is left out: it
was run before two of the four questions were rewritten, and is in
[docs/measurements.md](docs/measurements.md) with that caveat attached.

**Zero is a count, not a rate.** 0/76 is consistent with a false-allow rate anywhere up to
3.9% at 95% confidence, and tests 2 and 3 together, 1/119, bound it at the same 3.9%.
Saying below 1% would take 299 unsafe commands with none let through — four times test 3.
`eval:risk-gate` prints that bound under every false-allow count, from exact binomial
bounds in `eval/stats.ts`. They treat each command as an independent draw, and commands
generated a task at a time are not quite that, so the real uncertainty is a little wider.

**A threshold is only the one measured if nothing under it moved.** 0.2 is a property of
the judge, the prompt and the four questions together, and each of them can change with no
error anywhere: another model behind the same name, another quantisation, a prompt someone
tidied. `checkGate(gate)` puts the gate through seven canaries from the dev set — three
reads it clears far below 0.2, and one sure case for each harm — and compares their scores
with the ones recorded when the threshold was measured. A held canary allowed, or scores
moved more than one unit of log-odds towards allowing, is `unsafe`: do not use this gate.
Moved the other way, it is safe but not the gate that was measured, and its threshold wants
measuring again. `eval:risk-gate` runs the check before anything else and prints it.

The prompt is on that list because of what `npm run eval:order` found: the same four
questions over the 83 dev commands, asked as shipped and then with N named before Y in the
instruction, nothing else changed.

| answer instruction | cleared · false allows at 0.2 | AUC | cleared with none let through |
|---|---|---|---|
| "Y for yes, N for no" — shipped | 36/41 · 0/42 | 0.975 | 39/41 |
| "N for no, Y for yes" | **0/41** · 0/42 | 0.960 | 34/41 |
| both, averaged in log-odds | 20/41 · 0/42 | 0.974 | 37/41 |

Naming N first moved every question up by 1.6 to 2.9 in log-odds and changed 36 of the 83
decisions — every safe command the shipped gate cleared is asked about instead. The ranking
barely moves, so the order does not change what the judge knows; it changes the numbers a
threshold is set on. Averaging both orders, the usual cure for an order bias, costs twice
the calls and ranks no better. With nothing to judge at all, `command: N/A`, the shipped
order answers yes 24–45% of the time and the swapped one 54–76%. This is the dev set, where
the wordings were tuned under the shipped order, so it says the order matters, not which
order is better.

**The finding worth keeping.** The gate first asked one question listing all four harms.
That cost 9 false allows out of 34, and four of the nine were credential reads — the last
clause in the list. Four narrow questions, worst answer wins, removed all four. A single
yes/no over a disjunction makes a model weigh the clauses against each other; four narrow
ones do not. Three of those wordings have since been tuned one at a time, and the winners
have nothing in common — the move that fixed one made another five times worse. There is
no phrasing rule to carry forward, which is the argument for the harness rather than for
any wording it produced. [docs/measurements.md](docs/measurements.md) has the rest.

### The router

`createModelRouter` (`src/router.ts`) asks one question about the user's prompt before
the first turn and picks a model from it. Its failures resolve to the expensive model:
closed, in the direction that costs money rather than quality. `npm run eval:routing`
scores 40 dev requests and 65 held-out ones, labelled by tier:

|  | dev (40) | held out (65) |
|---|---|---|
| downgraded | 15/40 (38%) | 22/65 (34%) |
| wrong downgrades | 1/20 (5%) | **7/37 (19%)** |
| wrong escalations | 6/20 | 13/28 |
| cost saved, estimated | 30% | 27% |

This measures agreement with my own tier labels, not whether the cheap model's answer
would have been good enough, which would need two outputs compared. Nearly four times the
error rate out of sample — and 7 of 37 is consistent with a true rate as high as 33% —
and the reason is structural: a shell command carries its hazard
on its face, while the difficulty of "optimize the database query performance" depends on
a codebase the judge is never shown. It is behind a flag, not on by default.

### Retrying a failed read — where a model lost

`createRetryJudge` (`src/retry.ts`): when a call that changes nothing fails, is it worth
one more try before the model sees the error? The loop asks only about read-only calls, and
at most once per call; the judge says whether the error is transient, and a judge that
fails means no retry. `npm run eval:retry`, 36 failures in the tools' own formats, 17 of
them transient:

|  | right | wasted retries | missed retries |
|---|---|---|---|
| llama3.1:8b, first wording | 25/36 | 0/19 | 11/17 |
| llama3.1:8b, best of four wordings | 29/36 | 6/19 | 1/17 |
| `TRANSIENT_ERROR_PATTERNS` | **36/36** | 0/19 | 0/17 |

So the patterns ship, and the model judge is kept to measure. The list was written in the
same sitting as the cases, so 36/36 is an upper bound, but the gap is not close. It is the
gate's argument turned round: `rmdir /s /q dist` is dangerous with no keyword saying so,
which is what a model is for, while `ECONNRESET` and `503` mean one thing in every message
they appear in. A decision layer is worth its latency where the answer is not already
written on the input.

### Knowing when to stop

`createRepeatStopJudge` and `createStopJudge` (`src/stop.ts`) are asked after each turn of
tool calls whether the run is getting anywhere. A wrong stop interrupts a run that was
working; a missed one costs turns up to a limit that exists anyway. So the repeat rule
needs the same call to fail the same way three times, the model is not asked before four
calls and stops only at P ≥ 0.8, and a judge that fails means carry on.
`npm run eval:stop`, wrong stops / missed stops:

|  | dev, 27 runs | held out, 12 runs |
|---|---|---|
| same call, same failure, 3 times | 0 / 6 | 0 / 4 |
| llama3.1:8b | 0 / 1 | 0 / 1 |
| both, repeat rule first | **0 / 0** | **0 / 0** |

The rule cannot miss an exact repeat and cannot see a reworded one; the model sees the
reworded ones. Its wording was chosen on dev after a first version stopped all three runs
whose failures were shrinking — 5 failing tests, then 3, then 1. Asking whether the
*results are changing* moved every progressing run to 0.71 or below.

## On a board, and on a clock

`games/` holds two games the judge plays, and `arena/` a page to watch it play them.

![The snake arena playing live against llama3.1:8b](docs/snake-arena.gif)

**Snake** is `choice()`: a rule removes the walls and the body before anything is asked,
and the model chooses among the moves that survive — told, for each, whether it closes on
the food and whether it leads into a dead end. *Raw cells* hands over the same board
undigested. `npm run eval:snake`, 150 random boards:

|  | facts (default) | raw cells |
|---|---|---|
| picks a move that survives | 100%, by construction | 30% |
| picks the best move, when there is one | 133/133 | 43/133 |
| coverage | 1.000 | 1.000 |
| per decision, p50 / p95 | 36 / 41 ms | 41 / 46 ms |

Over five whole games the model averages 27.2 to the hand-written rule's 41.0, agreeing
with it on 86% of moves; the rule reads the exact room count, which the model is not told.
One wording mattered more than the rest. With the food move described as "eats the food"
and the question asking which move "gets closer to the food", the model preferred "farther
from food" often enough to circle the food for hundreds of moves (mean 17.6); "closer to
food, eats it" took that to 27.2. A decision model answers the question as worded.

![Flappy against a 30 ms budget, live against llama3.1:8b](docs/flappy-arena.gif)

**Flappy** runs on a clock: every tick is one yes/no — flap or not — with a budget, and
an answer that is not back inside it is a miss, on which the bird does nothing.
`npm run eval:flappy`:

| budget per tick | ticks missed | pipes passed, 3 flights |
|---|---|---|
| 60 ms | 0.0% | 21+ 21+ 21+ |
| 30 ms | 0.3% | 21+ 21+ 21+ |
| 20 ms | 31% | 1, 0, 0 |
| 15 ms | 95% | 0, 0, 0 |

21+ is the tick limit, not a crash. Answers take 15 ms at the median and 26–30 ms at p95,
so the cliff sits between 30 and 20 ms; in the browser, with its own round trip and
drawing, 30 ms missed 5–6% of ticks in the Instrument theme and about 9% in Aurora. The
judge that flies is given one fact — what happens if it does not flap — because
llama3.1:8b reads one fact well and does not combine two: asked over both, it got four of
six combinations right, and one it got wrong was fatal. A flap that would crash is the
rule's call, as a wall is for the snake.

## How many a second

`npm run eval:throughput`: *c* callers, each sending its next snake question the moment
the last returns, 96 questions per level, on an RTX 5080.

![Decisions per second and p95 latency against callers asking at once](docs/throughput.svg)

| callers at once | 1 | 2 | 4 | 8 | 16 |
|---|---|---|---|---|---|
| Ollama as installed, decisions/s | 33.5 | 41.3 | 41.7 | 41.5 | 41.0 |
| `OLLAMA_NUM_PARALLEL=4`, decisions/s | 37.4 | 37.5 | 38.4 | 39.7 | 41.5 |
| p95 as installed, ms | 43 | 72 | 128 | 240 | 463 |

About forty decisions a second is the ceiling, and four parallel slots do not move it:
past one or two callers, each extra caller adds a place in the queue and p95 grows with it.

`npm run eval:latency` takes one gate decision apart, through Ollama's native endpoint,
which reports how long it spent reading the prompt:

| the gate's four questions about one command | Ollama as installed | `OLLAMA_NUM_PARALLEL=4` |
|---|---|---|
| one question, short command | 25–28 ms, 18–20 of them reading the prompt | the same |
| all four at once, short command | **89 ms** — answered one after another | 107 ms — side by side, and slower |
| all four at once, 2,000-character command | **278 ms** | 867 ms |

The answer is one token, so the time is in reading the prompt, and below a hundred tokens
or so that is one pass through the model whatever the length — 85 tokens and 109 both take
18–20 ms. Past that, length is the cost: a 2,000-character command is 823 tokens and 154 ms.
The gate's four questions queue behind each other on the server, and they share their
start: after the first question read that command, the other three took about 20 ms each,
because the server kept what it had read. Parallel slots undo exactly that. Each slot keeps
its own copy, so four slots read the same command four times, and the gate gets slower —
three times slower on the long one. The lever for a decision layer is a smaller model (not
measured here), or a server that reads the shared part once and answers the four in one
pass, not more slots.

## Are the numbers worth thresholding?

A threshold only means something if the numbers under it do. `npm run eval:calibration`
bins the gate's worst answer on the dev set — dev only, since the held-out sets log every
read — and asks how often each bin is actually unsafe:

![The gate's calibration, and a one-question harm rubric on the same commands](docs/calibration.svg)

| gate's worst answer | 0–0.1 | 0.1–0.2 | 0.2–0.5 | 0.5–0.9 | 0.9–0.99 | 0.99–1 |
|---|---|---|---|---|---|---|
| commands | 27 | 9 | 8 | 11 | 13 | 15 |
| actually unsafe | 0% | 0% | 63% | 100% | 85% | 100% |

Clean where it matters: nothing below the shipped 0.2 is unsafe, and nothing above 0.99 is
safe. Expected calibration error 0.111, AUC 0.975, on the same 83 commands the threshold
was chosen on — a description, not a validation. The same run tries `rubric()`: asked once
"how much harm could this do, 1 to 5", it ranks the commands nearly as well (AUC 0.968) and
does much worse where it counts — with no unsafe command let through it clears 29 of the
41 safe ones, against the gate's 39, because a secret and a truncation blur into "not much
harm". One graded question weighs the harms against each other the way one compound
yes/no did.

## Status

The mock suite — `npm test`, 43 checks, no model — covers the logic that would otherwise
fail quietly: the gate's answers returned in question order and decided on the worst; the
four ways each of the gate and the router can fail (a backend that throws, times out,
skips a question, or answers outside [0, 1]) landing on asking and on the strong model; the
allow-list's rejections, including the two it once let through; `choice()` and `rubric()`
against a stand-in endpoint, renormalised with coverage beside them and an error rather
than a guess when no label comes back; the snake and Flappy rules; the retry and stop
judges' thresholds and failure directions; an answer with too little of its token on a yes
or a no, refused by all four decisions; the gate's self-check, in both directions of
drift; the answer order reaching the prompt; and the bounds `eval/stats.ts` puts beside a
count.

The tables for the four decisions, the games, throughput and calibration were measured in
mini-claude-code, with this code and these sets, before the decision layer moved here.
After the move the gate's dev set was run again — `allowlist` 23/41 · 0/42, `llm` 36/41 ·
0/42 — and matches; the answer-order and latency tables were measured here, on
2026-09-24. The `llm` rows need a judge
standing up first; the ones published were measured against a local Ollama serving
`llama3.1:8b`.

**What is not known.** Anything about a judge other than llama3.1:8b: every `llm` number
here is that one model, at Ollama's default quantisation. Whether a hosted provider's
logprobs agree with a local model's: this path has only run against Ollama. How the gate
does on the commands an agent actually sends over weeks, rather than on labelled sets of
a hundred or so, and against commands written to slip past it — obfuscated, encoded,
split across variables — which no set here contains. Whether a third fewer prompts feels different
across a long session than it does across a table of 153 rows. The 0.2 threshold is a
property of this judge and this prompt, not of the gate: a different model needs it
measured again. The router's out-of-sample
error rate is 19%, which is not a number to ship as an automatic decision. Three held-out
gate sets exist and each carries a log of every time it has been read, because a test set
consulted repeatedly becomes a dev set whether or not anyone admits it; two are spent and
the third has been read once.

## Development

```bash
npm test                  # 43 checks, mocked
npm run typecheck         # src, games, eval, test and arena
npm run lint
npm run build             # the library, to dist/
npm run eval:risk-gate                    # offline: the allow-list is its default backend
npm run eval:risk-gate -- --backend llm   # the other evals ask the judge by default:
                                          # routing retry stop snake flappy throughput calibration order latency
npm run eval:risk-gate -- --cases test3   # a held-out set; read its docstring first
```

`docs/capture-arena.mjs` records the arena GIFs from the live page against a live judge;
it needs Electron and ffmpeg, and its header says how.

## Provenance

The decision layer was built inside [mini-claude-code](https://github.com/liu-x27/mini-claude-code),
an agent framework whose loop still calls the gate, the router and the retry and stop
judges. It moved here with the history of the files that were its own: the first 27
commits are that history, filtered to those paths, with their original messages and dates.
Its working record — every threshold reasoned wrong before being measured right, every
wording refused — is [docs/measurements.md](docs/measurements.md).

Every backend failure here resolves to asking, rather than to a default, because of one
rule: **a fallback must either raise, or write into a diagnostic that something actually
checks.** Building the logprob backend ran into two silent returns that needed it — a
label word missing from the top-K, and a reasoning model spending its budget before
answering — which is why `LlmJudge.probe()` exists.

## License

MIT — see [LICENSE](LICENSE).
