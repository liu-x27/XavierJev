/**
 * Recent calls from a run, labelled by whether the run is stuck.
 *
 * "Stuck" here means: the calls keep failing the same way, and nothing in
 * them suggests the next one will differ. Six kinds, because they are where a
 * call comparison and a model would differ:
 *
 * - `exact` — the same call, the same failure. Comparing calls finds these.
 * - `variant` — the same failing approach, reworded each time: a path with
 *   and without `./`, `cat` then `head` on a file that is not there, the same
 *   test failure after an edit that changes nothing. Comparing calls does not.
 * - `explore` — many different reads. Progress.
 * - `fixed` — failures, then the fix, then success. Progress.
 * - `polling` — the same command repeated while its output changes. Progress,
 *   and the case most likely to be mistaken for being stuck.
 * - `converging` — a failure that changes each time: 5 failing tests, then 3,
 *   then 1. Progress.
 *
 * Labels are mine, written in one sitting with the judges they score.
 */

export type StopKind = "exact" | "variant" | "explore" | "fixed" | "polling" | "converging";

export interface StopCase {
  name: string;
  kind: StopKind;
  stuck: boolean;
  prompt: string;
  calls: Array<[tool: string, input: Record<string, unknown>, ok: boolean, outcome: string]>;
}

const bash = (command: string) => ({ command });
const read = (file_path: string) => ({ file_path });
const grep = (pattern: string, path = "src") => ({ pattern, path });

const TEST_FAIL = "FAIL src/agent.test.ts ● run › stops at max turns: expected 'max_turns', received 'end_turn'";

