/**
 * The README's first figure: three measurements, one panel each.
 *
 *   npm run figures        # writes docs/at-a-glance.svg
 *
 * - Where a gate decision's time goes: `eval:latency`, 2026-09-24. Those
 *   numbers need a second Ollama started with OLLAMA_NUM_PARALLEL=4 to
 *   measure, so they are copied here from docs/measurements.md rather than
 *   read from a file; re-run the eval and update them if the setup changes.
 * - What naming N before Y does: every answer from `eval:order --json`,
 *   read from docs/data/order.json.
 * - What a count of zero can claim: exact binomial bounds from eval/stats.ts.
 *
 * Colours: the repository's chart surface and ink, and three series hues
 * that pass the palette checks on that surface (lightness band, chroma,
 * colour-blind and normal-vision separation, contrast).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { upperBound } from "../stats.js";

const INK = { primary: "#ecedee", secondary: "#9096a0", muted: "#5b616b", grid: "#1e2127", rule: "#2a2e36" };
const SURFACE = "#0f1013";
const BLUE = "#3987e5";
const ORANGE = "#d95926";

const W = 1020;
const H = 340;
const parts: string[] = [];
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Every label goes through here, escaped: a "<" in one is otherwise the start of a tag. */
const text = (x: number, y: number, s: string, fill = INK.secondary, extra = "") =>
  parts.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${fill}" ${extra}>${esc(s)}</text>`);

/** A bar anchored at x, square at the baseline and rounded 4px at its data end. */
function bar(x: number, y: number, w: number, h: number, fill: string) {
  const r = Math.min(4, w / 2, h / 2);
  parts.push(
    `<path d="M${x},${y}h${(w - r).toFixed(1)}a${r},${r} 0 0 1 ${r},${r}v${(h - 2 * r).toFixed(1)}a${r},${r} 0 0 1 -${r},${r}h-${(w - r).toFixed(1)}z" fill="${fill}"/>`,
  );
}

function panelTitle(x: number, title: string, subtitle: string) {
  text(x, 34, title, INK.primary, 'font-size="13"');
  text(x, 52, subtitle);
}

// ─── Panel 1: where a gate decision's time goes (ms) ───
{
  const x0 = 24;
  const width = 292;
  panelTitle(x0, "Where a gate decision's time goes", "ms · llama3.1:8b on Ollama · RTX 5080");
  const rows = [
    { label: "one question", installed: 27, slots: 27 },
    { label: "four at once, short command", installed: 89, slots: 107 },
    { label: "four at once, 2,000 characters", installed: 278, slots: 867 },
  ];
  const max = 900;
  const plotW = width - 44;
  const scale = (ms: number) => Math.max(3, (ms / max) * plotW);
  rows.forEach((r, i) => {
    const y = 88 + i * 70;
    text(x0, y, r.label);
    bar(x0, y + 10, scale(r.installed), 12, BLUE);
    text(x0 + scale(r.installed) + 6, y + 20, String(r.installed), INK.primary);
    bar(x0, y + 24, scale(r.slots), 12, ORANGE);
    text(x0 + scale(r.slots) + 6, y + 34, String(r.slots), INK.primary);
  });
  parts.push(`<line x1="${x0}" x2="${x0}" y1="92" y2="268" stroke="${INK.rule}"/>`);
  const ly = 300;
  bar(x0, ly - 8, 12, 9, BLUE);
  text(x0 + 18, ly, "as installed");
  bar(x0 + 120, ly - 8, 12, 9, ORANGE);
  text(x0 + 138, ly, "4 parallel slots");
  text(x0, 324, "four slots read the same command four times", INK.muted);
}

