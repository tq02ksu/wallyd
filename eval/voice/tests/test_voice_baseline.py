"""GH-14 语音回归基线：纯逻辑单测（不需要麦克风、喇叭或 macOS）。

覆盖三类容易被「悄悄变绿」的地方：
1. 判定：SKIP 不能算 PASS；绝对值与 20% 相对退步取严；两次波动翻倍必须判红；
2. 测量口径：首字用音频时间轴（与句长无关），final 的 file/mic 两种口径；
3. 夹具契约：字段缺失 fail closed；pending-hardware 旁边出现音频文件必须判红。

运行：python3 -m unittest discover -s eval/voice/tests -v
"""

from __future__ import annotations

import contextlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

VOICE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(VOICE_DIR))

import voice_baseline as vb  # noqa: E402

DATA = Path(__file__).resolve().parent / "data"
FIXTURES = VOICE_DIR / "fixtures"

FAKE_ENV = {
    "platform": "Linux",
    "machine": "x86_64",
    "macos_version": None,
    "swift": None,
    "probe_error": None,
    "mic_authorization": "unknown",
    "mic_name": "unknown",
    "speaker_name": "unknown",
    "zh_voices": [],
    "asr": {},
}


def stream_events(
    *,
    onset_ms: float = 600,
    partial_end_ms: float = 1000,
    endpoint_audio_ms: float = 5500,
    silence_ms: float = 700,
    finalize_tail_ms: float = 300,
    text: str = "你好",
    wall_tail_ms: float | None = None,
) -> list[dict]:
    """一段最小的 --file NDJSON。墙钟与音频轴刻意脱钩，方便验证口径。"""
    wall = wall_tail_ms if wall_tail_ms is not None else finalize_tail_ms
    # 端点/静音事件一起发出；final 的墙钟 = 这个时刻 + finalize 尾巴。
    endpoint_wall = 2_000_000_000
    return [
        {"ev": "ready", "ts_mono_ns": 0},
        {"ev": "vad_calibrated", "ts_mono_ns": 600_000_000},
        {"ev": "speech_state", "state": "speech", "audio_ms": onset_ms, "ts_mono_ns": 1_400_000_000},
        {"ev": "partial", "text": text, "audio_start_ms": onset_ms - 300, "audio_end_ms": partial_end_ms, "ts_mono_ns": 1_500_000_000},
        {"ev": "speech_state", "state": "silence", "audio_ms": endpoint_audio_ms - silence_ms, "ts_mono_ns": endpoint_wall},
        {"ev": "endpoint", "reason": "silence", "audio_ms": endpoint_audio_ms, "silence_ms": silence_ms, "ts_mono_ns": endpoint_wall},
        {"ev": "final", "text": text, "stop_reason": "silence", "ts_mono_ns": endpoint_wall + int(wall * 1e6)},
    ]


class PercentileTests(unittest.TestCase):
    def test_nearest_rank(self):
        values = [10, 20, 30, 40, 50]
        self.assertEqual(vb.percentile(values, 50), 30)
        self.assertEqual(vb.percentile(values, 95), 50)  # n<20 时 p95 就是最大值
        self.assertEqual(vb.percentile(values, 100), 50)
        with self.assertRaises(ValueError):
            vb.percentile([], 50)

    def test_delta_pct_uses_smaller_denominator(self):
        self.assertAlmostEqual(vb.delta_pct(100, 120), 20.0)
        self.assertAlmostEqual(vb.delta_pct(120, 100), 20.0)
        self.assertAlmostEqual(vb.delta_pct(0, 0), 0.0)


