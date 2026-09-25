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

# JevBench weights its tiers easy .14, standard .28, judge .28, hard .30 and
# renormalises over the tiers present; the public "original" tier is the
# standard one's public half, and the judge tier is not public.
WEIGHTS = {"easy": 0.14, "original": 0.28, "hard": 0.30}
present = [t for t in WEIGHTS if t in out and out[t]["above_chance"] is not None]
if present:
    weighted = sum(WEIGHTS[t] * out[t]["above_chance"] for t in present) / sum(WEIGHTS[t] for t in present)
    out["weighted_above_chance"] = weighted
    print(f"\naccuracy above chance, weighted as JevBench weights its tiers (public ones only): {weighted:.1f}")

all_tasks = [t for tier in ("easy", "original", "hard") for t in load_jsonl(f"{args.dir}/datasets/public/{tier}.jsonl")]
all_rows = []
for task in all_tasks:
    record = records.get(task.id)
    if record is None:
        continue
    row = dict(record)
    row.update(score_task(record["probs"], task) if record.get("ok") and record.get("probs") else
               {"valid": False, "strict_valid": False, "renormalized": False, "correct": False, "predicted": None})
    all_rows.append(row)
if all_rows:
    s_all = summarize(all_tasks, all_rows)
    ece_all = s_all["ece"]["ece"] if isinstance(s_all["ece"], dict) else s_all["ece"]
    out["all"] = {"n": len(all_rows), "accuracy": s_all["accuracy"], "ece": ece_all,
                  "calibration_axis": max(0.0, 100 * (1 - ece_all / 0.5)), "brier": s_all["brier_mean"]}
    print(f"all public tasks: {len(all_rows)}, accuracy {s_all['accuracy']:.3f}, ECE {ece_all:.3f}, "
          f"calibration axis {out['all']['calibration_axis']:.1f}, Brier {s_all['brier_mean']:.3f}")

if args.json:
    with open(args.json, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)
        fh.write("\n")
    print(f"written to {args.json}")
