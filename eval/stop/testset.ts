/**
 * Held-out runs for the stop judges.
 *
 * Written after the wording and threshold in `src/judge/stop.ts` were chosen
 * on `cases.ts`, and not used to choose anything. Same kinds, new situations.
 * Scored with `npm run eval:stop -- --cases test`.
 *
 * ## Read log
 *
 * Every run against this set is logged here, because a test set read
 * repeatedly becomes a dev set.
 *
 * 1. 2026-09-23, llama3.1:8b, the shipped wording and 0.8 threshold.
 *    Wrong stops / missed stops: repeats 0 / 4, model 0 / 1, either 0 / 0.
 *    The model's one miss is the 3-call run, below its `minCalls` of 4.
 */
import type { StopCase } from "./cases.js";

const bash = (command: string) => ({ command });
const read = (file_path: string) => ({ file_path });

export const STOP_TEST_CASES: StopCase[] = [
  // stuck
  {
    name: "docker build, same missing base image",
    kind: "exact",
    stuck: true,
    prompt: "Build the image.",
    calls: [
      ["Bash", bash("docker build -t app ."), false, "ERROR: failed to solve: node:24-alpinee: not found"],
      ["Bash", bash("docker build -t app ."), false, "ERROR: failed to solve: node:24-alpinee: not found"],
      ["Bash", bash("docker build -t app ."), false, "ERROR: failed to solve: node:24-alpinee: not found"],
      ["Bash", bash("docker build -t app ."), false, "ERROR: failed to solve: node:24-alpinee: not found"],
    ],
  },
  {
    name: "git push rejected, rephrased",
    kind: "variant",
    stuck: true,
    prompt: "Push the branch.",
    calls: [
      ["Bash", bash("git push"), false, "! [rejected] main -> main (fetch first) error: failed to push some refs"],
      ["Bash", bash("git push origin main"), false, "! [rejected] main -> main (fetch first) error: failed to push some refs"],
      ["Bash", bash("git push -u origin main"), false, "! [rejected] main -> main (fetch first) error: failed to push some refs"],
      ["Bash", bash("git push origin HEAD:main"), false, "! [rejected] HEAD -> main (fetch first) error: failed to push some refs"],
    ],
  },
  {
    name: "a JSON file that does not parse, read four ways",
    kind: "variant",
    stuck: true,
    prompt: "What port does the config use?",
    calls: [
      ["Bash", bash("node -e \"require('./config.json')\""), false, "SyntaxError: config.json: Unexpected token } in JSON at position 212"],
      ["Bash", bash("jq .port config.json"), false, "jq: error (at config.json:14): Cannot parse: Expected separator between values"],
      ["Bash", bash("python -c \"import json; json.load(open('config.json'))\""), false, "json.decoder.JSONDecodeError: Expecting ',' delimiter: line 14 column 3"],
      ["Bash", bash("node -p \"JSON.parse(require('fs').readFileSync('config.json','utf8')).port\""), false, "SyntaxError: Unexpected token } in JSON at position 212"],
    ],
  },
  {
    name: "migration keeps failing on the same column",
    kind: "variant",
    stuck: true,
    prompt: "Run the database migrations.",
    calls: [
      ["Bash", bash("npm run migrate"), false, "error: column \"email\" of relation \"users\" already exists"],
      ["Bash", bash("npx knex migrate:latest"), false, "error: column \"email\" of relation \"users\" already exists"],
      ["Bash", bash("npm run migrate -- --verbose"), false, "error: column \"email\" of relation \"users\" already exists"],
      ["Bash", bash("npx knex migrate:up"), false, "error: column \"email\" of relation \"users\" already exists"],
    ],
  },
  {
    name: "the same 403 from an API",
    kind: "exact",
    stuck: true,
    prompt: "Fetch the open issues.",
    calls: [
      ["WebFetch", { url: "https://api.github.com/repos/o/r/issues" }, false, "HTTP 403 Forbidden: https://api.github.com/repos/o/r/issues"],
      ["WebFetch", { url: "https://api.github.com/repos/o/r/issues" }, false, "HTTP 403 Forbidden: https://api.github.com/repos/o/r/issues"],
      ["WebFetch", { url: "https://api.github.com/repos/o/r/issues" }, false, "HTTP 403 Forbidden: https://api.github.com/repos/o/r/issues"],
    ],
  },
  {
    name: "cannot find the tests, several runners",
    kind: "variant",
    stuck: true,
    prompt: "Run the tests.",
    calls: [
      ["Bash", bash("npm test"), false, "Error: no test specified"],
      ["Bash", bash("npx jest"), false, "No tests found, exiting with code 1"],
      ["Bash", bash("npx vitest run"), false, "No test files found, exiting with code 1"],
      ["Bash", bash("npx mocha"), false, "Error: No test files found: \"./test\""],
    ],
  },
  // not stuck
  {
    name: "benchmarks getting faster",
    kind: "converging",
    stuck: false,
    prompt: "Get the benchmark under 100 ms.",
    calls: [
      ["Bash", bash("npm run bench"), false, "p50 240 ms (target 100 ms)"],
      ["Edit", { file_path: "src/hot.ts", old_string: "map", new_string: "for" }, true, "Edited src/hot.ts"],
      ["Bash", bash("npm run bench"), false, "p50 160 ms (target 100 ms)"],
      ["Edit", { file_path: "src/hot.ts", old_string: "JSON.parse", new_string: "cached" }, true, "Edited src/hot.ts"],
      ["Bash", bash("npm run bench"), false, "p50 112 ms (target 100 ms)"],
    ],
  },
  {
    name: "tailing a log while a job runs",
    kind: "polling",
    stuck: false,
    prompt: "Tell me when the import job finishes.",
    calls: [
      ["Bash", bash("tail -1 import.log"), true, "imported 1200/10000 rows"],
      ["Bash", bash("tail -1 import.log"), true, "imported 4800/10000 rows"],
      ["Bash", bash("tail -1 import.log"), true, "imported 8100/10000 rows"],
      ["Bash", bash("tail -1 import.log"), true, "imported 10000/10000 rows — done"],
    ],
  },
  {
    name: "a merge conflict resolved",
    kind: "fixed",
    stuck: false,
    prompt: "Merge main into the branch.",
    calls: [
      ["Bash", bash("git merge main"), false, "CONFLICT (content): Merge conflict in src/app.ts"],
      ["Read", read("src/app.ts"), true, "<<<<<<< HEAD ... >>>>>>> main"],
      ["Edit", { file_path: "src/app.ts", old_string: "<<<<<<< HEAD", new_string: "" }, true, "Edited src/app.ts"],
      ["Bash", bash("git add src/app.ts && git commit --no-edit"), true, "[feature 9f8e7d] Merge branch 'main'"],
    ],
  },
  {
    name: "looking through logs for an error",
    kind: "explore",
    stuck: false,
    prompt: "Why did last night's job fail?",
    calls: [
      ["Glob", { pattern: "logs/*.log" }, true, "logs/2026-09-21.log logs/2026-09-22.log"],
      ["Grep", { pattern: "ERROR", path: "logs/2026-09-22.log" }, true, "03:12 ERROR upload timed out"],
      ["Grep", { pattern: "upload", path: "logs/2026-09-22.log" }, true, "03:10 upload started ... 03:12 ERROR upload timed out"],
      ["Read", read("jobs/upload.ts"), true, "const TIMEOUT = 120_000 ..."],
    ],
  },
  {
    name: "flaky test, passes on the third run",
    kind: "fixed",
    stuck: false,
    prompt: "Confirm the suite passes.",
    calls: [
      ["Bash", bash("npm test"), false, "Tests: 1 failed (timeout in ws.test.ts), 55 passed"],
      ["Bash", bash("npm test"), false, "Tests: 1 failed (timeout in ws.test.ts), 55 passed"],
      ["Bash", bash("npm test"), true, "Tests: 56 passed, 56 total"],
    ],
  },
  {
    name: "coverage climbing",
    kind: "converging",
    stuck: false,
    prompt: "Get coverage to 80%.",
    calls: [
      ["Bash", bash("npm run coverage"), false, "Coverage 61% (threshold 80%)"],
      ["Write", { file_path: "test/a.test.ts", content: "..." }, true, "Wrote test/a.test.ts"],
      ["Bash", bash("npm run coverage"), false, "Coverage 70% (threshold 80%)"],
      ["Write", { file_path: "test/b.test.ts", content: "..." }, true, "Wrote test/b.test.ts"],
      ["Bash", bash("npm run coverage"), false, "Coverage 77% (threshold 80%)"],
    ],
  },
];
