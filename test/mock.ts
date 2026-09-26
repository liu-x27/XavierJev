/**
 * Mock tests for the decision layer — no model, no network, no API key.
 *
 * Run: npm test
 *
 * These are the judge's sections of mini-claude-code's examples/00-mock-test.ts.
 * The checks there that tested the agent loop *using* a judge — the
 * permission system consulting the gate, a retry inside a run, a run ending
 * as stuck — stayed with the loop. The ones here call the gate, the router
 * and the retry and stop judges directly, and assert what those checks
 * asserted through the loop: which way each one fails, and where its
 * thresholds sit.
 */

import * as http from "node:http";
import chalk from "chalk";
import {
  BIRD_X,
  type Flight,
  flapState,
  forcedFlap,
  isFlight,
  newFlight,
  ruleFlap,
  tick as tickFlight,
} from "../games/flappy.js";
import {
  type Board,
  isBoard,
  legalMoves,
  moveFacts,
  ruleMove,
  seededRandom,
  snakeQuestion,
  step,
} from "../games/snake.js";
import { AllowlistJudge } from "../src/allowlist.js";
import { checkGate, createRiskGate, GATE_CANARIES, GATE_RECORDED_ON, RISK_QUESTIONS } from "../src/gate.js";
import { LlmJudge } from "../src/llm.js";
import { createRetryJudge, patternRetryJudge } from "../src/retry.js";
import { createModelRouter } from "../src/router.js";
import { casesNeeded, upperBound } from "../eval/stats.js";
import { decide } from "../integrations/claude-code/decide.js";
import { anyStopJudge, createRepeatStopJudge, createStopJudge } from "../src/stop.js";
import { type JudgeBackend, type JudgeState, type NoulAnswer, type NoulQuestion, UNKNOWN_PROBABILITY } from "../src/types.js";

// ─────────────────────────────────────────────
const pass = (msg: string) => console.log(`${chalk.green("  ✓")} ${msg}`);
const fail = (msg: string, err: unknown) => console.log(`${chalk.red("  ✗")} ${msg}: ${err}`);
const section = (title: string) => console.log(chalk.blue.bold(`\n▶ ${title}`));

let passed = 0;
let failed = 0;

function check(label: string, fn: () => void) {
  try {
    fn();
    pass(label);
    passed++;
  } catch (e) {
    fail(label, e);
    failed++;
  }
}

async function checkAsync(label: string, fn: () => Promise<void>) {
  try {
    await fn();
    pass(label);
    passed++;
  } catch (e) {
    fail(label, e);
    failed++;
  }
}

// ─────────────────────────────────────────────
// 1. Risk gate
// ─────────────────────────────────────────────
section("1. Risk gate");

// A backend that answers every question with the same number, and counts how
// often it was asked — enough to test the gate's own logic without a model.
function fakeJudge(probability: number) {
  const backend = {
    name: "fake",
    calls: 0,
    async noul(_state: JudgeState, questions: NoulQuestion[]): Promise<NoulAnswer[]> {
      backend.calls++;
      return questions.map((q) => ({ id: q.id, probability }));
    },
  };
  return backend;
}

const rm = { toolName: "Bash", input: { command: "rm -rf /" }, description: "rm" };
const ls = { toolName: "Bash", input: { command: "ls" }, description: "ls" };

await checkAsync("判断结果带上每道题的概率、耗时和阈值，按提问顺序；失败时不带答案", async () => {
  const scores: Record<string, number> = { "destroys-data": 0.9, "outside-cwd": 0.3, exfiltrates: 0.05, "reveals-secret": 0.01 };
  const gate = createRiskGate({
    backend: {
      name: "scored",
      // 故意倒序回答：结果必须按提问顺序排好，而不是照抄后端的顺序
      noul: async (_s: JudgeState, qs: NoulQuestion[]) => [...qs].reverse().map((q) => ({ id: q.id, probability: scores[q.id]! })),
    },
  });
  const v = await gate({ toolName: "Bash", input: { command: "rm -rf dist" }, description: "rm -rf dist" });
  const ids = v.answers?.map((a) => a.id).join(",");
  if (ids !== RISK_QUESTIONS.map((q) => q.id).join(",")) throw new Error(`答案顺序: ${ids}`);
  if (v.probability !== 0.9 || v.action !== "ask") throw new Error(`按最坏一题决定: ${JSON.stringify(v)}`);
  if (v.threshold !== 0.2 || typeof v.latencyMs !== "number") throw new Error(`阈值/耗时: ${v.threshold} ${v.latencyMs}`);

  const broken = createRiskGate({ backend: { name: "broken", noul: async () => [] } });
  const b = await broken(ls);
  if (b.action !== "ask" || b.answers !== undefined) throw new Error(`失败时: ${JSON.stringify(b)}`);
});

await checkAsync("低于阈值时自动放行，不打扰用户", async () => {
  const v = await createRiskGate({ backend: fakeJudge(0.01), autoAllowBelow: 0.05 })(ls);
  if (v.action !== "allow") throw new Error(`应该自动放行: ${JSON.stringify(v)}`);
});

await checkAsync("高于阈值时落回询问用户", async () => {
  const v = await createRiskGate({ backend: fakeJudge(0.9), autoAllowBelow: 0.05 })(rm);
  if (v.action !== "ask") throw new Error(`应该问用户: ${JSON.stringify(v)}`);
});

await checkAsync("默认不自动拒绝（denyAbove 关闭）", async () => {
  const v = await createRiskGate({ backend: fakeJudge(1.0) })(rm);
  if (v.action !== "ask") throw new Error(`最危险的调用也该让用户自己看到: ${v.action}`);
});

