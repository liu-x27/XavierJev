/**
 * Record the snake arena playing live, as docs/snake-arena.gif.
 *
 * Same idea as capture-screenshots.mjs: drive the real UI against a real
 * judge and record what it does. The GIF plays at the rate the frames were
 * captured, so what it shows is the speed the judge actually decided at —
 * not sped up, and not a replay.
 *
 * Needs an Electron binary (see capture-screenshots.mjs for why it is not a
 * devDependency) and ffmpeg on the PATH:
 *
 *   AGENT_JUDGE_BASE_URL=http://127.0.0.1:11434/v1 AGENT_JUDGE_MODEL=llama3.1:8b \
 *     AGENT_JUDGE_API_KEY=ollama npm run server        # terminal 1
 *   npm run client                                     # terminal 2
 *   path/to/electron.exe docs/capture-arena.mjs
 */
import { app, BrowserWindow } from "electron";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const URL = "http://localhost:5174/#arena";
const OUT = "D:/CODE/agent-app/docs/snake-arena.gif";
const WARMUP_MS = 4000; // let the latency numbers fill in first
const RECORD_MS = 8000;
const WIDTH = 920; // of the GIF, in pixels

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const frames = mkdtempSync(path.join(tmpdir(), "agent-arena-"));
  const win = new BrowserWindow({
    width: 1280,
    height: 780,
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

    await js(`document.querySelector('[aria-label="Play"]').click(); true`);
    await sleep(WARMUP_MS);

    const r = await js(`(() => { const b = document.querySelector(".arena").getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, dpr: devicePixelRatio }; })()`);
    // Frames arrive in device pixels; the crop has to be in them too.
    const crop = [r.width, r.height, r.x, r.y].map((v) => Math.round(v * r.dpr)).join(":");

    // Every frame the page paints, rather than capturePage() in a loop: that
    // re-renders on each call and managed about nine a second, which at
    // twenty-odd moves a second skipped two or three moves per frame.
    mkdirSync(frames, { recursive: true });
    let n = 0;
    let last = 0;
    const started = Date.now();
    win.webContents.beginFrameSubscription(false, (image) => {
      const now = Date.now();
      if (now - last < 40) return; // 25 fps is plenty, and keeps the file small
      last = now;
      writeFileSync(path.join(frames, `f${String(n++).padStart(4, "0")}.jpg`), image.toJPEG(95));
    });
    await sleep(RECORD_MS);
    win.webContents.endFrameSubscription();
    const fps = n / ((Date.now() - started) / 1000);
    const hud = await js(`[...document.querySelectorAll(".hud-kpi")].map(e => e.innerText.replace(/\\n/g, " ")).join(" | ")`);
    console.log(`${n} frames at ${fps.toFixed(1)} fps · ${hud}`);

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
