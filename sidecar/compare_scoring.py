"""Whether one forward pass per request may replace one per question: the same rows scored both
ways, beside a float32 reference, against a rule written down before any of them was scored.

    python sidecar/compare_scoring.py --run sidecar/run --rows pool.jsonl --rows val.jsonl ... \\
        [--set-names pool,val,...] [--split pool=names.json] --out comparison.json

A request is one state and the questions the judge was trained on. It is scored

  batched  by `common.margins` on the request's texts, left-padded into one batch: what serve.py
           did until 0.8.0, three times the state for three questions;
  packed   by `common.request_margins`: one sequence, the shared beginning read once and each
           question's tail read against it (`common.packed`, `common.packed_mask`);

and, for scale,

  offline  by `common.margins` over every row's text for one question, sixteen to a batch by
           length: how score.py and train.py's calibration scored rows until 0.8.0, so the
           distance between the numbers a threshold was drawn on and the numbers it was applied to;
  fp32     as `offline`, on the same merged weights upcast to float32 with float32 activations:
           the function the bfloat16 paths approximate (padding costs float32 nothing measurable).

Registered 2026-10-19, before any of the rows was scored by either path. Packed becomes the
default if and only if all four hold:

  1. tokens: for every row and question, the shared part followed by the question's segment is
     the text's own tokenization, ids and positions, and the batched path's unpadded tokens are
     the same ids;
  2. accuracy: against fp32, packed's mean |error| in the margin is at most 1.05 times batched's,
     and its 99th percentile at most 1.10 times;
  3. no gross change: no gate score moves by 1.0 log-odds or more between packed and batched.
     Rounding moves scores by tenths (Round 4 put the offline-to-online drift's 99th percentile
     at 0.155); a mask or a position wrong would move most of them by whole units;
  4. speed: on 2,000-character commands the median request is faster packed than batched.

Reported beside the rule and not ruled on: how far packed and offline each are from batched,
margin by margin and in the gate's log-odds, and the verdicts that change at the judge's
threshold, by set and by label.

Everything written to --out is a count, a rate or a quantile; no command leaves the machine.
"""
import argparse
import json
import math
import os
import statistics
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import torch  # noqa: E402

import common  # noqa: E402

DRIFT = 0.155  # Round 4: offline batch against the live hook, p99 of the gate's log-odds


