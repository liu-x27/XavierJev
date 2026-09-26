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
```

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
python sidecar/serve.py --run sidecar/run --canaries sidecar/run/canaries.json
npm run claude-code -- --backend sidecar [--read-scripts]
```

The server answers only the questions it was trained on, and only in their trained wording; any
other question is refused and the gate asks the user. It reports its own threshold and canaries at
`GET /identify`, and a digest of the base model, adapters and calibration, so the gate's self-check
compares it with itself as recorded — not with llama3.1:8b, whose scale it does not share.
`reveals-secret` never reaches it: `SidecarJudge` answers that from the word list.