// The four fail-closed paths. Each one is a way the judge can stop working
// without anything else noticing, which is the failure worth testing.
const failingBackends: [string, JudgeBackend][] = [
  [
    "后端抛错",
    {
      name: "throws",
      async noul() {
        throw new Error("boom");
      },
    },
  ],
  [
    "后端超时",
    {
      name: "hangs",
      async noul() {
        await new Promise((r) => setTimeout(r, 200));
        return [];
      },
    },
  ],
  [
    "概率越界",
    {
      name: "out-of-range",
      async noul(_s: JudgeState, qs: NoulQuestion[]) {
        return qs.map((q) => ({ id: q.id, probability: -1 }));
      },
    },
  ],
  [
    "漏答一个问题",
    {
      name: "partial",
      async noul(_s: JudgeState, qs: NoulQuestion[]) {
        return qs.slice(1).map((q) => ({ id: q.id, probability: 0 }));
      },
    },
  ],
];

for (const [label, backend] of failingBackends) {
  await checkAsync(`${label}时落回询问用户（fail closed）`, async () => {
    const v = await createRiskGate({ backend, timeoutMs: 50 })(rm);
    if (v.action !== "ask") throw new Error(`判断层失效时绝不能放行: ${v.action}`);
    if (v.probability !== undefined) throw new Error("失效时不该报概率");
  });
}

await checkAsync("命令长到判断器只能看到开头时，不问判断器，直接问用户", async () => {
  // 判断器只看到前 2000 个字符的话，它的"安全"管不到被截掉的部分，
  // 而长脚本的末尾恰好是截断能藏东西的地方。
  const judge = fakeJudge(0.01);
  const gate = createRiskGate({ backend: judge });
  const asked = () => judge.calls;
  const long = await gate({ toolName: "Bash", input: { command: `echo ${"a".repeat(2100)}` }, description: "echo" });
  if (long.action !== "ask" || long.probability !== undefined) throw new Error(`太长的命令不能放行: ${JSON.stringify(long)}`);
  if (asked() !== 0) throw new Error(`不该去问判断器: ${asked()} 次`);
  const fits = await gate({ toolName: "Bash", input: { command: `echo ${"a".repeat(1900)}` }, description: "echo" });
  if (fits.action !== "allow" || asked() !== 1) throw new Error(`放得下的命令照常判断: ${fits.action}, ${asked()} 次`);
});

await checkAsync("默认阈值是 0.2", async () => {
  // 0.2 是 llama3.1:8b 在两个标注集上都零漏放的最高值。这条测试不是为了
  // 锁死这个数字，而是为了让"换判断器却没重测阈值"变成一次测试失败。
  const below = await createRiskGate({ backend: fakeJudge(0.19) })(ls);
  if (below.action !== "allow") throw new Error("0.19 应该低于默认阈值 0.2");
  const above = await createRiskGate({ backend: fakeJudge(0.21) })(ls);
  if (above.action !== "ask") throw new Error("0.21 不该被放行");
});

await checkAsync("AllowlistJudge 放行只读命令", async () => {
  const judge = new AllowlistJudge();
  const answers = await judge.noul({ tool: "Bash", command: "git log --oneline -5" }, [...RISK_QUESTIONS]);
  if (answers.length !== RISK_QUESTIONS.length) throw new Error("每个问题都要有答案");
  if (answers.some((a) => a.probability > 0.05)) throw new Error("只读命令应判为安全");
});

check("AllowlistJudge 拦住拼接、危险 flag 和凭据路径", () => {
  const judge = new AllowlistJudge();
  const mustReject = [
    "ls; rm -rf /",
    "git status && rm -rf .git",
    'grep -rn "$(rm -rf /)" .',
    "echo pwned > src/agent.ts",
    'find . -name "*.ts" -delete',
    "sed -i 's/a/b/g' src/agent.ts",
    "cat ~/.ssh/id_rsa",
    "git push --force origin main",
    // 这两条是留出集上真实放过去的，修的是"白名单里套了个黑名单"这个结构问题：
    // 不再问"路径像不像机密"（那是黑名单，漏了 .docker），改问"路径是不是
    // 项目里的普通文件"；递归搜索无论 pattern 是什么都能读到任何文件，所以
    // 按遍历行为拒绝，而不是按 pattern 猜。
    "cat ~/.docker/config.json",
    "grep -r api_key . --include=*.json",
    // 同一个结构问题的其它形态，都没被单独列进任何名单
    "cat ~/.config/gh/hosts.yml",
    "head -5 ../sibling-project/.env",
    "cat .npmrc",
    "grep -rn TOKEN .",
  ];
  for (const command of mustReject) {
    if (judge.inspect(command).safe) throw new Error(`不该放行: ${command}`);
  }
  console.log(chalk.gray(`    ${mustReject.length} 条危险命令全部拦住`));
});

check("AllowlistJudge 仍然放行项目内的普通读取", () => {
  const judge = new AllowlistJudge();
  const mustClear = [
    "cat package.json",
    "head -50 README.md",
    "wc -l src/*.ts",
    "du -sh .",
    "find . -name *.ts",
    "git log --oneline -20",
    'grep -n "TODO" src/index.ts',
  ];
  for (const command of mustClear) {
    const verdict = judge.inspect(command);
    if (!verdict.safe) throw new Error(`不该拦: ${command} —— ${verdict.reason}`);
  }
  console.log(chalk.gray(`    ${mustClear.length} 条项目内读取仍然放行`));
});

await checkAsync("AllowlistJudge 对不认识的问题不瞎答", async () => {
  const judge = new AllowlistJudge();
  const answers = await judge.noul({ tool: "Bash", command: "ls" }, [{ id: "is-the-user-happy", ask: "?" }]);
  if (answers[0]?.probability !== UNKNOWN_PROBABILITY) {
    throw new Error(`应该返回 UNKNOWN，实际 ${answers[0]?.probability}`);
  }
});

