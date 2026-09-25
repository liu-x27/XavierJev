/**
 * Record the arena playing live, as docs/snake-arena.gif (or, with
 * CAPTURE_GAME=flappy, docs/flappy-arena.gif).
 *
 * Drive the real arena against a real judge and record what it does. The
 * GIF plays at the rate the frames were captured, so what it shows is the
 * speed the judge actually decided at — not sped up, and not a replay.
 *
 * Needs an Electron binary — not a devDependency, since it is a large
 * download for one script — and ffmpeg on the PATH:
 *
 *   AGENT_JUDGE_BASE_URL=http://127.0.0.1:11434/v1 AGENT_JUDGE_MODEL=llama3.1:8b \
 *     AGENT_JUDGE_API_KEY=ollama npm run arena         # terminal 1
 *   npm run arena:client                               # terminal 2
 *   path/to/electron.exe docs/capture-arena.mjs
 *   CAPTURE_GAME=flappy CAPTURE_BUDGET=60 path/to/electron.exe docs/capture-arena.mjs
 *   CAPTURE_WAIT_GAMES=0 CAPTURE_FROM_SCORE=35 CAPTURE_WAIT_MIN=30 CAPTURE_SECONDS=25 \
 *     CAPTURE_UNTIL_END=1 path/to/electron.exe docs/capture-arena.mjs   # the first game past 35, to its end
 */
import { app, BrowserWindow } from "electron";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// CAPTURE_GAME=flappy records the Flappy tab instead, as docs/flappy-arena.gif.
const GAME = process.env.CAPTURE_GAME === "flappy" ? "flappy" : "snake";
const URL = `http://localhost:5175/${GAME === "flappy" ? "#arena/flappy" : "#arena"}`;
// Flappy's budget, in ms: 60, 30 or 20; the page starts at 30. From a browser
// the budget has to cover the round trip to the server too, not only the judge.
const BUDGET = process.env.CAPTURE_BUDGET;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), `${GAME}-arena.gif`);
// Not the opening seconds, where every game looks weak: this many whole
// games first, so the HUD's mean is over something, then the next game or
// flight from when it passes this score. Whatever game comes next is the
// one recorded; nothing is retried.
const WAIT_GAMES = Number(process.env.CAPTURE_WAIT_GAMES ?? (GAME === "snake" ? 3 : 0));
const FROM_SCORE = Number(process.env.CAPTURE_FROM_SCORE ?? (GAME === "snake" ? 15 : 20));
// How long to wait for such a game (CAPTURE_WAIT_MIN, minutes), and how long to record
// (CAPTURE_SECONDS). With CAPTURE_UNTIL_END=1 the clip stops a moment after the recorded
// game ends, if that comes first — a high threshold may take many games to meet.
const WAIT_LIMIT_MS = Number(process.env.CAPTURE_WAIT_MIN ?? 6) * 60_000;
const RECORD_MS = Number(process.env.CAPTURE_SECONDS ?? 10) * 1000;
const UNTIL_END = process.env.CAPTURE_UNTIL_END === "1";
const WIDTH = 920; // of the GIF, in pixels

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Whole games so far, the running score, and the crash banner if one is up. */
const PROGRESS = `(() => {
  const facts = [...document.querySelectorAll(".hud-facts > div")].map((d) => [d.querySelector("dt").innerText, d.querySelector("dd").innerText]);
  const games = facts.find(([k]) => /^(Games|Flights)/.test(k));
  return {
    games: games ? parseInt(games[1], 10) || 0 : 0,
    score: parseInt(document.querySelectorAll(".hud-kpi b")[2]?.innerText ?? "0", 10) || 0,
    mean: games ? games[1] : "",
    crash: document.querySelector(".board-crash b")?.innerText ?? null,
  };
})()`;

