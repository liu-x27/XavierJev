"""What sidecar/train.py, score.py and serve.py share: the prompt, the adapters, the model.

The prompt is LlmJudge's yes/no prompt, byte for byte (src/llm.ts, YES_NO_PROMPTS["yes-first"]
and yesNoMessages), put through the model's own chat template with thinking off. The state is
rendered the way renderState renders it: `key: value` lines in the order given. A judge trained
here and served by serve.py therefore reads exactly what the gate would have sent to an LLM.
"""
import hashlib
import math
import os

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")

import torch  # noqa: E402

SYSTEM = (
    "You answer a single yes/no question about a tool call. "
    "Reply with exactly one character: Y for yes, N for no. "
    "No punctuation, no explanation, no other text."
)
TARGETS = ("q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj")


def render_state(state):
    return "\n".join(f"{k}: {v}" for k, v in state.items())


def prompt(tok, state, ask):
    msgs = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": f"{render_state(state)}\n\nQuestion: {ask}\nAnswer (Y or N):"},
    ]
    return tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True, enable_thinking=False)


class LoRALinear(torch.nn.Module):
    """y = W x + (alpha / r) * B A x, with A and B trained and W frozen."""

    def __init__(self, base, r, alpha, dropout=0.0):
        super().__init__()
        self.base = base
        self.A = torch.nn.Parameter(torch.empty(r, base.in_features, dtype=torch.float32))
        self.B = torch.nn.Parameter(torch.zeros(base.out_features, r, dtype=torch.float32))
        torch.nn.init.kaiming_uniform_(self.A, a=math.sqrt(5))
        self.scale = alpha / r
        self.drop = torch.nn.Dropout(dropout)

    def forward(self, x):
        return self.base(x) + (self.drop(x).to(self.A.dtype) @ self.A.t() @ self.B.t()).to(x.dtype) * self.scale


def add_lora(model, r, alpha, dropout=0.0):
    for p in model.parameters():
        p.requires_grad_(False)
    for mod in list(model.modules()):
        for t in TARGETS:
            child = getattr(mod, t, None)
            if isinstance(child, torch.nn.Linear):
                setattr(mod, t, LoRALinear(child, r, alpha, dropout).to(child.weight.device))
    return [p for p in model.parameters() if p.requires_grad]


def merge_lora(model):
    """Fold every adapter into its base weight and put the plain Linear back: same answers up to
    bf16 rounding, the base model's speed. Calibrate after this, not before."""
    for mod in list(model.modules()):
        for name, child in list(mod.named_children()):
            if isinstance(child, LoRALinear):
                with torch.no_grad():
                    child.base.weight += (child.B @ child.A * child.scale).to(child.base.weight.dtype)
                setattr(mod, name, child.base)


def load(model_name, adapter=None, rank=None, device="cuda"):
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(model_name)
    tok.padding_side = "left"
    model = AutoModelForCausalLM.from_pretrained(model_name, dtype=torch.bfloat16).to(device)
    if adapter:
        attach_adapter(model, torch.load(adapter, map_location=device), rank)
        merge_lora(model)
    model.eval()
    return tok, model


def attach_adapter(model, state, rank=None):
    """Put trained adapters on `model`: every one it has, and nothing else."""
    r = rank or next(v.shape[0] for k, v in state.items() if k.endswith(".A"))
    add_lora(model, r, 2 * r)
    bad = model.load_state_dict(state, strict=False).unexpected_keys
    if bad:
        raise ValueError(f"adapter keys the model does not have: {bad[:3]}")
    # strict=False also forgives the opposite, an adapter file missing some of the model's
    # adapters, which would leave those at their initial values and serve a different judge.
    wanted = [k for k in model.state_dict() if k.endswith(".A") or k.endswith(".B")]
    missing = [k for k in wanted if k not in state]
    if missing:
        raise ValueError(f"the adapter file lacks {len(missing)} of the model's {len(wanted)} adapter tensors: {missing[:3]}")


def yn_ids(tok):
    y = tok.encode("Y", add_special_tokens=False)
    n = tok.encode("N", add_special_tokens=False)
    if len(y) != 1 or len(n) != 1:
        raise ValueError("Y and N are not single tokens for this tokenizer")
    return y[0], n[0]


@torch.no_grad()
def margins(tok, model, texts, batch=16):
    """logit(Y) - logit(N) at the answer position, one per text, shortest first for padding."""
    y_id, n_id = yn_ids(tok)
    out = [0.0] * len(texts)
    order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
    for s in range(0, len(order), batch):
        idx = order[s:s + batch]
        enc = tok([texts[i] for i in idx], return_tensors="pt", padding=True, add_special_tokens=False).to(model.device)
        lg = model.lm_head(model.model(**enc).last_hidden_state[:, -1, :]).float()
        for i, m in zip(idx, (lg[:, y_id] - lg[:, n_id]).tolist()):
            out[i] = m
    return out


