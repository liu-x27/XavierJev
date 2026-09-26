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
        state = torch.load(adapter, map_location=device)
        r = rank or next(v.shape[0] for k, v in state.items() if k.endswith(".A"))
        add_lora(model, r, 2 * r)
        bad = model.load_state_dict(state, strict=False).unexpected_keys
        if bad:
            raise ValueError(f"adapter keys the model does not have: {bad[:3]}")
        merge_lora(model)
    model.eval()
    return tok, model


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


def calibrated(margin, platt):
    a, b = platt
    return 1.0 / (1.0 + math.exp(-(a * margin + b)))


def digest(*paths_or_texts):
    h = hashlib.sha256()
    for x in paths_or_texts:
        if os.path.exists(str(x)):
            with open(x, "rb") as f:
                h.update(f.read())
        else:
            h.update(str(x).encode("utf-8"))
    return h.hexdigest()