app.whenReady().then(async () => {
  const frames = mkdtempSync(path.join(tmpdir(), "agent-arena-"));
  const win = new BrowserWindow({
    width: 1280,
    height: 940, // the arena and its tab strip, whole
    show: true,
    webPreferences: { backgroundThrottling: false },
  });
  const js = (code) => win.webContents.executeJavaScript(code);

  try {
    await win.loadURL(URL);
    await js(`localStorage.setItem("theme", "instrument"); true`);
    win.webContents.reload();
    await new Promise((r) => win.webContents.once("did-finish-load", r));
    await sleep(1500);

    const judge = await js(`document.querySelector(".arena-judge")?.textContent`);
    if (!judge || judge.includes("no model")) throw new Error("the server has no model judge — set AGENT_JUDGE_*");
    console.log(`judge: ${judge}`);

    if (GAME === "flappy" && BUDGET) {
      const picked = await js(`(() => { const b = [...document.querySelectorAll('[role="radio"]')].find((e) => e.innerText.trim() === "${BUDGET} ms"); b?.click(); return !!b; })()`);
      if (!picked) throw new Error(`no ${BUDGET} ms budget on the page`);
    }
    await js(`document.querySelector('[aria-label="Play"]').click(); true`);
    const waitStarted = Date.now();
    for (;;) {
      const p = await js(PROGRESS);
      if (p.games >= WAIT_GAMES && p.score >= FROM_SCORE && !p.crash) break;
      if (Date.now() - waitStarted > WAIT_LIMIT_MS) throw new Error(`no game past ${FROM_SCORE} after ${WAIT_GAMES} games in time`);
      await sleep(100);
    }
    const before = await js(PROGRESS);
    console.log(`recording from ${Math.round((Date.now() - waitStarted) / 1000)} s in: ${before.games} whole, mean ${before.mean}; this one at ${before.score}`);

    const r = await js(`(() => { const b = document.querySelector(".arena").getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, dpr: devicePixelRatio, view: innerHeight }; })()`);
    if (r.y + r.height > r.view) throw new Error(`the arena runs past the window (${Math.ceil(r.y + r.height)} > ${r.view}); make it taller`);
    // Frames arrive in device pixels; the crop has to be in them too.
    const crop = [r.width, r.height, r.x, r.y].map((v) => Math.round(v * r.dpr)).join(":");

    // Every frame the page paints, rather than capturePage() in a loop: that
    // re-renders on each call and managed about nine a second, which at
    // twenty-odd moves a second skipped two or three moves per frame.
    mkdirSync(frames, { recursive: true });

    // How the recorded game ended, for the caption: watched from the first
    // frame, since it can end inside the clip. A flight can outlast all this.
    const ended = (async () => {
      const endBy = Date.now() + RECORD_MS + 3 * 60_000;
      while (Date.now() < endBy) {
        const p = await js(PROGRESS);
        if (p.crash && p.games > before.games) return `${p.crash}; ${p.games} whole, mean ${p.mean}`;
        await sleep(50);
      }
      return null;
    })();

    let n = 0;
    let last = 0;
    const started = Date.now();
    win.webContents.beginFrameSubscription(false, (image) => {
      const now = Date.now();
      if (now - last < 40) return; // 25 fps is plenty, and keeps the file small
      last = now;
      writeFileSync(path.join(frames, `f${String(n++).padStart(4, "0")}.jpg`), image.toJPEG(95));
    });
    // Until the clip's length, or (CAPTURE_UNTIL_END) until the recorded game has ended and its
    // crash has been on screen a moment.
    await Promise.race([sleep(RECORD_MS), ...(UNTIL_END ? [ended.then((e) => (e ? sleep(1500) : new Promise(() => {})))] : [])]);
    win.webContents.endFrameSubscription();
    const fps = n / ((Date.now() - started) / 1000);
    const hud = await js(`[...document.querySelectorAll(".hud-kpi")].map(e => e.innerText.replace(/\\n/g, " ")).join(" | ")`);
    console.log(`${n} frames at ${fps.toFixed(1)} fps · ${hud}`);

    const end = await ended;
    console.log(end ? `the recorded one ended: ${end}` : "the recorded one had not ended 3 minutes after the clip");

    await js(`document.querySelector('[aria-label="Pause"]')?.click(); localStorage.removeItem("theme"); true`);

    // One palette for the whole clip, so the colours do not flicker frame to frame.
    const scale = `crop=${crop},scale=${WIDTH}:-1:flags=lanczos`;
    const ffmpeg = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel", "error",
        "-framerate", fps.toFixed(2),
        "-i", path.join(frames, "f%04d.jpg"),
        "-vf", `${scale},split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
        OUT,
      ],
      { stdio: "inherit" },
    );
    if (ffmpeg.status !== 0) throw new Error(`ffmpeg exited with ${ffmpeg.status}`);
    console.log(`wrote ${OUT}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    rmSync(frames, { recursive: true, force: true });
    app.quit();
  }
});