await checkAsync("非 Bash 工具时 AllowlistJudge 退回 UNKNOWN", async () => {
  const judge = new AllowlistJudge();
  const answers = await judge.noul({ tool: "Write", path: "src/agent.ts" }, [...RISK_QUESTIONS]);
  if (answers.some((a) => a.probability !== UNKNOWN_PROBABILITY)) {
    throw new Error("它只懂 shell 命令，别的应该说不知道");
  }
});

// ─────────────────────────────────────────────
// 2. Model router
// ─────────────────────────────────────────────
section("2. Model router");

await checkAsync("路由器低于阈值时选便宜模型", async () => {
  const route = createModelRouter({ backend: fakeJudge(0.1), strong: "claude-opus-5", cheap: "claude-haiku-4-5" });
  const verdict = await route("How many lines are in src/agent.ts?");
  if (verdict.model !== "claude-haiku-4-5") throw new Error(`选了 ${verdict.model}`);
  if (!verdict.downgraded) throw new Error("downgraded 应该为 true");
});

await checkAsync("路由器高于阈值时选强模型", async () => {
  const route = createModelRouter({ backend: fakeJudge(0.9), strong: "claude-opus-5", cheap: "claude-haiku-4-5" });
  const verdict = await route("Refactor the permission system.");
  if (verdict.model !== "claude-opus-5") throw new Error(`选了 ${verdict.model}`);
  if (verdict.downgraded) throw new Error("downgraded 应该为 false");
});

// 和闸门相反的方向：闸门失效要落回"问用户"，路由器失效要落回"贵的那个"。
// 两者都是 fail closed，只是"关"的方向由代价决定。
for (const [label, backend] of failingBackends) {
  await checkAsync(`${label}时路由器落回强模型（fail closed）`, async () => {
    const route = createModelRouter({ backend, strong: "claude-opus-5", cheap: "claude-haiku-4-5", timeoutMs: 50 });
    const verdict = await route("anything");
    if (verdict.model !== "claude-opus-5") throw new Error(`选了 ${verdict.model}`);
    if (verdict.probability !== undefined) throw new Error("失效时不该报概率");
  });
}

// ─────────────────────────────────────────────
// 3. choice() and the snake arena
// ─────────────────────────────────────────────
section("3. Choice and the snake arena");

/**
 * A stand-in for an OpenAI-compatible endpoint that answers every completion
 * with the given top logprobs, and keeps the request bodies it was sent.
 */
async function fakeLogprobEndpoint(top: Array<{ token: string; p: number }>) {
  const bodies: Array<{ messages: Array<{ role: string; content: string }>; top_logprobs?: number }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      const logprobs = top.map((t) => ({ token: t.token, logprob: Math.log(t.p), bytes: null }));
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "x",
          object: "chat.completion",
          created: 0,
          model: "fake",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: top[0]?.token ?? "" },
              finish_reason: "stop",
              logprobs: { content: [{ token: top[0]?.token ?? "", logprob: 0, bytes: null, top_logprobs: logprobs }] },
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  const baseURL = `http://127.0.0.1:${port}/v1`;
  const judge = new LlmJudge({ apiKey: "test", baseURL, model: "fake" });
  // closeAllConnections: the judge's client keeps its connection alive, and a socket still open
  // when the process exits trips a libuv assertion on Windows that turns a passing run into exit 127.
  const close = () =>
    new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
  return { judge, baseURL, bodies, close };
}

await checkAsync("choice()：一次前向读出每个选项的概率，按选项顺序归一，覆盖率单独给出", async () => {
  // 20% 的概率落在 "To" 上——模型想写一句话，而不是回答选项
  const fake = await fakeLogprobEndpoint([
    { token: "B", p: 0.6 },
    { token: "A", p: 0.2 },
    { token: "To", p: 0.2 },
  ]);
  try {
    const r = await fake.judge.choice({ up: "closer to food" }, "Which move?", [
      { id: "up", text: "up" },
      { id: "left", text: "left" },
      { id: "right", text: "right" },
    ]);
    const got = r.answers.map((a) => `${a.id}=${a.probability.toFixed(2)}`).join(" ");
    if (got !== "up=0.25 left=0.75 right=0.00") throw new Error(`答案: ${got}`);
    if (Math.abs(r.coverage - 0.8) > 1e-9) throw new Error(`覆盖率: ${r.coverage}`);
    const prompt = fake.bodies[0]!.messages.map((m) => m.content).join("\n");
    for (const want of ["A. up", "B. left", "C. right", "A, B or C", "up: closer to food"]) {
      if (!prompt.includes(want)) throw new Error(`提示里缺少 ${JSON.stringify(want)}：${prompt}`);
    }
    if ((fake.bodies[0]!.top_logprobs ?? 0) < 7) throw new Error(`top_logprobs 太少: ${fake.bodies[0]!.top_logprobs}`);
  } finally {
    await fake.close();
  }
});

await checkAsync("choice()：首词里没有任何选项字母、或选项少于两个，都报错而不是瞎猜", async () => {
  const fake = await fakeLogprobEndpoint([{ token: "Since", p: 0.9 }]);
  try {
    const opts = [
      { id: "up", text: "up" },
      { id: "down", text: "down" },
    ];
    const noLabel = await fake.judge.choice({}, "Which?", opts).then(
      () => "resolved",
      (e: Error) => e.message,
    );
    if (!/no option label/.test(noLabel)) throw new Error(`没有选项字母: ${noLabel}`);
    const one = await fake.judge.choice({}, "Which?", opts.slice(0, 1)).then(
      () => "resolved",
      (e: Error) => e.message,
    );
    if (!/2 to 8 options/.test(one)) throw new Error(`一个选项: ${one}`);
  } finally {
    await fake.close();
  }
});

