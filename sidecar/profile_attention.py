"""Which attention kernel the sidecar's model runs, with a mask and without one, and what that costs.

    python sidecar/profile_attention.py [--model Qwen/Qwen3-0.6B] [--lengths 256,1024,2048] [--out profile.json]

Qwen3-0.6B has grouped KV heads (16 query heads, 8 key/value). Given no attention mask,
transformers hands SDPA the 8 heads with `enable_gqa=True` and `is_causal=True`; given one, it
repeats the KV heads to 16 itself and passes the mask (`integrations/sdpa_attention.py`,
`use_gqa_in_sdpa`). A padding mask with no padding in it counts as none: it is dropped before it
reaches the attention. Which of SDPA's kernels takes each case depends on the PyTorch build —
whether it has flash attention (this Windows build does not) and which kernels accept GQA.

For each length this times one forward pass of the base model two ways — no mask, and a 4D
causal mask, which reaches the attention as it is — and records the CUDA kernels the attention
launched under the profiler, and the peak memory. Then, on the attention alone, asks each of
SDPA's kernels to take `enable_gqa=True` with `is_causal=True`, as transformers calls it without a
mask, and records which may and why the others may not. Nothing is trained and no weights other
than the base model's are read.
"""
import argparse
import json
import os
import statistics
import sys
import time
import warnings

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import torch  # noqa: E402

import common  # noqa: E402,F401  (sets HF_HUB_OFFLINE before transformers is imported)


def attention_kernels(fn):
    """The CUDA kernels one call of `fn` launches whose names say attention, softmax or batched
    matmul, with their total CUDA time in microseconds."""
    from torch.profiler import ProfilerActivity, profile

    with profile(activities=[ProfilerActivity.CUDA]) as prof:
        fn()
        torch.cuda.synchronize()
    out = {}
    for e in prof.key_averages():
        name = e.key
        if any(w in name.lower() for w in ("attention", "fmha", "flash", "softmax", "gemm", "bmm", "cudnn")):
            t = getattr(e, "device_time_total", None) or getattr(e, "cuda_time_total", 0)
            out[name[:120]] = {"calls": e.count, "us": round(t, 1)}
    return dict(sorted(out.items(), key=lambda kv: -kv[1]["us"])[:12])


def timed(fn, n=20):
    for _ in range(3):
        fn()
    torch.cuda.synchronize()
    ms = []
    for _ in range(n):
        s = time.perf_counter()
        fn()
        torch.cuda.synchronize()
        ms.append((time.perf_counter() - s) * 1000)
    return statistics.median(ms)


def peak_mb(fn):
    torch.cuda.synchronize()
    torch.cuda.reset_peak_memory_stats()
    base = torch.cuda.memory_allocated()
    fn()
    torch.cuda.synchronize()
    return round((torch.cuda.max_memory_allocated() - base) / 2**20, 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen3-0.6B")
    ap.add_argument("--lengths", default="256,1024,2048")
    ap.add_argument("--batch", type=int, default=1)
    ap.add_argument("--out")
    a = ap.parse_args()
    from transformers import AutoModelForCausalLM

    model = AutoModelForCausalLM.from_pretrained(a.model, dtype=torch.bfloat16).cuda().eval()
    cfg = model.config
    result = {
        "torch": torch.__version__, "cuda": torch.version.cuda, "gpu": torch.cuda.get_device_name(0),
        "transformers": __import__("transformers").__version__,
        "flash_available": torch.backends.cuda.is_flash_attention_available(),
        "heads": {"query": cfg.num_attention_heads, "key_value": cfg.num_key_value_heads, "dim": cfg.head_dim},
        "batch": a.batch, "lengths": {},
    }
    for length in [int(x) for x in a.lengths.split(",")]:
        ids = torch.randint(1000, 20000, (a.batch, length), device="cuda")
        causal = torch.ones(length, length, dtype=torch.bool, device="cuda").tril()[None, None].expand(a.batch, 1, -1, -1)
        cases = {
            "no mask": lambda: model.model(input_ids=ids, use_cache=False),
            "4D causal mask": lambda: model.model(input_ids=ids, attention_mask=causal, use_cache=False),
        }
        row = {}
        with torch.no_grad():
            for name, fn in cases.items():
                row[name] = {"ms": round(timed(fn), 2), "peak_mb": peak_mb(fn), "kernels": attention_kernels(fn)}
        row["no mask / mask"] = round(row["no mask"]["ms"] / row["4D causal mask"]["ms"], 2)
        result["lengths"][length] = row
        print(f"{length:5d} tokens: no mask {row['no mask']['ms']:.1f} ms, {row['no mask']['peak_mb']} MB · "
              f"4D mask {row['4D causal mask']['ms']:.1f} ms, {row['4D causal mask']['peak_mb']} MB · "
              f"ratio {row['no mask / mask']}", flush=True)

    # The attention alone, as transformers calls it without a mask: may the memory-efficient kernel take it?
    from torch.nn.attention import SDPBackend, sdpa_kernel

    q = torch.randn(1, cfg.num_attention_heads, 1024, cfg.head_dim, device="cuda", dtype=torch.bfloat16)
    k = torch.randn(1, cfg.num_key_value_heads, 1024, cfg.head_dim, device="cuda", dtype=torch.bfloat16)
    probe = {}
    for name, backend in (("efficient", SDPBackend.EFFICIENT_ATTENTION), ("cudnn", SDPBackend.CUDNN_ATTENTION),
                          ("flash", SDPBackend.FLASH_ATTENTION), ("math", SDPBackend.MATH)):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            try:
                with sdpa_kernel([backend]):
                    torch.nn.functional.scaled_dot_product_attention(q, k, k, is_causal=True, enable_gqa=True)
                probe[name] = {"runs": True}
            except RuntimeError as e:
                probe[name] = {"runs": False, "error": str(e).splitlines()[0][:200]}
            reasons = [str(w.message).splitlines()[0][:200] for w in caught]
            if reasons:
                probe[name]["warnings"] = reasons[:4]
    result["gqa_causal_no_mask_1024"] = probe
    for name, p in probe.items():
        print(f"enable_gqa, is_causal, {name}: {'runs' if p['runs'] else 'refused'}"
              + (f" — {p['warnings'][0]}" if p.get("warnings") else ""), flush=True)
    if a.out:
        with open(a.out, "w", encoding="utf-8", newline="\n") as f:
            json.dump(result, f, indent=1)


if __name__ == "__main__":
    main()
