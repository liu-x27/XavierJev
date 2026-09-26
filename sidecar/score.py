"""Score prepared rows with a trained judge, offline, the way serve.py would answer them.

    python sidecar/score.py --run sidecar/run --rows rows.jsonl --out scores.jsonl

Each output line: {"gate": worst calibrated answer or 1 when the word list matched, "answers":
{question: probability}, "unsafe", "secret"} for the matching input row, in order.
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
    a = ap.parse_args()
    with open(os.path.join(a.run, "calibration.json"), encoding="utf-8") as f:
        cal = json.load(f)
    tok, model = common.load(cal["model"], os.path.join(a.run, "adapter.pt"), cal.get("rank"))
    with open(a.rows, encoding="utf-8") as f:
        rows = [json.loads(line) for line in f if line.strip()]
    probs = {}
    for q, spec in cal["questions"].items():
        ms = common.margins(tok, model, [common.prompt(tok, r["state"], spec["ask"]) for r in rows])
        probs[q] = [common.calibrated(m, spec["platt"]) for m in ms]
    with open(a.out, "w", encoding="utf-8") as f:
        for i, r in enumerate(rows):
            answers = {q: probs[q][i] for q in probs}
            gate = 1.0 if r.get("secret") else max(answers.values())
            f.write(json.dumps({"gate": gate, "answers": answers, "unsafe": r.get("unsafe"), "secret": r.get("secret")}) + "\n")
    print(f"{len(rows)} rows scored -> {a.out}")


if __name__ == "__main__":
    main()
