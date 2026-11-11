"""GH-58：`eval/aec3/smoke_voice.sh` 的离线判据（不需要麦克风/喇叭/macOS）。

断言层 `voice_smoke.py` 与进程采集解耦，所以这里能用固定 NDJSON fixture 把
B1–B7 逐条打红/打绿。反向判据是重点：把成功 fixture 的 `tts_played.played`
改成 0、删掉 `tts_played`、删掉 `bridge_ready`，对应检查必须变成 FAIL——
只证明「成功样例是绿的」不足以证明判据有约束力。

运行：cd robotd && python -m pytest tests/unit/test_smoke_voice.py -q
（也用标准库 unittest 直接跑：python -m unittest discover -s tests/unit -p 'test_smoke_voice.py'）
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
AEC3 = ROOT / "eval" / "aec3"
SCRIPT = AEC3 / "smoke_voice.sh"
ASSERT = AEC3 / "voice_smoke.py"
FIXTURES = AEC3 / "fixtures"
PASS_EVENTS = FIXTURES / "smoke_voice_pass.ndjson"
PASS_STDERR = FIXTURES / "smoke_voice_pass.stderr"
CRASH_STDERR = FIXTURES / "smoke_voice_crash.stderr"
README = AEC3 / "README.md"

RESPONSE_ID = "smoke-voice"
PRODUCTION_COMMANDS = {
    "listen",
    "stop",
    "speak",
    "stop_speak",
    "mute",
    "unmute",
    "status",
    "quit",
}


def _events() -> list[dict]:
    lines = PASS_EVENTS.read_text(encoding="utf-8").splitlines()
    return [json.loads(line) for line in lines if line.strip()]


class SmokeVoiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="gh58-smoke-voice-")
        self.tmp = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _assert(
        self,
        events: list[dict] | None = None,
        stderr: Path = PASS_STDERR,
        response_id: str | None = RESPONSE_ID,
    ) -> subprocess.CompletedProcess:
        path = self.tmp / "events.ndjson"
        chosen = _events() if events is None else events
        path.write_text(
            "\n".join(json.dumps(event, ensure_ascii=False) for event in chosen) + "\n",
            encoding="utf-8",
        )
        command = [sys.executable, str(ASSERT), "--events", str(path), "--stderr", str(stderr)]
        if response_id is not None:
            command += ["--response-id", response_id]
        return subprocess.run(command, capture_output=True, text=True, check=False)

    def _failed(self, out: str) -> set[str]:
        return set(re.findall(r"^FAIL (\w+) ", out, re.MULTILINE))

    def test_script_is_executable_and_passes_sh_n(self) -> None:
        self.assertTrue(SCRIPT.is_file())
        self.assertTrue(os.access(SCRIPT, os.X_OK), "smoke_voice.sh 必须可执行（100755）")
        syntax = subprocess.run(["sh", "-n", str(SCRIPT)], capture_output=True, text=True, check=False)
        self.assertEqual(syntax.returncode, 0, syntax.stderr)

    def test_success_fixture_passes_and_prints_counts(self) -> None:
        proc = self._assert()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("tts_chunk_finished      3", proc.stdout)
        self.assertIn("played: 1,2,3", proc.stdout)
        self.assertIn("最大值 3", proc.stdout)
        self.assertTrue(proc.stdout.rstrip().endswith("PASS"))
        self.assertEqual(self._failed(proc.stdout), set())

    def test_missing_bridge_ready_fails(self) -> None:
        events = [event for event in _events() if event.get("ev") != "bridge_ready"]
        proc = self._assert(events)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("B1", self._failed(proc.stdout))

    def test_missing_tts_played_fails(self) -> None:
        events = [event for event in _events() if event.get("ev") != "tts_played"]
        proc = self._assert(events)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("B4", self._failed(proc.stdout))
        self.assertIn("缺 tts_played", proc.stdout)

    def test_zero_played_fails_b4(self) -> None:
        """反向判据（#58 判据 3）：`tts_played.played` 改成 0 必须变红。"""
        events = _events()
        for event in events:
            if event.get("ev") == "tts_played":
                event["played"] = 0
        proc = self._assert(events)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("B4", self._failed(proc.stdout))
        self.assertIn("played 最大值 = 0", proc.stdout)
        # B4 不能被 tts_chunk_finished.played 蒙混过关：那些事件仍是 1/2/3。
        self.assertNotIn("B3", self._failed(proc.stdout))

    def test_terminating_app_in_stderr_fails(self) -> None:
        proc = self._assert(stderr=CRASH_STDERR)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("B6", self._failed(proc.stdout))
        self.assertIn("Terminating app", proc.stdout)

    def test_no_capture_level_in_window_fails_b7(self) -> None:
        events = [event for event in _events() if event.get("ev") not in {"aec_echo_probe", "speech_state"}]
        proc = self._assert(events)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("B7", self._failed(proc.stdout))

    def test_levels_only_before_the_speech_window_fail_b7(self) -> None:
        """B7 只看播报窗口：窗口外的电平不能证明播报期间麦克风还在更新。"""
        events = _events()
        for event in events:
            if event.get("ev") == "aec_echo_probe" and isinstance(event.get("t_ms"), int):
                event["t_ms"] = 100 + (event["t_ms"] % 1000)
        proc = self._assert(events)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("B7", self._failed(proc.stdout))
        self.assertIn("播报窗口内 0", proc.stdout)

    def test_speech_state_also_satisfies_b7(self) -> None:
        events = []
        for event in _events():
            if event.get("ev") == "aec_echo_probe":
                events.append({"ev": "speech_state", "state": "speech", "t_ms": event["t_ms"]})
            else:
                events.append(event)
        proc = self._assert(events)
        self.assertEqual(proc.returncode, 0, proc.stdout)

    def test_dry_run_is_not_playback_evidence(self) -> None:
        events = _events()
        for event in events:
            if event.get("ev") == "tts_started":
                event["dry_run"] = True
        proc = self._assert(events)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("B4", self._failed(proc.stdout))

    def test_harness_build_is_rejected_as_production_evidence(self) -> None:
        events = _events()
        for event in events:
            if event.get("ev") == "bridge_ready":
                event["test_harness"] = True
        proc = self._assert(events)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("C0", self._failed(proc.stdout))

    def test_other_response_ids_do_not_satisfy_tts_checks(self) -> None:
        """同一份事件换个 response_id 看，TTS 判据必须全红，不能串到别人的播报。"""
        proc = self._assert(response_id="someone-else")
        self.assertEqual(proc.returncode, 1)
        self.assertTrue({"B2", "B3", "B4", "B5", "B7"} <= self._failed(proc.stdout))
        self.assertNotIn("B1", self._failed(proc.stdout))

    def test_malformed_ndjson_is_an_input_error(self) -> None:
        path = self.tmp / "broken.ndjson"
        path.write_text('{"ev": "bridge_ready"}\nnot-json\n', encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, str(ASSERT), "--events", str(path), "--stderr", str(PASS_STDERR)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 2)
        self.assertIn("不是合法 JSON", proc.stderr)

    def test_script_only_sends_production_commands(self) -> None:
        text = SCRIPT.read_text(encoding="utf-8")
        commands = set(re.findall(r'"cmd"\s*:\s*"([a-z_]+)"', text))
        self.assertTrue(commands, "脚本必须实际发送命令")
        extra = commands - PRODUCTION_COMMANDS
        self.assertFalse(extra, f"用了生产命令面以外的命令：{extra}")
        self.assertIn("speak", commands)
        self.assertNotIn("harness_play_wav", text)
        self.assertNotIn("harness_record_pair", text)
        self.assertNotIn("WALLY_AUDIO_TEST_HARNESS", text)

    def test_assert_only_entrypoint_runs_offline(self) -> None:
        proc = subprocess.run(
            ["sh", str(SCRIPT), "--assert-only", str(PASS_EVENTS), str(PASS_STDERR)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("PASS", proc.stdout)

    def test_assert_only_entrypoint_propagates_failure(self) -> None:
        events = _events()
        for event in events:
            if event.get("ev") == "tts_played":
                event["played"] = 0
        path = self.tmp / "zero-played.ndjson"
        path.write_text(
            "\n".join(json.dumps(event, ensure_ascii=False) for event in events) + "\n",
            encoding="utf-8",
        )
        proc = subprocess.run(
            ["sh", str(SCRIPT), "--assert-only", str(path), str(PASS_STDERR)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("FAIL B4", proc.stdout)

    def test_non_darwin_is_an_explicit_skip_not_a_pass(self) -> None:
        if sys.platform == "darwin":
            self.skipTest("真机行为由 #41 验收；这里只锁非 Darwin 的 SKIP")
        proc = subprocess.run(["sh", str(SCRIPT)], capture_output=True, text=True, check=False)
        self.assertEqual(proc.returncode, 77, proc.stdout + proc.stderr)
        self.assertTrue(proc.stdout.startswith("SKIP:"))
        self.assertIn("SKIP 不是 PASS", proc.stdout)

    def test_readme_documents_the_real_command_and_outputs(self) -> None:
        text = README.read_text(encoding="utf-8")
        self.assertIn("smoke_voice.sh", text)
        self.assertIn('SMOKE_VOICE_TEXT=""', text)
        self.assertIn("work/verify/smoke_voice", text)
        self.assertIn("退出码", text)
        # 文档里提到的每个 .sh 都必须真的存在，避免再写「执行不存在的脚本」。
        for name in set(re.findall(r"([A-Za-z0-9_./-]+\.sh)", text)):
            candidate = ROOT / name
            if not candidate.exists():
                candidate = AEC3 / name
            self.assertTrue(candidate.exists(), f"README 提到的脚本不存在：{name}")


if __name__ == "__main__":
    unittest.main()