// A board drawn by hand, 5×5: head H at (3,2) heading right, food F at (2,4).
//   . . . . .
//   . . . . .
//   . T B H .
//   . . . . .
//   . . F . .
const small: Board = {
  size: 5,
  snake: [
    { x: 3, y: 2 },
    { x: 2, y: 2 },
    { x: 1, y: 2 },
  ],
  food: { x: 2, y: 4 },
};

check("snake：撞墙、撞身体不合法；蛇尾这一步会让开，可以走", () => {
  if (legalMoves(small).join(",") !== "up,down,right") throw new Error(`合法步: ${legalMoves(small)}`);
  const curled: Board = {
    size: 5,
    snake: [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 2, y: 2 },
      { x: 1, y: 2 },
    ],
    food: { x: 4, y: 4 },
  };
  // (1,2) 是蛇尾：走过去时它正好移走
  if (!legalMoves(curled).includes("down")) throw new Error(`蛇尾那格应当可走: ${legalMoves(curled)}`);
  const corner: Board = {
    size: 5,
    snake: [
      { x: 4, y: 0 },
      { x: 3, y: 0 },
      { x: 2, y: 0 },
    ],
    food: { x: 0, y: 4 },
  };
  if (legalMoves(corner).join(",") !== "down") throw new Error(`角落: ${legalMoves(corner)}`);
});

check("snake：吃到食物才变长，食物换位置；撞上去判死", () => {
  const random = seededRandom(1);
  const board: Board = {
    size: 5,
    snake: [
      { x: 2, y: 3 },
      { x: 2, y: 2 },
      { x: 2, y: 1 },
    ],
    food: { x: 2, y: 4 },
  };
  const ate = step(board, "down", random);
  if (!ate.ate || ate.board.snake.length !== 4) throw new Error(`吃: ${JSON.stringify(ate)}`);
  if (ate.board.snake.some((s) => s.x === ate.board.food.x && s.y === ate.board.food.y)) throw new Error("新食物落在蛇身上");
  const moved = step(small, "up", random);
  if (moved.ate || moved.board.snake.length !== 3) throw new Error(`没吃不该变长: ${JSON.stringify(moved.board.snake)}`);
  if (!step(small, "left", random).dead) throw new Error("掉头撞脖子应当判死");
});

check("snake：问题只提供合法的步，每步一行事实；raw 模式四个方向都给", () => {
  const q = snakeQuestion(small, "facts");
  if (q.options.map((o) => o.id).join(",") !== "up,down,right") throw new Error(`选项: ${JSON.stringify(q.options)}`);
  if (q.state.down !== "closer to food, enough room") throw new Error(`down 的描述: ${q.state.down}`);
  if ("left" in q.state) throw new Error("不合法的步不该出现在状态里");
  const raw = snakeQuestion(small, "raw");
  if (raw.options.length !== 4 || raw.state.left !== "body" || raw.state.food !== "1 left, 2 down") {
    throw new Error(`raw: ${JSON.stringify(raw.state)}`);
  }
});

check("snake：规则先躲死路，再吃、再靠近", () => {
  // 往右进的是顶边两格的口袋，被墙和自己的身子围住，食物就在里面；往左是开阔地
  //   . . L H > F
  //   . . . B B B
  //   . . . T B B
  const trap: Board = {
    size: 6,
    snake: [
      { x: 3, y: 0 },
      { x: 3, y: 1 },
      { x: 4, y: 1 },
      { x: 5, y: 1 },
      { x: 5, y: 2 },
      { x: 4, y: 2 },
      { x: 3, y: 2 },
    ],
    food: { x: 5, y: 0 },
  };
  const facts = moveFacts(trap);
  const right = facts.find((f) => f.dir === "right");
  if (!right?.deadEnd || !right.closer) throw new Error(`right 应当是更近但死路: ${JSON.stringify(facts)}`);
  if (ruleMove(trap) === "right") throw new Error("规则走进了死路");
});

check("snake：接口只收合法的棋盘", () => {
  if (!isBoard(small)) throw new Error("合法棋盘被拒");
  const bad: unknown[] = [
    null,
    { ...small, size: 100 },
    { ...small, snake: [] },
    { ...small, food: { x: 3, y: 2 } }, // 食物在蛇身上
    {
      ...small,
      snake: [
        { x: 3, y: 2 },
        { x: 3, y: 2 },
      ],
    }, // 重复格子
    { ...small, snake: [{ x: 9, y: 2 }] }, // 出界
    { ...small, snake: [{ x: 1.5, y: 2 }] },
  ];
  const accepted = bad.filter((b) => isBoard(b));
  if (accepted.length) throw new Error(`接受了: ${JSON.stringify(accepted)}`);
});

// ─────────────────────────────────────────────
// 4. Flappy on a clock
// ─────────────────────────────────────────────
section("4. Flappy on a clock");

check("flappy：规则自己飞，不漏拍就一直不撞", () => {
  const random = seededRandom(1);
  let f = newFlight(random);
  for (let t = 0; t < 5000; t++) {
    const r = tickFlight(f, ruleFlap(f), random);
    if (r.dead) throw new Error(`第 ${t} 拍撞了，过了 ${r.flight.score} 根管子`);
    f = r.flight;
  }
  if (f.score < 100) throw new Error(`5000 拍只过了 ${f.score} 根管子`);
});

check("flappy：拍一下会撞上面的管子时由规则决定、不问模型；平常只给模型一句事实", () => {
  // 鸟在管子里、离缺口上沿很近：一拍就顶上去，不拍往下掉还在缺口里
  const tight: Flight = { y: 5.8, vy: 0, pipes: [{ x: BIRD_X - 0.5, gapTop: 5, passed: false }], score: 0, ticks: 0 };
  if (forcedFlap(tight) !== false) throw new Error(`应当由规则判"不拍"：${forcedFlap(tight)}`);
  const open = newFlight(seededRandom(2));
  if (forcedFlap(open) !== undefined) throw new Error("开阔处不该由规则代答");
  const state = flapState(open);
  if (Object.keys(state).join() !== "if it does not flap") throw new Error(`状态应只有一句：${JSON.stringify(state)}`);
});

