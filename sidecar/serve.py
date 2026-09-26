"""Serve a judge trained by sidecar/train.py to XavierJev's SidecarJudge, on this machine only.

    python sidecar/serve.py --run sidecar/run [--port 8765] [--canaries sidecar/run/canaries.json] [--max-pending 4]

GET  /identify  -> {model, digest, detail, questions, threshold, readScripts, modelRevision, recording}
POST /noul      {state, questions: [{id, ask}]} -> {answers: [{id, probability}]}

It answers only the questions it was trained on, and only in the wording it was trained on: a
question whose text differs from calibration.json's is refused with HTTP 400, which the gate
treats as a judge failure and asks the user — a judge asked a question it never learned is not
the judge that was measured. The digest covers the base model's name and revision, the adapters
and the calibration, so the gate's self-check notices when any of them changes; and adapters
trained on one revision of the base model are not served on another.

`recording` is the canaries file as `npm run sidecar:canaries` wrote it, passed through: the
hook compares what it says they were recorded on with this judge, not this judge with itself.
"""
import argparse
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402


def refusal(trained, questions):
    """Why these questions cannot be answered by a judge trained on `trained` (calibration.json's
    questions), or None: an id it was not trained on, or its wording changed."""
    for q in questions:
        known = trained.get(q.get("id"))
        if known is None:
            return f"not trained on {q.get('id')}"
        if q.get("ask") != known["ask"]:
            return f"{q['id']} is worded differently from the question it was trained on"
    return None


def read_recording(path):
    """The canaries file as `npm run sidecar:canaries` wrote it. One written before 0.7.0 is a bare
    array of canaries, served as {canaries} with nothing to say what they were recorded on."""
    with open(path, encoding="utf-8") as f:
        recording = json.load(f)
    return {"canaries": recording} if isinstance(recording, list) else recording


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True, help="the --out directory of train.py")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--canaries", help="written by `npm run sidecar:canaries`")
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--max-pending", type=int, default=4,
                    help="requests answered or waiting at once; past that, 503 and the gate asks the user")
    a = ap.parse_args()
    adapter = os.path.join(a.run, "adapter.pt")
    cal_path = os.path.join(a.run, "calibration.json")
    with open(cal_path, encoding="utf-8") as f:
        cal = json.load(f)
    recording = read_recording(a.canaries) if a.canaries else None
    tok, model = common.load(cal["model"], adapter, cal.get("rank"), a.device)
    revision = common.model_revision(cal["model"], model)
    trained_on = cal.get("model_revision")
    if trained_on and trained_on != revision:
        sys.exit(f"{cal['model']} is now revision {revision}, and these adapters were trained on {trained_on}")
    lock = threading.Lock()
    # The model answers one request at a time. A caller that stopped waiting drops its
    # connection, but a request already queued here would still be computed, so the queue is
    # bounded: past it the answer is 503, which the gate treats as a failure and asks the user.
    pending = threading.BoundedSemaphore(a.max_pending)
    info = {
        "model": f"{cal['model']}+lora",
        "digest": common.digest(cal["model"], revision, adapter, cal_path),
        "detail": f"{cal['model']} ({revision[:12]}) with rank-{cal.get('rank')} adapters from {os.path.abspath(a.run)}",
        "questions": list(cal["questions"]),
        "threshold": cal["threshold"],
        "readScripts": cal.get("read_scripts"),
        "modelRevision": revision,
    }
    if recording:
        info["recording"] = recording
    recorded_on = (recording or {}).get("recordedOn") or {}
    if recording and recorded_on.get("digest") != info["digest"]:
        print("warning: the canaries were not recorded on this judge (digest differs or is missing); the hook will"
              " refuse to start until they are recorded again with `npm run sidecar:canaries`", flush=True)

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
            refused = refusal(cal["questions"], questions)
            if refused:
                self.reply(400, {"error": refused})
                return
            texts = [common.prompt(tok, state, q["ask"]) for q in questions]
            if not pending.acquire(blocking=False):
                self.reply(503, {"error": f"busy: {a.max_pending} requests already answered or waiting"})
                return
            try:
                with lock:
                    ms = common.margins(tok, model, texts)
            finally:
                pending.release()
            self.reply(200, {"answers": [
                {"id": q["id"], "probability": common.calibrated(m, cal["questions"][q["id"]]["platt"])}
                for q, m in zip(questions, ms)
            ]})

    server = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    print(f"sidecar judge at http://127.0.0.1:{a.port} · {info['detail']} · threshold {info['threshold']}"
          f" · digest {info['digest'][:12]} · canaries {'yes' if recording else 'none yet'}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
