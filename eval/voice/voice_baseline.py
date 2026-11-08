#!/usr/bin/env python3
"""WALLY 语音回归基线（GH-14）。

一条命令量 6 项 §11 指标：首字延迟、ASR 最终延迟、TTS 首包、打断响应、
自听误触发率、采集连续性。每项要么 ``measured``，要么 ``skipped`` 并给出原因；
缺硬件只降级该项，绝不中断整条基线（退出码 3 = 不完整，不是崩）。

数据来源（只读，不改 robotd 判定逻辑，也不改契约）：

- ASR 首字/最终：``swift scripts/mac_speech.swift stream --file <夹具>`` 的 NDJSON
  （``--file`` 与麦克风走同一条转换/VAD/ASR 管线，见脚本头注释）；
- TTS 首包：``swift scripts/mac_speech.swift speak-stream`` 的 NDJSON（真播，非 dry-run）；
- 打断响应 / 自听误触发率：需要 serve 桥同时播报 + 回采，随 #41 AEC harness 落地；
- 采集连续性：``stream`` 麦克风模式长跑（``--with-long-run``）。

判定：§11 绝对值门槛与「相对基线退步 > 20%」同时生效，两者取严。

退出码：0 = 6 项全 measured 且全过；1 = 有 FAIL；2 = 参数/工具错误；
3 = 不完整（有 SKIP，或某项没拿到样本），但报告是完整的。
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import math
import platform
import re
import shutil
import subprocess
import sys
import threading
import time
import wave
from pathlib import Path

SCHEMA = "wallyd.voice-baseline/1"

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SPEECH_SCRIPT = ROOT / "scripts" / "mac_speech.swift"
FIXTURE_SCRIPT = ROOT / "scripts" / "speech_fixture.swift"
DEFAULT_FIXTURES = HERE / "fixtures"
DEFAULT_BASELINE = HERE / "baseline.json"
DEFAULT_OUT_DIR = HERE / "runs"

# 指标顺序 = 摘要顺序 = 报告顺序；新增指标必须同时改 METRIC_LABELS。
METRICS = (
    "first_token",
    "asr_final",
    "tts_first_chunk",
    "barge_in",
    "self_trigger",
    "capture_continuity",
)
METRIC_LABELS = {
    "first_token": "首字延迟",
    "asr_final": "ASR 最终延迟",
    "tts_first_chunk": "TTS 首包",
    "barge_in": "打断响应",
    "self_trigger": "自听误触发率",
    "capture_continuity": "采集连续性",
}

# §11 绝对值门槛（ms）。self_trigger 是计数门槛，不进这张表。
THRESHOLD_MS = {
    "first_token": 800.0,
    "asr_final": 1500.0,
    "tts_first_chunk": 800.0,
    "barge_in": 300.0,
    # §11 只说「30 分钟无非预期断流」，没有数字门槛。这里给一个代理阈值：
    # 相邻事件间隔 > 2s 视为疑似断流。它比 §11 更容易判红，方向上是保守的。
    "capture_continuity": 2000.0,
}
THRESHOLD_SOURCE = {
    "first_token": "§11",
    "asr_final": "§11",
    "tts_first_chunk": "§11",
    "barge_in": "§11",
    "self_trigger": "§11",
    "capture_continuity": "GH-14 代理阈值（§11 无数字门槛）",
}
SELF_TRIGGER_MAX = 0.0
RELATIVE_LIMIT = 0.20

SOURCE_VALUES = ("synthesized", "recorded", "pending-hardware")
KINDS = ("single_utterance", "multi_speaker", "silence", "barge_in")
AUDIO_SUFFIXES = (".caf", ".wav", ".aiff", ".aif", ".m4a")

FIXTURE_LEAD_MS = 900
FIXTURE_TAIL_MS = 1400
FIXTURE_RATE = 0.5
SILENCE_SAMPLE_RATE = 16000
TTS_TEXT = "你好，我是瓦力。这是一次语音首包延迟测试。"

BASIS = {
    "first_token": "音频时间轴：首个 partial 的 audio_end_ms - VAD 判开口的 audio_ms",
    "asr_final": "file: endpoint.silence_ms + (final.ts_mono_ns - endpoint.ts_mono_ns)；mic: 墙钟 final - 静音起点",
    "tts_first_chunk": "进程内单调时钟：tts_chunk_started(第 0 块) - tts_started",
    "barge_in": "墙钟：用户开口 - 停止播放（需 serve 桥单进程同时产出两侧事件）",
    "self_trigger": "播放期 VAD 判开口的次数（§11: 应为 0）",
    "capture_continuity": "真机：--trace 的 feed 心跳最大间隔；replay：事件间隔（桥不吐帧序号）",
}


class FixtureError(Exception):
    """夹具标注不合法（fail closed，不猜字段）。"""


def now_iso() -> str:
    return _dt.datetime.now().astimezone().isoformat(timespec="seconds")


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def new_runs_dir(base: Path | None = None) -> Path:
    """本次运行的落盘目录 ``runs/<UTC 时间戳>/``（GH-45）。

    只算路径、不建目录：目录在第一次真正采集时由 ``run_streaming`` 创建，
    所以 replay 运行（没有子进程事件）不会留下一堆空目录。
    """
    root = Path(base) if base is not None else DEFAULT_OUT_DIR
    stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    candidate = root / stamp
    suffix = 1
    while candidate.exists():
        candidate = root / f"{stamp}-{suffix}"
        suffix += 1
    return candidate


# ---------------------------------------------------------------- 统计
def percentile(values: list[float], quantile: float) -> float:
    """最近秩百分位（nearest-rank）。

    n 很小（一轮 5–8 个样本）时线性插值会给出不存在的样本值，最近秩更诚实：
    p95 在 n<20 时就是最大值，判红方向保守。
    """
    if not values:
        raise ValueError("percentile() 需要至少一个样本")
    ordered = sorted(values)
    rank = max(1, math.ceil(quantile / 100.0 * len(ordered)))
    return float(ordered[min(rank, len(ordered)) - 1])


def delta_pct(a: float, b: float) -> float:
    """两次运行之间的相对波动，分母取较小值（更严）。"""
    base = min(a, b)
    if base <= 0:
        return 0.0 if a == b else float("inf")
    return abs(a - b) / base * 100.0


# ---------------------------------------------------------------- NDJSON
def _classify_line(raw: str) -> tuple[str, dict | None]:
    """把一行 stdout 分类成事件 / 桥错误 / 坏行 / 空行。

    流式读时每读一行就要立刻下判断，所以单行分类单独抽出来；
    ``parse_ndjson`` 与 ``run_streaming`` 共用它，语义只有一处。
    """
    line = raw.strip()
    if not line:
        return "blank", None
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        return "malformed", None
    if not isinstance(obj, dict):
        return "malformed", None
    if obj.get("ok") is False and "error" in obj:
        return "error", obj["error"] if isinstance(obj["error"], dict) else {"message": str(obj["error"])}
    return "event", obj


def parse_ndjson(lines: list[str]) -> tuple[list[dict], dict | None, int]:
    """解析桥的 NDJSON。返回 (事件, 桥错误, 坏行数)。

    坏行不猜语义，只计数；``ok:false`` 的对象是桥的 fail() 输出，单独返回。
    """
    events: list[dict] = []
    error: dict | None = None
    malformed = 0
    for raw in lines:
        kind, value = _classify_line(raw)
        if kind == "malformed":
            malformed += 1
        elif kind == "error":
            error = value
        elif kind == "event" and value is not None:
            events.append(value)
    return events, error, malformed


def _first(events: list[dict], predicate) -> dict | None:
    for event in events:
        if predicate(event):
            return event
    return None


def _mono_ms(event: dict) -> float | None:
    ns = event.get("ts_mono_ns")
    if isinstance(ns, (int, float)):
        return float(ns) / 1e6
    t_ms = event.get("t_ms")
    if isinstance(t_ms, (int, float)):
        return float(t_ms)
    return None


def _num(value) -> float | None:
    return float(value) if isinstance(value, (int, float)) else None


def speech_onset_audio_ms(events: list[dict]) -> float | None:
    event = _first(events, lambda e: e.get("ev") == "speech_state" and e.get("state") == "speech")
    return None if event is None else _num(event.get("audio_ms"))


def first_token_ms(events: list[dict]) -> float | None:
    """首个 partial 覆盖到的音频末尾 - 开口位置。

    用音频时间轴而不是墙钟：``--file`` 模式灌数据比实时快得多，墙钟会把
    「说多久才出字」压缩成「ASR 算多快」，5s 与 60s 夹具就不可比了。
    """
    onset = speech_onset_audio_ms(events)
    partial = _first(events, lambda e: e.get("ev") == "partial" and _num(e.get("audio_end_ms")) is not None)
    if onset is None or partial is None:
        return None
    return max(0.0, float(partial["audio_end_ms"]) - onset)


def asr_final_ms(events: list[dict], basis: str) -> float | None:
    """说完 → final。

    ``file`` 模式：端点那 700ms 静音是音频时间轴上的，finalize 的尾巴才是墙钟，
    所以两者相加；只用墙钟会把 700ms 静音压成 ~0。``mic`` 模式全程墙钟。
    """
    final = _first(events, lambda e: e.get("ev") == "final")
    if final is None:
        return None
    final_ms = _mono_ms(final)
    if final_ms is None:
        return None
    if basis == "mic":
        silence = _first(events, lambda e: e.get("ev") == "speech_state" and e.get("state") == "silence")
        silence_ms = None if silence is None else _mono_ms(silence)
        if silence_ms is None:
            return None
        return max(0.0, final_ms - silence_ms)
    endpoint = _first(events, lambda e: e.get("ev") == "endpoint")
    if endpoint is None:
        return None
    endpoint_ms = _mono_ms(endpoint)
    silence_ms = _num(endpoint.get("silence_ms"))
    if endpoint_ms is None or silence_ms is None:
        return None
    return max(0.0, silence_ms) + max(0.0, final_ms - endpoint_ms)


def tts_first_chunk_ms(events: list[dict]) -> float | None:
    """提交文本 → 首块开始播。

    ``speak-stream --dry-run`` 不碰音频设备，它的 tts_chunk_started 是模拟值，
    不能当测量：返回 None，由调用方标 SKIP。
    """
    started = _first(events, lambda e: e.get("ev") == "tts_started")
    if started is None or started.get("dry_run") is True:
        return None
    chunk = _first(events, lambda e: e.get("ev") == "tts_chunk_started" and int(e.get("index", -1)) == 0)
    if chunk is None:
        return None
    start_ms = _mono_ms(started)
    chunk_ms = _mono_ms(chunk)
    if start_ms is None or chunk_ms is None:
        return None
    return max(0.0, chunk_ms - start_ms)


def speech_finals(events: list[dict]) -> int:
    """有文本的 final 数。

    ``--file`` 到 EOF 总会吐一个 final 信封（纯静音时文本为空）。静音夹具的判据是
    「空文本 final 不算语音 final」，否则 D 永远判红。
    """
    return sum(1 for e in events if e.get("ev") == "final" and str(e.get("text") or "").strip())


def partial_count(events: list[dict]) -> int:
    return sum(1 for e in events if e.get("ev") == "partial")


def speech_onset_count(events: list[dict]) -> int:
    return sum(1 for e in events if e.get("ev") == "speech_state" and e.get("state") == "speech")


def max_event_gap_ms(events: list[dict]) -> float | None:
    stamps = [value for value in (_mono_ms(e) for e in events) if value is not None]
    if len(stamps) < 2:
        return None
    return max(b - a for a, b in zip(stamps, stamps[1:]))


CAPTURE_TRACE = re.compile(r"\[mac_speech\] feed #(\d+) in=\d+ t=(\d+)ms")


def parse_capture_trace(text: str) -> list[dict]:
    """解析 `stream --trace` 的 stderr 心跳：`[mac_speech] feed #N in=… t=…ms`。

    桥不吐帧序号，这是它唯一能证明「采集还在走」的信号：每 ~25 个 tap（≈1s）一行。
    """
    entries = []
    for match in CAPTURE_TRACE.finditer(text or ""):
        entries.append({"feed": int(match.group(1)), "t_ms": int(match.group(2))})
    return entries


def continuity_from_trace(entries: list[dict]) -> dict:
    """心跳间隔 + feed 序号单调性（丢帧/重排时序号会不单调）。"""
    if len(entries) < 2:
        return {"feeds": len(entries), "max_gap_ms": None, "monotonic": True}
    gaps = [b["t_ms"] - a["t_ms"] for a, b in zip(entries, entries[1:])]
    feeds = [entry["feed"] for entry in entries]
    return {
        "feeds": len(entries),
        "max_gap_ms": float(max(gaps)),
        "monotonic": all(b > a for a, b in zip(feeds, feeds[1:])),
    }


# ---------------------------------------------------------------- 夹具
REQUIRED_FIXTURE_FIELDS = ("fixture", "kind", "duration_ms", "source", "expected", "notes")


def validate_fixture(data: dict, path: Path) -> list[str]:
    """严格校验标注。返回问题列表（空 = 合法）。"""
    problems: list[str] = []
    if not isinstance(data, dict):
        return [f"{path}: 标注必须是 JSON 对象"]
    for key in REQUIRED_FIXTURE_FIELDS:
        if key not in data:
            problems.append(f"{path}: 缺少必填字段 {key}")
    if problems:
        return problems

    if not isinstance(data["fixture"], str) or not data["fixture"].strip():
        problems.append(f"{path}: fixture 必须是非空字符串")
    if data["kind"] not in KINDS:
        problems.append(f"{path}: kind={data['kind']!r} 不在 {list(KINDS)}")
    if data["source"] not in SOURCE_VALUES:
        problems.append(f"{path}: source={data['source']!r} 不在 {list(SOURCE_VALUES)}")
    if not isinstance(data["duration_ms"], int) or data["duration_ms"] < 0:
        problems.append(f"{path}: duration_ms 必须是非负整数")
    if not isinstance(data["notes"], str) or not data["notes"].strip():
        problems.append(f"{path}: notes 必须说明夹具来源与限制（不能空）")

    expected = data["expected"]
    if not isinstance(expected, dict):
        problems.append(f"{path}: expected 必须是对象")
    else:
        if not isinstance(expected.get("utterances"), int) or expected["utterances"] < 0:
            problems.append(f"{path}: expected.utterances 必须是非负整数")
        texts = expected.get("texts")
        if not isinstance(texts, list) or any(not isinstance(t, str) for t in texts):
            problems.append(f"{path}: expected.texts 必须是字符串数组")
        elif isinstance(expected.get("utterances"), int) and len(texts) != expected["utterances"]:
            problems.append(f"{path}: expected.texts 长度必须等于 expected.utterances")

    generate = data.get("generate")
    if data["source"] == "synthesized":
        if not isinstance(generate, dict) or not generate:
            problems.append(f"{path}: source=synthesized 必须给 generate 段（怎么生成）")
        elif data["kind"] == "silence":
            if not isinstance(generate.get("silence_ms"), int) or generate["silence_ms"] <= 0:
                problems.append(f"{path}: 静音夹具的 generate.silence_ms 必须是正整数")
        else:
            segments = generate.get("segments")
            if not isinstance(segments, list) or not segments:
                problems.append(f"{path}: generate.segments 必须是非空数组")
            else:
                for index, segment in enumerate(segments):
                    if not isinstance(segment, dict):
                        problems.append(f"{path}: generate.segments[{index}] 必须是对象")
                        continue
                    if not isinstance(segment.get("text"), str) or not segment["text"].strip():
                        problems.append(f"{path}: generate.segments[{index}].text 必须是非空字符串")
    if data["source"] == "recorded" and generate:
        problems.append(f"{path}: source=recorded 不许带 generate（脚本不合成真人录音）")
    if data["source"] == "recorded":
        audio = data.get("audio")
        if isinstance(audio, str):
            audio = [audio]
        if not isinstance(audio, list) or not audio or any(not isinstance(a, str) or not a for a in audio):
            problems.append(f"{path}: source=recorded 必须给 audio（录音文件相对路径，字符串或字符串数组）")
    if data["source"] == "pending-hardware":
        if generate:
            problems.append(f"{path}: source=pending-hardware 不许带 generate")
        if isinstance(expected, dict) and expected.get("utterances") not in (0, None):
            problems.append(f"{path}: pending-hardware 夹具 expected.utterances 必须是 0")

    # 反作弊：pending-hardware 目录里出现音频文件 = 有人拿假 CAF 冒充真机录音。
    if data["source"] == "pending-hardware" and isinstance(data.get("fixture"), str):
        for suffix in AUDIO_SUFFIXES:
            if (path.parent / f"{data['fixture']}{suffix}").exists():
                problems.append(
                    f"{path}: pending-hardware 夹具旁边出现了 {data['fixture']}{suffix}；"
                    "真机录音必须走 source=recorded 并留下采集说明"
                )
    return problems


class Fixture:
    def __init__(self, path: Path, data: dict):
        self.path = path
        self.data = data
        self.name = data["fixture"]
        self.kind = data["kind"]
        self.source = data["source"]
        self.duration_ms = int(data["duration_ms"])
        self.expected = data["expected"]
        self.notes = data["notes"]
        self.generate = data.get("generate") or {}
        self.voice = data.get("voice")

    @property
    def measurable(self) -> bool:
        return self.source != "pending-hardware" and self.kind != "barge_in"

    def clips(self) -> list[dict]:
        """一次可喂给 stream 的音频单元。

        ``multi_speaker`` 的「轮流」在 run 序列层面：每个 segment 是一段独立音频，
        按声明顺序跑完就是 A→B→A→B。单文件拼接不做（CAF 拼接需要额外音频工具，
        且会把两句话并成一个 VAD 窗口，反而测不准）。
        """
        if self.kind == "silence":
            return [
                {
                    "name": self.name,
                    "audio": self.generate.get("audio") or f"{self.name}.wav",
                    "text": "",
                    "silence_ms": int(self.generate["silence_ms"]),
                }
            ]
        if self.source == "recorded":
            files = self.data.get("audio") or []
            if isinstance(files, str):
                files = [files]
            texts = self.expected.get("texts") or []
            return [
                {
                    "name": Path(name).stem,
                    "audio": name,
                    "text": texts[index] if index < len(texts) else "",
                    "lead_ms": FIXTURE_LEAD_MS,
                    "tail_ms": FIXTURE_TAIL_MS,
                    "rate": FIXTURE_RATE,
                }
                for index, name in enumerate(files)
            ]
        segments = self.generate.get("segments") or []
        clips = []
        for index, segment in enumerate(segments):
            name = segment.get("name") or (self.name if len(segments) == 1 else f"{self.name}-{index + 1}")
            clips.append(
                {
                    "name": name,
                    "audio": segment.get("audio") or f"{name}.caf",
                    "text": segment.get("text", ""),
                    "voice_slot": segment.get("voice_slot"),
                    "lead_ms": int(segment.get("lead_ms", FIXTURE_LEAD_MS)),
                    "tail_ms": int(segment.get("tail_ms", FIXTURE_TAIL_MS)),
                    "rate": float(segment.get("rate", FIXTURE_RATE)),
                }
            )
        return clips

    def audio_path(self, clip: dict) -> Path:
        return (self.path.parent / clip["audio"]).resolve()


def load_fixtures(fixtures_dir: Path) -> list[Fixture]:
    if not fixtures_dir.is_dir():
        raise FixtureError(f"夹具目录不存在：{fixtures_dir}")
    fixtures: list[Fixture] = []
    problems: list[str] = []
    seen: dict[str, Path] = {}
    for path in sorted(fixtures_dir.rglob("*.json")):
        if path.name.endswith(".generated.json"):
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            problems.append(f"{path}: JSON 解析失败：{exc}")
            continue
        found = validate_fixture(data, path)
        problems.extend(found)
        if found:
            continue
        name = data["fixture"]
        if name in seen:
            problems.append(f"{path}: fixture 名 {name!r} 与 {seen[name]} 重复")
            continue
        seen[name] = path
        fixtures.append(Fixture(path, data))
    if problems:
        raise FixtureError("\n".join(problems))
    if not fixtures:
        raise FixtureError(f"夹具目录里没有任何标注：{fixtures_dir}")
    return fixtures


# ---------------------------------------------------------------- 生成
def speech_fixture_command(clip: dict, out_path: Path, voice: str | None) -> list[str]:
    command = [
        "swift",
        str(FIXTURE_SCRIPT),
        "--text",
        clip["text"],
        "--out",
        str(out_path),
        "--lead-ms",
        str(clip["lead_ms"]),
        "--tail-ms",
        str(clip["tail_ms"]),
        "--rate",
        str(clip["rate"]),
    ]
    if voice:
        command += ["--voice", voice]
    return command


def write_silent_wav(path: Path, total_ms: int, sample_rate: int = SILENCE_SAMPLE_RATE) -> None:
    """纯标准库写 16bit 单声道 WAV。

    不走 speech_fixture.swift：它对空文本会以 E_TTS_EMPTY 失败（合成器不产出缓冲），
    而静音夹具要的正是「没有人声」。
    """
    frames = int(sample_rate * total_ms / 1000)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        chunk = b"\x00\x00" * min(frames, sample_rate * 5)
        remaining = frames
        while remaining > 0:
            take = min(remaining, sample_rate * 5)
            handle.writeframes(chunk[: take * 2])
            remaining -= take


def resolve_voices(env: dict) -> list[str]:
    """中文音色，普通话（zh-CN）优先；两个不同音色用于 B 类轮流。"""
    voices = [v for v in (env.get("zh_voices") or []) if v.get("identifier")]
    mainland = [
        v for v in voices if str(v.get("language") or "").replace("_", "-").lower().startswith("zh-cn")
    ]
    ordered = mainland + [v for v in voices if v not in mainland]
    return [v["identifier"] for v in ordered]


def generate_clip(fixture: Fixture, clip: dict, env: dict, timeout: float = 180.0) -> dict:
    """生成一个夹具片段；返回 {status, audio, reason?, total_ms?, voice?, sha256?}。"""
    out_path = fixture.audio_path(clip)
    if out_path.exists():
        return {"status": "present", "audio": str(out_path.relative_to(ROOT)) if out_path.is_relative_to(ROOT) else str(out_path)}

    if fixture.source == "recorded":
        return {
            "status": "missing",
            "reason": "needs-recording: source=recorded 的夹具必须人工录制并放到标注的路径",
        }
    try:
        if fixture.kind == "silence":
            # 静音是纯标准库写的 WAV，不需要 swift / macOS。
            write_silent_wav(out_path, int(clip["silence_ms"]))
            meta = {"generator": "silence-wav", "silence_ms": int(clip["silence_ms"]), "sample_rate": SILENCE_SAMPLE_RATE}
        else:
            if not shutil.which("swift"):
                return {"status": "missing", "reason": "needs-swift-toolchain: 找不到 swift，无法合成夹具"}
            if platform.system() != "Darwin":
                return {"status": "missing", "reason": "needs-macos: 语音夹具合成依赖 AVSpeechSynthesizer"}
            voices = resolve_voices(env)
            voice = clip.get("voice") or fixture.voice
            slot = clip.get("voice_slot")
            if slot in ("A", "B"):
                index = 0 if slot == "A" else 1
                if len(voices) <= index:
                    return {
                        "status": "generate-failed",
                        "reason": f"E_TTS_VOICE_COUNT: 需要至少 {index + 1} 个中文音色，实际 {len(voices)}",
                    }
                voice = voices[index]
            if voice and voice in ("zh-CN", "zh_CN"):
                voice = voices[0] if voices else voice
            command = speech_fixture_command(clip, out_path, voice)
            # 非采集用途：这里合成夹具音频，一次性拿生成参数即可（GH-45 只改测量采集层）。
            proc = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
            parsed, error, malformed = parse_ndjson(proc.stdout.splitlines())
            if proc.returncode != 0 or error is not None or malformed:
                reason = (error or {}).get("code") or f"exit-{proc.returncode}"
                return {"status": "generate-failed", "reason": f"{reason}: {(error or {}).get('message', proc.stderr.strip()[-300:])}"}
            payload = parsed[-1].get("data", {}) if parsed else {}
            meta = {
                "generator": "speech_fixture.swift",
                "args": command[1:],
                "voice": payload.get("voice") or voice,
                "speech_ms": payload.get("speech_ms"),
                "total_ms": payload.get("total_ms"),
                "lead_ms": clip["lead_ms"],
                "tail_ms": clip["tail_ms"],
            }
        write_json(out_path.with_suffix(out_path.suffix + ".generated.json"), {"schema": SCHEMA, **meta, "sha256": sha256_file(out_path)})
        result = {"status": "generated", "audio": str(out_path.relative_to(ROOT)) if out_path.is_relative_to(ROOT) else str(out_path)}
        if isinstance(meta.get("total_ms"), int):
            result["total_ms"] = meta["total_ms"]
            if fixture.duration_ms > 0:
                result["duration_delta_pct"] = round((meta["total_ms"] - fixture.duration_ms) / fixture.duration_ms * 100.0, 1)
        return result
    except subprocess.TimeoutExpired:
        return {"status": "generate-failed", "reason": f"合成超时（{timeout:.0f}s）"}
    except OSError as exc:
        return {"status": "generate-failed", "reason": f"{type(exc).__name__}: {exc}"}


# ---------------------------------------------------------------- 环境
def _run_probe(args: list[str], timeout: float = 30.0) -> dict:
    # 非采集用途：环境探测（short-lived probe），不产生待测量的事件流。
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "error": {"code": "E_PROBE", "message": f"{type(exc).__name__}: {exc}"}}
    events, error, _ = parse_ndjson(proc.stdout.splitlines())
    if error is not None:
        return {"ok": False, "error": error}
    for event in events:
        if event.get("ok") is True:
            return {"ok": True, "data": event.get("data") or {}}
    return {"ok": False, "error": {"code": "E_PROBE_EMPTY", "message": "probe 没有任何 JSON 输出"}}


def speaker_name() -> str:
    """默认输出设备名。取不到就 unknown —— 不许编。"""
    if platform.system() != "Darwin" or not shutil.which("system_profiler"):
        return "unknown"
    try:
        # 非采集用途：读取系统音频设备名，不产生事件流。
        proc = subprocess.run(
            ["system_profiler", "SPAudioDataType"], capture_output=True, text=True, timeout=30
        )
    except (OSError, subprocess.TimeoutExpired):
        return "unknown"
    name = "unknown"
    for line in proc.stdout.splitlines():
        stripped = line.strip()
        if stripped.endswith(":") and not stripped.lower().startswith(("audio", "devices")):
            name = stripped.rstrip(":").strip()
        if "Default Output Device: Yes" in stripped:
            return name
    return "unknown"


def probe_environment() -> dict:
    env: dict = {
        "platform": platform.system(),
        "machine": platform.machine(),
        "macos_version": platform.mac_ver()[0] or None,
        "swift": shutil.which("swift"),
        "probe_error": None,
        "mic_authorization": "unknown",
        "mic_name": "unknown",
        "speaker_name": "unknown",
        "zh_voices": [],
        "asr": {},
    }
    if env["platform"] == "Darwin" and env["swift"]:
        result = _run_probe(["swift", str(SPEECH_SCRIPT), "list"])
        if result["ok"]:
            data = result["data"]
            env["mic_authorization"] = data.get("microphone_authorization") or "unknown"
            mics = data.get("microphones") or []
            if mics:
                env["mic_name"] = mics[0].get("name") or "unknown"
            env["zh_voices"] = (data.get("tts") or {}).get("zh_voices") or []
            env["asr"] = data.get("asr") or {}
        else:
            env["probe_error"] = result["error"]
    env["speaker_name"] = speaker_name()
    return env


def asr_skip_reason(env: dict) -> str | None:
    """离线 ASR 车道为什么跑不了；None = 可以跑。"""
    if env.get("replay"):
        return None
    if env["platform"] != "Darwin":
        return f"needs-macos: 本机是 {env['platform']}，--file ASR 需要 AVSpeech/SpeechAnalyzer（macOS 26+）"
    if not env.get("swift"):
        return "needs-swift-toolchain: 找不到 swift"
    if env.get("probe_error"):
        error = env["probe_error"]
        return f"needs-macos-toolchain: mac_speech list 失败（{error.get('code')}: {error.get('message')}）"
    asr = env.get("asr") or {}
    if asr.get("error"):
        return f"needs-macos-26-asr: {asr['error']}"
    if asr.get("is_available") is False:
        return "needs-macos-26-asr: SpeechTranscriber.isAvailable=false"
    status = str(asr.get("zh_asset_status") or "").lower()
    if status and "installed" not in status and "supported" not in status:
        return f"needs-asr-asset: 中文 ASR 资产状态={asr.get('zh_asset_status')}"
    if env.get("mic_authorization") != "authorized":
        # 实测：mac_speech.swift 的 stream 在解析 --file 之前就检查 micAuth()，
        # 所以「没有麦克风授权」时离线车道同样起不来。如实标注，不伪造。
        return (
            "needs-mic-permission: 麦克风授权="
            f"{env.get('mic_authorization')}；mac_speech.swift 的 stream 在 --file 分支前仍检查 micAuth()"
        )
    return None


def tts_skip_reason(env: dict, no_playback: bool) -> str | None:
    if env.get("replay"):
        return None
    if no_playback:
        return "not-requested: --no-playback（TTS 首包需要真喇叭）"
    if env["platform"] != "Darwin":
        return f"needs-hardware: 本机是 {env['platform']}，TTS 首包需要 macOS 默认输出设备"
    if not env.get("swift"):
        return "needs-swift-toolchain: 找不到 swift"
    if env.get("probe_error"):
        return "needs-macos-toolchain: mac_speech list 失败"
    return None


def continuity_skip_reason(env: dict, with_long_run: bool) -> str | None:
    if env.get("replay"):
        return None
    if not with_long_run:
        return "not-requested: 需要 --with-long-run（默认不跑 30 分钟真机采集）"
    if env["platform"] != "Darwin" or not env.get("swift"):
        return "needs-hardware: 采集连续性只能真机（麦克风长跑）"
    if env.get("mic_authorization") != "authorized":
        return f"needs-mic-permission: 麦克风授权={env.get('mic_authorization')}"
    return None


# ---------------------------------------------------------------- 执行
def safe_stem(*parts: str) -> str:
    """`<fixture>.<clip>.run<N>` 之类的文件名前缀；不许把路径分隔符带进 runs/。"""
    joined = ".".join(str(part) for part in parts)
    return re.sub(r"[^A-Za-z0-9._-]+", "_", joined).strip("._") or "run"


def _append_line(handle, text: str) -> None:
    """读完一行立刻落盘；读线程可能在主线程关文件之后才收到最后一行，忽略即可。"""
    try:
        handle.write(text)
        handle.flush()
    except (OSError, ValueError):
        pass


def run_streaming(
    command: list[str],
    timeout: float,
    *,
    runs_dir: Path | None = None,
    stem: str | None = None,
    stdin_lines: list[str] | None = None,
    on_event=None,
    terminate_grace: float = 5.0,
) -> dict:
    """逐行实时读子进程的 NDJSON，边读边落盘（GH-45，替代 ``subprocess.run`` 一次性 dump）。

    返回结构与旧 ``run_command()`` 同构（``ok`` / ``events`` / ``error`` /
    ``malformed`` / ``stderr`` / ``stderr_full``），只多几个诊断/落盘字段：
    ``events_path`` / ``stderr_path`` / ``started_at`` / ``first_event_ms`` / ``exit_code``。

    超时或非零退出都**保留已经读到的事件**：崩溃前的事件和崩溃原因必须同时可见
    （旧实现超时直接 ``events: []``，几百条事件全丢）。

    ``first_event_ms`` 是首个事件到达的墙钟偏移，**只做诊断**，不参与任何指标：
    指标一律用事件自带的 ``ts_mono_ns`` / ``audio_ms`` / ``audio_end_ms``。

    ``ok`` 沿用旧定义 ``error is None and bool(events)``：超时后即使有事件，
    也不是成功（半截数据不能被当成完整样本）。
    """
    started_at = now_iso()
    start_mono = time.monotonic()
    base = Path(runs_dir) if runs_dir is not None else DEFAULT_OUT_DIR
    base.mkdir(parents=True, exist_ok=True)
    events_path = base / (f"{stem}.ndjson" if stem else "events.ndjson")
    stderr_path = base / (f"{stem}.stderr.log" if stem else "stderr.log")

    events: list[dict] = []
    stderr_chunks: list[str] = []
    state: dict = {"malformed": 0, "bridge_error": None, "first_event_ms": None}

    def on_stdout(raw: str) -> None:
        kind, value = _classify_line(raw)
        if kind == "event" and value is not None:
            if state["first_event_ms"] is None:
                state["first_event_ms"] = round((time.monotonic() - start_mono) * 1000.0, 3)
            events.append(value)
            # 原样落盘（只去掉行尾换行），保证改动前后的 ndjson 可逐字段比。
            _append_line(events_handle, raw.rstrip("\r\n") + "\n")
            if on_event is not None:
                on_event(value)
            return
        if kind == "malformed":
            state["malformed"] += 1
        elif kind == "error":
            state["bridge_error"] = value
        if kind in ("malformed", "error"):
            # 坏行 / 桥 fail() 输出不丢：原样记进 stderr 日志，崩溃现场还能查。
            _append_line(stderr_handle, f"[stdout] {raw.rstrip()}\n")

    def on_stderr(raw: str) -> None:
        stderr_chunks.append(raw)
        _append_line(stderr_handle, raw if raw.endswith("\n") else raw + "\n")

    def pump(stream, handler) -> None:
        try:
            for raw in stream:
                handler(raw)
        except (OSError, ValueError):
            # 主线程因超时关闭了管道/文件；已经读到的行都已落盘。
            pass

    events_handle = events_path.open("w", encoding="utf-8", buffering=1)
    stderr_handle = stderr_path.open("w", encoding="utf-8", buffering=1)
    try:
        proc = subprocess.Popen(
            command,
            stdin=subprocess.PIPE if stdin_lines is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=1,
            text=True,
        )
    except OSError as exc:
        events_handle.close()
        stderr_handle.close()
        return {
            "ok": False,
            "events": [],
            "error": {"code": "E_SPAWN", "message": f"{type(exc).__name__}: {exc}"},
            "malformed": 0,
            "stderr": "",
            "stderr_full": "",
            "events_path": None,
            "stderr_path": None,
            "started_at": started_at,
            "first_event_ms": None,
            "exit_code": None,
        }

    readers = [
        threading.Thread(target=pump, args=(proc.stdout, on_stdout), daemon=True),
        threading.Thread(target=pump, args=(proc.stderr, on_stderr), daemon=True),
    ]
    for reader in readers:
        reader.start()

    if stdin_lines is not None and proc.stdin is not None:
        def feed() -> None:
            # 喂 stdin 放到独立线程：子进程不读 stdin 时不会把主线程卡在写管道上，
            # 超时依旧生效。speak-stream 是 ``text\nend\n`` 喂法。
            try:
                for line in stdin_lines:
                    proc.stdin.write(f"{line}\n")
                proc.stdin.flush()
                proc.stdin.close()
            except (OSError, ValueError):
                pass

        threading.Thread(target=feed, daemon=True).start()

    timed_out = False
    try:
        exit_code = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        proc.terminate()
        try:
            exit_code = proc.wait(timeout=terminate_grace)
        except subprocess.TimeoutExpired:
            proc.kill()
            try:
                exit_code = proc.wait(timeout=terminate_grace)
            except subprocess.TimeoutExpired:
                exit_code = None

    for reader in readers:
        reader.join(timeout=terminate_grace)
    for stream in (proc.stdout, proc.stderr):
        try:
            stream.close()
        except (OSError, ValueError):
            pass
    events_handle.close()
    stderr_handle.close()

    stderr_full = "".join(stderr_chunks)
    if timed_out:
        error: dict | None = {
            "code": "E_TIMEOUT",
            "message": f"超时 {timeout:.0f}s；保留已读到的 {len(events)} 条事件（见 {events_path}）",
        }
    elif state["bridge_error"] is not None:
        error = state["bridge_error"]
    elif exit_code not in (0, None):
        error = {"code": f"E_EXIT_{exit_code}", "message": stderr_full.strip()[-300:] or "no stderr"}
    else:
        error = None
    return {
        "ok": error is None and bool(events),
        "events": events,
        "error": error,
        "malformed": state["malformed"],
        "stderr": stderr_full.strip()[-300:],
        "stderr_full": stderr_full,
        "events_path": str(events_path),
        "stderr_path": str(stderr_path),
        "started_at": started_at,
        "first_event_ms": state["first_event_ms"],
        "exit_code": exit_code,
    }


def run_stream_file(
    audio: Path,
    duration_ms: int,
    utterance: str,
    *,
    runs_dir: Path | None = None,
    stem: str | None = None,
) -> dict:
    seconds = max(60, int(duration_ms / 1000) + 60)
    command = [
        "swift",
        str(SPEECH_SCRIPT),
        "stream",
        "--file",
        str(audio),
        "--locale",
        "zh_CN",
        "--utterance",
        utterance,
        "--max-seconds",
        str(seconds),
    ]
    return run_streaming(
        command, timeout=max(120, seconds * 2.0 + 120), runs_dir=runs_dir, stem=stem
    )


def run_tts_playback(
    text: str,
    voice: str | None = None,
    *,
    runs_dir: Path | None = None,
    stem: str | None = None,
) -> dict:
    command = ["swift", str(SPEECH_SCRIPT), "speak-stream"]
    if voice:
        command += ["--voice", voice]
    result = run_streaming(
        command,
        timeout=120,
        runs_dir=runs_dir,
        stem=stem,
        stdin_lines=[text, "end"],
    )
    # 语义保持：TTS 车道原来只把「进程没报错」当 ok，空事件由 tts_first_chunk_ms
    # 判 no-sample；不能因为换成流式读就把它改成 run-failed。
    result["ok"] = result["error"] is None
    return result


def run_stream_mic(
    seconds: int,
    *,
    runs_dir: Path | None = None,
    stem: str | None = None,
) -> dict:
    command = [
        "swift",
        str(SPEECH_SCRIPT),
        "stream",
        "--locale",
        "zh_CN",
        "--max-seconds",
        str(seconds),
        # 默认 20s 空闲超时会在安静房间里提前收尾，长采集必须关掉。
        "--idle-timeout",
        str(seconds * 1000 + 5000),
        # 心跳：每 ~1s 一行 stderr，用来判采集是否还在走。
        "--trace",
    ]
    return run_streaming(command, timeout=seconds + 180.0, runs_dir=runs_dir, stem=stem)


def failed_run_record(result: dict, fixture: str, clip: str, run_index: int) -> dict:
    """失败/超时的采集也要留证据：跑到第几个事件才停、原始文件在哪（GH-45）。"""
    return {
        "fixture": fixture,
        "clip": clip,
        "run": run_index,
        "error_code": (result.get("error") or {}).get("code"),
        "events": len(result.get("events") or []),
        "events_path": result.get("events_path"),
        "stderr_path": result.get("stderr_path"),
        "first_event_ms": result.get("first_event_ms"),
        "exit_code": result.get("exit_code"),
    }


def replay_events(replay_dir: Path, name: str) -> dict:
    path = replay_dir / f"{name}.ndjson"
    if not path.exists():
        return {"ok": False, "events": [], "error": {"code": "E_REPLAY_MISSING", "message": f"缺少 {path}"}}
    events, error, malformed = parse_ndjson(path.read_text(encoding="utf-8").splitlines())
    return {"ok": error is None and bool(events), "events": events, "error": error, "malformed": malformed}


# ---------------------------------------------------------------- 判定
def judge_metric(
    metric: str,
    samples: list[dict],
    baseline_p95: float | None,
    hard_failures: list[str] | None = None,
) -> dict:
    """把样本变成指标条目。样本为空时由调用方补 skip 原因。"""
    values = [float(s["value"]) for s in samples]
    entry: dict = {
        "metric": metric,
        "label": METRIC_LABELS[metric],
        "basis": BASIS[metric],
        "threshold_source": THRESHOLD_SOURCE[metric],
        "samples": samples,
        "n": len(values),
    }
    if metric == "self_trigger":
        entry["unit"] = "count"
        entry["threshold_max"] = SELF_TRIGGER_MAX
    else:
        entry["unit"] = "ms"
        entry["threshold_ms"] = THRESHOLD_MS[metric]
    if not values:
        raise ValueError(f"{metric}: 没有样本时不要调用 judge_metric")

    entry["p50"] = round(percentile(values, 50), 1)
    entry["p95"] = round(percentile(values, 95), 1)
    entry["baseline_p95"] = baseline_p95
    entry["regression_pct"] = (
        None if baseline_p95 in (None, 0) else round((entry["p95"] - baseline_p95) / baseline_p95 * 100.0, 1)
    )

    failures: list[str] = list(hard_failures or [])
    limit = SELF_TRIGGER_MAX if metric == "self_trigger" else THRESHOLD_MS[metric]
    if entry["p95"] > limit:
        unit = "次" if metric == "self_trigger" else "ms"
        failures.append(f"p95={entry['p95']}{unit} 超过绝对值门槛 {limit}{unit}")
    if entry["regression_pct"] is not None and entry["regression_pct"] > RELATIVE_LIMIT * 100.0:
        failures.append(
            f"p95 相对基线退步 {entry['regression_pct']}%（基线 {baseline_p95}ms，上限 {RELATIVE_LIMIT * 100:.0f}%）"
        )
    entry["status"] = "measured"
    entry["verdict"] = "fail" if failures else "pass"
    entry["failures"] = failures
    return entry


def skipped_metric(metric: str, reason: str) -> dict:
    entry: dict = {
        "metric": metric,
        "label": METRIC_LABELS[metric],
        "basis": BASIS[metric],
        "threshold_source": THRESHOLD_SOURCE[metric],
        "status": "skipped",
        "reason": reason,
        "samples": [],
        "n": 0,
        "verdict": None,
        "failures": [],
    }
    if metric == "self_trigger":
        entry["unit"] = "count"
        entry["threshold_max"] = SELF_TRIGGER_MAX
    else:
        entry["unit"] = "ms"
        entry["threshold_ms"] = THRESHOLD_MS[metric]
    return entry


def judge_stability(samples: list[dict], repeat: int) -> dict | None:
    """同一台机、同一会话内连跑两次的波动（判据 3）。"""
    if repeat < 2:
        return None
    results = []
    for metric in METRICS:
        by_run: dict[int, list[float]] = {}
        for sample in samples:
            if sample.get("metric") != metric:
                continue
            by_run.setdefault(int(sample["run"]), []).append(float(sample["value"]))
        entries = []
        for run, values in sorted(by_run.items()):
            entries.append({"run": run, "p95": round(percentile(values, 95), 1), "n": len(values)})
        if len(entries) < 2:
            continue
        first, second = entries[0], entries[1]
        delta = round(delta_pct(first["p95"], second["p95"]), 1)
        results.append(
            {
                "metric": metric,
                "label": METRIC_LABELS[metric],
                "p95_by_run": [first["p95"], second["p95"]],
                "delta_pct": delta,
                "limit_pct": RELATIVE_LIMIT * 100.0,
                "verdict": "fail" if delta > RELATIVE_LIMIT * 100.0 else "pass",
            }
        )
    return {"runs": repeat, "metrics": results} if results else {"runs": repeat, "metrics": []}


ALLOWED_STATUS = ("measured", "skipped")


def validate_report(report: dict) -> list[str]:
    """报告自检：6 项齐全、状态只有 measured/skipped、skipped 必须给原因、
    measured 必须有 n>0 和 p95、且不许出现 status=\"pass\" 这种冒充。"""
    problems: list[str] = []
    if report.get("schema") != SCHEMA:
        problems.append(f"schema 必须是 {SCHEMA}")
    metrics = report.get("metrics") or []
    names = [m.get("metric") for m in metrics]
    if names != list(METRICS):
        problems.append(f"metrics 必须按 {list(METRICS)} 顺序完整出现，实际 {names}")
    for metric in metrics:
        name = metric.get("metric")
        status = metric.get("status")
        if status not in ALLOWED_STATUS:
            problems.append(f"{name}: status={status!r} 不在 {list(ALLOWED_STATUS)}")
            continue
        if status == "skipped":
            if not str(metric.get("reason") or "").strip():
                problems.append(f"{name}: skipped 必须写 reason")
            if metric.get("verdict") is not None:
                problems.append(f"{name}: skipped 不许有 verdict（SKIP 不能算 PASS）")
        else:
            if not metric.get("n") or int(metric["n"]) <= 0:
                problems.append(f"{name}: measured 必须 n>0")
            if metric.get("p95") is None:
                problems.append(f"{name}: measured 必须有 p95")
    return problems


