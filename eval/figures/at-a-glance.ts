/**
 * The README's first figure: six measurements, one panel each.
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
// Third series hue, for the one panel that compares two judges: passes the same checks
// beside BLUE and ORANGE on SURFACE, all pairs.
const GREEN = "#1baf7a";

const W = 1020;
const ROW = 340;
const H = 2 * ROW;
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

function panelTitle(x: number, title: string, subtitle: string, oy = 0) {
  text(x, oy + 34, title, INK.primary, 'font-size="13"');
  text(x, oy + 52, subtitle);
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

const trained = JSON.parse(readFileSync(new URL("../../docs/data/trained-judge.json", import.meta.url), "utf8")) as {
  real_traffic_test: { curve_at_matched_let_through_strict: { let_through: number[]; "llama3.1:8b_safe_cleared": number[] } };
  round2: {
    real_traffic_test_second_read: {
      strict: {
        "curve_safe_cleared_at_0_to_5_let_through (test thresholds)": number[];
        "registered (one on validation)": { cleared_safe: string; false_allows: string };
      };
    };
  };
};
const labelled = JSON.parse(readFileSync(new URL("../../docs/data/real-traffic-labelled.json", import.meta.url), "utf8")) as {
  labelled: { read: number; held: number; shouldHaveAsked: { session: number } };
};
const order = JSON.parse(readFileSync(new URL("../../docs/data/option-order.json", import.meta.url), "utf8")) as {
  choice: { tasks: number; firstPositionByOptionCount: Record<string, { tasks: number; firstPicked: number; chance: number }> };
};
const jevbench = JSON.parse(readFileSync(new URL("../../docs/data/jevbench-orderings.json", import.meta.url), "utf8")) as {
  as_listed: { hard: { accuracy: number } };
  averaged_over_orders: { hard: { accuracy: number } };
};

// ─── Panel 4: a judge trained on this machine's commands ───
{
  const oy = ROW;
  const x0 = 24;
  panelTitle(x0, "Trained on this machine's commands", "safe cleared, of 733 · 1,000 held-out ones", oy);
  const lets = trained.real_traffic_test.curve_at_matched_let_through_strict.let_through;
  const prompted = trained.real_traffic_test.curve_at_matched_let_through_strict["llama3.1:8b_safe_cleared"];
  const test = trained.round2.real_traffic_test_second_read.strict;
  const tuned = test["curve_safe_cleared_at_0_to_5_let_through (test thresholds)"];
  const [preset, presetLet] = [Number(test["registered (one on validation)"].cleared_safe.split("/")[0]), Number(test["registered (one on validation)"].false_allows.split("/")[0])];
  const left = x0 + 34;
  const right = x0 + 262;
  const top = oy + 72;
  const bottom = oy + 246;
  const px = (n: number) => left + (n / 5) * (right - left);
  const py = (c: number) => bottom - (c / 733) * (bottom - top);
  for (const c of [0, 200, 400, 600]) {
    parts.push(`<line x1="${left}" x2="${right}" y1="${py(c).toFixed(1)}" y2="${py(c).toFixed(1)}" stroke="${INK.grid}"/>`);
    text(left - 6, py(c) + 4, String(c), INK.secondary, 'text-anchor="end"');
  }
  parts.push(`<line x1="${left}" x2="${right}" y1="${py(733)}" y2="${py(733)}" stroke="${INK.secondary}" stroke-dasharray="4 3"/>`);
  text(left + 2, py(733) - 5, "all 733", INK.secondary);
  for (const n of lets) text(px(n), bottom + 14, String(n), INK.secondary, 'text-anchor="middle"');
  text((left + right) / 2, bottom + 28, "unsafe let through, of 256 →", INK.secondary, 'text-anchor="middle"');
  for (const [series, colour] of [
    [prompted, GREEN],
    [tuned, BLUE],
  ] as const) {
    parts.push(
      `<polyline points="${series.map((c, i) => `${px(lets[i]!).toFixed(1)},${py(c).toFixed(1)}`).join(" ")}" fill="none" stroke="${colour}" stroke-width="2"/>`,
    );
    series.forEach((c, i) =>
      parts.push(`<circle cx="${px(lets[i]!).toFixed(1)}" cy="${py(c).toFixed(1)}" r="4" fill="${colour}" stroke="${SURFACE}" stroke-width="1.5"/>`),
    );
    text(right + 8, py(series.at(-1)!) + 4, String(series.at(-1)), INK.primary);
  }
  // The thresholds each shipped with, set before the test — not the best ones read off it.
  for (const [n, c, colour, note, anchor, dy] of [
    [presetLet, preset, BLUE, `${preset} · set beforehand`, "end", 20],
    [1, 308, GREEN, "308 · the shipped 0.2", "start", 18],
  ] as const) {
    parts.push(`<circle cx="${px(n).toFixed(1)}" cy="${py(c).toFixed(1)}" r="5" fill="none" stroke="${colour}" stroke-width="2"/>`);
    text(px(n) + (anchor === "end" ? 4 : 8), py(c) + dy, note, INK.primary, `text-anchor="${anchor}"`);
  }
  const ly = oy + 300;
  bar(x0, ly - 8, 12, 9, BLUE);
  text(x0 + 18, ly, "Qwen3-0.6B, fine-tuned");
  bar(x0 + 176, ly - 8, 12, 9, GREEN);
  text(x0 + 194, ly, "llama3.1:8b");
  text(x0, oy + 324, "dots: best threshold, read off the test", INK.muted);
}

// ─── Panel 5: every command the gate cleared, read ───
{
  const oy = ROW;
  const x0 = 364;
  const { read, held, shouldHaveAsked } = labelled.labelled;
  panelTitle(x0, "Every command it cleared, read by hand", `llama3.1:8b at 0.2 · ${read.toLocaleString("en-US")} of ${(read + held).toLocaleString("en-US")} cleared`, oy);
  const cols = 48;
  const pitch = 6;
  const left = x0 + 2;
  const top = oy + 76;
  for (let i = 0; i < read; i++) {
    const wrong = i >= read - shouldHaveAsked.session;
    const cx = left + (i % cols) * pitch;
    const cy = top + Math.floor(i / cols) * pitch;
    parts.push(`<rect x="${cx}" y="${cy}" width="5" height="5" rx="1" fill="${wrong ? ORANGE : BLUE}"/>`);
  }
  const rows = Math.ceil(read / cols);
  const endX = left + ((read - 1) % cols) * pitch + 5;
  const endY = top + (rows - 1) * pitch;
  text(endX + 6, endY + 6, `${shouldHaveAsked.session} should have been asked`, INK.primary);
  text(x0, top + rows * pitch + 22, "one square per command", INK.secondary);
  const ly = oy + 300;
  bar(x0, ly - 8, 12, 9, BLUE);
  text(x0 + 18, ly, "fine on reading");
  bar(x0 + 150, ly - 8, 12, 9, ORANGE);
  text(x0 + 168, ly, "should have asked");
  text(x0, oy + 324, "wrong clears ≤ about 1.00% (95%)", INK.muted);
}

// ─── Panel 6: choice() and where the options sit ───
{
  const oy = ROW;
  const x0 = 704;
  panelTitle(x0, "choice() picks what is listed first", `llama3.1:8b · ${order.choice.tasks} JevBench choice tasks`, oy);
  const rows = Object.entries(order.choice.firstPositionByOptionCount);
  const plotW = 232;
  const scale = (p: number) => Math.max(3, p * plotW);
  rows.forEach(([n, r], i) => {
    const y = oy + 86 + i * 46;
    text(x0, y, `${n} options · ${r.tasks} tasks`);
    bar(x0, y + 8, scale(r.firstPicked), 14, BLUE);
    text(x0 + scale(r.firstPicked) + 6, y + 19, `${Math.round(r.firstPicked * 100)}%`, INK.primary);
    const cx = x0 + r.chance * plotW;
    parts.push(`<line x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${y + 4}" y2="${y + 26}" stroke="${INK.primary}" stroke-width="2"/>`);
  });
  parts.push(`<line x1="${x0}" x2="${x0}" y1="${oy + 90}" y2="${oy + 266}" stroke="${INK.rule}"/>`);
  const ly = oy + 300;
  bar(x0, ly - 8, 12, 9, BLUE);
  text(x0 + 18, ly, "first option picked");
  parts.push(`<line x1="${x0 + 176}" x2="${x0 + 176}" y1="${ly - 10}" y2="${ly + 2}" stroke="${INK.primary}" stroke-width="2"/>`);
  text(x0 + 184, ly, "no preference");
  const hard = (a: number) => `${Math.round(a * 100)}%`;
  text(x0, oy + 324, `every order, averaged: hard tier ${hard(jevbench.as_listed.hard.accuracy)} → ${hard(jevbench.averaged_over_orders.hard.accuracy)}`, INK.muted);
}

parts.push(`<line x1="24" x2="${W - 24}" y1="${ROW}" y2="${ROW}" stroke="${INK.rule}"/>`);

const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="11" role="img" aria-labelledby="t d">`,
  `<title id="t">XavierJev at a glance</title>`,
  `<desc id="d">Six panels. Latency of one gate decision: 27 ms for one question; four questions at once take 89 ms as installed and 107 ms with four parallel slots on a short command, 278 and 867 ms on a 2,000-character one. Naming N before Y moves the gate's worst answer up for all 83 dev-set commands, and 36 safe commands go from cleared to asked. With no false allow, the 95% upper bound on the false-allow rate is 3.9% after 76 unsafe commands, 2% after 149 and 1% after 299. On 1,000 held-out commands from this machine, a fine-tuned Qwen3-0.6B clears 476 to 699 of 733 safe commands at 0 to 5 unsafe let through, against 204 to 402 for prompted llama3.1:8b; at thresholds set beforehand, 656 with 4 let through against 308 with 1. Of 4,000 real commands the gate cleared 1,181, every one read by hand, and 6 should have been asked. choice() picks the option listed first 76% of the time with three options, 61% with four, 38% with five and 33% with six, against 33%, 25%, 20% and 17% by chance; averaged over every order, the hard tier of JevBench goes from 36% to 51% right.</desc>`,
  `<rect width="${W}" height="${H}" rx="10" fill="${SURFACE}"/>`,
  ...parts,
  "</svg>",
].join("\n");
writeFileSync(new URL("../../docs/at-a-glance.svg", import.meta.url), `${svg}\n`);
console.log("wrote docs/at-a-glance.svg");
