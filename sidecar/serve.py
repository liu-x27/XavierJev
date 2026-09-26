"""Serve a judge trained by sidecar/train.py to XavierJev's SidecarJudge, on this machine only.

    python sidecar/serve.py --run sidecar/run [--port 8765] [--canaries sidecar/run/canaries.json]

GET  /identify  -> {model, digest, detail, questions, threshold, canaries}
POST /noul      {state, questions: [{id, ask}]} -> {answers: [{id, probability}]}

It answers only the questions it was trained on, and only in the wording it was trained on: a
question whose text differs from calibration.json's is refused with HTTP 400, which the gate
treats as a judge failure and asks the user — a judge asked a question it never learned is not
the judge that was measured. The digest covers the base model name, the adapters and the
calibration, so the gate's self-check notices when any of them changes.
"""
import argparse
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True, help="the --out directory of train.py")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--canaries", help="written by `npm run sidecar:canaries`")
    ap.add_argument("--device", default="cuda")
    a = ap.parse_args()
    adapter = os.path.join(a.run, "adapter.pt")
    cal_path = os.path.join(a.run, "calibration.json")
    with open(cal_path, encoding="utf-8") as f:
        cal = json.load(f)
    canaries = None
    if a.canaries and os.path.exists(a.canaries):
        with open(a.canaries, encoding="utf-8") as f:
            canaries = json.load(f)
    tok, model = common.load(cal["model"], adapter, cal.get("rank"), a.device)
    lock = threading.Lock()
    info = {
        "model": f"{cal['model']}+lora",
        "digest": common.digest(cal["model"], adapter, cal_path),
        "detail": f"{cal['model']} with rank-{cal.get('rank')} adapters from {os.path.abspath(a.run)}",
        "questions": list(cal["questions"]),
        "threshold": cal["threshold"],
    }
    if canaries:
        info["canaries"] = canaries

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, code, body):
            data = json.dumps(body).encode("utf-8")
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/identify":
                self.reply(200, info)
            else:
                self.reply(404, {"error": "unknown route"})

        def do_POST(self):
            if self.path != "/noul":
                self.reply(404, {"error": "unknown route"})
                return
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
                state, questions = body["state"], body["questions"]
            except (ValueError, KeyError):
                self.reply(400, {"error": "expected {state, questions}"})
                return
            for q in questions:
                known = cal["questions"].get(q.get("id"))
                if known is None:
                    self.reply(400, {"error": f"not trained on {q.get('id')}"})
                    return
                if q.get("ask") != known["ask"]:
                    self.reply(400, {"error": f"{q['id']} is worded differently from the question it was trained on"})
                    return
            texts = [common.prompt(tok, state, q["ask"]) for q in questions]
            with lock:
                ms = common.margins(tok, model, texts)
            self.reply(200, {"answers": [
                {"id": q["id"], "probability": common.calibrated(m, cal["questions"][q["id"]]["platt"])}
                for q, m in zip(questions, ms)
            ]})

    server = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    print(f"sidecar judge at http://127.0.0.1:{a.port} · {info['detail']} · threshold {info['threshold']}"
          f" · digest {info['digest'][:12]} · canaries {'yes' if canaries else 'none yet'}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
