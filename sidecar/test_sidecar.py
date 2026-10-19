"""Checks for the sidecar scripts that need neither a GPU nor a model download.

    python -m unittest discover -s sidecar -p "test_*.py"

torch is needed (CPU is enough). One check, that packing a request's questions into one pass
answers as reading each alone, builds a small random model of the sidecar's architecture and so
needs transformers; without it that check is skipped. CI runs these beside the mock suite.
"""
import importlib.util
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import torch  # noqa: E402

import common  # noqa: E402
import serve  # noqa: E402
import train  # noqa: E402


class Threshold(unittest.TestCase):
    def test_counts_are_taken_at_the_value_saved(self):
        # The second-lowest unsafe score needs more than six places: 0.6.0 saved it rounded up,
        # which let it through while the counts, taken before the rounding, said one.
        scored = [{"unsafe": 1, "secret": 0}, {"unsafe": 1, "secret": 0}, {"unsafe": 0, "secret": 0}]
        gate = [0.01, 0.03187795799538798, 0.0318779]
        threshold, counts = train.threshold_and_counts(gate, scored)
        saved = json.loads(json.dumps({"threshold": threshold}))["threshold"]
        self.assertEqual(saved, 0.03187795799538798)
        self.assertEqual(counts["unsafe_let_through"], sum(g < saved for g, r in zip(gate, scored) if r["unsafe"]))
        self.assertEqual(counts["unsafe_let_through"], 1)
        self.assertEqual(counts["safe_cleared"], 1)

    def test_risk_order_matches_the_binomial(self):
        # 0.99^299 < 0.05 < 0.99^298: 299 unsafe commands are the fewest that support 1% at 95%.
        self.assertEqual(train.risk_order(299, 0.01, 0.95), 1)
        self.assertEqual(train.risk_order(298, 0.01, 0.95), 0)
        self.assertEqual(train.risk_order(1000, 0.01, 0.95), 5)
        # the second-lowest of 182, the old rule, is what 3% at 95% allows
        self.assertEqual(train.risk_order(182, 0.03, 0.95), 2)

    def test_smallest_risk_is_the_least_rate_the_rows_reach(self):
        # 1 - 0.05^(1/n), rounded up to a tenth of a percent: what to say when the target needs
        # more unsafe rows than there are.
        self.assertEqual(train.smallest_risk(299, 0.95), 0.01)
        self.assertEqual(train.smallest_risk(83, 0.95), 0.036)
        self.assertEqual(train.risk_order(83, 0.036, 0.95), 1)
        self.assertEqual(train.risk_order(83, 0.035, 0.95), 0)
        self.assertIsNone(train.smallest_risk(1, 0.95))

    def test_risk_threshold_clears_nothing_without_the_evidence(self):
        scored = [{"unsafe": 1, "secret": 0}] * 50 + [{"unsafe": 0, "secret": 0}] * 50
        gate = [0.5] * 50 + [0.001] * 50
        threshold, k, n, counts = train.risk_threshold(gate, scored, 0.01, 0.95)
        self.assertEqual((threshold, k, n, counts["safe_cleared"]), (0.0, 0, 50, 0))

    def test_calibration_rows_must_be_held_out_of_training(self):
        trained = [{"state": {"tool": "Bash", "command": "ls"}}, {"state": {"tool": "Bash", "command": "pwd"}}]
        apart = [{"state": {"tool": "Bash", "command": "git status"}}]
        self.assertFalse(train.shares_rows(apart, trained))
        # the same state written with its keys in another order is the same row
        self.assertTrue(train.shares_rows(apart + [{"state": {"command": "pwd", "tool": "Bash"}}], trained))

    def test_word_list_rows_do_not_set_it(self):
        scored = [{"unsafe": 1, "secret": 1}, {"unsafe": 1, "secret": 0}, {"unsafe": 1, "secret": 0}]
        threshold, _ = train.threshold_and_counts([0.001, 0.2, 0.3], scored)
        self.assertEqual(threshold, 0.3)


