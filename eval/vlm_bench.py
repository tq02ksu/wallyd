#!/usr/bin/env python3
"""慢路径实测：对本地 miniCPM-V（mlx_vlm.server 的 OpenAI 兼容接口）发同一批图片，量单帧延迟。

不依赖第三方包（只用标准库）；服务端必须在**沙箱外**跑（MLX 需要 Metal）。
环境变量：MINICPM_MODEL / MINICPM_BASE_URL / BENCH_PROMPT / BENCH_MAX_TOKENS / BENCH_REPS
输出 CSV：image,rep,seconds,prompt_tokens,completion_tokens,text
"""
import base64
import json
import mimetypes
import os
import pathlib
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve()
MODEL = os.environ.get("MINICPM_MODEL", "/Users/tq02ksu/workspace/bot/models/MiniCPM-V-4.6-4bit")
BASE = os.environ.get("MINICPM_BASE_URL", "http://127.0.0.1:8080/v1")
PROMPT = os.environ.get("BENCH_PROMPT", "用一句话描述这张图片。")
MAXTOK = int(os.environ.get("BENCH_MAX_TOKENS", "32"))
REPS = int(os.environ.get("BENCH_REPS", "2"))

# 坑：macOS 的**系统代理**会让 urllib 把 127.0.0.1 的请求也发给代理（返回 502 Bad Gateway），
# 而 curl 只认环境变量、不受影响 —— 所以这里显式禁用代理（同一现象见 docs/poc-design.md 的"两个必须写进实现的坑"）。
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def image_part(path: str) -> dict:
    mime = mimetypes.guess_type(path)[0] or "image/jpeg"
    with open(path, "rb") as fh:
        b64 = base64.b64encode(fh.read()).decode()
    return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}


def call(path: str) -> tuple:
    payload = {
        "model": MODEL,
        "messages": [{"role": "user", "content": [{"type": "text", "text": PROMPT}, image_part(path)]}],
        "max_tokens": MAXTOK,
    }
    req = urllib.request.Request(
        f"{BASE}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    t0 = time.perf_counter()
    with OPENER.open(req, timeout=600) as resp:
        data = json.load(resp)
    dt = time.perf_counter() - t0
    usage = data.get("usage", {}) or {}
    text = (data["choices"][0]["message"]["content"] or "").strip().replace("\n", " ")[:80]
    return dt, usage.get("prompt_tokens"), usage.get("completion_tokens"), text


def main() -> None:
    images = sys.argv[1:]
    if not images:
        print("usage: vlm_bench.py <image>...", file=sys.stderr)
        sys.exit(2)

    warm, _, _, _ = call(images[0])          # 预热（Metal kernel / 首次加载图像编码器）
    print(f"warmup_seconds,{warm:.2f}")
    print("image,rep,seconds,prompt_tokens,completion_tokens,text")
    raw = []
    for path in images:
        name = os.path.basename(path)
        for rep in range(REPS):
            dt, pt, ct, text = call(path)
            raw.append((dt, pt, ct, text))
            print(f"{name},{rep + 1},{dt:.2f},{pt},{ct},{text}")
    dts = [r[0] for r in raw]
    cts = [r[2] for r in raw if r[2]]
    print(f"\nsummary n={len(dts)} mean={sum(dts) / len(dts):.2f}s "
          f"min={min(dts):.2f}s max={max(dts):.2f}s "
          f"| completion_tokens mean={sum(cts) / len(cts):.1f}" if cts else "")
    if cts:
        print(f"throughput ≈ {sum(cts) / sum(dts):.1f} tok/s")


if __name__ == "__main__":
    main()
