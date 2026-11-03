#!/usr/bin/env python3
"""modeld —— POC 版模型服务（Python：按语言分工，涉及模型的走 Python）。

只实现设计里 Runtime↔modeld 那一段契约（communication-protocol §4）：
  POST /v1/chat/completions   OpenAI 兼容，robotd 的 vision.describe 调它
  GET  /health

backend：
  stub（默认）—— 确定性回包，用来验证跨进程链路与超时/降级，不需要模型权重。
  mlx        —— 若本机装了 mlx-vlm 才可用（POC 不下载权重，缺库时直接报错）。

跑法：/usr/bin/python3 src/modeld.py --port 8790
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

START = time.time()
BACKEND = "stub"
MODEL_NAME = "stub-vlm-poc"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _json(self, code, body):
        payload = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        sys.stderr.write("[modeld] %s\n" % (fmt % args))

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True, "backend": BACKEND, "model": MODEL_NAME,
                                    "uptime_s": round(time.time() - START, 1)})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            req = json.loads(raw or b"{}")
        except Exception as e:
            return self._json(400, {"error": {"message": "bad json: %s" % e}})

        if self.path != "/v1/chat/completions":
            return self._json(404, {"error": {"message": "not found"}})

        question = ""
        for m in req.get("messages", []):
            if m.get("role") == "user":
                c = m.get("content")
                question = c if isinstance(c, str) else json.dumps(c, ensure_ascii=False)

        t0 = time.time()
        if BACKEND == "mlx":
            text = _run_mlx(question)
        else:
            text = ("（stub VLM）我看到工作台上有一台小车，车上有两块步进驱动板和一块控制板；"
                    "画面里没有人。问题：%s" % question)
        return self._json(200, {
            "id": "chatcmpl-poc",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": MODEL_NAME,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                         "finish_reason": "stop"}],
            "usage": {"latency_ms": int((time.time() - t0) * 1000)},
        })


def _run_mlx(question):
    try:
        from mlx_vlm import load, generate  # type: ignore
        from mlx_vlm.utils import load_config  # type: ignore
    except Exception as e:
        raise RuntimeError("mlx-vlm 未安装（POC 不下载权重）：%s" % e)
    model_path = "mlx-community/MiniCPM-V-4_5-8bit"   # 占位，真实路径由 --model 传
    model, processor = load(model_path)
    config = load_config(model_path)
    return generate(model, processor, config, question, max_tokens=256)[0]


def main():
    global BACKEND, MODEL_NAME
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--backend", default="stub", choices=["stub", "mlx"])
    ap.add_argument("--model", default=MODEL_NAME)
    args = ap.parse_args()
    BACKEND, MODEL_NAME = args.backend, args.model
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print("[modeld] listening 127.0.0.1:%d backend=%s model=%s" % (args.port, BACKEND, MODEL_NAME),
          flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
