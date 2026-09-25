"""Score eval/jevbench/run.ts's records with JevBench's own scoring code.

    python eval/jevbench/score.py --dir path/to/jevbench --results runs/jevbench.jsonl [--json out.json]

Imports `jevbench.tasks`, `jevbench.scoring` and `jevbench.summarize` from the
checkout given, so the grading is JevBench's, not a re-implementation. Per
tier: accuracy, accuracy above chance (JevBench's intelligence axis before its
tier weights), top-label ECE over 10 bins, Brier, and the calibration axis as
JevBench defines it from ECE, 100 * (1 - ECE / 0.5), without the gold-probability
term the hard tier adds. The leaderboard's composite also needs the sealed set,
which is not public, so no composite is computed here.
"""
import argparse
import json
import sys

ap = argparse.ArgumentParser()
ap.add_argument("--dir", required=True)
ap.add_argument("--results", required=True)
ap.add_argument("--json")
args = ap.parse_args()
sys.path.insert(0, args.dir)

from jevbench.scoring import score_task  # noqa: E402
from jevbench.summarize import summarize  # noqa: E402
from jevbench.tasks import load_jsonl  # noqa: E402

with open(args.results, encoding="utf-8") as fh:
    records = {r["task_id"]: r for r in (json.loads(line) for line in fh if line.strip())}

out = {}
print(f"{'tier':9} {'n':>4} {'acc':>6} {'above chance':>13} {'ECE':>6} {'calib':>6} {'Brier':>6} {'min cov':>8}")
for tier in ("easy", "original", "hard"):
    tasks = load_jsonl(f"{args.dir}/datasets/public/{tier}.jsonl")
    rows = []
    for task in tasks:
        record = records.get(task.id)
        if record is None:
            continue
        row = dict(record)
        if record.get("ok") and record.get("probs"):
            row.update(score_task(record["probs"], task))
        else:
            row.update(valid=False, strict_valid=False, renormalized=False, correct=False, predicted=None)
        rows.append(row)
    if not rows:
        continue
    s = summarize(tasks, rows)
    chance = sum(1 / len(t.labels) for t in tasks) / len(tasks)
    acc = s["accuracy"]
    above = max(0.0, min(100.0, 100 * (acc - chance) / (1 - chance))) if acc is not None else None
    ece = s["ece"]["ece"] if isinstance(s["ece"], dict) else s["ece"]
    calib = max(0.0, 100 * (1 - ece / 0.5)) if ece is not None else None
    covs = [r["coverage"] for r in rows if r.get("coverage") is not None]
    out[tier] = {
        "n": len(rows),
        "accuracy": acc,
        "chance": chance,
        "above_chance": above,
        "ece": ece,
        "calibration_axis": calib,
        "brier": s["brier_mean"],
        "min_coverage": min(covs) if covs else None,
        "latency_p50_s": s["latency"].get("p50_s") if isinstance(s["latency"], dict) else None,
    }
    fmt = lambda v, d=3: "-" if v is None else f"{v:.{d}f}"  # noqa: E731
    print(
        f"{tier:9} {len(rows):>4} {fmt(acc):>6} {fmt(above, 1):>13} {fmt(ece):>6} {fmt(calib, 1):>6} "
        f"{fmt(s['brier_mean']):>6} {fmt(out[tier]['min_coverage']):>8}"
    )

if args.json:
    with open(args.json, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)
        fh.write("\n")
    print(f"written to {args.json}")
