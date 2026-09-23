/**
 * Flappy as pure functions: a bird, pipes, one tick, and the yes/no question
 * a judge is asked each tick — flap now, or not.
 *
 * The snake arena is turn-based: the game waits for the model, so speed is
 * only a number on the screen. This one runs on a clock. Each tick has a
 * budget, and an answer that is not back inside it is a miss: the bird does
 * nothing that tick, the way a real-time controller falls back to its no-op.
 * Too slow and the bird falls.
 *
 * Units are cells of a 24 × 16 field; y grows downwards.
 */
import type { JudgeState, NoulQuestion } from "../src/judge/types.js";

export const FIELD = { width: 24, height: 16 } as const;
export const BIRD_X = 6;

const GRAVITY = 0.04;
const FLAP_VELOCITY = -0.34;
const MAX_FALL = 0.55;
const PIPE_SPEED = 0.22;
const PIPE_WIDTH = 2;
const PIPE_SPACING = 9;
const GAP = 5;
const BIRD_RADIUS = 0.42;

export interface Pipe {
  /** Left edge. */
  x: number;
  /** Top of the gap. */
  gapTop: number;
  passed: boolean;
}

export interface Flight {
  y: number;
  vy: number;
  pipes: Pipe[];
  score: number;
  ticks: number;
}

function newPipe(x: number, random: () => number): Pipe {
  return { x, gapTop: 2 + random() * (FIELD.height - GAP - 4), passed: false };
}

export function newFlight(random: () => number): Flight {
  return {
    y: FIELD.height / 2,
    vy: 0,
    pipes: [newPipe(FIELD.width - 4, random), newPipe(FIELD.width - 4 + PIPE_SPACING, random)],
    score: 0,
    ticks: 0,
  };
}

/** The pipe the bird has to get through next. */
export function nextPipe(f: Flight): Pipe {
  return f.pipes.find((p) => p.x + PIPE_WIDTH > BIRD_X - BIRD_RADIUS) ?? f.pipes[0]!;
}

function crashed(y: number, pipes: Pipe[]): boolean {
  if (y - BIRD_RADIUS < 0 || y + BIRD_RADIUS > FIELD.height) return true;
  return pipes.some(
    (p) =>
      BIRD_X + BIRD_RADIUS > p.x &&
      BIRD_X - BIRD_RADIUS < p.x + PIPE_WIDTH &&
      (y - BIRD_RADIUS < p.gapTop || y + BIRD_RADIUS > p.gapTop + GAP),
  );
}

export interface TickResult {
  flight: Flight;
  dead: boolean;
  scored: boolean;
}

export function tick(f: Flight, flap: boolean, random: () => number): TickResult {
  const vy = flap ? FLAP_VELOCITY : Math.min(MAX_FALL, f.vy + GRAVITY);
  const y = f.y + vy;
  let scored = false;
  let pipes = f.pipes.map((p) => {
    const moved = { ...p, x: p.x - PIPE_SPEED };
    if (!moved.passed && moved.x + PIPE_WIDTH < BIRD_X - BIRD_RADIUS) {
      moved.passed = true;
      scored = true;
    }
    return moved;
  });
  if (pipes[0]!.x + PIPE_WIDTH < 0) pipes = [...pipes.slice(1), newPipe(pipes.at(-1)!.x + PIPE_SPACING, random)];
  const next = { y, vy, pipes, score: f.score + (scored ? 1 : 0), ticks: f.ticks + 1 };
  return { flight: next, dead: crashed(y, pipes), scored };
}

/** Where the bird would be `n` ticks from now, flapping first or not. */
function project(f: Flight, flap: boolean, n: number): { y: number; crashes: boolean } {
  let y = f.y;
  let vy = f.vy;
  let pipes = f.pipes;
  for (let i = 0; i < n; i++) {
    vy = i === 0 && flap ? FLAP_VELOCITY : Math.min(MAX_FALL, vy + GRAVITY);
    y += vy;
    pipes = pipes.map((p) => ({ ...p, x: p.x - PIPE_SPEED }));
    if (crashed(y, pipes)) return { y, crashes: true };
  }
  return { y, crashes: false };
}

export interface FlapFacts {
  /** Above or below the middle of the next gap, in cells. Positive is below. */
  offset: number;
  falling: boolean;
  /** Does waiting this tick and the next few crash, or leave it below the gap? */
  waitCrashes: boolean;
  waitEndsLow: boolean;
  flapCrashes: boolean;
}

const LOOKAHEAD = 3;

export function flapFacts(f: Flight): FlapFacts {
  const p = nextPipe(f);
  const middle = p.gapTop + GAP / 2;
  const wait = project(f, false, LOOKAHEAD);
  const flap = project(f, true, LOOKAHEAD);
  return {
    offset: f.y - middle,
    falling: f.vy > 0,
    waitCrashes: wait.crashes,
    waitEndsLow: wait.y > p.gapTop + GAP - 0.9,
    flapCrashes: flap.crashes,
  };
}

/** The hand-written rule over the same facts: flap when waiting would crash or sink, unless flapping crashes. */
export function ruleFlap(f: Flight): boolean {
  const facts = flapFacts(f);
  if (facts.flapCrashes && !facts.waitCrashes) return false;
  return facts.waitCrashes || facts.waitEndsLow;
}

export const FLAP_QUESTION: NoulQuestion = {
  id: "flap",
  ask: "Will the bird fall out of the gap if it does not flap now?",
};

/**
 * Above this P(yes) the bird flaps. Not 0.5: on the three states the judge
 * is asked about, llama3.1:8b answered 0.486 for "it stays in the gap" and
 * 0.773 / 0.785 for the two that need a flap, so the line goes between them.
 */
export const FLAP_THRESHOLD = 0.6;

/**
 * A tick the rule decides without asking: flapping would crash into the pipe
 * above. Like a wall for the snake, that is not a judgement.
 *
 * It is also the one the judge got wrong. Asked a single question over both
 * facts — what happens if it flaps and if it does not — llama3.1:8b got 4 of
 * the 6 combinations right, and one of the two it missed was exactly this: told
 * that not flapping keeps it in the gap and flapping hits the pipe, it
 * flapped, at P = 0.62, and flew into the pipe. A two-way choice between the
 * outcomes got 3 of 6, and two narrow yes/no questions 3 of 6 — the one about
 * crashing was perfect, the one about leaving the gap never cleared 0.47. It
 * reads one fact well and does not combine two, so it is given one.
 */
export function forcedFlap(f: Flight): boolean | undefined {
  const facts = flapFacts(f);
  return facts.flapCrashes ? facts.waitCrashes : undefined;
}

/** The judge's view of a flight, when it is asked at all: what happens if it does not flap. */
export function flapState(f: Flight): JudgeState {
  const facts = flapFacts(f);
  return {
    "if it does not flap": facts.waitCrashes
      ? "it falls out of the gap and crashes"
      : facts.waitEndsLow
        ? "it falls out of the gap"
        : "it stays in the gap",
  };
}

export function isFlight(x: unknown): x is Flight {
  if (typeof x !== "object" || x === null) return false;
  const f = x as Partial<Flight>;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  return (
    num(f.y) &&
    num(f.vy) &&
    num(f.score) &&
    num(f.ticks) &&
    Array.isArray(f.pipes) &&
    f.pipes.length >= 1 &&
    f.pipes.length <= 4 &&
    f.pipes.every((p) => typeof p === "object" && p !== null && num(p.x) && num(p.gapTop) && typeof p.passed === "boolean")
  );
}

export const PIPE = { width: PIPE_WIDTH, gap: GAP } as const;
export { BIRD_RADIUS };