def packed(tok, texts):
    """Several prompts that begin alike — one request's questions about one state — as one
    sequence in which what they share is read once.

    Each text is tokenized on its own, as `margins` tokenizes it, and the tokens every text begins
    with go in once, followed by each text's remaining tokens. The split is found on the tokens,
    not on the strings, so no token is cut at the boundary: the shared part followed by any one
    segment is that text's own tokenization, token for token. The shared part stops one token
    short of the shortest text, so that every segment keeps its answer position.

    Returns (input_ids, position_ids, segment, ends): `position_ids` restart at the end of the
    shared part in every segment, the positions each text has on its own; `segment` is 0 for a
    shared token and i + 1 for the i-th text's; `ends` is the index of each text's last token."""
    ids = [tok(t, add_special_tokens=False)["input_ids"] for t in texts]
    shared, limit = 0, min(len(s) for s in ids) - 1
    while shared < limit and all(s[shared] == ids[0][shared] for s in ids[1:]):
        shared += 1
    input_ids, positions, segment, ends = list(ids[0][:shared]), list(range(shared)), [0] * shared, []
    for i, s in enumerate(ids):
        input_ids += s[shared:]
        positions += range(shared, len(s))
        segment += [i + 1] * (len(s) - shared)
        ends.append(len(input_ids) - 1)
    return input_ids, positions, segment, ends


def packed_mask(segment, device):
    """The 4D mask (True: may attend) for a sequence from `packed`: causal, and a token past the
    shared part sees the shared part and its own segment, never another's. With it each segment
    is read as its text would be read alone."""
    seg = torch.tensor(segment, device=device)
    causal = torch.ones(len(segment), len(segment), dtype=torch.bool, device=device).tril()
    return (causal & ((seg[None, :] == 0) | (seg[None, :] == seg[:, None])))[None, None]


@torch.no_grad()
def request_margins(tok, model, texts):
    """What `margins` gives for one request's texts, from one forward pass over them packed (see
    `packed`): the state, which every question repeats, is computed once instead of once per
    question. A mask passed as 4D reaches the attention as it is; transformers adds nothing to it."""
    y_id, n_id = yn_ids(tok)
    input_ids, positions, segment, ends = packed(tok, texts)
    mask = packed_mask(segment, model.device)
    attention = model.config._attn_implementation
    if attention == "eager":  # eager attention adds the mask to its scores rather than selecting with it
        mask = torch.zeros(mask.shape, dtype=model.dtype, device=model.device).masked_fill(~mask, torch.finfo(model.dtype).min)
    elif attention != "sdpa":
        raise ValueError(f"a packed request needs sdpa or eager attention, and the model runs {attention}")
    hidden = model.model(
        input_ids=torch.tensor([input_ids], device=model.device),
        position_ids=torch.tensor([positions], device=model.device),
        attention_mask=mask,
        use_cache=False,
    ).last_hidden_state[0, ends, :]
    lg = model.lm_head(hidden).float()
    return (lg[:, y_id] - lg[:, n_id]).tolist()


# How a request's questions are put to the model. "batched": one row per question, padded into a
# batch, as everything before 0.8.0 did. "packed": one pass per request (`request_margins`).
SCORINGS = ("batched", "packed")


def scoring_of(calibration):
    """How the numbers a calibration was fitted on were computed: what calibration.json says, and
    "batched" for one written before 0.8.0, which says nothing."""
    return calibration.get("scoring", "batched")


def score_request(tok, model, texts, scoring):
    """One request's margins, computed the way `scoring` names."""
    if scoring == "packed":
        return request_margins(tok, model, texts)
    if scoring == "batched":
        return margins(tok, model, texts)
    raise ValueError(f"unknown scoring {scoring!r}: one of {', '.join(SCORINGS)}")


def calibrated(margin, platt):
    a, b = platt
    return 1.0 / (1.0 + math.exp(-(a * margin + b)))


def model_revision(model_name, model):
    """Which weights `model_name` resolved to: the hub snapshot's commit when it came from the hub
    cache, else a hash of a local model directory's weight and config files. A name alone says
    nothing about the weights behind it once the cache is updated."""
    rev = getattr(model.config, "_commit_hash", None)
    if rev:
        return rev
    if os.path.isdir(model_name):
        h = hashlib.sha256()
        for name in sorted(os.listdir(model_name)):
            if name.endswith((".safetensors", ".bin")) or name == "config.json":
                with open(os.path.join(model_name, name), "rb") as f:
                    for chunk in iter(lambda: f.read(1 << 20), b""):
                        h.update(chunk)
        return "sha256:" + h.hexdigest()
    return "unknown"


def digest(model_name, revision, *files, scoring="batched"):
    """One hash over the base model's name and revision and the bytes of each file (the adapters,
    the calibration), so that a change to any of them changes it — and over how requests are
    scored, when that is not the "batched" every judge before 0.8.0 was served by, so that their
    digests stand and a judge served another way than it was calibrated is not the same judge."""
    h = hashlib.sha256()
    for text in (model_name, revision):
        h.update(str(text).encode("utf-8"))
        h.update(b"\0")
    for path in files:
        with open(path, "rb") as f:
            h.update(f.read())
    if scoring != "batched":
        h.update(b"\0scoring\0" + scoring.encode("utf-8"))
    return h.hexdigest()
