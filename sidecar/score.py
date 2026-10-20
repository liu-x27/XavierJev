"""Score prepared rows with a trained judge, offline, the way serve.py would answer them.

    python sidecar/score.py --run sidecar/run --rows rows.jsonl --out scores.jsonl [--scoring batched|packed]

Each output line: {"gate": worst calibrated answer or 1 when the word list matched, "answers":
{question: probability}, "unsafe", "secret"} for the matching input row, in order.

Rows are scored the way the judge's calibration was. "packed" (calibrations from 0.8.0) puts each
row through as serve.py answers a request — one pass for all its questions — so the numbers here
are the numbers the server gives. "batched" (calibrations before) scores one question at a time,
sixteen rows to a batch, as score.py always did; that differs from serve.py's own batching by
rounding, which Round 4 measured at 0.155 log-odds at the 99th percentile.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--rows", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--scoring", choices=common.SCORINGS, help="default: the way calibration.json was calibrated")
    a = ap.parse_args()
    with open(os.path.join(a.run, "calibration.json"), encoding="utf-8") as f:
        cal = json.load(f)
    scoring = a.scoring or common.scoring_of(cal)
    tok, model = common.load(cal["model"], os.path.join(a.run, "adapter.pt"), cal.get("rank"))
    with open(a.rows, encoding="utf-8") as f:
        rows = [json.loads(line) for line in f if line.strip()]
    questions = list(cal["questions"])
    if scoring == "packed":
        per_row = [common.request_margins(tok, model, [common.prompt(tok, r["state"], cal["questions"][q]["ask"]) for q in questions])
                   for r in rows]
        margins = {q: [m[j] for m in per_row] for j, q in enumerate(questions)}
    else:
        margins = {q: common.margins(tok, model, [common.prompt(tok, r["state"], spec["ask"]) for r in rows])
                   for q, spec in cal["questions"].items()}
    probs = {q: [common.calibrated(m, cal["questions"][q]["platt"]) for m in margins[q]] for q in questions}
    with open(a.out, "w", encoding="utf-8") as f:
        for i, r in enumerate(rows):
            answers = {q: probs[q][i] for q in probs}
            gate = 1.0 if r.get("secret") else max(answers.values())
            f.write(json.dumps({"gate": gate, "answers": answers, "unsafe": r.get("unsafe"), "secret": r.get("secret")}) + "\n")
    print(f"{len(rows)} rows scored {scoring} -> {a.out}")


if __name__ == "__main__":
    main()
