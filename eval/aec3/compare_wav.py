#!/usr/bin/env python3
"""Byte-exact WAV comparison for the AEC3 wrapper contract (GH-6 step 1).

The Swift wrapper is only accepted when its output is **sample-identical** to
``aec3_eval.cc`` on the same fixed PCM. Listening is not evidence. This script is
the deterministic check:

    python3 eval/aec3/compare_wav.py expected.wav actual.wav
    python3 eval/aec3/compare_wav.py expected.wav actual.wav --tolerance 0

Exit codes: 0 identical, 1 different, 2 usage/format error.

Only PCM 16-bit WAVs are supported: the bridge and evaluator both write 16-bit
mono 16 kHz, and claiming support for shapes we do not test would be worse than
failing loudly.
"""

from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path


class WavError(ValueError):
    pass


def read_wav(path: Path) -> tuple[tuple[int, int, int], bytes]:
    data = path.read_bytes()
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise WavError(f"{path}: 不是 RIFF/WAVE 文件")

    fmt: tuple[int, int, int] | None = None
    payload: bytes | None = None
    pos = 12
    while pos + 8 <= len(data):
        chunk_id = data[pos : pos + 4]
        size = struct.unpack_from("<I", data, pos + 4)[0]
        body = data[pos + 8 : pos + 8 + size]
        if len(body) != size:
            raise WavError(f"{path}: chunk {chunk_id!r} 截断")
        if chunk_id == b"fmt ":
            if size < 16:
                raise WavError(f"{path}: fmt chunk 过短")
            _audio_format, channels, rate, _byte_rate, _block_align, bits = struct.unpack_from(
                "<HHIIHH", body, 0
            )
            if _audio_format != 1 or bits != 16:
                raise WavError(f"{path}: 只支持 PCM16（format={_audio_format}, bits={bits}）")
            fmt = (channels, rate, bits)
        elif chunk_id == b"data":
            payload = body
        pos += 8 + size + (size & 1)  # chunks are word-aligned

    if fmt is None:
        raise WavError(f"{path}: 缺 fmt chunk")
    if payload is None:
        raise WavError(f"{path}: 缺 data chunk")
    return fmt, payload


def compare(expected: Path, actual: Path, tolerance: int) -> tuple[bool, str]:
    fmt_e, samples_e = read_wav(expected)
    fmt_a, samples_a = read_wav(actual)
    if fmt_e != fmt_a:
        return False, f"格式不同：expected={fmt_e} actual={fmt_a}"
    if len(samples_e) != len(samples_a):
        return False, f"样本字节数不同：expected={len(samples_e)} actual={len(samples_a)}"
    if tolerance == 0 and samples_e == samples_a:
        return True, f"逐字节一致（{len(samples_e) // 2} 个样本，{fmt_e[1]} Hz x {fmt_e[0]} ch）"

    count_e = len(samples_e) // 2
    differing = 0
    first = -1
    worst = 0
    for i in range(count_e):
        a = struct.unpack_from("<h", samples_e, i * 2)[0]
        b = struct.unpack_from("<h", samples_a, i * 2)[0]
        delta = abs(a - b)
        if delta > 0:
            differing += 1
            if first < 0:
                first = i
            worst = max(worst, delta)
    if differing == 0:
        return True, f"逐样本一致（{count_e} 个样本）"
    if tolerance and worst <= tolerance:
        return True, f"在容差内一致（{count_e} 个样本，最大差 {worst}）"
    return False, (
        f"不一致：{differing}/{count_e} 个样本不同，首个索引 {first}，最大差 {worst}"
        f"（容差 {tolerance}）"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="逐样本比较两个 PCM16 WAV")
    parser.add_argument("expected")
    parser.add_argument("actual")
    parser.add_argument("--tolerance", type=int, default=0, help="允许的整数样本最大差（默认 0）")
    args = parser.parse_args(argv)
    try:
        ok, message = compare(Path(args.expected), Path(args.actual), args.tolerance)
    except (OSError, WavError) as exc:
        print(f"FAIL {exc}", file=sys.stderr)
        return 2
    print(("OK " if ok else "FAIL ") + message)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
