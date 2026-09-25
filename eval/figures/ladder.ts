/**
 * The model ladder as one figure: how fast each judge answers the gate's
 * four questions, against how many safe dev-set commands it could clear
 * with no unsafe one let through, and what the self-check said about it.
 *
 *   npm run figures        # also writes docs/ladder.svg, from docs/data/ladder.json
 *
 * One series of points, each labelled with its model, so there is no legend;
 * the palette is the at-a-glance figure's.
 */
import { readFileSync, writeFileSync } from "node:fs";

const INK = { primary: "#ecedee", secondary: "#9096a0", muted: "#5b616b", grid: "#1e2127" };
const SURFACE = "#0f1013";
const BLUE = "#3987e5";

interface Row {
  model: string;
  usable: boolean;
  clearable?: number;
  meanMs?: number;
  atShipped?: { cleared: number; falseAllows: number };
  selfCheck?: { asMeasured: boolean; unsafe: boolean };
}
const data = JSON.parse(readFileSync(new URL("../../docs/data/ladder.json", import.meta.url), "utf8")) as {
  safe: number;
  rows: Row[];
};
const rows = data.rows.filter((r) => r.usable);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const W = 640;
const H = 344;
const left = 64;
const right = W - 28;
const top = 92;
const bottom = 272;
const maxMs = Math.ceil(Math.max(...rows.map((r) => r.meanMs!)) / 20) * 20 + 20;
const px = (ms: number) => left + (ms / maxMs) * (right - left);
const py = (n: number) => bottom - (n / data.safe) * (bottom - top);
const parts: string[] = [];
const text = (x: number, y: number, s: string, fill = INK.secondary, extra = "") =>
  parts.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${fill}" ${extra}>${esc(s)}</text>`);

text(24, 34, "Smaller judges are barely faster, and much worse", INK.primary, 'font-size="13"');
text(24, 52, "the gate's four questions over its 83-command dev set, one local model each");
for (const n of [0, 10, 20, 30, 41]) {
  parts.push(`<line x1="${left}" x2="${right}" y1="${py(n)}" y2="${py(n)}" stroke="${INK.grid}"/>`);
  text(left - 8, py(n) + 4, String(n), INK.secondary, 'text-anchor="end"');
}
for (let ms = 0; ms <= maxMs; ms += 20) text(px(ms), bottom + 16, String(ms), INK.secondary, 'text-anchor="middle"');
text((left + right) / 2, bottom + 34, "ms for the four questions (mean) →", INK.secondary, 'text-anchor="middle"');
text(24, 76, "safe commands cleared with none let through ↑");

const placed = rows.map((r) => ({ r, x: px(r.meanMs!), y: py(r.clearable!) }));
for (const { r, x, y } of placed) {
  parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="${BLUE}" stroke="${SURFACE}" stroke-width="2"/>`);
  const verdict = r.selfCheck?.unsafe ? "self-check: unsafe" : r.selfCheck?.asMeasured ? "self-check: as measured" : "self-check: not as measured";
  const through = r.atShipped?.falseAllows ?? 0;
  const lines = [r.model, verdict, through ? `0.2 lets ${through} unsafe through` : "0.2 lets none through"];
  // Left of the point when another sits to its right at about the same height, or the edge is close.
  const crowded = placed.some((o) => o.x > x && Math.abs(o.y - y) < 40);
  const end = crowded || x > right - 170;
  const tx = end ? x - 10 : x + 10;
  const anchor = end ? 'text-anchor="end"' : "";
  // Below the point near the top of the plot, above it otherwise.
  const y0 = y - 44 < top ? y + 16 : y - 34;
  lines.forEach((line, i) => text(tx, y0 + i * 13, line, i === 0 ? INK.primary : INK.secondary, anchor));
}
text(24, H - 14, "clearable is at each model's best threshold, chosen on these same commands: a ceiling, not a result", INK.muted);

const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="11" role="img" aria-labelledby="t d">`,
  `<title id="t">The gate on judges of different sizes</title>`,
  `<desc id="d">${esc(rows.map((r) => `${r.model}: ${Math.round(r.meanMs!)} ms, ${r.clearable} of ${data.safe} safe commands clearable with none let through`).join("; "))}.</desc>`,
  `<rect width="${W}" height="${H}" rx="10" fill="${SURFACE}"/>`,
  ...parts,
  "</svg>",
].join("\n");
writeFileSync(new URL("../../docs/ladder.svg", import.meta.url), `${svg}\n`);
console.log("wrote docs/ladder.svg");