class AnalysisTests(unittest.TestCase):
    def test_first_token_uses_audio_axis_not_wall_clock(self):
        # 墙钟把 5s 音频压缩到几百 ms（file 模式灌得比实时快），音频轴仍然是 400ms。
        events = stream_events(partial_end_ms=1000, wall_tail_ms=1)
        self.assertEqual(vb.first_token_ms(events), 400.0)

    def test_first_token_independent_of_utterance_length(self):
        short = stream_events(partial_end_ms=1000, endpoint_audio_ms=5500)
        long = stream_events(partial_end_ms=1000, endpoint_audio_ms=60500)
        self.assertEqual(vb.first_token_ms(short), vb.first_token_ms(long))

    def test_first_token_missing_partial_returns_none(self):
        events = [e for e in stream_events() if e["ev"] != "partial"]
        self.assertIsNone(vb.first_token_ms(events))

    def test_asr_final_file_basis_adds_endpoint_silence(self):
        events = stream_events(silence_ms=700, finalize_tail_ms=300)
        self.assertEqual(vb.asr_final_ms(events, "file"), 1000.0)

    def test_asr_final_mic_basis_is_wall_clock(self):
        events = stream_events(finalize_tail_ms=250)
        # speech_state(silence) 墙钟 2000ms，final 2250ms
        self.assertEqual(vb.asr_final_ms(events, "mic"), 250.0)

    def test_tts_dry_run_is_not_a_measurement(self):
        events = [
            {"ev": "tts_started", "dry_run": True, "ts_mono_ns": 0},
            {"ev": "tts_chunk_started", "index": 0, "ts_mono_ns": 250_000_000},
        ]
        self.assertIsNone(vb.tts_first_chunk_ms(events))

    def test_tts_first_chunk_measured(self):
        events = [
            {"ev": "tts_started", "dry_run": False, "ts_mono_ns": 0},
            {"ev": "tts_chunk_started", "index": 0, "ts_mono_ns": 250_000_000},
        ]
        self.assertEqual(vb.tts_first_chunk_ms(events), 250.0)

    def test_silence_only_counts_nonempty_finals(self):
        events = [
            {"ev": "ready", "ts_mono_ns": 0},
            {"ev": "final", "text": "", "ts_mono_ns": 60_000_000_000},
        ]
        self.assertEqual(vb.speech_finals(events), 0)
        self.assertEqual(vb.partial_count(events), 0)
        self.assertEqual(vb.speech_onset_count(events), 0)
        events.append({"ev": "final", "text": "喂", "ts_mono_ns": 61_000_000_000})
        self.assertEqual(vb.speech_finals(events), 1)

    def test_parse_ndjson_surfaces_bridge_error_and_bad_lines(self):
        lines = ['{"ev":"ready"}', "not json", '{"ok":false,"error":{"code":"E_MIC_PERM","message":"x"}}']
        events, error, malformed = vb.parse_ndjson(lines)
        self.assertEqual(len(events), 1)
        self.assertEqual(error["code"], "E_MIC_PERM")
        self.assertEqual(malformed, 1)

    def test_max_event_gap(self):
        events = [{"ts_mono_ns": 0}, {"ts_mono_ns": 1_000_000_000}, {"ts_mono_ns": 4_500_000_000}]
        self.assertEqual(vb.max_event_gap_ms(events), 3500.0)

    def test_capture_trace_parsing_and_gap(self):
        text = (
            "[mac_speech] feed #25 in=2048 t=1000ms\n"
            "noise\n"
            "[mac_speech] feed #50 in=2048 t=2050ms\n"
            "[mac_speech] feed #75 in=2048 t=6000ms\n"
        )
        entries = vb.parse_capture_trace(text)
        self.assertEqual([e["feed"] for e in entries], [25, 50, 75])
        stats = vb.continuity_from_trace(entries)
        self.assertEqual(stats["feeds"], 3)
        self.assertEqual(stats["max_gap_ms"], 3950.0)
        self.assertTrue(stats["monotonic"])

    def test_capture_trace_detects_non_monotonic_feeds(self):
        entries = [{"feed": 25, "t_ms": 1000}, {"feed": 20, "t_ms": 2000}]
        self.assertFalse(vb.continuity_from_trace(entries)["monotonic"])

    def test_capture_trace_needs_two_heartbeats(self):
        stats = vb.continuity_from_trace([{"feed": 25, "t_ms": 1000}])
        self.assertIsNone(stats["max_gap_ms"])

    def test_mic_long_run_disables_idle_timeout_and_enables_trace(self):
        captured = {}

        def fake_run(command, timeout):
            captured["command"] = command
            captured["timeout"] = timeout
            return {"ok": True, "events": [], "error": None, "stderr": "", "stderr_full": ""}

        with mock.patch.object(vb, "run_command", side_effect=fake_run):
            vb.run_stream_mic(1800)
        command = captured["command"]
        self.assertIn("--trace", command)
        idle = command[command.index("--idle-timeout") + 1]
        self.assertGreaterEqual(int(idle), 1_800_000)
        self.assertEqual(command[command.index("--max-seconds") + 1], "1800")

    def test_voice_resolution_prefers_mandarin(self):
        env = {"zh_voices": [{"identifier": "hk", "language": "zh-HK"}, {"identifier": "cn", "language": "zh-CN"}]}
        self.assertEqual(vb.resolve_voices(env), ["cn", "hk"])