export const STOP_CASES: StopCase[] = [
  // ── exact: the same call, the same failure ──────────────────
  {
    name: "npm test, unchanged, three times",
    kind: "exact",
    stuck: true,
    prompt: "Make the tests pass.",
    calls: [
      ["Read", read("src/agent.ts"), true, "import Anthropic from ..."],
      ["Bash", bash("npm test"), false, TEST_FAIL],
      ["Bash", bash("npm test"), false, TEST_FAIL],
      ["Bash", bash("npm test"), false, TEST_FAIL],
    ],
  },
  {
    name: "missing file read four times",
    kind: "exact",
    stuck: true,
    prompt: "Summarise the config.",
    calls: [
      ["Read", read("config/settings.yaml"), false, "File not found: D:/proj/config/settings.yaml"],
      ["Read", read("config/settings.yaml"), false, "File not found: D:/proj/config/settings.yaml"],
      ["Read", read("config/settings.yaml"), false, "File not found: D:/proj/config/settings.yaml"],
      ["Read", read("config/settings.yaml"), false, "File not found: D:/proj/config/settings.yaml"],
    ],
  },
  {
    name: "same failing curl",
    kind: "exact",
    stuck: true,
    prompt: "Check whether the local API is up.",
    calls: [
      ["Bash", bash("curl -s http://localhost:8080/health"), false, "curl: (7) Failed to connect to localhost port 8080: Connection refused"],
      ["Bash", bash("curl -s http://localhost:8080/health"), false, "curl: (7) Failed to connect to localhost port 8080: Connection refused"],
      ["Bash", bash("curl -s http://localhost:8080/health"), false, "curl: (7) Failed to connect to localhost port 8080: Connection refused"],
    ],
  },
  {
    name: "edit whose old_string is not there, repeated",
    kind: "exact",
    stuck: true,
    prompt: "Rename the function load to loadConfig.",
    calls: [
      ["Grep", grep("function load"), true, "src/config.ts:12: export function loadSettings() {"],
      ["Edit", { file_path: "src/config.ts", old_string: "function load(", new_string: "function loadConfig(" }, false, "old_string not found in src/config.ts"],
      ["Edit", { file_path: "src/config.ts", old_string: "function load(", new_string: "function loadConfig(" }, false, "old_string not found in src/config.ts"],
      ["Edit", { file_path: "src/config.ts", old_string: "function load(", new_string: "function loadConfig(" }, false, "old_string not found in src/config.ts"],
    ],
  },
  {
    name: "build, same type error",
    kind: "exact",
    stuck: true,
    prompt: "Fix the build.",
    calls: [
      ["Bash", bash("npx tsc"), false, "src/app.ts(14,7): error TS2322: Type 'string' is not assignable to type 'number'."],
      ["Read", read("src/app.ts"), true, "const port: number = process.env.PORT ..."],
      ["Bash", bash("npx tsc"), false, "src/app.ts(14,7): error TS2322: Type 'string' is not assignable to type 'number'."],
      ["Bash", bash("npx tsc"), false, "src/app.ts(14,7): error TS2322: Type 'string' is not assignable to type 'number'."],
    ],
  },

  // ── variant: the same failing approach, reworded ────────────
  {
    name: "one missing file, four spellings",
    kind: "variant",
    stuck: true,
    prompt: "What does the README say about deployment?",
    calls: [
      ["Read", read("README.MD"), false, "File not found: D:/proj/README.MD"],
      ["Read", read("./README.MD"), false, "File not found: D:/proj/README.MD"],
      ["Bash", bash("cat README.MD"), false, "cat: README.MD: No such file or directory"],
      ["Bash", bash("head -50 README.MD"), false, "head: cannot open 'README.MD' for reading: No such file or directory"],
    ],
  },
  {
    name: "test fails identically after edits that change nothing",
    kind: "variant",
    stuck: true,
    prompt: "Make the tests pass.",
    calls: [
      ["Edit", { file_path: "src/agent.ts", old_string: "turn < max", new_string: "turn <= max" }, true, "Edited src/agent.ts"],
      ["Bash", bash("npm test"), false, TEST_FAIL],
      ["Edit", { file_path: "src/agent.ts", old_string: "turn <= max", new_string: "turn < max" }, true, "Edited src/agent.ts"],
      ["Bash", bash("npm test"), false, TEST_FAIL],
      ["Edit", { file_path: "src/agent.ts", old_string: "turn < max", new_string: "turn <= max" }, true, "Edited src/agent.ts"],
      ["Bash", bash("npm test"), false, TEST_FAIL],
    ],
  },
  {
    name: "install retried with different flags, same error",
    kind: "variant",
    stuck: true,
    prompt: "Install the dependencies.",
    calls: [
      ["Bash", bash("npm install"), false, "npm ERR! gyp ERR! find VS could not find a version of Visual Studio 2017 or newer to use"],
      ["Bash", bash("npm install --force"), false, "npm ERR! gyp ERR! find VS could not find a version of Visual Studio 2017 or newer to use"],
      ["Bash", bash("npm install --legacy-peer-deps"), false, "npm ERR! gyp ERR! find VS could not find a version of Visual Studio 2017 or newer to use"],
      ["Bash", bash("npm ci"), false, "npm ERR! gyp ERR! find VS could not find a version of Visual Studio 2017 or newer to use"],
    ],
  },
  {
    name: "port still refused, different probes",
    kind: "variant",
    stuck: true,
    prompt: "Check whether the local API is up.",
    calls: [
      ["Bash", bash("curl http://localhost:8080/health"), false, "curl: (7) Failed to connect to localhost port 8080: Connection refused"],
      ["Bash", bash("curl http://127.0.0.1:8080/health"), false, "curl: (7) Failed to connect to 127.0.0.1 port 8080: Connection refused"],
      ["Bash", bash("curl -v http://localhost:8080/"), false, "curl: (7) Failed to connect to localhost port 8080: Connection refused"],
      ["WebFetch", { url: "http://localhost:8080/health" }, false, "Fetch failed: TypeError: fetch failed (cause: ECONNREFUSED 127.0.0.1:8080)"],
    ],
  },
  {
    name: "grep for a symbol that does not exist, widening",
    kind: "variant",
    stuck: true,
    prompt: "Where is handleWebhook defined?",
    calls: [
      ["Grep", grep("handleWebhook"), true, "No matches found"],
      ["Grep", grep("handleWebhook", "."), true, "No matches found"],
      ["Grep", grep("handle_webhook", "."), true, "No matches found"],
      ["Bash", bash("grep -rn handleWebhook ."), false, "exit code 1 (no output)"],
      ["Grep", grep("Webhook", "src"), true, "No matches found"],
    ],
  },
  {
    name: "permission denied, different write paths in the same place",
    kind: "variant",
    stuck: true,
    prompt: "Save the report.",
    calls: [
      ["Write", { file_path: "/var/reports/out.md", content: "..." }, false, "Write threw: EACCES: permission denied, open '/var/reports/out.md'"],
      ["Write", { file_path: "/var/reports/report.md", content: "..." }, false, "Write threw: EACCES: permission denied, open '/var/reports/report.md'"],
      ["Bash", bash("echo ... > /var/reports/out.md"), false, "bash: /var/reports/out.md: Permission denied"],
      ["Write", { file_path: "/var/reports/final.md", content: "..." }, false, "Write threw: EACCES: permission denied, open '/var/reports/final.md'"],
    ],
  },
  {
    name: "python module missing, several ways to run it",
    kind: "variant",
    stuck: true,
    prompt: "Run the analysis script.",
    calls: [
      ["Bash", bash("python analyze.py"), false, "ModuleNotFoundError: No module named 'pandas'"],
      ["Bash", bash("python3 analyze.py"), false, "ModuleNotFoundError: No module named 'pandas'"],
      ["Bash", bash("py analyze.py"), false, "ModuleNotFoundError: No module named 'pandas'"],
      ["Bash", bash("python -u analyze.py --verbose"), false, "ModuleNotFoundError: No module named 'pandas'"],
    ],
  },

  // ── explore: many different reads ───────────────────────────
  {
    name: "reading the repo, file by file",
    kind: "explore",
    stuck: false,
    prompt: "Explain how the agent loop works.",
    calls: [
      ["Glob", { pattern: "src/**/*.ts" }, true, "src/agent.ts src/types.ts src/tools/bash.ts ... (24 files)"],
      ["Read", read("src/agent.ts"), true, "export class Agent { ..."],
      ["Read", read("src/types.ts"), true, "export interface AgentConfig { ..."],
      ["Read", read("src/tools/registry.ts"), true, "export class ToolRegistry { ..."],
      ["Read", read("src/permissions/index.ts"), true, "export class PermissionSystem { ..."],
    ],
  },
  {
    name: "a couple of misses while looking around",
    kind: "explore",
    stuck: false,
    prompt: "Find where sessions are saved.",
    calls: [
      ["Grep", grep("sessionDir"), true, "src/session/manager.ts:22: this.dir = dir ?? ..."],
      ["Read", read("src/session/store.ts"), false, "File not found: D:/proj/src/session/store.ts"],
      ["Read", read("src/session/manager.ts"), true, "export class SessionManager { ..."],
      ["Grep", grep("\\.agent-app"), true, "src/session/manager.ts:24: path.join(os.homedir(), '.agent-app', 'sessions')"],
    ],
  },
  {
    name: "searching for TODOs across folders",
    kind: "explore",
    stuck: false,
    prompt: "List the TODO comments.",
    calls: [
      ["Grep", grep("TODO", "src"), true, "src/agent.ts:88: // TODO per-turn routing"],
      ["Grep", grep("TODO", "server"), true, "server/index.ts:40: // TODO resume sessions from the browser"],
      ["Grep", grep("TODO", "client"), true, "No matches found"],
      ["Grep", grep("FIXME", "."), true, "No matches found"],
      ["Grep", grep("XXX", "."), true, "No matches found"],
    ],
  },
  {
    name: "checking tool versions",
    kind: "explore",
    stuck: false,
    prompt: "Which versions of node, npm and git are installed?",
    calls: [
      ["Bash", bash("node --version"), true, "v24.12.0"],
      ["Bash", bash("npm --version"), true, "11.6.2"],
      ["Bash", bash("pnpm --version"), false, "bash: pnpm: command not found"],
      ["Bash", bash("git --version"), true, "git version 2.51.0.windows.1"],
    ],
  },
  {
    name: "reading docs from several URLs, one 404",
    kind: "explore",
    stuck: false,
    prompt: "Summarise the Vite proxy options.",
    calls: [
      ["WebFetch", { url: "https://vite.dev/config/server-options" }, true, "server.proxy: Configure custom proxy rules ..."],
      ["WebFetch", { url: "https://vite.dev/config/server-proxy" }, false, "HTTP 404 Not Found: https://vite.dev/config/server-proxy"],
      ["WebFetch", { url: "https://github.com/http-party/node-http-proxy#options" }, true, "options: target, forward, ws, changeOrigin ..."],
      ["Read", read("client/vite.config.ts"), true, "proxy: { '/api': 'http://127.0.0.1:3001' }"],
    ],
  },

  // ── fixed: failures, then the fix, then success ─────────────
  {
    name: "test fails, fix, test passes",
    kind: "fixed",
    stuck: false,
    prompt: "Make the tests pass.",
    calls: [
      ["Bash", bash("npm test"), false, TEST_FAIL],
      ["Read", read("src/agent.ts"), true, "while (turn < this.config.maxTurns) { ..."],
      ["Edit", { file_path: "src/agent.ts", old_string: "let finalStopReason = \"end_turn\"", new_string: "let finalStopReason = \"max_turns\"" }, true, "Edited src/agent.ts"],
      ["Bash", bash("npm test"), true, "Tests: 56 passed, 56 total"],
    ],
  },
  {
    name: "missing dependency installed, then it runs",
    kind: "fixed",
    stuck: false,
    prompt: "Run the analysis script.",
    calls: [
      ["Bash", bash("python analyze.py"), false, "ModuleNotFoundError: No module named 'pandas'"],
      ["Bash", bash("pip install pandas"), true, "Successfully installed pandas-2.3.2"],
      ["Bash", bash("python analyze.py"), true, "rows: 1204  mean: 3.41"],
    ],
  },
  {
    name: "wrong path corrected",
    kind: "fixed",
    stuck: false,
    prompt: "What does the README say about deployment?",
    calls: [
      ["Read", read("README.MD"), false, "File not found: D:/proj/README.MD"],
      ["Glob", { pattern: "*.md" }, true, "README.md CHANGELOG.md"],
      ["Read", read("README.md"), true, "## Deploying ..."],
    ],
  },
  {
    name: "server started, then the health check answers",
    kind: "fixed",
    stuck: false,
    prompt: "Check whether the local API is up.",
    calls: [
      ["Bash", bash("curl -s http://localhost:8080/health"), false, "curl: (7) Failed to connect to localhost port 8080: Connection refused"],
      ["Bash", bash("npm run server &"), true, "Server listening on 8080"],
      ["Bash", bash("curl -s http://localhost:8080/health"), true, "{\"status\":\"ok\"}"],
    ],
  },

  // ── polling: the same command while its output changes ─────
  {
    name: "waiting for a build to finish",
    kind: "polling",
    stuck: false,
    prompt: "Wait for the CI build and report the result.",
    calls: [
      ["Bash", bash("gh run view 123 --json status"), true, "{\"status\":\"queued\"}"],
      ["Bash", bash("gh run view 123 --json status"), true, "{\"status\":\"in_progress\"}"],
      ["Bash", bash("gh run view 123 --json status"), true, "{\"status\":\"in_progress\"}"],
      ["Bash", bash("gh run view 123 --json status"), true, "{\"status\":\"completed\",\"conclusion\":\"success\"}"],
    ],
  },
  {
    name: "git status between edits",
    kind: "polling",
    stuck: false,
    prompt: "Split the change into two commits.",
    calls: [
      ["Bash", bash("git status --short"), true, " M src/a.ts\n M src/b.ts"],
      ["Bash", bash("git add src/a.ts && git commit -m 'a'"), true, "[main 1a2b3c] a"],
      ["Bash", bash("git status --short"), true, " M src/b.ts"],
      ["Bash", bash("git add src/b.ts && git commit -m 'b'"), true, "[main 4d5e6f] b"],
      ["Bash", bash("git status --short"), true, ""],
    ],
  },
  {
    name: "server not up yet, then up",
    kind: "polling",
    stuck: false,
    prompt: "Start the dev server and confirm it responds.",
    calls: [
      ["Bash", bash("npm run dev &"), true, "starting..."],
      ["Bash", bash("curl -s localhost:5173"), false, "curl: (7) Failed to connect to localhost port 5173: Connection refused"],
      ["Bash", bash("curl -s localhost:5173"), false, "curl: (7) Failed to connect to localhost port 5173: Connection refused"],
      ["Bash", bash("curl -s localhost:5173"), true, "<!DOCTYPE html><html>..."],
    ],
  },

  // ── converging: a failure that changes each time ────────────
  {
    name: "failing tests going down",
    kind: "converging",
    stuck: false,
    prompt: "Make the tests pass.",
    calls: [
      ["Bash", bash("npm test"), false, "Tests: 5 failed, 51 passed, 56 total"],
      ["Edit", { file_path: "src/a.ts", old_string: "x", new_string: "y" }, true, "Edited src/a.ts"],
      ["Bash", bash("npm test"), false, "Tests: 3 failed, 53 passed, 56 total"],
      ["Edit", { file_path: "src/b.ts", old_string: "p", new_string: "q" }, true, "Edited src/b.ts"],
      ["Bash", bash("npm test"), false, "Tests: 1 failed, 55 passed, 56 total"],
    ],
  },
  {
    name: "type errors being fixed one by one",
    kind: "converging",
    stuck: false,
    prompt: "Fix the build.",
    calls: [
      ["Bash", bash("npx tsc"), false, "Found 4 errors in 3 files."],
      ["Edit", { file_path: "src/a.ts", old_string: "string", new_string: "number" }, true, "Edited src/a.ts"],
      ["Bash", bash("npx tsc"), false, "Found 2 errors in 2 files."],
      ["Edit", { file_path: "src/c.ts", old_string: "any", new_string: "unknown" }, true, "Edited src/c.ts"],
      ["Bash", bash("npx tsc"), false, "Found 1 error in src/d.ts:9"],
    ],
  },
  {
    name: "lint warnings shrinking",
    kind: "converging",
    stuck: false,
    prompt: "Clean up the lint warnings.",
    calls: [
      ["Bash", bash("npm run lint"), false, "✖ 12 problems (0 errors, 12 warnings)"],
      ["Bash", bash("npm run lint -- --fix"), false, "✖ 4 problems (0 errors, 4 warnings)"],
      ["Edit", { file_path: "src/x.ts", old_string: "var", new_string: "const" }, true, "Edited src/x.ts"],
      ["Bash", bash("npm run lint"), false, "✖ 2 problems (0 errors, 2 warnings)"],
    ],
  },
];
