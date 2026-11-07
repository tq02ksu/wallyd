"""GH-6 步骤 1：逐样本对齐的比较器（Linux 可判定）。"""

from __future__ import annotations

import importlib.util
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "eval" / "aec3" / "compare_wav.py"


def load_module():
    spec = importlib.util.spec_from_file_location("compare_wav", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_wav(path: Path, samples: list[int]) -> None:
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(16000)
        f.writeframes(b"".join(int(s).to_bytes(2, "little", signed=True) for s in samples))


def test_identical_wav_is_accepted(tmp_path):
    mod = load_module()
    a, b = tmp_path / "a.wav", tmp_path / "b.wav"
    write_wav(a, [0, 1, -1, 32767, -32768])
    write_wav(b, [0, 1, -1, 32767, -32768])

    ok, message = mod.compare(a, b, 0)

    assert ok, message
    assert "逐字节一致" in message


def test_single_sample_difference_fails_at_the_right_index(tmp_path):
    mod = load_module()
    a, b = tmp_path / "a.wav", tmp_path / "b.wav"
    write_wav(a, [0, 100, 200])
    write_wav(b, [0, 101, 200])

    ok, message = mod.compare(a, b, 0)

    assert not ok
    assert "首个索引 1" in message
    assert "最大差 1" in message


def test_tolerance_allows_small_differences_but_not_large_ones(tmp_path):
    mod = load_module()
    a, b = tmp_path / "a.wav", tmp_path / "b.wav"
    write_wav(a, [0, 100])
    write_wav(b, [0, 103])

    assert mod.compare(a, b, 0)[0] is False
    assert mod.compare(a, b, 3)[0] is True
    assert mod.compare(a, b, 2)[0] is False


def test_length_mismatch_is_reported(tmp_path):
    mod = load_module()
    a, b = tmp_path / "a.wav", tmp_path / "b.wav"
    write_wav(a, [0, 1, 2])
    write_wav(b, [0, 1])

    ok, message = mod.compare(a, b, 0)

    assert not ok
    assert "样本字节数不同" in message