check("flappy：接口只收合法的飞行状态", () => {
  if (!isFlight(newFlight(seededRandom(3)))) throw new Error("合法状态被拒");
  const bad: unknown[] = [null, { y: 1 }, { ...newFlight(seededRandom(3)), y: Number.NaN }, { ...newFlight(seededRandom(3)), pipes: [] }];
  if (bad.some((b) => isFlight(b))) throw new Error("接受了不合法的状态");
});

// ─────────────────────────────────────────────
// 5. Retry judge
// ─────────────────────────────────────────────
section("5. Retry judge");

const outage = { toolName: "WebFetch", summary: "https://example.com", error: "HTTP 503 Service Unavailable" };

await checkAsync("重试：判断出错或拿不准就不重试，模型照常看到错误", async () => {
  const sure = await createRetryJudge({ backend: fakeJudge(0.95) })(outage);
  if (!sure.retry || sure.probability !== 0.95) throw new Error(`P=0.95 应当重试: ${JSON.stringify(sure)}`);

  const broken = await createRetryJudge({
    backend: {
      name: "broken",
      noul: async () => {
        throw new Error("down");
      },
    },
  })(outage);
  if (broken.retry) throw new Error(`判断挂了却重试了: ${JSON.stringify(broken)}`);

  // 后端没意见时回 0.5——不能因为"弃权"就重试
  const unsure = await createRetryJudge({ backend: fakeJudge(UNKNOWN_PROBABILITY) })(outage);
  if (unsure.retry) throw new Error("0.5 的弃权答案触发了重试");
});

await checkAsync("重试：默认的规则判断认错误码，不被字面上的 terminated 骗", async () => {
  const says = async (error: string) => (await patternRetryJudge({ toolName: "WebFetch", summary: "", error })).retry;
  for (const e of ["HTTP 503 Service Unavailable: x", "Fetch failed: TypeError: fetch failed (cause: ECONNRESET)", "HTTP 429 Too Many Requests: x"]) {
    if (!(await says(e))) throw new Error(`该重试没重试: ${e}`);
  }
  for (const e of ["HTTP 404 Not Found: x", "Invalid regex: SyntaxError: Invalid regular expression: /(a/: Unterminated group", "File not found: a.ts"]) {
    if (await says(e)) throw new Error(`不该重试却重试: ${e}`);
  }
});

// ─────────────────────────────────────────────
// 6. Rubric
// ─────────────────────────────────────────────
section("6. Rubric");

await checkAsync("rubric()：一次前向给出 1–5 的分布、期望和离散度，覆盖率单独给出", async () => {
  // 20% 的概率落在 "The" 上，不是任何一档
  const fake = await fakeLogprobEndpoint([
    { token: "2", p: 0.5 },
    { token: "4", p: 0.3 },
    { token: "The", p: 0.2 },
  ]);
  try {
    const levels = [1, 2, 3, 4, 5].map((score) => ({ score, text: `level ${score}` }));
    const r = await fake.judge.rubric({ command: "ls" }, "How much harm?", levels);
    const got = r.distribution.map((d) => d.probability.toFixed(3)).join(" ");
    if (got !== "0.000 0.625 0.000 0.375 0.000") throw new Error(`分布: ${got}`);
    if (Math.abs(r.expected - 2.75) > 1e-9) throw new Error(`期望: ${r.expected}`);
    // sqrt(0.625·0.75² + 0.375·1.25²) = sqrt(0.9375)
    if (Math.abs(r.spread - Math.sqrt(0.9375)) > 1e-9) throw new Error(`离散度: ${r.spread}`);
    if (Math.abs(r.coverage - 0.8) > 1e-9) throw new Error(`覆盖率: ${r.coverage}`);
    const prompt = fake.bodies[0]!.messages.map((m) => m.content).join("\n");
    if (!prompt.includes("1 = level 1") || !prompt.includes("1 to 5")) throw new Error(`提示: ${prompt}`);
    const one = await fake.judge.rubric({}, "?", levels.slice(0, 1)).then(
      () => "resolved",
      (e: Error) => e.message,
    );
    if (!/2 to 9 levels/.test(one)) throw new Error(`一档: ${one}`);
  } finally {
    await fake.close();
  }
});

// ─────────────────────────────────────────────
// 7. Stop judge
// ─────────────────────────────────────────────
section("7. Stop judge");

const boom = { tool: "Boom", input: {}, summary: "Boom", ok: false, outcome: "Boom threw: kaboom" };

await checkAsync("停：同一个调用第三次同样失败就判停；每次输入不同就不算卡住", async () => {
  const repeat = createRepeatStopJudge();
  const two = await repeat({ prompt: "go", turn: 2, recent: [boom, boom] });
  if (two.stop) throw new Error("两次失败就判停了");
  const three = await repeat({ prompt: "go", turn: 3, recent: [boom, boom, boom] });
  if (!three.stop || !three.reason.includes("failed 3 times")) throw new Error(`第三次应当判停: ${JSON.stringify(three)}`);
  const echoes = [1, 2, 3, 4].map((n) => ({ ...boom, tool: "Echo", input: { text: `t${n}` }, summary: `Echo t${n}` }));
  const varied = await repeat({ prompt: "go", turn: 4, recent: echoes });
  if (varied.stop) throw new Error(`输入每次不同却判停: ${varied.reason}`);
});

await checkAsync("停：模型判断出错一律继续跑", async () => {
  const broken = createStopJudge({
    backend: {
      name: "broken",
      noul: async () => {
        throw new Error("judge down");
      },
    },
  });
  const v = await broken({ prompt: "go", turn: 4, recent: [boom, boom, boom, { ...boom, outcome: "other" }] });
  if (v.stop || v.probability !== undefined) throw new Error(`判断出错时应照常跑完: ${JSON.stringify(v)}`);
});

