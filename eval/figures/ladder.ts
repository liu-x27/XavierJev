/**
 * The model ladder as one figure: how fast each judge answers the gate's
 * four questions, against how many safe dev-set commands it could clear
 * with no unsafe one let through, and what the self-check said about it.
 *
 *   npm run figures        # also writes docs/ladder.svg, from docs/data/ladder.json
 *
 * The self-check verdict is the marker (filled, ring, orange), named in the
 * legend; each point carries only its model's name, and the README's table
 * under the figure has the rest. Palette as in the at-a-glance figure.
 */
import { readFileSync, writeFileSync } from "node:fs";

const INK = { primary: "#ecedee", secondary: "#9096a0", muted: "#5b616b", grid: "#1e2127" };
const SURFACE = "#0f1013";
const BLUE = "#3987e5";
const ORANGE = "#d95926";

interface Row {
  model: string;
  usable: boolean;
  detail?: string;
  clearable?: number;
  meanMs?: number;
  selfCheck?: { asMeasured: boolean; unsafe: boolean };
}
const data = JSON.parse(readFileSync(new URL("../../docs/data/ladder.json", import.meta.url), "utf8")) as {
  safe: number;
  rows: Row[];
};
const rows = data.rows.filter((r) => r.usable);
const unusable = data.rows.filter((r) => !r.usable);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const W = 640;
const H = 366;
const left = 64;
const right = W - 28;
const top = 92;
const bottom = 262;
const maxMs = Math.ceil(Math.max(...rows.map((r) => r.meanMs!)) / 20) * 20 + 20;
const px = (ms: number) => left + (ms / maxMs) * (right - left);
const py = (n: number) => bottom - (n / data.safe) * (bottom - top);
const parts: string[] = [];
const text = (x: number, y: number, s: string, fill = INK.secondary, extra = "") =>
  parts.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${fill}" ${extra}>${esc(s)}</text>`);

function marker(x: number, y: number, r: Row) {
  if (r.selfCheck?.unsafe) {
    parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="${ORANGE}" stroke="${SURFACE}" stroke-width="2"/>`);
  } else if (r.selfCheck?.asMeasured) {
    parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="${BLUE}" stroke="${SURFACE}" stroke-width="2"/>`);
  } else {
    parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" fill="${SURFACE}" stroke="${BLUE}" stroke-width="2"/>`);
  }
}

text(24, 34, "Smaller judges are barely faster, and bigger is not better", INK.primary, 'font-size="13"');
text(24, 52, "the gate's four questions over its 83-command dev set, one local model each");
text(24, 76, "safe commands cleared with none let through ↑");
for (const n of [0, 10, 20, 30, 41]) {
  parts.push(`<line x1="${left}" x2="${right}" y1="${py(n)}" y2="${py(n)}" stroke="${INK.grid}"/>`);
  text(left - 8, py(n) + 4, String(n), INK.secondary, 'text-anchor="end"');
}
for (let ms = 0; ms <= maxMs; ms += 20) text(px(ms), bottom + 16, String(ms), INK.secondary, 'text-anchor="middle"');
text((left + right) / 2, bottom + 34, "ms for the four questions (mean) →", INK.secondary, 'text-anchor="middle"');

// Names beside the points; one crowding the one above it moves up a line.
const placed = rows
  .map((r) => ({ r, x: px(r.meanMs!), y: py(r.clearable!) }))
  .sort((a, b) => a.x - b.x);
const taken: Array<{ x: number; y: number }> = [];
for (const { r, x, y } of placed) {
  marker(x, y, r);
  let ly = y - 9;
  while (taken.some((t) => Math.abs(t.x - x) < 110 && Math.abs(t.y - ly) < 13)) ly -= 13;
  taken.push({ x, y: ly });
  const end = x > right - 90;
  text(end ? x - 8 : x + 8, ly, r.model, INK.primary, end ? 'text-anchor="end"' : "");
}

const ly = H - 50;
parts.push(`<circle cx="30" cy="${ly - 4}" r="5" fill="${BLUE}"/>`);
text(40, ly, "self-check: as measured");
parts.push(`<circle cx="210" cy="${ly - 4}" r="4.5" fill="${SURFACE}" stroke="${BLUE}" stroke-width="2"/>`);
text(220, ly, "not as measured");
parts.push(`<circle cx="354" cy="${ly - 4}" r="5" fill="${ORANGE}"/>`);
text(364, ly, "unsafe — would clear unsafe commands");
const notes = [
  "cleared is at each model's best threshold, chosen on these same commands: a ceiling, not a result",
  ...unusable.map((r) => `${r.model}: cannot judge (its first token is not Y or N)`),
];
notes.forEach((note, i) => text(24, H - 30 + i * 16, note, INK.muted));

const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="11" role="img" aria-labelledby="t d">`,
  `<title id="t">The gate on judges of different sizes</title>`,
  `<desc id="d">${esc(
    rows
      .map(
        (r) =>
          `${r.model}: ${Math.round(r.meanMs!)} ms, ${r.clearable} of ${data.safe} clearable with none let through, self-check ${r.selfCheck?.unsafe ? "unsafe" : r.selfCheck?.asMeasured ? "as measured" : "not as measured"}`,
      )
      .join("; "),
  )}${unusable.length ? `; ${unusable.map((r) => `${r.model} cannot judge`).join("; ")}` : ""}.</desc>`,
  `<rect width="${W}" height="${H}" rx="10" fill="${SURFACE}"/>`,
  ...parts,
  "</svg>",
].join("\n");
writeFileSync(new URL("../../docs/ladder.svg", import.meta.url), `${svg}\n`);
console.log("wrote docs/ladder.svg");