// ─── Panel 2: naming N before Y ───
{
  const data = JSON.parse(readFileSync(new URL("../../docs/data/order.json", import.meta.url), "utf8")) as {
    cases: Array<{ label: "safe" | "unsafe"; shipped: number[]; swapped: number[] }>;
  };
  const x0 = 364;
  panelTitle(x0, "Only “Y or N” became “N or Y”", "the gate's worst answer, 83 dev-set commands");
  const left = x0 + 30;
  const right = x0 + 286;
  const top = 72;
  const bottom = 276;
  const lo = Math.log(0.005 / 0.995);
  const hi = -lo;
  const logit = (p: number) => {
    const q = Math.min(0.995, Math.max(0.005, p));
    return Math.log(q / (1 - q));
  };
  const px = (p: number) => left + ((logit(p) - lo) / (hi - lo)) * (right - left);
  const py = (p: number) => bottom - ((logit(p) - lo) / (hi - lo)) * (bottom - top);
  for (const t of [0.01, 0.2, 0.5, 0.99]) {
    parts.push(`<line x1="${px(t)}" x2="${px(t)}" y1="${top}" y2="${bottom}" stroke="${INK.grid}"/>`);
    parts.push(`<line x1="${left}" x2="${right}" y1="${py(t)}" y2="${py(t)}" stroke="${INK.grid}"/>`);
    text(px(t), bottom + 14, String(t), INK.secondary, 'text-anchor="middle"');
    text(left - 6, py(t) + 4, String(t), INK.secondary, 'text-anchor="end"');
  }
  parts.push(`<line x1="${px(0.005)}" y1="${py(0.005)}" x2="${px(0.995)}" y2="${py(0.995)}" stroke="${INK.rule}"/>`);
  parts.push(`<line x1="${px(0.2)}" x2="${px(0.2)}" y1="${top}" y2="${bottom}" stroke="${INK.secondary}" stroke-dasharray="4 3"/>`);
  parts.push(`<line x1="${left}" x2="${right}" y1="${py(0.2)}" y2="${py(0.2)}" stroke="${INK.secondary}" stroke-dasharray="4 3"/>`);
  let flipped = 0;
  const points = data.cases.map((c) => ({ label: c.label, a: Math.max(...c.shipped), b: Math.max(...c.swapped) }));
  // Unsafe first, so the safe ones — the ones that move — draw on top.
  for (const p of [...points.filter((q) => q.label === "unsafe"), ...points.filter((q) => q.label === "safe")]) {
    if (p.a < 0.2 && p.b >= 0.2) flipped++;
    parts.push(
      `<circle cx="${px(p.a).toFixed(1)}" cy="${py(p.b).toFixed(1)}" r="4.5" fill="${p.label === "safe" ? BLUE : ORANGE}" stroke="${SURFACE}" stroke-width="1.5"/>`,
    );
  }
  text(left + 4, top + 12, `${flipped} cleared as shipped,`, INK.primary);
  text(left + 4, top + 26, "asked when swapped", INK.primary);
  text((left + right) / 2, bottom + 30, "as shipped →", INK.secondary, 'text-anchor="middle"');
  text(left - 6, top - 8, "swapped ↑", INK.secondary, 'text-anchor="start"');
  const ly = 324;
  parts.push(`<circle cx="${left + 4}" cy="${ly - 4}" r="4.5" fill="${BLUE}"/>`);
  text(left + 14, ly, "labelled safe");
  parts.push(`<circle cx="${left + 124}" cy="${ly - 4}" r="4.5" fill="${ORANGE}"/>`);
  text(left + 134, ly, "labelled unsafe");
}

// ─── Panel 3: what a count of zero can claim ───
{
  const x0 = 704;
  panelTitle(x0, "Zero is a count, not a rate", "95% bound on the false-allow rate, zero seen");
  const left = x0 + 34;
  const right = x0 + 288;
  const top = 72;
  const bottom = 276;
  const nMin = 20;
  const nMax = 320;
  const yMax = 0.15;
  const px = (n: number) => left + ((n - nMin) / (nMax - nMin)) * (right - left);
  const py = (r: number) => bottom - (r / yMax) * (bottom - top);
  for (const r of [0, 0.05, 0.1, 0.15]) {
    parts.push(`<line x1="${left}" x2="${right}" y1="${py(r)}" y2="${py(r)}" stroke="${INK.grid}"/>`);
    text(left - 6, py(r) + 4, `${Math.round(r * 100)}%`, INK.secondary, 'text-anchor="end"');
  }
  for (const n of [50, 100, 200, 300]) text(px(n), bottom + 14, String(n), INK.secondary, 'text-anchor="middle"');
  const pts: string[] = [];
  for (let n = nMin; n <= nMax; n += 2) pts.push(`${px(n).toFixed(1)},${py(upperBound(0, n)).toFixed(1)}`);
  parts.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${BLUE}" stroke-width="2"/>`);
  const marks = [
    { n: 76, note: "76 · test 3 today", anchor: "start" },
    { n: 149, note: "149", anchor: "start" },
    { n: 299, note: "299", anchor: "end" },
  ];
  for (const m of marks) {
    const r = upperBound(0, m.n);
    parts.push(`<circle cx="${px(m.n)}" cy="${py(r)}" r="4.5" fill="${BLUE}" stroke="${SURFACE}" stroke-width="2"/>`);
    const dx = m.anchor === "end" ? -2 : 8;
    text(px(m.n) + dx, py(r) - 10, `${m.note} → ${(r * 100).toFixed(1)}%`, INK.primary, `text-anchor="${m.anchor}"`);
  }
  text((left + right) / 2, bottom + 30, "unsafe commands tested →", INK.secondary, 'text-anchor="middle"');
  text(x0, 324, "claiming <1% takes 299 with none let through", INK.muted);
}

const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="11" role="img" aria-labelledby="t d">`,
  `<title id="t">XavierJev at a glance</title>`,
  `<desc id="d">Three panels. Latency of one gate decision: 27 ms for one question; four questions at once take 89 ms as installed and 107 ms with four parallel slots on a short command, 278 and 867 ms on a 2,000-character one. Naming N before Y moves the gate's worst answer up for all 83 dev-set commands, and 36 safe commands go from cleared to asked. With no false allow, the 95% upper bound on the false-allow rate is 3.9% after 76 unsafe commands, 2% after 149 and 1% after 299.</desc>`,
  `<rect width="${W}" height="${H}" rx="10" fill="${SURFACE}"/>`,
  ...parts,
  "</svg>",
].join("\n");
writeFileSync(new URL("../../docs/at-a-glance.svg", import.meta.url), `${svg}\n`);
console.log("wrote docs/at-a-glance.svg");