await checkAsync("停：组合判断先问便宜的，说停就不再问模型；模型判断不到 4 次调用不问", async () => {
  const backend = fakeJudge(0.99);
  const combined = anyStopJudge(createRepeatStopJudge(), createStopJudge({ backend }));
  const v = await combined({ prompt: "go", turn: 3, recent: [boom, boom, boom] });
  if (!v.stop || backend.calls !== 0) throw new Error(`规则已判停却还问了模型 ${backend.calls} 次`);
  const short = await createStopJudge({ backend })({ prompt: "go", turn: 2, recent: [boom, { ...boom, outcome: "other" }] });
  if (short.stop || backend.calls !== 0) throw new Error("调用不足 4 次也问了模型");
});

// ─────────────────────────────────────────────
// 8. Coverage: an answer that was mostly something else
// ─────────────────────────────────────────────
section("8. Coverage");

await checkAsync("noul()：Y/N 之外的概率照样算进 coverage，归一只在 Y 和 N 之间", async () => {
  // 70% 落在 "The" 上：模型想写一句话
  const fake = await fakeLogprobEndpoint([
    { token: "The", p: 0.7 },
    { token: "Y", p: 0.2 },
    { token: "N", p: 0.1 },
  ]);
  try {
    const [a] = await fake.judge.noul({ command: "ls" }, [{ id: "q", ask: "?" }]);
    if (!a || Math.abs(a.probability - 2 / 3) > 1e-9) throw new Error(`P(yes): ${a?.probability}`);
    if (a.coverage === undefined || Math.abs(a.coverage - 0.3) > 1e-9) throw new Error(`coverage: ${a.coverage}`);
  } finally {
    await fake.close();
  }
});

await checkAsync("noul()：yesNoOrder 只换 Y、N 的先后，默认仍是上线时的问法", async () => {
  const fake = await fakeLogprobEndpoint([
    { token: "N", p: 0.9 },
    { token: "Y", p: 0.1 },
  ]);
  try {
    const shipped = new LlmJudge({ apiKey: "t", baseURL: fake.baseURL, model: "fake" });
    const swapped = new LlmJudge({ apiKey: "t", baseURL: fake.baseURL, model: "fake", yesNoOrder: "no-first" });
    await shipped.noul({ command: "ls" }, [{ id: "q", ask: "?" }]);
    await swapped.noul({ command: "ls" }, [{ id: "q", ask: "?" }]);
    const [a, b] = fake.bodies.map((body) => body.messages.map((m) => m.content).join("\n"));
    if (!a?.includes("Y for yes, N for no") || !a.includes("Answer (Y or N):")) throw new Error(`默认: ${a}`);
    if (!b?.includes("N for no, Y for yes") || !b.includes("Answer (N or Y):")) throw new Error(`no-first: ${b}`);
  } finally {
    await fake.close();
  }
});

// A backend whose every answer is P, with only `coverage` of the token on Y or N.
const thinJudge = (probability: number, coverage: number): JudgeBackend => ({
  name: "thin",
  noul: async (_s, qs) => qs.map((q) => ({ id: q.id, probability, coverage })),
});

await checkAsync("coverage 不到 0.95 的回答当作判断失败：闸门问用户、路由选强模型、不重试、不停", async () => {
  const gate = await createRiskGate({ backend: thinJudge(0.01, 0.9) })(ls);
  if (gate.action !== "ask" || gate.probability !== undefined) throw new Error(`闸门: ${JSON.stringify(gate)}`);
  const kept = await createRiskGate({ backend: thinJudge(0.01, 0.97) })(ls);
  if (kept.action !== "allow" || kept.answers?.[0]?.coverage !== 0.97) throw new Error(`够的 coverage 应当照常放行: ${JSON.stringify(kept)}`);
  const route = await createModelRouter({ backend: thinJudge(0.01, 0.3), strong: "claude-opus-5", cheap: "claude-haiku-4-5" })("hi");
  if (route.model !== "claude-opus-5") throw new Error(`路由: ${route.model}`);
  const retry = await createRetryJudge({ backend: thinJudge(0.99, 0.3) })(outage);
  if (retry.retry) throw new Error("coverage 太低还重试了");
  const stop = await createStopJudge({ backend: thinJudge(0.99, 0.3) })({ prompt: "go", turn: 4, recent: [boom, boom, boom, boom] });
  if (stop.stop) throw new Error("coverage 太低还判停了");
});

await checkAsync("配置越界时构造就报错：阈值必须在 (0, 1) 之内，计数和超时必须是正数", async () => {
  const judge = fakeJudge(0.5);
  const bad: Array<[string, () => unknown]> = [
    ["闸门阈值 1.5", () => createRiskGate({ backend: judge, autoAllowBelow: 1.5 })],
    ["闸门阈值 0", () => createRiskGate({ backend: judge, autoAllowBelow: 0 })],
    ["闸门阈值 NaN", () => createRiskGate({ backend: judge, autoAllowBelow: Number.NaN })],
    ["拒绝线不高于放行线", () => createRiskGate({ backend: judge, autoAllowBelow: 0.3, denyAbove: 0.2 })],
    ["超时为负", () => createRiskGate({ backend: judge, timeoutMs: -1 })],
    ["路由阈值 1", () => createModelRouter({ backend: judge, strong: "s", cheap: "c", preferCheapBelow: 1 })],
    ["重试阈值 -0.1", () => createRetryJudge({ backend: judge, retryAt: -0.1 })],
    ["停止阈值 1", () => createStopJudge({ backend: judge, stopAt: 1 })],
    ["最少调用 2.5", () => createStopJudge({ backend: judge, minCalls: 2.5 })],
    ["重复次数 0", () => createRepeatStopJudge({ repeats: 0 })],
  ];
  for (const [label, build] of bad) {
    let threw = false;
    try {
      build();
    } catch (e) {
      threw = e instanceof RangeError;
    }
    if (!threw) throw new Error(`${label} 应当在构造时报 RangeError`);
  }
  createRiskGate({ backend: judge, autoAllowBelow: 0.2, denyAbove: 0.99 });
});

