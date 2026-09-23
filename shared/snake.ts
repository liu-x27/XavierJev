/**
 * Snake as pure functions: a board, a step, the legal moves, and the
 * question a judge is asked about them.
 *
 * Shared by both halves of the arena. The server turns a board into a
 * `choice()` question, so the prompt is built in one place and the browser
 * cannot send it anything else; the browser plays the game, draws it, and
 * runs the hand-written rule the model is compared with.
 *
 * The split between rule and model is the risk gate's, pointed at a game.
 * Whether a move is legal is not a judgement — a wall is a wall — so a rule
 * decides it and the model is only offered the moves that survive. Which of
 * those to take is the part worth a model.
 */
import type { ChoiceOption, JudgeState } from "../src/judge/types.js";

export const DIRECTIONS = ["up", "down", "left", "right"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export interface Point {
  x: number;
  y: number;
}

export interface Board {
  size: number;
  /** Head first. */
  snake: Point[];
  food: Point;
}

const DELTA: Record<Direction, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export const move = (p: Point, d: Direction): Point => ({ x: p.x + DELTA[d].x, y: p.y + DELTA[d].y });
const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const key = (p: Point) => p.y * 1024 + p.x;
const inside = (size: number, p: Point) => p.x >= 0 && p.y >= 0 && p.x < size && p.y < size;
const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** mulberry32: seeded, so a game can be replayed from its seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A free cell, or undefined when the snake fills the board. */
function placeFood(size: number, snake: Point[], random: () => number): Point | undefined {
  const taken = new Set(snake.map(key));
  const free: Point[] = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!taken.has(key({ x, y }))) free.push({ x, y });
  return free[Math.floor(random() * free.length)];
}

export function newBoard(size: number, random: () => number): Board {
  const mid = Math.floor(size / 2);
  const snake = [
    { x: mid, y: mid },
    { x: mid - 1, y: mid },
    { x: mid - 2, y: mid },
  ];
  return { size, snake, food: placeFood(size, snake, random)! };
}

export type Cell = "wall" | "body" | "food" | "empty";

/** What moving `dir` runs into. The tail moves out of the way unless the snake eats. */
export function cellAhead(board: Board, dir: Direction): Cell {
  const next = move(board.snake[0]!, dir);
  if (!inside(board.size, next)) return "wall";
  if (same(next, board.food)) return "food";
  if (board.snake.slice(0, -1).some((s) => same(s, next))) return "body";
  return "empty";
}

export function legalMoves(board: Board): Direction[] {
  return DIRECTIONS.filter((d) => {
    const c = cellAhead(board, d);
    return c === "empty" || c === "food";
  });
}

export interface StepResult {
  board: Board;
  ate: boolean;
  dead: boolean;
  /** The snake fills the board: nowhere left to put food. */
  won: boolean;
}

export function step(board: Board, dir: Direction, random: () => number): StepResult {
  const cell = cellAhead(board, dir);
  if (cell === "wall" || cell === "body") return { board, ate: false, dead: true, won: false };
  const ate = cell === "food";
  const snake = [move(board.snake[0]!, dir), ...(ate ? board.snake : board.snake.slice(0, -1))];
  if (!ate) return { board: { ...board, snake }, ate, dead: false, won: false };
  const food = placeFood(board.size, snake, random);
  return food
    ? { board: { ...board, snake, food }, ate, dead: false, won: false }
    : { board: { ...board, snake }, ate, dead: false, won: true };
}

/** How many cells the head could still reach after moving `dir`. */
export function roomAfter(board: Board, dir: Direction): number {
  const head = move(board.snake[0]!, dir);
  const body = cellAhead(board, dir) === "food" ? board.snake : board.snake.slice(0, -1);
  const blocked = new Set(body.map(key));
  const seen = new Set([key(head)]);
  const stack = [head];
  let count = 0;
  while (stack.length) {
    const p = stack.pop()!;
    for (const d of DIRECTIONS) {
      const n = move(p, d);
      const k = key(n);
      if (!inside(board.size, n) || seen.has(k) || blocked.has(k)) continue;
      seen.add(k);
      count++;
      stack.push(n);
    }
  }
  return count;
}

export interface MoveFacts {
  dir: Direction;
  eats: boolean;
  closer: boolean;
  room: number;
  /** Less room than the snake is long: it would likely trap itself. */
  deadEnd: boolean;
}