def fixture(**overrides) -> dict:
    data = {
        "fixture": "t_single",
        "kind": "single_utterance",
        "duration_ms": 5000,
        "source": "synthesized",
        "expected": {"utterances": 1, "texts": ["你好"]},
        "notes": "测试夹具",
        "generate": {"segments": [{"text": "你好"}]},
    }
    data.update(overrides)
    return data


class FixtureContractTests(unittest.TestCase):
    def test_valid_fixture_has_no_problems(self):
        self.assertEqual(vb.validate_fixture(fixture(), Path("x.json")), [])

    def test_missing_notes_is_rejected(self):
        data = fixture()
        data.pop("notes")
        problems = vb.validate_fixture(data, Path("x.json"))
        self.assertTrue(any("notes" in p for p in problems))

    def test_empty_notes_is_rejected(self):
        problems = vb.validate_fixture(fixture(notes="  "), Path("x.json"))
        self.assertTrue(any("notes" in p for p in problems))

    def test_unknown_source_is_rejected(self):
        problems = vb.validate_fixture(fixture(source="real-human"), Path("x.json"))
        self.assertTrue(any("source" in p for p in problems))

    def test_texts_length_must_match_utterances(self):
        data = fixture(expected={"utterances": 2, "texts": ["只有一句"]})
        problems = vb.validate_fixture(data, Path("x.json"))
        self.assertTrue(any("expected.texts" in p for p in problems))

    def test_recorded_fixture_must_not_be_generated(self):
        problems = vb.validate_fixture(fixture(source="recorded"), Path("x.json"))
        self.assertTrue(any("recorded" in p for p in problems))

    def test_recorded_fixture_requires_audio_manifest(self):
        data = fixture(source="recorded", audio=["rec_a.caf"], expected={"utterances": 1, "texts": ["甲"]})
        data.pop("generate")
        self.assertEqual(vb.validate_fixture(data, Path("x.json")), [])

        missing = dict(data)
        missing.pop("audio")
        problems = vb.validate_fixture(missing, Path("x.json"))
        self.assertTrue(any("audio" in p for p in problems))

    def test_recorded_fixture_clips_come_from_audio_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data = fixture(
                fixture="rec_scene",
                source="recorded",
                audio=["rec_a.caf", "rec_b.wav"],
                expected={"utterances": 2, "texts": ["甲", "乙"]},
            )
            data.pop("generate")
            (root / "rec.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            found = vb.load_fixtures(root)[0]
            self.assertEqual([c["audio"] for c in found.clips()], ["rec_a.caf", "rec_b.wav"])
            self.assertEqual([c["text"] for c in found.clips()], ["甲", "乙"])

    def test_recorded_fixture_is_never_synthesized(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixtures = root / "fixtures"
            fixtures.mkdir()
            data = fixture(
                fixture="rec_scene",
                source="recorded",
                audio=["rec_a.caf"],
                expected={"utterances": 1, "texts": ["甲"]},
            )
            data.pop("generate")
            (fixtures / "rec.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            args = vb.parse_args(
                ["--fixtures-dir", str(fixtures), "--out", str(root / "r.json"), "--baseline", str(root / "b.json"), "--repeat", "1"]
            )
            with mock.patch.object(vb, "probe_environment", return_value=dict(FAKE_ENV)):
                collected = vb.collect(args)
            self.assertEqual(collected["clips_state"][0]["status"], "missing")
            self.assertIn("needs-recording", collected["clips_state"][0]["reason"])
            self.assertFalse((fixtures / "rec_a.caf").exists())

    def test_pending_hardware_must_not_ship_audio(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "barge_in.json"
            path.write_text("{}", encoding="utf-8")
            (Path(tmp) / "c_fake.caf").write_bytes(b"caff")
            data = fixture(
                fixture="c_fake",
                kind="barge_in",
                source="pending-hardware",
                duration_ms=0,
                expected={"utterances": 0, "texts": []},
            )
            data.pop("generate")
            problems = vb.validate_fixture(data, path)
            self.assertTrue(any("pending-hardware" in p and ".caf" in p for p in problems))

    def test_pending_hardware_without_audio_is_valid(self):
        data = fixture(
            fixture="c_ok",
            kind="barge_in",
            source="pending-hardware",
            duration_ms=0,
            expected={"utterances": 0, "texts": []},
        )
        data.pop("generate")
        self.assertEqual(vb.validate_fixture(data, Path("c.json")), [])

    def test_add_fixture_json_without_changing_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "new_scene.json").write_text(json.dumps(fixture(fixture="zz_new_scene"), ensure_ascii=False), encoding="utf-8")
            found = vb.load_fixtures(root)
            self.assertEqual([f.name for f in found], ["zz_new_scene"])

    def test_invalid_json_reports_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "bad.json").write_text("{oops", encoding="utf-8")
            with self.assertRaises(vb.FixtureError) as ctx:
                vb.load_fixtures(root)
            self.assertIn("bad.json", str(ctx.exception))

    def test_multi_speaker_clips_keep_declared_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data = fixture(
                fixture="b_multi",
                kind="multi_speaker",
                expected={"utterances": 2, "texts": ["甲", "乙"]},
                generate={
                    "segments": [
                        {"name": "s1", "text": "甲", "voice_slot": "A"},
                        {"name": "s2", "text": "乙", "voice_slot": "B"},
                    ]
                },
            )
            (root / "b.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            found = vb.load_fixtures(root)[0]
            self.assertEqual([c["name"] for c in found.clips()], ["s1", "s2"])
            self.assertEqual([c["voice_slot"] for c in found.clips()], ["A", "B"])


def measured(value: float, run: int = 1, metric: str = "first_token") -> dict:
    return {"metric": metric, "fixture": "t", "clip": "c", "run": run, "value": value}


class VerdictTests(unittest.TestCase):
    def test_pass_without_baseline(self):
        entry = vb.judge_metric("first_token", [measured(400)], None)
        self.assertEqual(entry["status"], "measured")
        self.assertEqual(entry["verdict"], "pass")
        self.assertIsNone(entry["regression_pct"])

    def test_absolute_threshold_fails(self):
        entry = vb.judge_metric("first_token", [measured(900)], None)
        self.assertEqual(entry["verdict"], "fail")
        self.assertTrue(any("绝对值" in f for f in entry["failures"]))

    def test_relative_regression_over_20_percent_fails(self):
        entry = vb.judge_metric("first_token", [measured(620)], 500.0)
        self.assertAlmostEqual(entry["regression_pct"], 24.0)
        self.assertEqual(entry["verdict"], "fail")
        self.assertTrue(any("退步" in f for f in entry["failures"]))

    def test_relative_regression_at_limit_passes(self):
        entry = vb.judge_metric("first_token", [measured(600)], 500.0)
        self.assertAlmostEqual(entry["regression_pct"], 20.0)
        self.assertEqual(entry["verdict"], "pass")

    def test_stricter_of_absolute_and_relative_wins(self):
        # 相对退步只有 10%（pass），但绝对值 900ms > 800ms（fail）→ 必须 FAIL
        entry = vb.judge_metric("first_token", [measured(900)], 800.0)
        self.assertAlmostEqual(entry["regression_pct"], 12.5)
        self.assertEqual(entry["verdict"], "fail")

    def test_self_trigger_counts_anything_above_zero(self):
        entry = vb.judge_metric("self_trigger", [measured(1, metric="self_trigger")], None)
        self.assertEqual(entry["verdict"], "fail")

    def test_hard_failure_fails_even_when_value_passes(self):
        entry = vb.judge_metric("capture_continuity", [measured(500)], None, ["feed 序号不单调"])
        self.assertEqual(entry["verdict"], "fail")
        self.assertIn("feed 序号不单调", entry["failures"])

    def test_stability_within_limit_passes(self):
        samples = [measured(100, 1), measured(115, 2)]
        stability = vb.judge_stability(samples, 2)
        self.assertEqual(stability["metrics"][0]["delta_pct"], 15.0)
        self.assertEqual(stability["metrics"][0]["verdict"], "pass")

    def test_stability_doubling_fails(self):
        samples = [measured(100, 1), measured(200, 2)]
        stability = vb.judge_stability(samples, 2)
        self.assertEqual(stability["metrics"][0]["verdict"], "fail")

    def test_stability_needs_two_runs(self):
        self.assertIsNone(vb.judge_stability([measured(100, 1)], 1))
        stability = vb.judge_stability([measured(100, 1)], 2)
        self.assertEqual(stability["metrics"], [])


def replay_report(repeat: int = 1, replay_dir: Path = DATA) -> dict:
    args = vb.parse_args(
        ["--replay-dir", str(replay_dir), "--repeat", str(repeat), "--fixtures-dir", str(FIXTURES)]
    )
    collected = vb.collect(args)
    return vb.build_report(collected, {"schema": vb.SCHEMA, "seeded": False, "metrics": {}}, repeat)


class ReportTests(unittest.TestCase):
    def test_skipped_metric_has_no_verdict(self):
        entry = vb.skipped_metric("tts_first_chunk", "needs-hardware: 没有喇叭")
        self.assertEqual(entry["status"], "skipped")
        self.assertIsNone(entry["verdict"])
        self.assertIn("needs-hardware", entry["reason"])

    def test_validate_report_rejects_status_pass(self):
        report = replay_report()
        report["metrics"][0]["status"] = "pass"
        self.assertTrue(any("status" in p for p in vb.validate_report(report)))

    def test_validate_report_rejects_skip_with_verdict(self):
        report = replay_report()
        report["metrics"][2] = vb.skipped_metric("tts_first_chunk", "needs-hardware: x")
        report["metrics"][2]["verdict"] = "pass"
        self.assertTrue(any("verdict" in p for p in vb.validate_report(report)))

    def test_validate_report_rejects_measured_without_samples(self):
        report = replay_report()
        report["metrics"][0]["n"] = 0
        report["metrics"][0]["p95"] = None
        problems = vb.validate_report(report)
        self.assertTrue(any("n>0" in p or "p95" in p for p in problems))

    def test_replay_report_measures_all_six(self):
        report = replay_report(repeat=2)
        self.assertEqual([m["metric"] for m in report["metrics"]], list(vb.METRICS))
        self.assertTrue(all(m["status"] == "measured" for m in report["metrics"]))
        self.assertEqual(report["exit_code"], 0)
        self.assertTrue(report["host"]["replay"])
        self.assertEqual(report["device"]["source"], "replay")

    def test_silence_fixture_row_passes_with_zero_speech_finals(self):
        report = replay_report()
        row = next(f for f in report["fixtures"] if f["fixture"] == "d_silence_10min")
        self.assertEqual(row["speech_finals"], 0)
        self.assertTrue(row["ok"])

    def test_summary_marks_skips_and_replay(self):
        report = replay_report()
        text = vb.render_summary(report, Path("/tmp/x.json"), Path("/tmp/b.json"))
        self.assertIn("replay", text)
        self.assertIn("不是硬件证据", text)

    def test_report_shaped_baseline_is_read(self):
        report = replay_report()
        report["seeded"] = True
        self.assertEqual(vb.baseline_p95(report, "first_token"), 500.0)

    def test_skipped_baseline_entry_is_not_a_baseline(self):
        report = replay_report()
        for entry in report["metrics"]:
            if entry["metric"] == "first_token":
                entry["status"] = "skipped"
                entry["p95"] = None
        self.assertIsNone(vb.baseline_p95(report, "first_token"))

    def test_legacy_map_baseline_still_read(self):
        legacy = {"schema": vb.SCHEMA, "seeded": True, "metrics": {"first_token": {"p95": 480.0}}}
        self.assertEqual(vb.baseline_p95(legacy, "first_token"), 480.0)

    def test_seeded_baseline_is_isomorphic_to_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "baseline.json"
            report = replay_report()
            payload = vb.seed_baseline(path, report)
            written = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(set(written) - {"seeded", "seed_note"}, set(report))
            self.assertTrue(written["seeded"])
            self.assertTrue(payload["seeded"])
            self.assertEqual([m["metric"] for m in written["metrics"]], list(vb.METRICS))
            self.assertEqual(vb.baseline_p95(written, "first_token"), 500.0)

    def test_committed_baseline_is_unseeded_and_well_formed(self):
        data = json.loads((VOICE_DIR / "baseline.json").read_text(encoding="utf-8"))
        self.assertFalse(data["seeded"])
        self.assertEqual([m["metric"] for m in data["metrics"]], list(vb.METRICS))
        self.assertTrue(all(vb.baseline_p95(data, metric) is None for metric in vb.METRICS))


class CliTests(unittest.TestCase):
    def run_main(self, argv: list[str]) -> tuple[int, str]:
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(io.StringIO()):
            code = vb.main(argv)
        return code, buffer.getvalue()

    def test_without_toolchain_reports_skip_not_pass(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(vb, "probe_environment", return_value=dict(FAKE_ENV)):
            out = Path(tmp) / "report.json"
            code, text = self.run_main(
                [
                    "--out",
                    str(out),
                    "--baseline",
                    str(Path(tmp) / "baseline.json"),
                    "--no-generate",
                    "--repeat",
                    "1",
                ]
            )
            self.assertEqual(code, 3)
            self.assertIn("SKIP", text)
            self.assertNotIn("PASS", text)
            report = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(vb.validate_report(report), [])
            self.assertEqual(report["result"], "incomplete")
            self.assertEqual(report["summary"], {"pass": 0, "fail": 0, "skip": 6})

    def test_unseeded_run_does_not_write_baseline(self):
        with tempfile.TemporaryDirectory() as tmp:
            baseline = Path(tmp) / "baseline.json"
            code, _ = self.run_main(
                [
                    "--replay-dir",
                    str(DATA),
                    "--out",
                    str(Path(tmp) / "report.json"),
                    "--baseline",
                    str(baseline),
                    "--repeat",
                    "1",
                ]
            )
            self.assertEqual(code, 0)
            self.assertFalse(baseline.exists())

    def test_mac_authorised_without_playback_measures_two_and_skips_four(self):
        """判据 2 的反向验证：有麦克风授权、不出声的 Mac → 2 measured / 4 SKIP，退出码 3。"""
        mac_env = {
            "platform": "Darwin",
            "machine": "arm64",
            "macos_version": "26.1",
            "swift": "/usr/bin/swift",
            "probe_error": None,
            "mic_authorization": "authorized",
            "mic_name": "Mac mini Microphone",
            "speaker_name": "Mac mini Speakers",
            "zh_voices": [{"identifier": "cn", "language": "zh-CN", "name": "Tingting"}],
            "asr": {"is_available": True, "zh_asset_status": "installed"},
        }
        events, _, _ = vb.parse_ndjson((DATA / "a_single_zh_5s.ndjson").read_text(encoding="utf-8").splitlines())

        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(
            vb, "probe_environment", return_value=mac_env
        ), mock.patch.object(
            vb, "run_stream_file", return_value={"ok": True, "events": events, "error": None}
        ):
            root = Path(tmp)
            fixtures = root / "fixtures"
            fixtures.mkdir()
            data = fixture(fixture="a_single_zh_5s")
            (fixtures / "a.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            (fixtures / "a_single_zh_5s.caf").write_bytes(b"caff")
            out = root / "report.json"
            code, text = self.run_main(
                [
                    "--fixtures-dir",
                    str(fixtures),
                    "--out",
                    str(out),
                    "--baseline",
                    str(root / "baseline.json"),
                    "--no-playback",
                    "--repeat",
                    "1",
                ]
            )
            self.assertEqual(code, 3)
            report = json.loads(out.read_text(encoding="utf-8"))
            measured = [m["metric"] for m in report["metrics"] if m["status"] == "measured"]
            skipped = [m["metric"] for m in report["metrics"] if m["status"] == "skipped"]
            self.assertEqual(measured, ["first_token", "asr_final"])
            self.assertEqual(
                skipped, ["tts_first_chunk", "barge_in", "self_trigger", "capture_continuity"]
            )
            self.assertEqual(report["summary"], {"pass": 2, "fail": 0, "skip": 4})
            self.assertEqual(report["device"]["mic"], "Mac mini Microphone")
            self.assertIn("not-requested", report["metrics"][2]["reason"])

    def test_doubled_sample_against_seeded_baseline_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            baseline = root / "baseline.json"
            baseline_doc = json.loads(json.dumps(replay_report()))
            baseline_doc["seeded"] = True
            baseline.write_text(json.dumps(baseline_doc, ensure_ascii=False), encoding="utf-8")

            # 未篡改：与基线一致，必须 PASS
            code, _ = self.run_main(
                [
                    "--replay-dir",
                    str(DATA),
                    "--out",
                    str(root / "same.json"),
                    "--baseline",
                    str(baseline),
                    "--repeat",
                    "1",
                ]
            )
            self.assertEqual(code, 0)

            # 人为把 5s 夹具的首字采样翻倍：400ms → 800ms（绝对值恰好不超，相对退步 60%）。
            tampered = root / "data"
            shutil.copytree(DATA, tampered)
            path = tampered / "a_single_zh_5s.ndjson"
            lines = []
            for line in path.read_text(encoding="utf-8").splitlines():
                event = json.loads(line)
                if event.get("ev") == "partial" and event.get("revision") == 1:
                    event["audio_end_ms"] = 1400
                lines.append(json.dumps(event, ensure_ascii=False))
            path.write_text("\n".join(lines) + "\n", encoding="utf-8")

            code, text = self.run_main(
                [
                    "--replay-dir",
                    str(tampered),
                    "--out",
                    str(root / "regressed.json"),
                    "--baseline",
                    str(baseline),
                    "--repeat",
                    "1",
                ]
            )
            self.assertEqual(code, 1)
            self.assertIn("FAIL", text)
            self.assertIn("退步", text)

    def test_seed_from_replay_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            baseline = Path(tmp) / "baseline.json"
            code, _ = self.run_main(
                [
                    "--replay-dir",
                    str(DATA),
                    "--out",
                    str(Path(tmp) / "r.json"),
                    "--baseline",
                    str(baseline),
                    "--repeat",
                    "1",
                    "--seed-baseline",
                ]
            )
            self.assertEqual(code, 2)
            self.assertFalse(baseline.exists())

    def test_seed_refuses_when_nothing_measured(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(vb, "probe_environment", return_value=dict(FAKE_ENV)):
            baseline = Path(tmp) / "baseline.json"
            code, _ = self.run_main(
                [
                    "--out",
                    str(Path(tmp) / "report.json"),
                    "--baseline",
                    str(baseline),
                    "--no-generate",
                    "--repeat",
                    "1",
                    "--seed-baseline",
                ]
            )
            self.assertEqual(code, 2)
            self.assertFalse(baseline.exists())

    def test_generate_only_writes_silence_wav_on_linux(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixtures = root / "fixtures"
            fixtures.mkdir()
            (fixtures / "silence.json").write_text(
                json.dumps(
                    {
                        "fixture": "x_silence",
                        "kind": "silence",
                        "duration_ms": 1000,
                        "source": "synthesized",
                        "expected": {"utterances": 0, "texts": []},
                        "notes": "静音测试",
                        "generate": {"silence_ms": 1000, "audio": "x_silence.wav"},
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            with mock.patch.object(vb, "probe_environment", return_value=dict(FAKE_ENV)):
                code, text = self.run_main(
                    ["--fixtures-dir", str(fixtures), "--generate-only", "--out", str(root / "r.json")]
                )
            self.assertEqual(code, 0)
            self.assertIn("generated", text)
            wav = fixtures / "x_silence.wav"
            self.assertTrue(wav.exists())
            self.assertEqual(wav.stat().st_size, 44 + 16000 * 2)


if __name__ == "__main__":
    unittest.main()
