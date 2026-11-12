"""GH-65：AEC 实验断言层 `eval/aec3/aec_assert.sh` 的离线判据。

事故背景（#41 真机现场）：Swift 桥输出的是紧凑 JSON（`"test_harness":true`，
冒号后无空格），而 `aec_ab2.sh` / `collect_pair.sh` 用带空格的 grep 字面量去匹配，
于是 harness 明明启动并校准过，六组实验仍被判成「未用测试构建」；更糟的是
`aec_ab2.sh` 最后无条件 `echo OK`，六组全崩也照样打印 OK。

这里钉住两件事：

1. 判据读**解析后的字段**，与 JSON 排版无关（紧凑与带空格两种写法都必须绿）；
2. 桥进错 AEC 模式、或生产构建冒充 harness，必须变红；
3. 单组失败必须让 `aec_ab2.sh` 非零退出，且不再打印 OK。

全部离线：只用标准库 `unittest` + `subprocess`，不需要 macOS、麦克风或扬声器。

运行：cd robotd && python -m pytest tests/unit/test_aec_assert.py -q
（也可 `python3 -m unittest tests.unit.test_aec_assert -v`）
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
AEC3 = ROOT / "eval" / "aec3"
ASSERT = AEC3 / "aec_assert.sh"
AB2 = AEC3 / "aec_ab2.sh"
COLLECT = AEC3 / "collect_pair.sh"
FIXTURES = AEC3 / "fixtures"
AEC3_EVENTS = FIXTURES / "ab2_harness_aec3.ndjson"
VPIO_EVENTS = FIXTURES / "ab2_harness_vpio.ndjson"
PRODUCTION_EVENTS = FIXTURES / "smoke_voice_pass.ndjson"


def _bridge_line(path: Path) -> str:
    for line in path.read_text(encoding="utf-8").splitlines():
        if '"bridge_ready"' in line:
            return line
    raise AssertionError(f"{path} 里没有 bridge_ready")


# 离线假桥：只实现 `open` 的参数约定（--stdin/--stdout）与关键事件。它在启动时
# 就把 play_finished 写进去（真实桥是播完才写），这样汇总用例只验证「退出码怎么
# 合」，不依赖真实节奏。
FAKE_BRIDGE = """IN=""
OUT=""
MODE=vpio
while [ $# -gt 0 ]; do
  case "$1" in
    --stdin) IN=$2; shift 2 ;;
    --stdout) OUT=$2; shift 2 ;;
    --aec3) MODE=aec3; shift ;;
    *) shift ;;
  esac
done
{
  printf '{"aec":true,"aec_mode":"%s","engine_started":true,"ev":"bridge_ready","t_ms":10,"test_harness":true}\\n' "$MODE"
  printf '{"ev":"vad_calibrated","t_ms":20}\\n'
  printf '{"ev":"play_finished","dur_ms":5000,"t_ms":30}\\n'
} > "$OUT"
exec 3<"$IN"
i=0
while [ "$i" -lt 400 ]; do
  if read -r line <&3; then
    case "$line" in *quit*) exit 0 ;; esac
  else
    /bin/sleep 0.02
  fi
  i=$((i + 1))
done
exit 0"""

# 缩短脚本里「等现实时间」的 sleep，但**不能**缩短 `sleep 90 > fifo &` 那个
# 保持 FIFO 写端打开的 holder：它一提前退出，脚本后面写命令就会永久阻塞。
SHORT_SLEEP = """if [ "$1" -ge 30 ] 2>/dev/null; then
  exec /bin/sleep 30