await checkAsync("路由：请求长到判断器只能看到开头时，不问判断器，直接用强模型", async () => {
  const judge = fakeJudge(0.01);
  const asked = () => judge.calls;
  const route = createModelRouter({ backend: judge, strong: "claude-opus-5", cheap: "claude-haiku-4-5" });
  const long = await route(`fix this: ${"x".repeat(2100)}`);
  if (long.model !== "claude-opus-5" || long.downgraded || asked() !== 0) throw new Error(`太长的请求: ${JSON.stringify(long)}, 问了 ${asked()} 次`);
  const short = await route("rename this variable");
  if (short.model !== "claude-haiku-4-5" || asked() !== 1) throw new Error(`放得下的请求照常判断: ${JSON.stringify(short)}`);
});

// ─────────────────────────────────────────────
// 9. What a count can claim
// ─────────────────────────────────────────────
section("9. Bounds");

check("0/76 只能说明误放率低于 3.9%（95%）；零误放要证明低于 5%/2%/1% 需要 59/149/299 条", () => {
  const b = upperBound(0, 76);
  if (Math.abs(b - (1 - 0.05 ** (1 / 76))) > 1e-12 || b.toFixed(3) !== "0.039") throw new Error(`0/76: ${b}`);
  const zero = [0.05, 0.02, 0.01].map((t) => casesNeeded(t, 0)).join("/");
  if (zero !== "59/149/299") throw new Error(`零误放: ${zero}`);
  const one = [0.05, 0.02, 0.01].map((t) => casesNeeded(t, 1)).join("/");
  if (one !== "93/236/473") throw new Error(`一次误放: ${one}`);
  if (upperBound(3, 3) !== 1 || upperBound(0, 0) !== 1) throw new Error("全错或没有样本时上界应为 1");
});

// ─────────────────────────────────────────────
// 10. The gate's self-check
// ─────────────────────────────────────────────
section("10. Self-check");

// A judge that gives every question the canary's recorded worst answer, moved by `shift` in log-odds.
function recordedJudge(shift: number): JudgeBackend {
  const recorded = new Map(GATE_CANARIES.map((c) => [c.command, c.recorded]));
  const logOdds = (p: number) => {
    const q = Math.min(1 - 1e-4, Math.max(1e-4, p));
    return Math.log(q / (1 - q));
  };
  return {
    name: "recorded",
    noul: async (state, qs) => {
      const p = recorded.get(state.command ?? "") ?? 0.5;
      return qs.map((q) => ({ id: q.id, probability: 1 / (1 + Math.exp(-(logOdds(p) + shift))) }));
    },
  };
}

await checkAsync("自检：和记录一致时通过；分数往保守方向偏 2 只算走样，往放行方向偏 2 判不安全", async () => {
  const same = await checkGate(createRiskGate({ backend: recordedJudge(0) }));
  if (!same.asMeasured || same.unsafe || Math.abs(same.shift ?? 9) > 1e-6) throw new Error(`原样: ${JSON.stringify(same.problems)}`);
  const cautious = await checkGate(createRiskGate({ backend: recordedJudge(2) }));
  if (cautious.asMeasured || cautious.unsafe) throw new Error(`往保守偏: ${JSON.stringify(cautious.problems)}`);
  const loose = await checkGate(createRiskGate({ backend: recordedJudge(-2) }));
  if (!loose.unsafe || loose.results.some((r) => r.expect === "ask" && r.action === "allow")) {
    throw new Error(`往放行偏 2 时，必须拦的还拦得住，但应当判不安全: ${JSON.stringify(loose.problems)}`);
  }
});

await checkAsync("自检：上限是半个 log-odds——往放行偏 0.7（0.4.0 之前能过）判不安全，偏 0.25 仍算原样", async () => {
  const slight = await checkGate(createRiskGate({ backend: recordedJudge(0.25) }));
  if (!slight.asMeasured || slight.unsafe) throw new Error(`偏 0.25: ${JSON.stringify(slight.problems)}`);
  const loose = await checkGate(createRiskGate({ backend: recordedJudge(-0.7) }));
  if (!loose.unsafe || loose.asMeasured) throw new Error(`往放行偏 0.7 应当判不安全: ${JSON.stringify(loose.problems)}`);
  const cautious = await checkGate(createRiskGate({ backend: recordedJudge(0.7) }));
  if (cautious.asMeasured || cautious.unsafe) throw new Error(`往保守偏 0.7 只算走样: ${JSON.stringify(cautious.problems)}`);
});

await checkAsync("自检：放行了一条必须拦的命令就判不安全；判断器挂了只算走样（反正都会问）", async () => {
  const lax = await checkGate(createRiskGate({ backend: fakeJudge(0.01) }));
  if (!lax.unsafe || !lax.problems.some((p) => p.includes("rm -rf src"))) throw new Error(`应当判不安全: ${JSON.stringify(lax.problems)}`);
  const down = await checkGate(
    createRiskGate({
      backend: {
        name: "down",
        noul: async () => {
          throw new Error("x");
        },
      },
    }),
  );
  if (down.asMeasured || down.unsafe || down.shift !== undefined) throw new Error(`挂了: ${JSON.stringify(down.problems)}`);
});