class Adapter(unittest.TestCase):
    def tiny(self):
        class Block(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.q_proj = torch.nn.Linear(8, 8)
                self.v_proj = torch.nn.Linear(8, 8)

        model = torch.nn.Sequential(Block(), Block())
        trained = torch.nn.Sequential(Block(), Block())
        common.add_lora(trained, 2, 4)
        state = {k: v for k, v in trained.state_dict().items() if k.endswith((".A", ".B"))}
        return model, state

    def test_a_complete_adapter_loads(self):
        model, state = self.tiny()
        common.attach_adapter(model, state)
        self.assertTrue(torch.equal(model[0].q_proj.A, state["0.q_proj.A"]))

    def test_a_missing_tensor_is_refused(self):
        model, state = self.tiny()
        del state["1.v_proj.B"]
        with self.assertRaisesRegex(ValueError, "lacks 1 of the model's 8"):
            common.attach_adapter(model, state)

    def test_a_foreign_tensor_is_refused(self):
        model, state = self.tiny()
        state["2.q_proj.A"] = state["0.q_proj.A"]
        with self.assertRaisesRegex(ValueError, "does not have"):
            common.attach_adapter(model, state)


class Identity(unittest.TestCase):
    def test_digest_moves_with_the_revision_and_the_files(self):
        with tempfile.TemporaryDirectory() as d:
            cal = os.path.join(d, "calibration.json")
            with open(cal, "w") as f:
                f.write('{"threshold": 0.1}')
            one = common.digest("Qwen/Qwen3-0.6B", "rev-a", cal)
            self.assertEqual(one, common.digest("Qwen/Qwen3-0.6B", "rev-a", cal))
            self.assertNotEqual(one, common.digest("Qwen/Qwen3-0.6B", "rev-b", cal))
            with open(cal, "w") as f:
                f.write('{"threshold": 0.2}')
            self.assertNotEqual(one, common.digest("Qwen/Qwen3-0.6B", "rev-a", cal))

    def test_revision_from_the_hub_or_the_local_files(self):
        class Config:
            _commit_hash = "c1899de2"

        class Model:
            config = Config()

        self.assertEqual(common.model_revision("Qwen/Qwen3-0.6B", Model()), "c1899de2")
        Config._commit_hash = None
        with tempfile.TemporaryDirectory() as d:
            weights = os.path.join(d, "model.safetensors")
            with open(weights, "wb") as f:
                f.write(b"one")
            first = common.model_revision(d, Model())
            with open(weights, "wb") as f:
                f.write(b"two")
            self.assertTrue(first.startswith("sha256:"))
            self.assertNotEqual(first, common.model_revision(d, Model()))


class Serving(unittest.TestCase):
    trained = {"destroys-data": {"ask": "Could it destroy data?", "platt": [1.0, 0.0]}}

    def test_only_trained_questions_in_trained_wording(self):
        self.assertIsNone(serve.refusal(self.trained, [{"id": "destroys-data", "ask": "Could it destroy data?"}]))
        self.assertIn("not trained", serve.refusal(self.trained, [{"id": "exfiltrates", "ask": "?"}]))
        self.assertIn("worded differently", serve.refusal(self.trained, [{"id": "destroys-data", "ask": "Destroys data?"}]))

    def test_old_canary_files_carry_no_record(self):
        with tempfile.TemporaryDirectory() as d:
            old, new = os.path.join(d, "old.json"), os.path.join(d, "new.json")
            canary = {"command": "ls", "expect": "allow", "recorded": 0.01}
            with open(old, "w") as f:
                json.dump([canary], f)
            with open(new, "w") as f:
                json.dump({"recordedOn": {"model": "m", "digest": "d"}, "canaries": [canary]}, f)
            self.assertEqual(serve.read_recording(old), {"canaries": [canary]})
            self.assertEqual(serve.read_recording(new)["recordedOn"]["digest"], "d")

    def test_calibrated_is_a_probability(self):
        self.assertAlmostEqual(common.calibrated(0.0, [1.0, 0.0]), 0.5)
        self.assertLess(common.calibrated(-10.0, [1.0, 0.0]), 0.001)


class CharTok:
    """A tokenizer with one token per character, Y and N among them."""

    def __call__(self, text, add_special_tokens=False):
        return {"input_ids": [ord(c) % 250 + 2 for c in text]}

    def encode(self, text, add_special_tokens=False):
        return self(text)["input_ids"]


class Packing(unittest.TestCase):
    texts = ["state: ls\nQ: does it delete?\nA:", "state: ls\nQ: does it upload?\nA:", "state: ls\nQ: outside?\nA:"]

    def test_each_segment_after_the_shared_part_is_its_text(self):
        tok = CharTok()
        ids, positions, segment, ends = common.packed(tok, self.texts)
        shared = segment.count(0)
        self.assertEqual(shared, len("state: ls\nQ: "))
        for i, text in enumerate(self.texts):
            mine = [k for k, s in enumerate(segment) if s in (0, i + 1)]
            self.assertEqual([ids[k] for k in mine], tok(text)["input_ids"])
            self.assertEqual([positions[k] for k in mine], list(range(len(text))))
            self.assertEqual(ends[i], mine[-1])

    def test_identical_texts_keep_their_last_token(self):
        ids, _, segment, ends = common.packed(CharTok(), ["ab", "ab"])
        self.assertEqual((ids, segment, ends), ([ids[0], ids[1], ids[1]], [0, 1, 2], [1, 2]))

    def test_a_segment_sees_the_shared_part_and_itself(self):
        mask = common.packed_mask([0, 0, 1, 1, 2], "cpu")[0, 0]
        self.assertEqual(mask.tolist(), [
            [True, False, False, False, False],
            [True, True, False, False, False],
            [True, True, True, False, False],
            [True, True, True, True, False],
            [True, True, False, False, True],
        ])

    @unittest.skipUnless(importlib.util.find_spec("transformers"), "needs transformers")
    def test_one_pass_answers_as_separate_passes(self):
        # A small randomly initialised model of the sidecar's architecture (grouped KV heads,
        # RoPE), in float32, where packing should agree with reading each text alone to rounding.
        from transformers import Qwen3Config, Qwen3ForCausalLM

        torch.manual_seed(0)
        config = Qwen3Config(vocab_size=256, hidden_size=64, intermediate_size=128, num_hidden_layers=2,
                             num_attention_heads=4, num_key_value_heads=2, head_dim=16, max_position_embeddings=256)
        tok = CharTok()
        y, n = common.yn_ids(tok)
        for attention in ("sdpa", "eager"):
            config._attn_implementation = attention
            model = Qwen3ForCausalLM(config).eval()
            alone = []
            with torch.no_grad():
                for text in self.texts:
                    h = model.model(input_ids=torch.tensor([tok(text)["input_ids"]])).last_hidden_state[0, -1]
                    lg = model.lm_head(h)
                    alone.append((lg[y] - lg[n]).item())
            for got, want in zip(common.request_margins(tok, model, self.texts), alone):
                self.assertAlmostEqual(got, want, places=4, msg=attention)
            # the shared part is read once: three texts, one sequence shorter than their sum
            self.assertLess(len(common.packed(tok, self.texts)[0]), sum(map(len, self.texts)))


if __name__ == "__main__":
    unittest.main()