# ---------------------------------------------------------------- 报告
def _fixture_rows(fixtures: list[Fixture], clips_state: list[dict], runs: list[dict]) -> list[dict]:
    rows = []
    for fixture in fixtures:
        row: dict = {
            "fixture": fixture.name,
            "kind": fixture.kind,
            "source": fixture.source,
            "duration_ms": fixture.duration_ms,
            "expected_utterances": fixture.expected.get("utterances"),
            "notes": fixture.notes,
        }
        if fixture.source == "pending-hardware":
            row["status"] = "pending-hardware"
            rows.append(row)
            continue
        states = [s for s in clips_state if s["fixture"] == fixture.name]
        row["clips"] = [
            {k: v for k, v in state.items() if k != "fixture"} for state in states
        ]
        clip_runs = [r for r in runs if r["fixture"] == fixture.name]
        if clip_runs:
            row["status"] = "measured"
        elif states and all(s.get("status") in ("missing", "generate-failed") for s in states):
            row["status"] = "missing"
        else:
            # 夹具在、但车道没跑（缺硬件/权限）——不是夹具缺失。
            row["status"] = "not-run"
        if fixture.kind == "silence":
            row["speech_finals"] = sum(r["speech_finals"] for r in clip_runs)
            row["partials"] = sum(r["partials"] for r in clip_runs)
            row["speech_onsets"] = sum(r["speech_onsets"] for r in clip_runs)
            row["ok"] = bool(clip_runs) and row["speech_finals"] == 0 and row["partials"] == 0 and row["speech_onsets"] == 0
        else:
            row["speech_finals"] = sum(r["speech_finals"] for r in clip_runs)
            row["partials"] = sum(r["partials"] for r in clip_runs)
            row["ok"] = bool(clip_runs) and all(r["speech_finals"] >= 1 for r in clip_runs)
        rows.append(row)
    return rows