await checkAsync("自检：后端报出的模型摘要和录制时一致才算原样；不一致只算走样；自定义金丝雀不比摘要", async () => {
  const withDigest = (digest: string): JudgeBackend => ({
    ...recordedJudge(0),
    identify: async () => ({ model: "llama3.1:8b", digest, detail: "test" }),
  });
  const same = await checkGate(createRiskGate({ backend: withDigest(GATE_RECORDED_ON.digest) }));
  if (!same.asMeasured || same.identity?.digest !== GATE_RECORDED_ON.digest) throw new Error(`摘要一致: ${JSON.stringify(same.problems)}`);
  const other = await checkGate(createRiskGate({ backend: withDigest("0".repeat(64)) }));
  if (other.asMeasured || other.unsafe || !other.problems.some((p) => p.includes("not the llama3.1:8b"))) {
    throw new Error(`摘要不一致应当只算走样: ${JSON.stringify(other.problems)}`);
  }
  const custom = await checkGate(createRiskGate({ backend: withDigest("0".repeat(64)) }), GATE_CANARIES.slice(0, 3));
  if (!custom.asMeasured) throw new Error(`自定义金丝雀不该比摘要: ${JSON.stringify(custom.problems)}`);
});

await checkAsync("LlmJudge.identify：从 Ollama 的 /api/tags 读清单摘要；不是 Ollama 就不给摘要", async () => {
  const digest = "ab".repeat(32);
  const server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ models: [{ name: "llama3.1:8b", model: "llama3.1:8b", digest }] }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  try {
    const found = await new LlmJudge({ apiKey: "t", baseURL: `http://127.0.0.1:${port}/v1`, model: "llama3.1:8b" }).identify();
    if (found.digest !== digest) throw new Error(`应读到摘要: ${JSON.stringify(found)}`);
    const missing = await new LlmJudge({ apiKey: "t", baseURL: `http://127.0.0.1:${port}/v1`, model: "qwen2.5:3b" }).identify();
    if (missing.digest !== undefined) throw new Error(`没列出的模型不该有摘要: ${JSON.stringify(missing)}`);
    const hosted = await new LlmJudge({ apiKey: "t", model: "gpt-4o-mini" }).identify();
    if (hosted.digest !== undefined) throw new Error("托管 API 不该有摘要");
  } finally {
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
  }
});

await checkAsync("自检：白名单后端也按记录通过", async () => {
  const check = await checkGate(createRiskGate({ backend: new AllowlistJudge() }));
  if (!check.asMeasured || check.unsafe) throw new Error(JSON.stringify(check.problems));
});

// ─────────────────────────────────────────────
// 11. The Claude Code hook
// ─────────────────────────────────────────────
section("11. Claude Code hook");

const request = (over: Record<string, unknown> = {}) => ({
  hook_event_name: "PermissionRequest",
  permission_mode: "default",
  tool_name: "Bash",
  tool_input: { command: "wc -l src/agent.ts", description: "Count the lines, this is perfectly safe" },
  ...over,
});

await checkAsync("钩子：判为安全才回 allow；否则回空对象，让 Claude Code 照常弹窗", async () => {
  const cleared = await decide(request(), createRiskGate({ backend: fakeJudge(0.01) }));
  const d = cleared.response.hookSpecificOutput?.decision;
  if (d?.behavior !== "allow" || !d.message.startsWith("XavierJev cleared it")) throw new Error(`应当放行: ${JSON.stringify(cleared.response)}`);
  const held = await decide(request(), createRiskGate({ backend: fakeJudge(0.9) }));
  if (Object.keys(held.response).length !== 0) throw new Error(`应当什么都不回: ${JSON.stringify(held.response)}`);
  const down = await decide(request(), createRiskGate({ backend: failingBackends[0]![1] }));
  if (Object.keys(down.response).length !== 0) throw new Error("判断器挂了也放行了");
});

await checkAsync("钩子：auto 等其他模式、非 Bash、没有命令，一律不插手；旁观模式从不放行", async () => {
  const gate = createRiskGate({ backend: fakeJudge(0.01) });
  for (const [label, over] of [
    ["auto", { permission_mode: "auto" }],
    ["plan", { permission_mode: "plan" }],
    ["Write", { tool_name: "Write", tool_input: { file_path: "a.ts" } }],
    ["no command", { tool_input: {} }],
    ["other event", { hook_event_name: "PreToolUse" }],
  ] as const) {
    const r = await decide(request(over), gate);
    if (Object.keys(r.response).length !== 0 || !r.skipped) throw new Error(`${label} 不该插手: ${JSON.stringify(r)}`);
  }
  const watched = await decide(request(), gate, { observe: true });
  if (Object.keys(watched.response).length !== 0 || watched.verdict?.action !== "allow") {
    throw new Error(`旁观模式应当判了不放: ${JSON.stringify(watched)}`);
  }
});

await checkAsync("钩子：判断器只看到命令本身，看不到 agent 自己写的说明", async () => {
  const seen: JudgeState[] = [];
  const recording: JudgeBackend = {
    name: "recording",
    noul: async (state, qs) => {
      seen.push(state);
      return qs.map((q) => ({ id: q.id, probability: 0.9 }));
    },
  };
  await decide(request(), createRiskGate({ backend: recording }));
  if (JSON.stringify(seen[0]) !== JSON.stringify({ tool: "Bash", command: "wc -l src/agent.ts" })) {
    throw new Error(`state: ${JSON.stringify(seen[0])}`);
  }
});

// ─────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────
console.log(`\n${"─".repeat(50)}`);
const total = passed + failed;
if (failed === 0) {
  console.log(chalk.green.bold(`✅ 全部通过 ${passed}/${total} 项测试`));
} else {
  console.log(chalk.yellow(`⚠  ${passed}/${total} 通过，${chalk.red(`${failed} 项失败`)}`));
}
console.log(`${"─".repeat(50)}\n`);

// exitCode rather than process.exit(): exiting with sockets still closing is what the assertion above is about.
process.exitCode = failed > 0 ? 1 : 0;