def read(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def long_command(n, chars=2000):
    """eval:decision-models' long command: a read-only script of the kind agents write, cut at the
    gate's 2,000-character cap, `n` in its first line."""
    body = "\n".join(
        f"rows_{k} = [json.loads(l) for l in open('runs/part{k}.jsonl', encoding='utf-8')]\n"
        f"print({k}, len(rows_{k}), sum(r['hp'] for r in rows_{k}) / max(1, len(rows_{k})))"
        for k in range(14))
    return f"cd planner/run{n} && python - <<'EOF'\n{body}\nEOF"[:chars]


def quantiles(xs):
    s = sorted(xs)
    at = lambda q: s[min(len(s) - 1, int(q * len(s)))]  # noqa: E731
    return {"n": len(s), "mean": sum(s) / len(s), "median": at(0.5), "p95": at(0.95), "p99": at(0.99),
            "p999": at(0.999), "max": s[-1]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--rows", action="append", required=True, help="prepared rows (sidecar/prepare.ts); repeat for several sets")
    ap.add_argument("--set-names", help="comma-separated names for the --rows files; default their file names")
    ap.add_argument("--split", action="append", default=[],
                    help="NAME=FILE: a JSON list giving each row of set NAME a subset name, e.g. dev and test 2 in one file")
    ap.add_argument("--timing", type=int, default=20, help="synthetic commands per length for the speed rule")
    ap.add_argument("--device", default="cuda", help="cpu only to try the script out: the rule is for the GPU it serves on")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    names = a.set_names.split(",") if a.set_names else [os.path.basename(p).rsplit(".", 1)[0] for p in a.rows]
    with open(os.path.join(a.run, "calibration.json"), encoding="utf-8") as f:
        cal = json.load(f)
    questions = list(cal["questions"])
    asks = [cal["questions"][q]["ask"] for q in questions]
    threshold = cal["threshold"]
    tok, model = common.load(cal["model"], os.path.join(a.run, "adapter.pt"), cal.get("rank"), a.device)
    sync = torch.cuda.synchronize if a.device == "cuda" else (lambda: None)
    revision = common.model_revision(cal["model"], model)

    rows, set_of = [], []
    for name, path in zip(names, a.rows):
        got = read(path)
        rows += got
        set_of += [name] * len(got)
    for spec in a.split:
        name, path = spec.split("=", 1)
        with open(path, encoding="utf-8") as f:
            sub = json.load(f)
        idx = [i for i, s in enumerate(set_of) if s == name]
        if len(sub) != len(idx):
            sys.exit(f"--split {name}: {len(sub)} names for {len(idx)} rows")
        for i, s in zip(idx, sub):
            set_of[i] = s
    texts = [[common.prompt(tok, r["state"], ask) for ask in asks] for r in rows]
    print(f"{len(rows)} rows, {len(questions)} questions: {', '.join(questions)}", flush=True)

    # 1. tokens
    mismatched = batch_mismatched = 0
    tokens_read = {"batched": [], "packed": []}  # tokens each path puts through the model per request
    for ts in texts:
        ids, positions, segment, _ = common.packed(tok, ts)
        enc = tok(ts, padding=True, add_special_tokens=False)
        tokens_read["batched"].append(len(ts) * len(enc["input_ids"][0]))
        tokens_read["packed"].append(len(ids))
        for i, t in enumerate(ts):
            own = tok(t, add_special_tokens=False)["input_ids"]
            mine = [k for k, s in enumerate(segment) if s in (0, i + 1)]
            if [ids[k] for k in mine] != own or [positions[k] for k in mine] != list(range(len(own))):
                mismatched += 1
            unpadded = [x for x, m in zip(enc["input_ids"][i], enc["attention_mask"][i]) if m]
            if unpadded != own:
                batch_mismatched += 1
    pairs = len(rows) * len(questions)
    print(f"tokens: {mismatched} of {pairs} segments differ from their text's own tokens; batched: {batch_mismatched}", flush=True)

    # the bfloat16 paths, then fp32 on the same weights
    t0 = time.time()
    batched = [common.margins(tok, model, ts) for ts in texts]
    packed = [common.request_margins(tok, model, ts) for ts in texts]
    by_q = [common.margins(tok, model, [ts[j] for ts in texts]) for j in range(len(questions))]
    offline = [[by_q[j][i] for j in range(len(questions))] for i in range(len(rows))]
    print(f"bfloat16 paths scored in {time.time() - t0:.0f}s", flush=True)

    # 5. speed, on synthetic commands, interleaved so that a drift in the GPU's clock hits both
    timing = {}
    for label, make in (("short", lambda n: f"wc -l src/agent{n}.ts"),
                        ("1000", lambda n: long_command(n, 1000)), ("2000", lambda n: long_command(n))):
        ts_list = [[common.prompt(tok, {"tool": "Bash", "command": make(5000 + n)}, ask) for ask in asks] for n in range(a.timing + 3)]
        ms = {"batched": [], "packed": []}
        for n, ts in enumerate(ts_list):
            for path, fn in (("batched", common.margins), ("packed", common.request_margins)):
                sync()
                s = time.perf_counter()
                fn(tok, model, ts)
                sync()
                if n >= 3:  # the first three warm up
                    ms[path].append((time.perf_counter() - s) * 1000)
        enc = tok(ts_list[0], padding=True, add_special_tokens=False)
        timing[label] = {
            "chars": len(make(5000)),
            "batched_ms": statistics.median(ms["batched"]), "packed_ms": statistics.median(ms["packed"]),
            "batched_tokens": len(enc["input_ids"]) * len(enc["input_ids"][0]),  # rows x padded length
            "packed_tokens": len(common.packed(tok, ts_list[0])[0]),
        }
        print(f"{label}: batched {timing[label]['batched_ms']:.1f} ms ({timing[label]['batched_tokens']} tokens), "
              f"packed {timing[label]['packed_ms']:.1f} ms ({timing[label]['packed_tokens']} tokens)", flush=True)

    model.float()
    # fp32 is scored with padding; on a sample, against each text alone, that should not show
    sample = [t for ts in texts[:40] for t in ts]
    alone = [common.margins(tok, model, [t])[0] for t in sample]
    padded = common.margins(tok, model, sample)
    fp32_padding = max(abs(x - y) for x, y in zip(alone, padded))
    by_q32 = [common.margins(tok, model, [ts[j] for ts in texts]) for j in range(len(questions))]
    fp32 = [[by_q32[j][i] for j in range(len(questions))] for i in range(len(rows))]
    print(f"all paths scored in {time.time() - t0:.0f}s", flush=True)

    def diffs(x, y, sel=None):
        return [abs(x[i][j] - y[i][j]) for i in range(len(rows)) if sel is None or sel(i) for j in range(len(questions))]

    def gate_log_odds(path, i):
        """The gate's worst calibrated answer, in log-odds: taken before the sigmoid, where nothing
        rounds; a row the word list matched is asked whatever the model says."""
        if rows[i].get("secret"):
            return math.inf
        return max(a * m + b for (a, b), m in zip((cal["questions"][q]["platt"] for q in questions), path[i]))

    margins = {
        "packed_vs_batched": quantiles(diffs(packed, batched)),
        "offline_vs_batched": quantiles(diffs(offline, batched)),
        "batched_vs_fp32": quantiles(diffs(batched, fp32)),
        "packed_vs_fp32": quantiles(diffs(packed, fp32)),
        "offline_vs_fp32": quantiles(diffs(offline, fp32)),
        "per_question": {
            q: {k: quantiles([abs(x[i][j] - y[i][j]) for i in range(len(rows))])
                for k, (x, y) in {"packed_vs_batched": (packed, batched), "packed_vs_fp32": (packed, fp32),
                                  "batched_vs_fp32": (batched, fp32)}.items()}
            for j, q in enumerate(questions)
        },
    }
    paths = {"batched": batched, "packed": packed, "offline": offline, "fp32": fp32}
    log_odds = {p: [gate_log_odds(v, i) for i in range(len(rows))] for p, v in paths.items()}
    line = math.log(threshold / (1 - threshold))  # the gate clears below the threshold
    cleared = {p: [lo < line for lo in v] for p, v in log_odds.items()}

    def flips(p):
        changed = [i for i in range(len(rows)) if cleared[p][i] != cleared["batched"][i]]
        return {
            "rows": len(changed),
            "now_cleared": sum(cleared[p][i] for i in changed),
            "unsafe_now_cleared": sum(cleared[p][i] and rows[i].get("unsafe") == 1 for i in changed),
            "beyond_drift": sum(abs(log_odds[p][i] - log_odds["batched"][i]) > DRIFT for i in changed),
            "largest_log_odds_change": max((abs(log_odds[p][i] - log_odds["batched"][i]) for i in changed), default=0.0),
        }

    def counts(p, name):
        idx = [i for i in range(len(rows)) if set_of[i] == name and rows[i].get("unsafe") in (0, 1)]
        return {"rows": len(idx), "unsafe": sum(rows[i]["unsafe"] for i in idx),
                "safe_cleared": sum(rows[i]["unsafe"] == 0 and cleared[p][i] for i in idx),
                "unsafe_let_through": sum(rows[i]["unsafe"] == 1 and cleared[p][i] for i in idx)}

    verdicts = {
        "threshold": threshold,
        "packed": flips("packed"),
        "offline": flips("offline"),
        "fp32": flips("fp32"),
        "gate_log_odds": {p: quantiles([abs(log_odds[p][i] - log_odds["batched"][i]) for i in range(len(rows)) if not rows[i].get("secret")])
                          for p in ("packed", "offline", "fp32")},
        "per_set": {name: {p: counts(p, name) for p in paths} for name in dict.fromkeys(set_of)},
    }

    rule = {
        "1_tokens": mismatched == 0 and batch_mismatched == 0,
        "2_accuracy": margins["packed_vs_fp32"]["mean"] <= 1.05 * margins["batched_vs_fp32"]["mean"]
        and margins["packed_vs_fp32"]["p99"] <= 1.10 * margins["batched_vs_fp32"]["p99"],
        "3_no_gross_change": verdicts["gate_log_odds"]["packed"]["max"] < 1.0,
        "4_speed": timing["2000"]["packed_ms"] < timing["2000"]["batched_ms"],
    }
    out = {
        "registered": "2026-10-19, in this file's docstring, before any row was scored",
        "judge": {"model": cal["model"], "revision": revision, "threshold": threshold,
                  "digest": common.digest(cal["model"], revision, os.path.join(a.run, "adapter.pt"), os.path.join(a.run, "calibration.json"))},
        "environment": {"torch": torch.__version__, "cuda": torch.version.cuda,
                        "transformers": __import__("transformers").__version__, "gpu": torch.cuda.get_device_name(0) if a.device == "cuda" else a.device,
                        "attention": model.config._attn_implementation,
                        "tf32_matmul": torch.backends.cuda.matmul.allow_tf32},
        "sets": {name: set_of.count(name) for name in dict.fromkeys(set_of)},
        "tokens": {"pairs": pairs, "segments_differing": mismatched, "batched_differing": batch_mismatched,
                   "per_request": {p: quantiles(v) for p, v in tokens_read.items()}},
        "fp32_padding_max_difference": fp32_padding,
        "margins": margins,
        "verdicts": verdicts,
        "timing": timing,
        "rule": rule,
        "adopt": all(rule.values()),
    }
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
    for k, v in rule.items():
        print(f"  {k}: {'holds' if v else 'FAILS'}")
    print(f"packed {'becomes' if out['adopt'] else 'does not become'} the default -> {a.out}")


if __name__ == "__main__":
    main()
