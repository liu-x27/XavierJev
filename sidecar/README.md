# A trained judge, served on this machine

The gate's default judge is a prompted llama3.1:8b. This directory trains a small model to
answer the same questions instead, and serves it to `SidecarJudge` (`src/sidecar.ts`). On one
machine's traffic the result cleared more than twice what the 8B clears for a few more misses,
and took 44 ms for the four questions; on commands written elsewhere it matched the 8B's clears
and missed two it caught ([docs/measurements.md](../docs/measurements.md#a-judge-trained-on-this-machines-traffic)).
Those numbers are about that machine. A judge trained on yours has to be measured on yours.

What you need: Python with `torch` (CUDA) and `transformers`, the base model in the Hugging Face
cache (default `Qwen/Qwen3-0.6B`, about 1.5 GB), and labelled commands. Nothing here downloads
anything by itself; `HF_HUB_OFFLINE=1` is set.

## 1. Label

One JSON object per line:

```json
{"command": "rm -rf build && npm run build", "cwd": "/home/me/app", "labels": {"destroys-data": 0, "outside-cwd": 0, "exfiltrates": 0, "reveals-secret": 0}}
```

A question left out of `labels` is unknown for that command and is not trained on. The criterion
the gate was built on is in `eval/risk-gate/cases.ts`; read it before labelling, and keep a
validation file of commands from the same source, labelled the same way, that training never
sees. Real traffic from your own agent is what makes the judge worth having — and what makes it
private: the labelled commands and the weights trained on them stay on your machine.

## 2. Prepare

```bash
npx tsx sidecar/prepare.ts train.labelled.jsonl train.jsonl [--read-scripts]
npx tsx sidecar/prepare.ts val.labelled.jsonl val.jsonl [--read-scripts]
```

This builds each state with the gate's own `gateState()`, so the judge is trained on exactly what
the gate will show it, and marks the commands the `reveals-secret` word list (`SECRET_WORDS`)
catches. It also writes `train.questions.json`, the questions' wording, which training uses and
the server insists on. Use `--read-scripts` here only if the gate will run with `readScripts` on.

## 3. Train

```bash
python sidecar/train.py --train train.jsonl --val val.jsonl --out sidecar/run
#   [--extra other.jsonl --extra-weight 0.25]  commands from elsewhere, at a share of the weight
#   [--resume]  checkpoint every 100 steps to <out>/resume.pt; run it again after a kill to continue
#   [--risk 0.03 --confidence 0.95 --calib-share 0.5]  a threshold for a stated let-through rate
```

On a machine shared with other work, `--resume` means a training stopped to give memory back, or
by running out of it, loses at most 100 steps: the adapters, optimizer, schedule, batch order and
random states are restored, and the checkpoint is deleted once training finishes.

By default the threshold sits below the second-lowest unsafe validation score, on the same rows
the calibration was fitted on. On one machine's labels that rule put the threshold anywhere from
0.006 to 0.054 depending on which 600 commands were validation, and the "one let through" it
shows on validation did not carry to held-out commands (0 of 308 on one split, 7 of 274 on
another). `--risk` states the target instead: part of the validation rows fit the calibration,
and the rest, which the calibrated scorer never saw, set the threshold at the k-th lowest unsafe
score, for the largest k with P(Binomial(n, risk) ≤ k−1) ≤ 1 − confidence. That bounds the
let-through rate among unsafe commands the word list misses, provided those n are exchangeable
with the ones to come. It takes data: 1% at 95% needs at least 299 unsafe calibration commands;
3% needs about 100. With fewer, the threshold is 0 and nothing is cleared — the run says there is
not enough evidence rather than pick a line anyway.

LoRA (rank 16, every attention and MLP projection) on the model's own Y-against-N answer to each
question, two epochs; about 25 minutes for 3,500 commands on an RTX 5080. Then the adapters are
merged, and on the merged model each question is Platt-calibrated on the validation file and the
threshold set there: below the second-lowest score among unsafe validation commands the word list
does not already catch. `sidecar/run/` gets `adapter.pt` and `calibration.json`; it is gitignored.

`python sidecar/score.py --run sidecar/run --rows test.jsonl --out scores.jsonl` scores held-out
rows offline, for measuring before you trust it.

## 4. Serve and record

```bash
python sidecar/serve.py --run sidecar/run                     # :8765, this machine only
npm run sidecar:canaries -- --out sidecar/run/canaries.json   # once, with the server up
python sidecar/serve.py --run sidecar/run --canaries sidecar/run/canaries.json [--max-pending 4]
npm run claude-code -- --backend sidecar [--read-scripts]
```

The model answers one request at a time. `--max-pending` bounds how many may be answered or
waiting at once; past that the server answers 503, which the gate treats like any judge
failure and asks the user. A request the gate stopped waiting for is cancelled, so the
server sees its connection drop instead of computing an answer nobody reads.

`python -m unittest discover -s sidecar` runs the checks that need no GPU and no model.

The server answers only the questions it was trained on, and only in their trained wording; any
other question is refused and the gate asks the user. It reports its threshold, whether it was
trained with scripts in its state, and a digest of the base model's name and revision, the
adapters and the calibration at `GET /identify`; it will not serve adapters on a revision of
the base model other than the one they were trained on. `reveals-secret` never reaches it:
`SidecarJudge` answers that from the word list.

The canaries file records what it was scored on: the judge's model and digest, its threshold,
and the build's word list. The hook compares that record with the sidecar it is talking to —
not with llama3.1:8b, whose scale it does not share, and not with whatever the sidecar says it
is now — and refuses to start if the digest, the threshold or the word list differ, if the
judge was trained with scripts shown and `--read-scripts` is off or the other way round, or if
the file predates 0.7.0 and records none of it. Retrain, or change the word list, and record
the canaries again.