def _ms(value: float | int | None) -> str:
    if value is None:
        return "—"
    if isinstance(value, float) and value.is_integer():
        return f"{int(value)}ms"
    return f"{value}ms"


def render_summary(report: dict, out_path: Path, baseline_path: Path) -> str:
    host = report["host"]
    mode = "replay（合成事件，不是硬件证据）" if host.get("replay") else "hardware"
    device = report["device"]
    lines = [
        f"WALLY 语音回归基线 · {report['generated_at']} · schema={report['schema']}",
        f"主机: {host['platform']}/{host['machine']} · 模式: {mode} · Python {host['python']}",
        f"设备: mic={device['mic']} speaker={device['speaker']} (来源 {device['source']})",
    ]
    fixtures = report["fixtures"]
    pending = sum(1 for f in fixtures if f.get("status") == "pending-hardware")
    lines.append(
        f"夹具: {len(fixtures)} 个声明 / {len(fixtures) - pending} 个可测 / {pending} 个 pending-hardware"
    )
    if report.get("warnings"):
        for warning in report["warnings"]:
            lines.append(f"WARN: {warning}")
    lines.append("")
    for metric in report["metrics"]:
        label = metric["label"]
        name = metric["metric"]
        if metric["status"] == "skipped":
            lines.append(f"{label}（{name}）: SKIP — {metric['reason']}")
            continue
        unit = "" if metric["unit"] == "ms" else "次"
        if metric["unit"] == "ms":
            baseline = _ms(metric["baseline_p95"])
        else:
            baseline = "—" if metric["baseline_p95"] is None else f"{metric['baseline_p95']}次"
        regression = "—" if metric["regression_pct"] is None else f"{metric['regression_pct']}%"
        limit = _ms(metric["threshold_ms"]) if metric["unit"] == "ms" else f"≤{metric['threshold_max']}次"
        verdict = "PASS" if metric["verdict"] == "pass" else "FAIL"
        lines.append(
            f"{label}（{name}）: {verdict} p50={metric['p50']}{unit or 'ms'} p95={metric['p95']}{unit or 'ms'} "
            f"n={metric['n']} 门槛={limit} 基线={baseline} 退步={regression}"
        )
        for failure in metric["failures"]:
            lines.append(f"    ✗ {failure}")
    stability = report.get("stability")
    if stability and stability.get("metrics"):
        lines.append("")
        lines.append(f"两次运行波动（上限 {RELATIVE_LIMIT * 100:.0f}%）:")
        for item in stability["metrics"]:
            lines.append(
                f"  {item['label']}: {item['p95_by_run'][0]}ms → {item['p95_by_run'][1]}ms "
                f"= {item['delta_pct']}% {item['verdict'].upper()}"
            )
    elif stability is not None:
        lines.append("")
        lines.append("两次运行波动: 无（本次没有可比的成对样本）")
    counts = report["summary"]
    lines.append("")
    lines.append(
        f"判定: {report['result'].upper()} (pass {counts['pass']} / fail {counts['fail']} / skip {counts['skip']})"
        f" · 退出码 {report['exit_code']}"
    )
    lines.append(f"JSON: {out_path}")
    if report.get("runs_dir"):
        lines.append(f"原始事件: {report['runs_dir']}")
    if not report["baseline"]["seeded"]:
        lines.append(
            f"基线: {baseline_path} 未播种 —— 目前只按 §11 绝对值判定；"
            "在 Mac 上跑一次 --seed-baseline 才会启用 20% 相对回归"
        )
    else:
        lines.append(f"基线: {baseline_path}（已播种 {report['baseline'].get('generated_at')}）")
    return "\n".join(lines)


