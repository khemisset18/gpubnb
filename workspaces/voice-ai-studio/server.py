"""Offline Whisper transcription. Audio never needs to leave the rented container."""
from __future__ import annotations
import json
import os
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock
from pathlib import Path

import torch
import whisper

# The model was downloaded during Docker build; this must not fetch at runtime.
if not torch.cuda.is_available():
    raise SystemExit("cuda_required_no_cpu_fallback")
model = whisper.load_model("tiny", download_root=os.environ["GPUBNB_WHISPER_MODEL"], device="cuda")
lock = Lock()

class Handler(BaseHTTPRequestHandler):
    def respond(self, status: int, data: dict) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/healthz":
            self.respond(200, {"ready": True, "engine": "whisper", "gpu": torch.cuda.get_device_name(0)})
        else:
            self.respond(404, {"error": "not_found"})

    def do_POST(self) -> None:
        if self.path != "/transcribe":
            return self.respond(404, {"error": "not_found"})
        size_text = self.headers.get("Content-Length", "")
        if not size_text.isdigit() or not 1 <= int(size_text) <= 10 * 1024 * 1024:
            return self.respond(413, {"error": "audio_size_invalid"})
        if self.headers.get("Content-Type", "").split(";")[0].strip() not in ("audio/wav", "audio/x-wav", "audio/mpeg"):
            return self.respond(415, {"error": "unsupported_audio_type"})
        if not lock.acquire(blocking=False):
            return self.respond(429, {"error": "gpu_busy"})
        try:
            with tempfile.TemporaryDirectory(prefix="gpubnb-voice-") as tmp:
                target = Path(tmp) / "audio"
                target.write_bytes(self.rfile.read(int(size_text)))
                result = model.transcribe(str(target), fp16=True)
            self.respond(200, {"text": result["text"], "language": result.get("language")})
        except Exception:
            # Keep renter-provided data and paths out of logs and error output.
            self.respond(422, {"error": "transcription_failed"})
        finally:
            lock.release()

if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 3000), Handler).serve_forever()
