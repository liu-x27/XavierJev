"""Fine-tune a small model to answer the gate's questions, then calibrate it and set its threshold.

    python sidecar/train.py --train train.jsonl --val val.jsonl --out sidecar/run \
        [--extra borrowed.jsonl --extra-weight 0.25] [--model Qwen/Qwen3-0.6B] [--rank 16] [--epochs 2]

Rows come from sidecar/prepare.ts. The model is trained, per (row, question) with a known label,
on the margin logit(Y) - logit(N) at the answer position, with class-balanced BCE per question —
so it stays a judge the LlmJudge prompt can ask, only now its answer is learned. `--extra` rows
(for instance labelled commands from somewhere else) are added at a fixed share of the total
weight.

After training the adapters are merged into the weights, the way serve.py runs them, and only
then is anything calibrated: each question's margin gets a Platt fit on the validation rows, and
the threshold is set on validation too — below the second-lowest gate score among the unsafe
validation rows the word list does not already catch (one let through on validation). Written
to --out: adapter.pt (the adapters, not merged) and calibration.json (questions with their exact
wording and Platt parameters, the threshold and how it was chosen, the base model's revision,
and whether prepare.ts showed the judge scripts, from its .meta.json). The questions are
XavierJev's RISK_QUESTIONS minus reveals-secret, which the word list answers, in the wording
prepare.ts writes beside the rows.

What it was measured to do on one machine's traffic is in docs/measurements.md, "A judge
trained on this machine's traffic"; nothing about another machine's is known.
"""
import argparse
import json
import os
import random
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import torch  # noqa: E402

import common  # noqa: E402


