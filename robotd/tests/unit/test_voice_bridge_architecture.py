"""GH-4 structural guardrails for the native voice bridge.

The Swift bridge cannot be compiled on the Linux CI runner, so these tests do not pretend to
be a runtime test. They pin the boundaries that the issue makes contractual: engine selection
flags, the two-pipeline worker shape, the four-command surface, and the observability events.
Real microphone/30-minute/p99 evidence must still come from the macOS target (docs/design/GH-4.md).
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PIPELINE = ROOT / "scripts" / "mac_speech_pipeline.swift"
ENTRY = ROOT / "scripts" / "mac_speech.swift"
BUILD = ROOT / "scripts" / "build_audio_bridge.sh"


def source() -> str:
    return PIPELINE.read_text(encoding="utf-8")


def test_serve_entry_delegates_to_split_pipeline():
    entry = ENTRY.read_text(encoding="utf-8")
    assert 'if mode == "serve" { await runServeBridgeMode() }' in entry
    # The old 1500-line ServeBridge monolith must not survive behind a second code path.
    assert "final class ServeBridge:" not in entry
    assert "func autoDetectOrPreroll" not in entry


def test_single_binary_compiles_both_sources():
    build = BUILD.read_text(encoding="utf-8")
    assert "mac_speech_pipeline.swift" in build
    assert 'cat "$SRC" "$PIPELINE" > "$TMP_BUILD/main.swift"' in build
    # GH-55: the test-only harness must be opt-in; the default build has no
    # -D WALLY_AUDIO_TEST_HARNESS on the swiftc line.
    assert 'swiftc -O -D VOICE_PIPELINE $HARNESS_DEFINE -o "$OUT/Contents/MacOS/AudioBridge"' in build
    assert 'HARNESS_DEFINE=""' in build


def test_engine_flags_accept_system_and_sherpa():
    text = source()
    assert '"--asr"' in text and '"--tts"' in text
    assert "case system" in text and "case sherpa" in text
    assert "E_ASR_NOT_IMPLEMENTED" in text
    assert "E_TTS_NOT_IMPLEMENTED" in text


def test_capture_tap_does_only_copy_and_dispatch():
    text = source()
    tap = text.split("func handleTap(", 1)[1].split("private func captureLoop", 1)[0]
    assert "copyPCMBuffer" in tap
    assert "rawQueue.append" in tap
    assert "tapTiming.record" in tap
    for forbidden in ("bufferDb(", "synthesize(", "player.play(", "eng.feed(", "vad.push("):
        assert forbidden not in tap, f"capture tap must not do work: {forbidden}"


def test_vad_and_asr_are_sibling_frame_subscribers():
    text = source()
    assert 'frameBus.subscribe("vad")' in text
    assert 'frameBus.subscribe("asr")' in text
    assert "private let vadQueue" in text
    assert "private let asrQueue" in text


def test_tts_pipeline_has_bounded_queue_and_explicit_drop_event():
    text = source()
    assert "final class BoundedTTSQueue" in text
    assert "tts_queued" in text
    assert "tts_played" in text
    assert "tts_chunk_dropped" in text
    assert '"reason": "queue_full"' in text


def test_aec_and_tap_timing_are_reported():
    text = source()
    assert "aec_erle_db" in text
    assert "capture_timing" in text
    assert "p99_ok" in text
    assert "fed_frames" in text
    assert "tap_p99_ms" in text
    assert "vad_frames" in text
    assert "asr_frames" in text


def test_command_surface_is_four_plus_lifecycle_commands():
    text = source()
    # The classifier lives in mac_speech.swift (shared pure core), not the pipeline.
    entry = ENTRY.read_text(encoding="utf-8")
    classifier = entry.split("func classifyServeCommand(", 1)[1].split("\n}\n", 1)[0]
    default = re.sub(r"#if.*?#endif", "", classifier, flags=re.S)
    commands = set(re.findall(r'case "([a-z_]+)"', default))
    assert commands == {"listen", "stop", "speak", "stop_speak", "mute", "unmute", "status", "quit"}
    assert 'case "play"' not in text
    assert 'case "record"' not in text


def test_bridge_does_not_suppress_vad_during_playback():
    """GH-5 判据 6：suppressAuto 必须真删，且不得换成「被压掉就不发事实」的短路。

    桥是适配层，只报事实；打断判定在 robotd 的 AudioRuntime。这里用源码断言把边界钉住，
    因为 Swift 桥在 Linux CI 上不能编译，无法用运行时测试代替。
    """
    text = source()
    assert "suppressAuto" not in text
    # VAD worker 的分支不再看「是否在播报」
    assert "if activeId == nil && !m && !busy {" in text
    handle = text.split("private func handleVadFrame", 1)[1].split("private func calibrate", 1)[0]
    assert "!s" not in handle
    assert "runProbeVAD(frame)" in handle

    # probe VAD 上升时必须如实发 speech_state 事实（后续 robotd 才可能产 speech.gate）
    probe = text.split("private func runProbeVAD", 1)[1].split("private func runUtteranceVAD", 1)[0]
    assert '"ev": "speech_state", "state": "speech"' in probe
    # 桥侧不得因为「正在播报」而跳过开轮或跳过事实上报（那只是把 suppressAuto 换个名字）
    assert "speaking" not in probe
    assert "response" not in probe
    # 桥侧不得出现契约名 speech.gate，也不得按「回声」决定发不发事实
    assert "speech.gate" not in text
    assert "suppress" not in probe.lower()
    assert not re.search(r"if[^\n]*(speaking|response)[^\n]*\{\s*return", handle)
