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
    assert 'swiftc -O -D VOICE_PIPELINE -o "$OUT/Contents/MacOS/AudioBridge"' in build


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
    switch = text.split('switch (obj["cmd"] as? String) ?? "" {', 1)[1].split("}", 1)[0]
    commands = set(re.findall(r'case "([a-z_]+)"', switch))
    assert commands == {"listen", "stop", "speak", "stop_speak", "mute", "unmute", "status", "quit"}
    assert 'case "play"' not in switch
    assert 'case "record"' not in switch