def read(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def platt(z, y):
    zt, yt = torch.tensor(z, dtype=torch.float32), torch.tensor(y, dtype=torch.float32)
    p = torch.tensor([1.0, 0.0], requires_grad=True)
    opt = torch.optim.LBFGS([p], lr=1, max_iter=100, line_search_fn="strong_wolfe")

    def closure():
        opt.zero_grad()
        loss = torch.nn.functional.binary_cross_entropy_with_logits(p[0] * zt + p[1], yt)
        loss.backward()
        return loss

    opt.step(closure)
    return p.detach().tolist()


def threshold_and_counts(gate, scored):
    """The threshold — below the second-lowest gate score among unsafe rows the word list does not
    catch, so one is let through — and what it clears on validation, counted at the value that
    will be saved: the gate clears below the threshold, so a threshold rounded up past that
    score would let a second row through while counts taken before the rounding said one."""
    unsafe = sorted(g for g, r in zip(gate, scored) if r["unsafe"] == 1 and not r["secret"])
    threshold = unsafe[1] if len(unsafe) > 1 else (unsafe[0] if unsafe else 0.05)
    threshold = json.loads(json.dumps(threshold))  # exactly what calibration.json will hold
    safe = [g for g, r in zip(gate, scored) if r["unsafe"] == 0]
    return threshold, {"rows": len(scored), "unsafe": sum(r["unsafe"] for r in scored),
                       "safe_cleared": sum(g < threshold for g in safe),
                       "unsafe_let_through": sum(1 for g in unsafe if g < threshold)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", required=True)
    ap.add_argument("--val", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--questions", help="default: <train>.questions.json, written by prepare.ts")
    ap.add_argument("--extra")
    ap.add_argument("--extra-weight", type=float, default=0.25)
    ap.add_argument("--model", default="Qwen/Qwen3-0.6B")
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--seed", type=int, default=20260926)
    ap.add_argument("--token-budget", type=int, default=8000)
    ap.add_argument("--resume", action="store_true", help="checkpoint every 100 steps to <out>/resume.pt and continue from it")
    a = ap.parse_args()
    random.seed(a.seed)
    torch.manual_seed(a.seed)
    with open(a.questions or a.train[: -len(".jsonl")] + ".questions.json", encoding="utf-8") as f:
        QUESTIONS = json.load(f)  # noqa: N806 — the gate's wording, exactly
    # How prepare.ts built the states: with or without the scripts a command runs. The hook
    # compares it with how the judge is being run.
    metas = []
    for path in (a.train, a.val):
        meta_path = path[: -len(".jsonl")] + ".meta.json"
        if os.path.exists(meta_path):
            with open(meta_path, encoding="utf-8") as f:
                metas.append(json.load(f))
        else:
            metas.append(None)
    if metas[0] and metas[1] and metas[0].get("readScripts") != metas[1].get("readScripts"):
        sys.exit("--train and --val were prepared differently: one with --read-scripts, one without")
    read_scripts = metas[0].get("readScripts") if metas[0] else None
    if read_scripts is None:
        print("warning: no <train>.meta.json from prepare.ts, so calibration.json cannot say whether scripts were shown", flush=True)
    os.makedirs(a.out, exist_ok=True)

    from transformers import AutoModelForCausalLM, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(a.model)
    tok.padding_side = "left"
    model = AutoModelForCausalLM.from_pretrained(a.model, dtype=torch.bfloat16).cuda()
    params = common.add_lora(model, a.rank, 2 * a.rank, 0.05)
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.config.use_cache = False

    # (text, question, label, weight) per known label
    def rows_of(data, weight):
        out = []
        for r in data:
            for q, ask in QUESTIONS.items():
                y = r["labels"].get(q)
                if y in (0, 1):
                    out.append([common.prompt(tok, r["state"], ask), q, y, weight])
        return out

    rows = rows_of(read(a.train), 1.0)
    n_main = len(rows)
    if a.extra:
        extra = rows_of(read(a.extra), 1.0)
        w = a.extra_weight * n_main / max(1, len(extra))
        for r in extra:
            r[3] = w
        rows += extra
    for q in QUESTIONS:  # balance each question's classes
        idx = [i for i, r in enumerate(rows) if r[1] == q]
        wp = sum(rows[i][3] for i in idx if rows[i][2] == 1)
        wn = sum(rows[i][3] for i in idx if rows[i][2] == 0)
        for i in idx:
            rows[i][3] *= 0.5 * (wp + wn) / (wp if rows[i][2] else wn) if (wp and wn) else 1.0
    lens = [len(tok(r[0], add_special_tokens=False)["input_ids"]) for r in rows]
    order = sorted(range(len(rows)), key=lambda i: lens[i])
    batches, cur = [], []
    for i in order:
        if cur and (len(cur) + 1) * lens[i] > a.token_budget:
            batches.append(cur)
            cur = []
        cur.append(i)
    if cur:
        batches.append(cur)
    print(f"{len(rows)} (row, question) pairs, {len(batches)} batches per epoch, {sum(p.numel() for p in params)} trainable", flush=True)

    y_id, n_id = common.yn_ids(tok)
    opt = torch.optim.AdamW(params, lr=a.lr, weight_decay=0.0)
    steps = a.epochs * len(batches)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / 50) * max(0.0, 1 - s / steps))
    model.train()
    t0 = time.time()
    # --resume: every 100 steps the adapters, optimizer, schedule, batch order and random states
    # go to <out>/resume.pt, and a run that was stopped continues from there rather than from the
    # start — on a shared machine a training can be killed to give memory back.
    resume = os.path.join(a.out, "resume.pt")
    start_ep, start_step, carried = 0, 0, 0.0

    def checkpoint(ep, step, total):
        torch.save({"epoch": ep, "step": step, "total": total, "batches": batches,
                    "adapters": {k: v.detach().cpu() for k, v in model.state_dict().items() if k.endswith((".A", ".B"))},
                    "opt": opt.state_dict(), "sched": sched.state_dict(), "py_random": random.getstate(),
                    "torch_random": torch.get_rng_state(), "cuda_random": torch.cuda.get_rng_state_all()}, resume + ".tmp")
        os.replace(resume + ".tmp", resume)

    if a.resume and os.path.exists(resume):
        # CPU: the random states must stay CPU tensors; the adapters and optimizer state are
        # moved to their parameters' device as they load.
        ck = torch.load(resume, map_location="cpu", weights_only=False)
        model.load_state_dict(ck["adapters"], strict=False)
        opt.load_state_dict(ck["opt"])
        sched.load_state_dict(ck["sched"])
        batches = ck["batches"]
        random.setstate(ck["py_random"])
        torch.set_rng_state(ck["torch_random"])
        torch.cuda.set_rng_state_all(ck["cuda_random"])
        start_ep, start_step, carried = ck["epoch"], ck["step"], ck["total"]
        print(f"resumed at epoch {start_ep + 1} step {start_step}", flush=True)
    for ep in range(start_ep, a.epochs):
        mid = ep == start_ep and start_step > 0
        if not mid:
            random.shuffle(batches)
        total = carried if mid else 0.0
        for k, b in enumerate(batches):
            if mid and k < start_step:
                continue
            enc = tok([rows[i][0] for i in b], return_tensors="pt", padding=True, add_special_tokens=False).to("cuda")
            lg = model.lm_head(model.model(**enc).last_hidden_state[:, -1, :]).float()
            m = lg[:, y_id] - lg[:, n_id]
            y = torch.tensor([rows[i][2] for i in b], dtype=torch.float32, device="cuda")
            w = torch.tensor([rows[i][3] for i in b], dtype=torch.float32, device="cuda")
            loss = (w * torch.nn.functional.binary_cross_entropy_with_logits(m, y, reduction="none")).sum() * len(batches) / len(rows)
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            opt.step()
            sched.step()
            total += loss.item()
            if (k + 1) % 200 == 0:
                print(f"  epoch {ep + 1} step {k + 1}/{len(batches)} loss {total / (k + 1):.4f} {time.time() - t0:.0f}s", flush=True)
            if a.resume and (k + 1) % 100 == 0 and k + 1 < len(batches):
                checkpoint(ep, k + 1, total)
        print(f"epoch {ep + 1}: loss {total / len(batches):.4f}, {time.time() - t0:.0f}s", flush=True)
        if a.resume:
            checkpoint(ep + 1, 0, 0.0)

    if a.resume and os.path.exists(resume):
        os.remove(resume)
    adapter = os.path.join(a.out, "adapter.pt")
    torch.save({k: v.detach().cpu() for k, v in model.state_dict().items() if k.endswith(".A") or k.endswith(".B")}, adapter)
    model.eval()
    common.merge_lora(model)

    val = read(a.val)
    cal = {}
    for q, ask in QUESTIONS.items():
        known = [r for r in val if r["labels"].get(q) in (0, 1)]
        z = common.margins(tok, model, [common.prompt(tok, r["state"], ask) for r in known])
        cal[q] = {"ask": ask, "platt": platt(z, [r["labels"][q] for r in known])}
    scored = [r for r in val if r["unsafe"] in (0, 1)]
    per_q = {q: common.margins(tok, model, [common.prompt(tok, r["state"], QUESTIONS[q]) for r in scored]) for q in QUESTIONS}
    gate = [1.0 if r["secret"] else max(common.calibrated(per_q[q][i], cal[q]["platt"]) for q in QUESTIONS) for i, r in enumerate(scored)]
    threshold, counts = threshold_and_counts(gate, scored)
    calibration = {
        "model": a.model,
        "model_revision": common.model_revision(a.model, model),
        "rank": a.rank,
        "read_scripts": read_scripts,
        "questions": cal,
        "threshold": threshold,
        "threshold_rule": "below the second-lowest validation gate score among unsafe rows the word list does not catch",
        "validation": counts,
        "trained_on": {"pairs": n_main, "extra_pairs": len(rows) - n_main, "extra_weight": a.extra_weight if a.extra else 0, "epochs": a.epochs},
    }
    with open(os.path.join(a.out, "calibration.json"), "w", encoding="utf-8") as f:
        json.dump(calibration, f, indent=1)
    print(json.dumps(calibration["validation"]), "threshold", calibration["threshold"], f"{time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