/** The facts about each legal move — what the model is told, and what the rule reads. */
export function moveFacts(board: Board): MoveFacts[] {
  const head = board.snake[0]!;
  return legalMoves(board).map((dir) => {
    const room = roomAfter(board, dir);
    return {
      dir,
      eats: cellAhead(board, dir) === "food",
      closer: distance(move(head, dir), board.food) < distance(head, board.food),
      room,
      deadEnd: room < board.snake.length,
    };
  });
}

export type QuestionMode = "facts" | "raw";

export const SNAKE_QUESTIONS: Record<QuestionMode, string> = {
  facts: "Which move avoids dead ends and gets closer to the food?",
  raw: "Which move keeps the snake alive and gets it closer to the food?",
};

const describe = (f: MoveFacts) =>
  `${f.eats ? "closer to food, eats it" : f.closer ? "closer to food" : "farther from food"}, ${f.deadEnd ? "dead end" : "enough room"}`;

function foodOffset(board: Board): string {
  const head = board.snake[0]!;
  const dx = board.food.x - head.x;
  const dy = board.food.y - head.y;
  const parts: string[] = [];
  if (dx) parts.push(`${Math.abs(dx)} ${dx > 0 ? "right" : "left"}`);
  if (dy) parts.push(`${Math.abs(dy)} ${dy > 0 ? "down" : "up"}`);
  return parts.join(", ") || "here";
}

/**
 * The judge's view of a board.
 *
 * `facts`, the default: one line per legal move, and only those moves as
 * options. `raw`: what is in each neighbouring cell and where the food is,
 * with all four moves offered — the same board, handed over undigested, which
 * is there to show what that costs. On 150 random boards with llama3.1:8b
 * (`npm run eval:snake`), `raw` picked a move that survives 30% of the time;
 * `facts` 100%, which it cannot fail to, and the best move 133 times of 133.
 *
 * The food move says "closer to food, eats it" rather than "eats the food"
 * because of what the question asks. Worded without "closer", the model
 * preferred "farther from food" to eating often enough to circle the food
 * for hundreds of moves; mean score over five games went 17.6 → 27.2.
 */
export function snakeQuestion(
  board: Board,
  mode: QuestionMode = "facts",
): { state: JudgeState; ask: string; options: ChoiceOption[] } {
  if (mode === "raw") {
    const state: JudgeState = {};
    for (const d of DIRECTIONS) state[d] = cellAhead(board, d);
    state["food"] = foodOffset(board);
    return { state, ask: SNAKE_QUESTIONS.raw, options: DIRECTIONS.map((d) => ({ id: d, text: d })) };
  }
  const facts = moveFacts(board);
  return {
    state: Object.fromEntries(facts.map((f) => [f.dir, describe(f)])),
    ask: SNAKE_QUESTIONS.facts,
    options: facts.map((f) => ({ id: f.dir, text: f.dir })),
  };
}

/**
 * The hand-written rule over the same facts: avoid dead ends, then eat, then
 * close in, then keep the most room. What the model is measured against.
 *
 * Not quite the same facts: the tie-break reads the exact room count, and the
 * model is only told "enough room" or "dead end". That is most of why the
 * rule outscores it over whole games (41.0 to 27.2 in the eval) while
 * agreeing on 86% of moves.
 */
export function ruleMove(board: Board): Direction | undefined {
  const rank = (f: MoveFacts) => (f.deadEnd ? 0 : 8) + (f.eats ? 4 : 0) + (f.closer ? 2 : 0);
  const facts = moveFacts(board);
  facts.sort((a, b) => rank(b) - rank(a) || b.room - a.room);
  return facts[0]?.dir;
}

/** A board as the browser sends it, checked before anything is asked about it. */
export function isBoard(x: unknown): x is Board {
  if (typeof x !== "object" || x === null) return false;
  const b = x as Partial<Board>;
  const isPoint = (p: unknown): p is Point =>
    typeof p === "object" &&
    p !== null &&
    Number.isInteger((p as Point).x) &&
    Number.isInteger((p as Point).y) &&
    inside(b.size!, p as Point);
  if (!Number.isInteger(b.size) || b.size! < 5 || b.size! > 32) return false;
  if (!Array.isArray(b.snake) || b.snake.length < 1 || b.snake.length > b.size! * b.size!) return false;
  if (!b.snake.every(isPoint) || !isPoint(b.food)) return false;
  return new Set(b.snake.map(key)).size === b.snake.length && !b.snake.some((s) => same(s, b.food!));
}
