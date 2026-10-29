"""Minimal offline inference API. Gateway authentication is mandatory upstream."""
from __future__ import annotations
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL_PATH = os.environ.get("GPUBNB_LLM_MODEL", "/opt/gpubnb-llm/model")
if not torch.cuda.is_available():
    raise SystemExit("cuda_required_no_cpu_fallback")
tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH, local_files_only=True)
model = AutoModelForCausalLM.from_pretrained(
    MODEL_PATH, local_files_only=True, torch_dtype=torch.float16
).to("cuda").eval()
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
            self.respond(200, {"ready": True, "gpu": torch.cuda.get_device_name(0)})
        else:
            self.respond(404, {"error": "not_found"})

    def do_POST(self) -> None:
        if self.path != "/generate":
            return self.respond(404, {"error": "not_found"})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size < 2 or size > 8192:
                return self.respond(413, {"error": "request_size_invalid"})
            obj = json.loads(self.rfile.read(size))
            prompt = obj.get("prompt", "")
            max_tokens = obj.get("max_tokens", 64)
            if not isinstance(prompt, str) or not 1 <= len(prompt) <= 2000:
                return self.respond(400, {"error": "invalid_prompt"})
            if not isinstance(max_tokens, int) or not 1 <= max_tokens <= 256:
                return self.respond(400, {"error": "invalid_max_tokens"})
            if not lock.acquire(blocking=False):
                return self.respond(429, {"error": "gpu_busy"})
            try:
                encoded = tokenizer(prompt, return_tensors="pt", truncation=True, max_length=512).to("cuda")
                with torch.inference_mode():
                    ids = model.generate(**encoded, max_new_tokens=max_tokens,
                                         do_sample=False, pad_token_id=tokenizer.eos_token_id)
                answer = tokenizer.decode(ids[0][encoded["input_ids"].shape[1]:],
                                          skip_special_tokens=True)
            finally:
                lock.release()
            self.respond(200, {"text": answer})
        except (ValueError, TypeError, json.JSONDecodeError):
            self.respond(400, {"error": "invalid_request"})

if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 3000), Handler).serve_forever()
