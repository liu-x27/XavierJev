# XavierJev

[![ci](https://github.com/liu-x27/XavierJev/actions/workflows/ci.yml/badge.svg)](https://github.com/liu-x27/XavierJev/actions/workflows/ci.yml)

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

![Three panels: a gate decision's latency, as installed and with parallel slots; each dev-set command's worst score with the answer letters in either order; and the 95% bound on the false-allow rate against the number of unsafe commands tested](docs/at-a-glance.svg)

Three measurements, from [docs/measurements.md](docs/measurements.md). A gate decision is four
questions the server answers one after another, about 90 ms in all, and parallel slots make
it slower. Naming N before Y in the answer instruction, and changing nothing else, moves
every score — the reason the gate checks canaries at startup. And zero false allows in 76
tries is a bound of 3.9%, not a rate of zero.

| decision | asked as | measured | where it falls short |
|---|---|---|---|
| may this tool call run unasked? | four yes/no, worst wins | 153 held-out commands: 29/77 safe cleared, **0/76** unsafe — a false-allow rate below 3.9% | 85% cleared on dev, 38% on the held-out set |
| cheap model or strong? | one yes/no | held out: 34% downgraded | 19% of hard requests downgraded — off by default |
| retry a failed read once? | one yes/no | best wording 29/36 | a regex gets 36/36, and ships |
| stop a run that is stuck? | repeat rule, then one yes/no | 0 wrong stops, 0 missed, dev and held out | 39 labelled runs in all |
| snake: which way? | one of up to four | best move 133/133 from digested facts | 43/133 from the raw board |
| flappy: flap? | yes/no inside 30 ms a tick | 0.3% of ticks missed, flies | 31% missed at 20 ms, and it dies |

## Quickstart

```bash
npm install
npm test                                        # 52 checks, mocked — no model, no key
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

llama.cpp's `llama-server` serves the same GGUF just as well (`ollama show llama3.1:8b
--modelfile` prints its path), given the prompt the threshold was measured on. Its default
template writes today's date into the prompt and moves the gate's answers
([On another server](#on-another-server)), so start it with `--no-jinja`:

```bash
llama-server -m <the GGUF> -ngl 99 --no-jinja   # or --chat-template-file eval/llama-cpp/llama3.1-as-ollama.jinja
export AGENT_JUDGE_API_KEY=none AGENT_JUDGE_BASE_URL=http://127.0.0.1:8080/v1 AGENT_JUDGE_MODEL=llama3.1:8b
```

As a library. It is not on npm; installing from GitHub builds it, and
[mini-claude-code](https://github.com/liu-x27/mini-claude-code) takes it this way:

```sh
npm install github:liu-x27/XavierJev#v0.5.0
```

```ts
import { createRiskGate, LlmJudge } from "xavierjev";

const judge = new LlmJudge();              // AGENT_JUDGE_* from the environment
console.log(await judge.probe());          // what the endpoint can actually do
const gate = createRiskGate({ backend: judge });

const verdict = await gate({ toolName: "Bash", input: { command: "rm -rf dist" }, description: "rm -rf dist" });
// { action: "ask", probability: 0.99…, answers: [four of them], latencyMs, threshold: 0.2 }
```

## In Claude Code

`plugins/xavierjev-gate` points Claude Code's PermissionRequest hook — which fires only when
Claude Code is about to ask you about a tool call — at a local server running this gate. A
shell command the gate scores safe is cleared without the prompt; everything else, and every
failure, including the server not running at all, is asked about as usual. It never denies,
and it stays out of every permission mode but Manual and accept-edits: auto mode has a
classifier of its own, and a prompt that classifier falls back to is not this gate's to
answer.

```bash
npm run claude-code                              # the server, :3003, with AGENT_JUDGE_* as above
claude plugin marketplace add liu-x27/XavierJev
claude plugin install xavierjev-gate@xavierjev
```

`npm run claude-code -- --observe` decides and logs without clearing anything. Either way
each request goes to `~/.xavierjev/claude-code.jsonl`, on this machine only, and the server
will not start if the judge returns no logprobs or the gate fails its self-check. Only the
command is shown to the judge, not the description the agent wrote for it.

Tested: the hook's decisions as mock checks, and the server against the real judge with
hand-sent requests — `git log --oneline -20` cleared at 0.021, `rm -rf src` at 0.999 left
to the prompt, auto mode and a Write left alone, a foreign `Host` refused. Not tested: a
session of real use. Claude Code already lets some read-only commands through by itself,
so what share of the prompts that do reach the hook it saves is not the held-out sets'
third, and is not known yet.

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
was left. Where the options sit moves the answer, though: llama3.1:8b picks the first of
`choice()`'s options about twice as often as no preference would ([On JevBench](#on-jevbench)). `noul()` reports it too, as the share of the token on a yes or a no, and an
answer with less than 95% of it (`MIN_COVERAGE`, a half before 0.2.0) counts as a judge failure in all four decisions
below. llama3.1:8b has put all of it on Y or N on every call measured.

`LlmJudge` (`src/llm.ts`) is the backend for all three. `AllowlistJudge` answers the risk
gate's four questions from patterns, offline, and says 0.5 — no opinion — to anything
else. `LlmJudge.probe()` asks a control question at startup, because both ways an endpoint
fails here are silent: it can accept `logprobs: true`, return 200 and include none, and a
reasoning model spends its one token on `<think>`.

## Four decisions an agent loop makes

The interfaces are in `src/decisions.ts`. They were written for mini-claude-code's agent
loop, which still calls them, now through this package at `v0.1.0` rather than a copy of
it. Each has a direction it fails in, chosen by what the error costs: the gate falls
through to asking, the router to the expensive model, the retry judge to not retrying,
the stop judge to carrying on.

### The risk gate

In a real session — [mini-claude-code](https://github.com/liu-x27/mini-claude-code)'s REPL,
with the loop on one provider and the judge, `llama3.1:8b`, on a local Ollama:

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

**So does a command too long to show whole.** The judge is shown at most 2,000 characters
of any input (`maxValueChars`), and a call with a longer one is asked about without the
judge being consulted: a clearance can only cover what was read, and the end of a long
script is where a cut would hide anything. No labelled command below is longer than 106
characters, so no number here moves.

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
| `llm` llama3.1:8b, before 0.3.0 | 0.20 | 36/41 · **0/42** | 26/53 · **1/43** | 26/77 · **0/76** |
| **`llm` llama3.1:8b, 0.3.0** | **0.20** | 35/41 · **0/42** | — | **29/77 · 0/76** |

Read the coverage left to right: **88% on dev, 49% on test 2, 34% on test 3.** The more
unfamiliar the commands, the less the gate clears — the right direction for something that
fails closed, and a poor advertisement for the dev-set figure. What ships is 29 of 77 safe
commands cleared, 38%, with no false allows on 153 commands it had never seen — up from a
third before 0.3.0 reworded `outside-cwd`, which is the last section of
[On real traffic](#on-real-traffic); test 2 is spent and was not read again for it. Test 3's
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
moved more than half a unit of log-odds towards allowing, is `unsafe`: do not use this gate.
Moved the other way, it is safe but not the gate that was measured, and its threshold wants
measuring again. `eval:risk-gate` runs the check before anything else and prints it. The
limit was a whole unit until 0.4.0. Then the same weights on llama.cpp's default template
moved the canaries 0.90 towards allowing, cleared a dev-set command the measured gate asks
about, and passed ([On another server](#on-another-server)). Half a unit fails that, and
still passes the +0.14 and +0.25 seen on configurations that build the measured prompt.

Canaries catch a move after it happens, so before them the check asks the backend which
model it is. Ollama answers with a manifest digest that covers the weights, the chat template
and the parameters together. A digest other than the one the canaries were recorded on
(`GATE_RECORDED_ON`: llama3.1:8b at `46e0c10c039e`, what a fresh pull gives on 2026-09-26) is
not the gate that was measured, whatever its canaries say. Other endpoints report no digest,
and for them the canaries are the whole check.

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

**What it judges.** The words of a command, not what they run. `npm test` or
`node scripts/migrate.js` is scored on that text, and whatever the script does is out of
its sight; under the label criterion, running the project's own code in the working
directory is safe. Someone who wants those asked about writes an ask rule, which the gate
is never consulted on.

**What it does not defend against.** It is built for an agent that means well and is
sometimes careless — the wrong directory under `rm -rf`, a key pasted into a command. It
is not built to hold against an agent working against the user, or a command written to
be misread: no labelled set here contains one, and nothing here measures it. For
comparison, [a red-team study](https://arxiv.org/abs/2609.19587) of Claude Code's auto
mode and Codex's Guardian, classifiers far larger than this one, reports agents getting
arbitrary bash past them with injection attacks in 79% of trials. A local 8B judge reading
one token should be assumed weaker. Against that threat the answer is a sandbox, not a
gate.

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
a codebase the judge is never shown. It is behind a flag, not on by default. A request
longer than the 2,000 characters the judge is shown goes to the strong model unasked: a
downgrade can only rest on what was read.

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

*Live, at the speed it decided: the page's fifth game, from when it passed 35 to its end at
43, boxed in with the board nearly full — the room the rule counts and the model is not
told about. It is the best of the five; the four before it averaged 25.5, the five 29.0.
Each game on the page starts from its own seed and the judge answered the same way both
times this was recorded, so the fifth game is the same game every time.
`docs/capture-arena.mjs` records the first game past the score it is given, and retries
nothing.*

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

![Flappy against a 60 ms budget, live against llama3.1:8b](docs/flappy-arena.gif)

*Live, at 60 ms a tick: the page's first flight, from pipe 20. No tick missed, and it was
still flying three minutes after the clip ends. The page's budget has to cover the round
trip to the local server as well as the judge, so at 30 ms it does worse than the eval
below: its answers came back at p95 36 ms, it missed 11.6% and 13.3% of ticks in two
runs, and its flights averaged 10.0 and 16.0 pipes. Recorded with other work running on
the same machine.*

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

**Slay the Spire 2** is where this is meant to go next, and it is not there yet.
[spire-jev](https://github.com/liu-x27/spire-jev) plays the real game — Ironclad, whole runs,
ascension 10, no human input — in the same shape: a simulator and a search for the order
to play each hand, since a search that looks at thousands of states has no room for a
model, and around the fights the judgement calls (card rewards, the path, events), which
is where `choice()` and `noul` are meant to go. Today those calls are hand-written rules,
and nothing in spire-jev calls this package, so none of its numbers are the judge's.

![Slay the Spire 2 at ascension 10, the last two floors: spire-jev beats Aeonglass, then dies to Test Subject (3×)](docs/spire-jev-a10-497.gif)

*Ascension 10, seed 497, floors 48 and 49 at 3×: one fight from a win, and not a win. The
current rules beat act 3's first boss, Aeonglass, and died on the fourth turn against the
second, Test Subject — the furthest of 90 seeds kept for confirmation, on which those rules
win no run, average floor 25 and beat act 1's boss 71% of the time.*

![Slay the Spire 2 at ascension 10: act 3's boss on floor 48, played by spire-jev's rules and search (3×)](docs/spire-jev-a10-707.gif)

*Ascension 10, seed 707, act 3's boss on floor 48 at 3×, on older rules: the furthest of the
102 seeds it was picked from; it died on turn 8 with the Queen at 279 HP. The numbers, and
how a recording is the same run as the headless one, are in spire-jev's README.*

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
three times slower on the long one. More slots are not the lever for a decision layer. That
leaves a smaller model, which the next section finds barely faster and much worse, and a
server that reads the shared part once and answers the four in one pass, which neither
Ollama nor [llama.cpp's server](#on-another-server) is.

## Smaller judges

`npm run eval:ladder` puts the gate's four questions over its dev set with other local
models (2026-09-24, Ollama 0.34.2, RTX 5080):

![Six local models: how fast each answers the gate's four questions, against how many safe commands it could clear with none let through, and what the self-check said about it](docs/ladder.svg)

| judge | AUC | cleared with none let through | at the shipped 0.2 | four questions, mean | self-check |
|---|---|---|---|---|---|
| llama3.2:1b | 0.630 | 2/41 | 12/41 · **7/42 unsafe cleared** | 45 ms | unsafe |
| llama3.2:3b | 0.893 | 17/41 | 2/41 · 0/42 | 66 ms | not as measured |
| qwen2.5:3b | 0.886 | 2/41 | 37/41 · **14/42 unsafe cleared** | 84 ms | unsafe |
| llama3.1:8b | 0.975 | 39/41 | 36/41 · 0/42 | 97 ms | as measured |
| yi:9b | 0.782 | 0/41 | 35/41 · **19/42 unsafe cleared** | 123 ms | unsafe |
| glm4:9b | — | cannot judge | — | — | the probe refuses it |

An eighth of the size takes 46% of the time, since a decision this short costs about one
pass through the model whichever model it is, and loses most of the judgement. A bigger
model is no rescue either: yi:9b is slower than the 8B and has no threshold at which it
lets nothing unsafe through. The shipped threshold does not travel: at 0.2, qwen2.5:3b
would clear 37 safe commands and 14 unsafe ones, yi:9b 35 and 19. That is what the startup
self-check is for — it called all three models 0.2 would have made dangerous unsafe, and
the fourth not the gate that was measured. glm4:9b, a usable judge three weeks ago, now
writes a newline before its answer, so its first token carries no Y or N and the probe
turns it away before a question is asked. "Cleared with none let through" is each model's
ceiling, at the best threshold for it chosen on these same commands.

Trained rather than prompted, a small model does better — on one machine. Frozen Qwen3-0.6B
with a logistic head per harm, fitted to 3,000 of this machine's agent commands read by hand,
ranks 1,000 more at AUC 0.981 against llama3.1:8b's 0.915: at the threshold registered before
the test, 289 of 733 safe commands cleared and one of 256 unsafe let through, close to the
8B's 308 and one, and with the threshold loosened, 556 cleared for two let through where the
8B manages 363. Its miss is a credential print, the one harm it has no head for (three
examples in 4,000), and its four questions take 47 ms. On the gate's own labelled sets it is
far worse than the 8B — AUC 0.847 on the dev set, 10/77 cleared on `testset3` — because what
it learned is this machine's habits. A second round fine-tuned the same model with LoRA, put a
word list in charge of `reveals-secret`, and added 179 labelled commands from the gate's spent
test sets: on the same held-out 1,000 it clears 656 of 733 safe commands for four unsafe let
through (the 8B: 308 and one), and on `testset3` 30/77 for two, level with the 8B's 29 but not
its zero — both misses are passwords given on the command line. Merged, its four questions take
44 ms. The commands and weights stay here; nothing ships from it
([A judge trained on this machine's traffic](docs/measurements.md#a-judge-trained-on-this-machines-traffic)).

## On another server

`npm run eval:llama-cpp` puts the gate on llama.cpp's `llama-server` beside Ollama, both
serving the one GGUF file Ollama keeps for llama3.1:8b, so whatever moves is the server
(2026-09-25, llama.cpp b11190, RTX 5080):

| server, and the chat template it builds the prompt with | dev set at 0.2: cleared · false allows | answers against Ollama's, mean in log-odds | self-check |
|---|---|---|---|
| Ollama | 35/41 · 0/42 | a second run: 0.000 | as measured, +0.14 |
| llama.cpp, the GGUF's own — its default | 36/41 · 0/42 | **−0.54** | **unsafe**, −0.90 — as measured under 0.3.0's limit |
| llama.cpp, `--no-jinja` | 35/41 · 0/42 | 0.000 | as measured, +0.14 |
| llama.cpp, `--chat-template-file eval/llama-cpp/llama3.1-as-ollama.jinja` | 35/41 · 0/42 | 0.000 | as measured, +0.14 |

Given the prompt Ollama builds, llama.cpp returns Ollama's answers, all 332 of them. Its
default does not build that prompt. It renders the template stored in the GGUF, which is
Meta's and puts two lines ahead of the gate's system prompt: *Cutting Knowledge Date:
December 2023* and *Today Date: 25 Sep 2026*. Those twenty tokens moved the answers half a
unit of log-odds towards allowing on average, and a tenth of them by more than 1.6. On the
dev set that cleared one more safe command and let nothing unsafe through. The date is the
day's, so that prompt changes every midnight. The self-check reported the move, and at the
time passed it: −0.90 was inside its limit of one unit. 0.4.0 halved the limit, so this gate
now reads unsafe, and the Claude Code hook refuses to start on it.

Speed is Ollama's. One gate decision, median of 15, with another job holding about a fifth
of the GPU when it started:

| | short command | 2,000 characters |
|---|---|---|
| Ollama, before · after the llama.cpp runs | 123 · 126 ms | 272 · 300 ms |
| llama.cpp, one slot | 111 ms | 271 ms |
| llama.cpp, four slots | 148 ms | 812 ms |
| llama.cpp, four slots sharing one KV cache (`-kvu`) | 109 ms | 831 ms |

Four slots make the long command three times slower, as Ollama's four did, which is what
reading it four times costs, and a KV cache the slots share does not change that. Batching
also nudges the arithmetic: with four slots the self-check's canaries sat at +0.25 and +0.22
rather than +0.14.

## On real traffic

The labelled sets are what the safety numbers stand on, and every command in them is a
short one-liner: the longest is 106 characters. `npm run eval:real-traffic` reads every Bash
call in this machine's Claude Code transcripts — 10,869 distinct commands, June to September
2026 — and prints counts, never commands.

|  | labelled sets | this machine's agent traffic |
|---|---|---|
| length, median · p95 | under 110 characters | 279 · 1,781 characters |
| multi-line scripts | none | 35% |
| one-liners that start with `cd` | almost none | 69% |
| longer than the 2,000 characters the judge is shown | none | 4%, asked about unjudged |

On 500 of them drawn at random, the gate cleared **132 (26%)**: 38% of the one-liners and 6%
of the scripts. All 132 were read by hand afterwards, and none would have needed asking —
they are reads, searches, `git log` and `git diff`, type-checks and test runs, two `curl`
GETs; about fifteen run the project's own code, which is the policy above, not a slip. There
were no judge failures and the lowest coverage was 0.999, so the 0.95 floor costs nothing.
What there is not is a false-allow count: this traffic has no labels, and reading 132
commands is not a measurement.

Two things hold it back. Decisions sit close to the line — 41 of the 132 cleared within 0.05
of it, and 60 held within 0.1 above — so a small shift in the judge moves the benefit a
lot. And 271 of the 345 it judged and held were held by `outside-cwd`: of the one-liners that
start with `cd` to an absolute path, 86% go to a directory other than the session's own, to
read something there, and the judge takes a path outside the working directory for a change
outside it. The dev set has none of those commands, which is why six wordings of that
question were compared on it without anyone noticing. The latency here, p50 316 ms and p95
469 ms, was measured while other experiments had the GPU; the figures above are from a quiet
machine.

0.3.0 rewords that question, adding *"Reading, listing or searching files does not count"* —
the first wording chosen on this traffic rather than on the dev set, and written down before
anything measured it. On the same 500 commands it clears 150 where the old one cleared 132;
on the other half of the split, which nothing had looked at, 139 against 115. Set against
itself, the old wording moves 3 of 500, so the gain is real, and it also says a decision within
a few hundredths of the line can go either way on a rerun. All 51 newly cleared commands were
read by hand, the dev set's 21 tagged harms are all still caught, and test 3's one read gives
29/77 cleared with 0/76 false allows. Each step, in the order it had to pass, is in
[docs/measurements.md](docs/measurements.md#reads-do-not-count).

Then what it lets through was counted. 0.3.0 was put over 4,000 commands, 2,000 from each
half with the earlier 1,000 among them, and all 1,181 it cleared (29.5%) were read by hand
against the label criterion. If *the working directory* means the session's, six should have
been asked about; if it means the one a command `cd`s into, three. They were two appends to a
tracked file in another repository, a new file in a scratch directory, an empty directory, and
a file written into another session's scratch directory. The sixth ran a script from a scratch
directory that rewrites a tracked README in place: the one that could lose work, and the one
the command's text does not show. Nothing cleared deletes a file, sends data out or shows a
credential. So the share of the gate's clears that were wrong is below **1.0%** at 95% (0.66%
on the second reading), or 1.33% on the 3,000 commands nothing had looked at before.

That bounds what the gate clears, not how much unsafe traffic gets through, since the 2,819 it
held were not read. It is also one run's count. All six scored between 0.15 and 0.2, and the
same 1,000 commands, judged again hours later, moved by up to 0.13 and flipped 26 decisions. Both
tables are in [docs/measurements.md](docs/measurements.md#counting-what-it-let-through).

## On JevBench

`npm run eval:jevbench` answers [JevBench](https://github.com/fstandhartinger/jevbench)'s 231
public tasks with the three primitives, and `eval/jevbench/score.py` grades the answers with
JevBench's own scoring code. Its labels are written by hand or by other LLMs, not by Jev; the
run reads only `datasets/public`, never the `results/` where JevBench keeps Jev's per-task
answers. llama3.1:8b, with a 16k context for the hard tier's long states (Ollama's default is
4,096):

| tier | tasks | accuracy | above chance | ECE |
|---|---|---|---|---|
| easy | 48 | 100% | 100 | 0.006 |
| original | 72 | 73.6% | 61.7 | 0.168 |
| hard | 111 | **36.0%** | **3.6** | **0.304** |
| all public | 231 | 61.0% | 45.0, weighted as JevBench weights its tiers | 0.174 |

The hard tier — long policies and multi-hop states, up to about 15,000 characters — comes out
barely above chance, and confident while wrong. Much of that is where the options sit rather
than what the model knows. `npm run eval:option-order` asks every task in every order its
options can be listed in: `choice()` picks the option listed first 47.8% of the time, where no
preference would give 22.1%, and averaging each label's probability over the orders — 3.5
times the calls — scores the hard tier at 51.4%, 26.7 above chance with an ECE of 0.117, and
all public tasks at 56.9 weighted. None of the four decisions uses `choice()` or `rubric()`,
so nothing shipped moves; a caller of `choice()` should know that on half of these tasks its
answer depended on the order
([The order the options are listed in](docs/measurements.md#the-order-the-options-are-listed-in)).
The weighted 45.0 sits beside the leaderboard's raw Qwen3-8B direct-logit baseline,
45.7 on that axis (rank 54 of 93 in v1.4.2), which is measured over the full set including a
sealed half, so they are neighbours rather than a comparison; the trained judges above it do
better. There is no composite here, because JevBench's composite needs the sealed set. And a
judge that answers every task uniformly scores an ECE of 0.017 on the same 231 tasks —
calibration read without accuracy says nothing.

## Beside a rule-based guard

`npm run eval:compare` puts [cc-safety-net](https://github.com/kenryu42/cc-safety-net) 2.4.7,
a rule-based PreToolUse guard, over the same labelled commands. It blocks what its rules
recognise and passes the rest; the gate clears what it is sure of and leaves the rest to the
prompt. So they are compared on the two counts both have: unsafe commands stopped — blocked
by one, left to the user by the other — and safe ones passed without friction.

| test 3 (153 commands) | unsafe stopped | safe passed |
|---|---|---|
| cc-safety-net 2.4.7, default rules | 11/76 (14%) | 76/77 (99%) |
| `allowlist` gate | 76/76 | 8/77 (10%) |
| **`llm` gate, llama3.1:8b, 0.3.0** | **76/76** | **29/77 (38%)** |

By harm, it stopped 11 of the 32 destructive commands, 4 of the 56 that reach outside the
project, none of the 3 that send data out — its README says it does not watch the network —
and none of the 7 credential cases, which are passwords typed on the command line rather than
the files (`~/.ssh`, `.env`) its credential rules guard. Tests 1 and 2 and the dev set say the
same; `eval:compare` prints them all. Over this machine's own agent traffic, 10,751 distinct
commands, it would have blocked 80 (0.7%): among them a force-removed worktree, a deleted
remote branch and a key read out of a `.env.local` into a request, and among them words in a
commit message that matched a rule.

The two fail in opposite directions, and nothing stops running both: the guard in PreToolUse,
where it sees every call in every permission mode, and the gate in PermissionRequest, where
it only ever clears. [dcg](https://github.com/Dicklesworthstone/destructive_command_guard), the
most-starred guard of this kind, is not in the table: its MIT licence carries a rider granting
no rights to Anthropic or those acting for it, benchmarking included, and these measurements
are made with Claude Code.

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

The mock suite — `npm test`, 52 checks, no model — covers the logic that would otherwise
fail quietly: the gate's answers returned in question order and decided on the worst; the
four ways each of the gate and the router can fail (a backend that throws, times out,
skips a question, or answers outside [0, 1]) landing on asking and on the strong model; the
allow-list's rejections, including the two it once let through; `choice()` and `rubric()`
against a stand-in endpoint, renormalised with coverage beside them and an error rather
than a guess when no label comes back; the snake and Flappy rules; the retry and stop
judges' thresholds and failure directions; an answer with too little of its token on a yes
or a no, refused by all four decisions; a command too long to show the judge whole, asked
about without it, and a request too long to show the router, sent to the strong model; a
threshold outside (0, 1), a negative timeout or a fractional count, refused when a decision is
built, since each would otherwise turn it silently into always or never; the gate's self-check, in both directions of
drift, and its model digest against the recorded one; the answer order reaching the prompt; the Claude Code hook's allow, silence and
abstentions; and the bounds `eval/stats.ts` puts beside a count.

The tables for the four decisions, the games, throughput and calibration were measured in
mini-claude-code, with this code and these sets, before the decision layer moved here.
After the move the gate's dev set was run again — `allowlist` 23/41 · 0/42, `llm` 36/41 ·
0/42 — and matches; the answer-order and latency tables were measured here, on
2026-09-24. The `llm` rows need a judge
standing up first; the ones published were measured against a local Ollama serving
`llama3.1:8b`.

**What is not known.** Anything about a judge other than llama3.1:8b beyond the ladder
above: every other `llm` number here is that one model, at Ollama's default quantisation. Whether a hosted provider's
logprobs agree with a local model's: this path has run against Ollama and llama.cpp's server,
which agree once they build the same prompt, and against nothing hosted. How much of the
unsafe traffic an agent actually sends gets through: what the gate cleared of it has been
read, 6 of 1,181 should have been asked about, but what it held has not; and how it does
against commands written to slip past it — obfuscated, encoded, split across variables — which no set here contains. Whether a third fewer prompts feels different
across a long session than it does across a table of 153 rows. The 0.2 threshold is a
property of this judge and this prompt, not of the gate: a different model needs it
measured again. The router's out-of-sample
error rate is 19%, which is not a number to ship as an automatic decision. Three held-out
gate sets exist and each carries a log of every time it has been read, because a test set
consulted repeatedly becomes a dev set whether or not anyone admits it; two are spent and
the third has been read once.

## Development

```bash
npm test                  # 52 checks, mocked
npm run typecheck         # src, games, eval, test and arena
npm run lint
npm run build             # the library, to dist/
npm run eval:risk-gate                    # offline: the allow-list is its default backend
npm run eval:risk-gate -- --backend llm   # the other evals ask the judge by default:
                                          # routing retry stop snake flappy throughput calibration order latency laddernpm run figures                           # redraws docs/at-a-glance.svg and docs/ladder.svg from docs/data/
npm run eval:risk-gate -- --cases test3   # a held-out set; read its docstring first
```

`docs/capture-arena.mjs` records the arena GIFs from the live page against a live judge;
it needs Electron and ffmpeg, and its header says how.

## Provenance

The decision layer was built inside [mini-claude-code](https://github.com/liu-x27/mini-claude-code),
an agent framework whose loop still calls the gate, the router and the retry and stop
judges, and since `v0.1.0` takes them from this package. It moved here with the history of the files that were its own: the first 27
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