fi
exec /bin/sleep 0.02"""


class AecAssertTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="gh65-aec-assert-")
        self.tmp = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _run(self, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["sh", str(ASSERT), *args],
            capture_output=True,
            text=True,
            check=False,
            env=env,
            timeout=60,
        )

    def _failed(self, out: str) -> set[str]:
        return {
            line.split()[1] for line in out.splitlines() if line.startswith("FAIL ") and len(line.split()) > 1
        }

    def _ab2_env(self, open_body: str) -> dict[str, str]:
        """给 aec_ab2.sh 一套不碰设备的替身：假 open + 空操作 pkill + 极短 sleep。"""
        shims = self.tmp / "bin"
        shims.mkdir()
        for name, body in (
            ("sleep", SHORT_SLEEP),
            ("pkill", "exit 0"),
            # 真 `open` 启动 app 后立刻返回；假桥要跟真桥一样在后台跑，
            # 否则脚本会一直等这个前台进程退出。
            ("open", f"(\n{open_body}\n) >/dev/null 2>&1 &\nexit 0"),
        ):
            script = shims / name
            script.write_text(f"#!/bin/sh\n{body}\n", encoding="utf-8")
            script.chmod(0o755)
        app = self.tmp / "AudioBridge.app"
        app.mkdir()
        wav = self.tmp / "aec_probe.wav"
        wav.write_bytes(b"RIFF0000WAVE")
        env = dict(os.environ)
        env["PATH"] = f"{shims}{os.pathsep}{env.get('PATH', '')}"
        env["AEC_AB2_APP"] = str(app)
        env["AEC_AB2_WAV"] = str(wav)
        env["AEC_AB2_OUT"] = str(self.tmp / "out")
        return env

    # --- 判定层本身 ---------------------------------------------------------

    def test_fixture_is_compact_json_like_the_swift_bridge(self) -> None:
        """fixture 必须保留事故现场的排版：冒号后无空格，否则验不出原来的 bug。"""
        text = AEC3_EVENTS.read_text(encoding="utf-8")
        self.assertIn('"test_harness":true', text)
        self.assertIn('"aec_mode":"aec3"', text)
        self.assertNotIn('"test_harness": true', text)

    def test_assert_script_is_executable_and_passes_sh_n(self) -> None:
        self.assertTrue(ASSERT.is_file())
        self.assertTrue(os.access(ASSERT, os.X_OK), "aec_assert.sh 必须可执行（100755）")
        syntax = subprocess.run(["sh", "-n", str(ASSERT)], capture_output=True, text=True, check=False)
        self.assertEqual(syntax.returncode, 0, syntax.stderr)

    def test_compact_harness_aec3_fixture_passes(self) -> None:
        """判据 1：紧凑 JSON 必须被正确识别（事故现场就是在这里被误判）。"""
        proc = self._run("bridge", str(AEC3_EVENTS), "--require-harness", "--expect-aec-mode", "aec3")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("PASS C0", proc.stdout)
        self.assertIn("PASS C0b", proc.stdout)
        self.assertEqual(self._failed(proc.stdout), set())
        self.assertTrue(proc.stdout.rstrip().endswith("PASS"))

    def test_spaced_json_also_passes(self) -> None:
        """判据 1 的反向：判据不能从一种排版换到另一种排版。"""
        events = [
            json.loads(line) for line in AEC3_EVENTS.read_text(encoding="utf-8").splitlines() if line.strip()
        ]
        spaced = self.tmp / "spaced.ndjson"
        # json.dumps 默认分隔符是 ', ' / ': '，即冒号后带空格。
        spaced.write_text(
            "\n".join(json.dumps(event, ensure_ascii=False) for event in events) + "\n",
            encoding="utf-8",
        )
        self.assertIn('"test_harness": true', spaced.read_text(encoding="utf-8"))
        proc = self._run("bridge", str(spaced), "--require-harness", "--expect-aec-mode", "aec3")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(self._failed(proc.stdout), set())

    def test_vpio_bridge_is_rejected_as_aec3(self) -> None:
        """判据 2：`--aec3` 被忽略（桥其实是 VPIO）必须变红，且红在 C0b。"""
        proc = self._run("bridge", str(VPIO_EVENTS), "--require-harness", "--expect-aec-mode", "aec3")
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("C0b", self._failed(proc.stdout))
        self.assertIn("vpio", proc.stdout)
        self.assertNotIn("C0", self._failed(proc.stdout))

    def test_production_fixture_is_rejected_when_harness_is_required(self) -> None:
        """判据 3：生产构建不能冒充 harness 实验。"""
        proc = self._run("bridge", str(PRODUCTION_EVENTS), "--require-harness")
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("C0", self._failed(proc.stdout))

    def test_production_fixture_still_passes_without_the_switch(self) -> None:
        """判据 3 反向：默认判据（smoke_voice 的生产构建语义）没被改坏。"""
        proc = self._run("bridge", str(PRODUCTION_EVENTS))
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("PASS C0", proc.stdout)

    def test_string_true_is_not_a_json_true(self) -> None:
        """手写 fixture 写成字符串 "true" 不算回报了 harness。"""
        events = [
            json.loads(line) for line in AEC3_EVENTS.read_text(encoding="utf-8").splitlines() if line.strip()
        ]
        for event in events:
            if event.get("ev") == "bridge_ready":
                event["test_harness"] = "true"
        path = self.tmp / "string-true.ndjson"
        path.write_text("\n".join(json.dumps(event) for event in events) + "\n", encoding="utf-8")
        proc = self._run("bridge", str(path), "--require-harness")
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("C0", self._failed(proc.stdout))

    def test_play_subcommand_requires_play_finished(self) -> None:
        """判据 4 的原料：缺 play_finished 的 fixture 走 play 必须红。"""
        good = self._run("play", str(AEC3_EVENTS))
        self.assertEqual(good.returncode, 0, good.stdout + good.stderr)
        self.assertIn("PASS P1", good.stdout)

        events = [
            json.loads(line) for line in AEC3_EVENTS.read_text(encoding="utf-8").splitlines() if line.strip()
        ]
        trimmed = self.tmp / "no-play-finished.ndjson"
        trimmed.write_text(
            "\n".join(json.dumps(event) for event in events if event.get("ev") != "play_finished") + "\n",
            encoding="utf-8",
        )
        proc = self._run("play", str(trimmed))
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("P1", self._failed(proc.stdout))
        self.assertIn("play_finished 次数 = 0", proc.stdout)

    def test_input_errors_exit_2(self) -> None:
        self.assertEqual(self._run().returncode, 2)
        self.assertEqual(self._run("bridge").returncode, 2)
        self.assertEqual(self._run("dance", str(AEC3_EVENTS)).returncode, 2)
        self.assertEqual(self._run("bridge", str(self.tmp / "missing.ndjson")).returncode, 2)
        self.assertEqual(self._run("bridge", str(AEC3_EVENTS), "--expect-aec-mode").returncode, 2)
        self.assertEqual(self._run("bridge", str(AEC3_EVENTS), "--nope").returncode, 2)

    def test_malformed_json_fails_closed(self) -> None:
        broken = self.tmp / "broken.ndjson"
        broken.write_text('{"ev": "bridge_ready"}\nnot-json\n', encoding="utf-8")
        proc = self._run("bridge", str(broken), "--require-harness")
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("不是合法 JSON", proc.stdout + proc.stderr)

    # --- 调用方：判据必须复用，不能各抄一份 ---------------------------------

    def test_aec_scripts_call_the_shared_assertion_layer(self) -> None:
        for script in (AB2, COLLECT):
            text = script.read_text(encoding="utf-8")
            self.assertIn("aec_assert.sh", text, f"{script.name} 必须调用共用断言层")
            for literal in ("'\"test_harness\": true'", '\'"aec_mode": "aec3"\''):
                self.assertNotIn(literal, text, f"{script.name} 还在用 grep 字面量判 JSON：{literal}")

    def test_failed_round_makes_ab2_exit_nonzero_without_ok(self) -> None:
        """判据 4（本条核心）：任何一组失败都必须非零退出，且不再打印 OK。

        不碰设备：用一个假 `open`（直接失败）+ 无操作的 `sleep` 让桥永远等不到
        `vad_calibrated`，于是每一组都走「校准超时」的失败分支。真实 `sleep`
        会让这个用例跑上几分钟，所以只在 PATH 里替换 sleep/pkill/open。
        """
        proc = subprocess.run(
            ["sh", str(AB2), "1", "vpio"],
            capture_output=True,
            text=True,
            check=False,
            env=self._ab2_env("exit 1"),
            timeout=120,
        )

        combined = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 1, combined)
        self.assertIn("校准超时", proc.stdout)
        self.assertIn("FAIL", proc.stderr)
        self.assertIn("2/2", proc.stderr)
        self.assertEqual(
            [line for line in combined.splitlines() if line.startswith("OK")],
            [],
            "任一组失败时不许打印 OK",
        )

    def test_all_rounds_passing_exits_zero_and_prints_ok(self) -> None:
        """判据 4 的另一半：全过时必须退出 0 并打印 OK（别把汇总改成永远红）。

        假桥回紧凑 JSON，`aec_mode` 跟着 `--aec3` 走，所以 aec3 那一组同时走通
        C0b；`play_finished` 让 play 断言通过。
        """
        proc = subprocess.run(
            ["sh", str(AB2), "1", "aec3"],
            capture_output=True,
            text=True,
            check=False,
            env=self._ab2_env(FAKE_BRIDGE),
            timeout=120,
        )

        combined = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 0, combined)
        self.assertIn("=== 第 1 轮 ===", proc.stdout)
        self.assertIn("OK 2 组全部通过", proc.stdout)
        self.assertNotIn("FAIL", combined)


if __name__ == "__main__":
    unittest.main()