def load_baseline(path: Path) -> dict:
    if not path.exists():
        return {"schema": SCHEMA, "seeded": False, "metrics": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise FixtureError(f"基线文件不是合法 JSON：{path}: {exc}") from exc
    if data.get("schema") != SCHEMA:
        raise FixtureError(f"基线 schema 不匹配：{path}")
    return data


def baseline_p95(baseline: dict, metric: str) -> float | None:
    """基线里的 p95。

    基线文件与运行报告同构（metrics 是条目数组）；同时兼容早期的最小
    ``{metric: {p95}}`` 形状。只有 ``measured`` 的条目才算基线，SKIP 永远返回 None。
    """
    entries = baseline.get("metrics") or []
    if isinstance(entries, dict):
        value = (entries.get(metric) or {}).get("p95")
        return float(value) if isinstance(value, (int, float)) else None
    for entry in entries:
        if entry.get("metric") == metric and entry.get("status") == "measured":
            value = entry.get("p95")
            return float(value) if isinstance(value, (int, float)) else None
    return None


def seed_baseline(baseline_path: Path, report: dict) -> dict:
    """把本轮报告整体写成基线（与输出 JSON 同构，便于逐字段对照）。

    SKIP 的指标保留在文件里但 p95 为 null，`baseline_p95()` 不会拿它们做回归基准：
    「没测过」不能变成「基线是 0」。
    """
    payload = json.loads(json.dumps(report, ensure_ascii=False))
    payload["seeded"] = True
    payload["seed_note"] = (
        "由 eval/voice/voice_baseline.py --seed-baseline 写入；与运行报告同构。"
        "只有 status=measured 的指标参与相对回归。"
    )
    write_json(baseline_path, payload)
    return payload


# ---------------------------------------------------------------- 主流程
def collect(args) -> dict:
    fixtures = load_fixtures(Path(args.fixtures_dir))
    if args.replay_dir:
        env: dict = {
            "platform": "replay",
            "machine": platform.machine(),
            "macos_version": None,
            "swift": None,
            "probe_error": None,
            "mic_authorization": "n/a",
            "mic_name": "replay",
            "speaker_name": "replay",
            "zh_voices": [],
            "asr": {},
            "replay": True,
        }
        replay_dir = Path(args.replay_dir)
    else:
        env = probe_environment()
        replay_dir = None

    # GH-45：本次运行一个落盘目录 runs/<UTC 时间戳>/；replay 没有子进程事件，不建目录。
    if replay_dir is not None:
        runs_dir: Path | None = None
    elif getattr(args, "runs_dir", None):
        runs_dir = Path(args.runs_dir)
    else:
        runs_dir = new_runs_dir()

    warnings: list[str] = []
    clips_state: list[dict] = []
    runs: list[dict] = []
    failed_runs: list[dict] = []
    samples: list[dict] = []
    lane_skip: dict[str, str] = {}
    hard_failures: dict[str, list[str]] = {}

    # ---- 夹具就绪
    for fixture in fixtures:
        if not fixture.measurable:
            continue
        for clip in fixture.clips():
            audio = fixture.audio_path(clip)
            if replay_dir is not None:
                state = {"fixture": fixture.name, "clip": clip["name"], "status": "replay"}
            elif audio.exists():
                state = {"fixture": fixture.name, "clip": clip["name"], "status": "present"}
                if fixture.duration_ms > 0 and fixture.kind == "silence":
                    state["duration_ms"] = fixture.duration_ms
            elif args.no_generate:
                state = {"fixture": fixture.name, "clip": clip["name"], "status": "missing", "reason": "not-requested: --no-generate"}
            else:
                state = {"fixture": fixture.name, "clip": clip["name"], **generate_clip(fixture, clip, env)}
            clips_state.append(state)
            if state["status"] in ("generated",) and isinstance(state.get("duration_delta_pct"), (int, float)):
                if abs(state["duration_delta_pct"]) > 50:
                    warnings.append(
                        f"{fixture.name}: 实际时长与标注差 {state['duration_delta_pct']}%（标注是名义值，指标仍按音频时间轴计算）"
                    )

    if args.generate_only:
        return {"fixtures": fixtures, "clips_state": clips_state, "runs": runs, "samples": samples,
                "env": env, "warnings": warnings, "runs_dir": runs_dir, "failed_runs": failed_runs,
                "generate_only": True}

    # ---- ASR（离线 --file）
    asr_reason = asr_skip_reason(env)
    if asr_reason:
        lane_skip["first_token"] = asr_reason
        lane_skip["asr_final"] = asr_reason
    else:
        errors: list[str] = []
        for fixture in fixtures:
            if not fixture.measurable:
                continue
            for clip in fixture.clips():
                state = next((s for s in clips_state if s["fixture"] == fixture.name and s["clip"] == clip["name"]), None)
                if state is None or state["status"] in ("missing", "generate-failed"):
                    errors.append(f"{fixture.name}/{clip['name']}: 夹具不可用")
                    continue
                for run_index in range(1, args.repeat + 1):
                    if replay_dir is not None:
                        result = replay_events(replay_dir, clip["name"])
                    else:
                        result = run_stream_file(
                            fixture.audio_path(clip),
                            clip.get("silence_ms") or fixture.duration_ms,
                            clip["name"],
                            runs_dir=runs_dir,
                            stem=safe_stem(fixture.name, clip["name"], f"run{run_index}"),
                        )
                    if not result["ok"]:
                        error = result.get("error") or {}
                        failed_runs.append(failed_run_record(result, fixture.name, clip["name"], run_index))
                        errors.append(f"{fixture.name}/{clip['name']}: {error.get('code')}: {error.get('message')}")
                        continue
                    events = result["events"]
                    runs.append(
                        {
                            "fixture": fixture.name,
                            "clip": clip["name"],
                            "kind": fixture.kind,
                            "run": run_index,
                            "events": len(events),
                            "speech_finals": speech_finals(events),
                            "partials": partial_count(events),
                            "speech_onsets": speech_onset_count(events),
                            "events_path": result.get("events_path"),
                            "first_event_ms": result.get("first_event_ms"),
                        }
                    )
                    endpoint = _first(events, lambda e: e.get("ev") == "endpoint")
                    nominal = state.get("total_ms") or fixture.duration_ms
                    if (
                        endpoint is not None
                        and fixture.expected.get("utterances") == 1
                        and nominal
                        and isinstance(endpoint.get("audio_ms"), (int, float))
                        and endpoint["audio_ms"] < 0.6 * nominal
                    ):
                        warnings.append(
                            f"{fixture.name}/{clip['name']}: 端点在 {endpoint['audio_ms']}ms 就收尾"
                            f"（夹具约 {nominal}ms），句内可能有超过 700ms 的停顿；首字样本仍有效，"
                            "但这条不能证明长句整体识别"
                        )
                    if fixture.kind == "silence":
                        continue
                    # 夹具一律经 ``--file`` 喂进去，所以 final 延迟一律用 file 口径。
                    basis = "file"
                    first = first_token_ms(events)
                    if first is not None:
                        samples.append({"metric": "first_token", "fixture": fixture.name, "clip": clip["name"], "run": run_index, "value": round(first, 1)})
                    final = asr_final_ms(events, basis)
                    if final is not None:
                        samples.append({"metric": "asr_final", "fixture": fixture.name, "clip": clip["name"], "run": run_index, "value": round(final, 1)})
        if errors:
            message = "；".join(errors[:3])
            measured_here = {s["metric"] for s in samples}
            if measured_here & {"first_token", "asr_final"}:
                warnings.append(f"ASR 夹具部分失败（其余样本照常统计）：{message}")
            for metric in ("first_token", "asr_final"):
                if metric not in measured_here:
                    lane_skip[metric] = f"run-failed: {message}"

    # ---- TTS 首包
    tts_reason = tts_skip_reason(env, args.no_playback)
    if tts_reason:
        lane_skip["tts_first_chunk"] = tts_reason
    else:
        for run_index in range(1, args.repeat + 1):
            if replay_dir is not None:
                result = replay_events(replay_dir, "tts")
            else:
                result = run_tts_playback(
                    args.tts_text,
                    runs_dir=runs_dir,
                    stem=safe_stem("tts", "tts", f"run{run_index}"),
                )
            if not result["ok"]:
                error = result.get("error") or {}
                failed_runs.append(failed_run_record(result, "tts", "tts", run_index))
                reason = f"run-failed: {error.get('code')}: {error.get('message')}"
                if any(s["metric"] == "tts_first_chunk" for s in samples):
                    warnings.append(f"TTS 有一轮失败（其余样本照常统计）：{reason}")
                else:
                    lane_skip["tts_first_chunk"] = reason
                break
            value = tts_first_chunk_ms(result["events"])
            if value is None:
                lane_skip["tts_first_chunk"] = "no-sample: 没有 tts_chunk_started（或这是 --dry-run 的模拟值）"
                break
            samples.append({"metric": "tts_first_chunk", "fixture": "tts", "clip": "tts", "run": run_index, "value": round(value, 1)})

    # ---- 打断响应 / 自听误触发率：需要 serve 桥同时播报 + 回采
    if replay_dir is not None:
        barge = replay_events(replay_dir, "barge_in")
        if barge["ok"]:
            speech = _first(barge["events"], lambda e: e.get("ev") == "speech_state" and e.get("state") == "speech")
            cancelled = _first(barge["events"], lambda e: e.get("ev") == "tts_cancelled")
            if speech is not None and cancelled is not None and _mono_ms(speech) is not None and _mono_ms(cancelled) is not None:
                samples.append(
                    {
                        "metric": "barge_in",
                        "fixture": "replay",
                        "clip": "barge_in",
                        "run": 1,
                        "value": round(max(0.0, _mono_ms(cancelled) - _mono_ms(speech)), 1),
                    }
                )
            else:
                lane_skip["barge_in"] = "no-sample: replay 事件里没有 speech_state(speech)+tts_cancelled"
        else:
            lane_skip["barge_in"] = "needs-hardware: 需要 serve 桥同时播报 + 回采（C 类夹具，随 #41 AEC harness 落地）"

        self_run = replay_events(replay_dir, "self_trigger")
        if self_run["ok"]:
            samples.append(
                {
                    "metric": "self_trigger",
                    "fixture": "replay",
                    "clip": "self_trigger",
                    "run": 1,
                    "value": speech_onset_count(self_run["events"]),
                }
            )
        else:
            lane_skip["self_trigger"] = "needs-hardware: 需要 30 分钟播报 + 回采（#41）"
    else:
        lane_skip["barge_in"] = (
            "needs-hardware: 需要真扬声器 + 真麦克风回采，且两侧事件必须出自同一个 serve 桥；"
            "C 类夹具 pending-hardware（随 #41 AEC harness 落地）"
        )
        lane_skip["self_trigger"] = "needs-hardware: 需要连续播报 30 分钟 + 麦克风回采（#41）"

    # ---- 采集连续性
    continuity_reason = continuity_skip_reason(env, args.with_long_run)
    if continuity_reason:
        lane_skip["capture_continuity"] = continuity_reason
    else:
        if replay_dir is not None:
            result = replay_events(replay_dir, "capture_continuity")
        else:
            result = run_stream_mic(
                args.long_run_seconds,
                runs_dir=runs_dir,
                stem=safe_stem("mic", f"{args.long_run_seconds}s", "run1"),
            )
        if not result["ok"]:
            error = result.get("error") or {}
            failed_runs.append(failed_run_record(result, "mic", f"{args.long_run_seconds}s", 1))
            lane_skip["capture_continuity"] = f"run-failed: {error.get('code')}: {error.get('message')}"
        else:
            entries = parse_capture_trace(result.get("stderr_full", ""))
            if entries:
                stats = continuity_from_trace(entries)
                gap = stats["max_gap_ms"]
                if not stats["monotonic"]:
                    hard_failures["capture_continuity"] = [
                        f"feed 序号不单调（{stats['feeds']} 个心跳）：疑似丢帧/重排"
                    ]
                sample = {
                    "metric": "capture_continuity",
                    "fixture": "mic",
                    "clip": f"{args.long_run_seconds}s",
                    "run": 1,
                    "value": round(gap, 1),
                    "feeds": stats["feeds"],
                }
            else:
                # replay 或旧桥没有 --trace：退回事件间隔（报告 basis 已注明口径）。
                gap = max_event_gap_ms(result["events"])
                sample = {
                    "metric": "capture_continuity",
                    "fixture": "mic",
                    "clip": f"{args.long_run_seconds}s",
                    "run": 1,
                    "value": None if gap is None else round(gap, 1),
                }
            if sample["value"] is None:
                lane_skip["capture_continuity"] = "no-sample: 心跳/事件不足以计算间隔"
            else:
                samples.append(sample)
    return {
        "fixtures": fixtures,
        "clips_state": clips_state,
        "runs": runs,
        "runs_dir": runs_dir,
        "failed_runs": failed_runs,
        "samples": samples,
        "env": env,
        "warnings": warnings,
        "lane_skip": lane_skip,
        "hard_failures": hard_failures,
    }


def build_report(collected: dict, baseline: dict, repeat: int) -> dict:
    samples = collected["samples"]
    lane_skip = collected["lane_skip"]
    metrics = []
    for metric in METRICS:
        own = [s for s in samples if s["metric"] == metric]
        if own:
            entry = judge_metric(
                metric,
                own,
                baseline_p95(baseline, metric),
                collected.get("hard_failures", {}).get(metric),
            )
        else:
            entry = skipped_metric(metric, lane_skip.get(metric) or "no-sample: 本轮没有可用样本")
        metrics.append(entry)

    counts = {"pass": 0, "fail": 0, "skip": 0}
    for metric in metrics:
        if metric["status"] == "skipped":
            counts["skip"] += 1
        elif metric["verdict"] == "pass":
            counts["pass"] += 1
        else:
            counts["fail"] += 1

    stability = judge_stability(samples, repeat)
    stability_failed = bool(stability and any(item["verdict"] == "fail" for item in stability["metrics"]))
    if counts["fail"] or stability_failed:
        result, exit_code = "fail", 1
    elif counts["skip"]:
        result, exit_code = "incomplete", 3
    else:
        result, exit_code = "pass", 0

    env = collected["env"]
    if env.get("replay"):
        device_source = "replay"
    elif env["platform"] == "Darwin":
        device_source = "mac_speech list + system_profiler SPAudioDataType"
    else:
        device_source = "unknown"
    fixture_rows = _fixture_rows(collected["fixtures"], collected["clips_state"], collected["runs"])

    report = {
        "schema": SCHEMA,
        "generated_at": now_iso(),
        "host": {
            "platform": env["platform"],
            "machine": env["machine"],
            "macos_version": env.get("macos_version"),
            "python": platform.python_version(),
            "replay": bool(env.get("replay")),
        },
        "device": {
            "mic": env.get("mic_name") or "unknown",
            "speaker": env.get("speaker_name") or "unknown",
            "source": device_source,
            "mic_authorization": env.get("mic_authorization"),
            "swift": env.get("swift"),
            "signature": "unknown",
            "signature_note": "TCC 身份取决于执行基线脚本的宿主 App；本轮没有 --mic-uid 实现，脚本不猜签名",
        },
        "environment": {
            "ambient_db": None,
            "note": "环境噪声未测：本轮不跑声学标定（issue 明确不做实验室级标定）",
        },
        "fixtures": fixture_rows,
        # GH-45：拿着报告能直接回去看原始事件（runs/<ts>/<fixture>.<clip>.run<N>.ndjson）。
        "runs_dir": None if collected.get("runs_dir") is None else str(collected["runs_dir"]),
        "failed_runs": collected.get("failed_runs", []),
        "metrics": metrics,
        "stability": stability,
        "summary": counts,
        "result": result,
        "exit_code": exit_code,
        "warnings": collected["warnings"],
        "baseline": {
            "seeded": bool(baseline.get("seeded")),
            "generated_at": baseline.get("generated_at"),
            "relative_limit": RELATIVE_LIMIT,
        },
    }
    return report


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="WALLY 语音回归基线（GH-14）")
    parser.add_argument("--fixtures-dir", default=str(DEFAULT_FIXTURES))
    parser.add_argument("--baseline", default=str(DEFAULT_BASELINE))
    parser.add_argument("--out", default=None, help="输出 JSON 路径（默认 eval/voice/runs/baseline-YYYYMMDD.json）")
    parser.add_argument(
        "--runs-dir",
        default=None,
        help="本次运行的事件落盘目录（默认 eval/voice/runs/<UTC 时间戳>/；replay 模式不落盘）",
    )
    parser.add_argument("--repeat", type=int, default=2, help="同一会话内连跑次数（默认 2，判据 3 需要）")
    parser.add_argument("--seed-baseline", action="store_true", help="把本轮 measured 的 p95 写入 baseline.json")
    parser.add_argument("--generate-only", action="store_true", help="只生成夹具，不测量")
    parser.add_argument("--no-generate", action="store_true", help="夹具缺失时不要合成（验证 SKIP 路径）")
    parser.add_argument("--no-playback", action="store_true", help="不跑 TTS 真播（不出声）")
    parser.add_argument("--with-long-run", action="store_true", help="跑 30 分钟麦克风长采集（采集连续性）")
    parser.add_argument("--long-run-seconds", type=int, default=1800)
    parser.add_argument("--tts-text", default=TTS_TEXT)
    parser.add_argument(
        "--replay-dir",
        default=None,
        help="调试/测试：从 <name>.ndjson 回放事件而不是驱动硬件（报告会标 replay，不能当硬件证据）",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.repeat < 1:
        print("--repeat 必须 >= 1", file=sys.stderr)
        return 2
    baseline_path = Path(args.baseline)
    try:
        baseline = load_baseline(baseline_path)
        collected = collect(args)
    except FixtureError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    if collected.get("generate_only"):
        failed = 0
        for state in collected["clips_state"]:
            reason = f" — {state['reason']}" if state.get("reason") else ""
            print(f"{state['fixture']}/{state['clip']}: {state['status']}{reason}")
            if state["status"] in ("missing", "generate-failed"):
                failed += 1
        return 0 if failed == 0 else 2

    report = build_report(collected, baseline, args.repeat)
    problems = validate_report(report)
    if problems:
        # 报告自检失败 = 代码缺陷，不能悄悄输出一份假报告。
        print("报告自检失败：", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 2

    out_path = Path(args.out) if args.out else DEFAULT_OUT_DIR / f"baseline-{_dt.date.today():%Y%m%d}.json"
    write_json(out_path, report)

    if args.seed_baseline:
        if collected["env"].get("replay"):
            print("拒绝播种：replay 是合成事件，不是硬件证据；基线只能由真机跑出来", file=sys.stderr)
            return 2
        seeded_metrics = [m for m in report["metrics"] if m["status"] == "measured"]
        if not seeded_metrics:
            print("拒绝播种：本轮没有任何 measured 指标（不能把 SKIP 当基线）", file=sys.stderr)
            return 2
        failed = [m["metric"] for m in seeded_metrics if m.get("verdict") == "fail"]
        if failed:
            report["warnings"].append(
                "基线已播种，但本轮这些指标未达门槛：" + "、".join(failed) + "（基线只记录现状，不改变判红）"
            )
        report["baseline"] = {
            "seeded": True,
            "generated_at": report["generated_at"],
            "relative_limit": RELATIVE_LIMIT,
        }
        write_json(out_path, report)
        seed_baseline(baseline_path, report)

    print(render_summary(report, out_path, baseline_path))
    return report["exit_code"]


if __name__ == "__main__":
    sys.exit(main())
