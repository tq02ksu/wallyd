"""GH-55：测试专用 WAV 通道的默认构建门禁（Linux 可判定）。

Swift 桥在 Linux CI 上不能编译，所以这里不假装是运行时测试。它钉住三件
E0/E1 可判定的事：

  1. 命令白名单：默认构建仍然只有 8 条命令；`harness_play_wav` /
     `harness_record_pair` 只存在于 `#if WALLY_AUDIO_TEST_HARNESS` 块里，
     默认构建因此回 `E_CMD_UNKNOWN`；
  2. harness 复用同一个 `ServeBridgeV2` / `playerNode`，不另起播放路径；
  3. `eval/aec3` 脚本改走 harness 命令，并在 `bridge_ready` 未回报
     `"test_harness": true` 时把实验判作废。

真正“默认构建真的不认识 / 开启后真的认识”由 `scripts/apple/Tests` 的两份
XCTest 执行（apple lane，不碰音频设备）：`BridgeCoreTests` 用默认编译，
`BridgeCoreHarnessTests` 用 `-D WALLY_AUDIO_TEST_HARNESS` 编译同一份抽取源码。
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PIPELINE = ROOT / "scripts" / "mac_speech_pipeline.swift"
ENTRY = ROOT / "scripts" / "mac_speech.swift"
BUILD = ROOT / "scripts" / "build_audio_bridge.sh"
APPLE = ROOT / "scripts" / "apple"
AEC3 = ROOT / "eval" / "aec3"

FLAG = "WALLY_AUDIO_TEST_HARNESS"
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
HARNESS_COMMANDS = {"harness_play_wav", "harness_record_pair"}


def _strip_flag_blocks(text: str) -> str:
    """Return ``text`` with every ``#if ... WALLY_AUDIO_TEST_HARNESS`` block removed.

    Nested ``#if`` blocks are handled so a conditional inside the harness body
    cannot leak its source into the “default build” view.
    """
    kept: list[str] = []
    depth = 0
    for line in text.splitlines():
        stripped = line.strip()
        if depth == 0 and stripped.startswith("#if") and FLAG in stripped:
            depth = 1
            continue
        if depth:
            if stripped.startswith("#if"):
                depth += 1
            elif stripped.startswith("#endif"):
                depth -= 1
            continue
        kept.append(line)
    return "\n".join(kept)


def _flag_blocks(text: str) -> str:
    """Return only the bodies of ``#if ... WALLY_AUDIO_TEST_HARNESS`` blocks."""
    kept: list[str] = []
    depth = 0
    for line in text.splitlines():
        stripped = line.strip()
        if depth == 0 and stripped.startswith("#if") and FLAG in stripped:
            depth = 1
            continue
        if depth:
            if stripped.startswith("#if"):
                depth += 1
            elif stripped.startswith("#endif"):
                depth -= 1
            else:
                kept.append(line)
    return "\n".join(kept)


def _block(text: str, marker: str) -> str:
    """Brace-matched body of the declaration starting at ``marker``."""
    start = text.index(marker)
    i = text.index("{", start)
    depth = 0
    while i < len(text):
        ch = text[i]
        if ch == "/" and text.startswith("//", i):
            newline = text.find("\n", i)
            if newline < 0:
                break
            i = newline
            continue
        if ch == '"':
            i += 1
            while i < len(text) and text[i] != '"':
                i += 2 if text[i] == "\\" else 1
            i += 1
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
        i += 1
    raise AssertionError(f"unbalanced block after {marker!r}")


def _classifier_body() -> str:
    return _block(ENTRY.read_text(encoding="utf-8"), "func classifyServeCommand(")


def test_legacy_single_play_script_is_deleted_and_unreferenced():
    # The token is assembled so this test itself does not defeat the
    # repository-wide `grep` requirement it asserts.
    legacy = "smoke" + "_play"
    assert not (AEC3 / f"{legacy}.sh").exists(), "GH-55 判据 1：旧单次播放脚本必须删除"

    # Walk tracked files (`grep -r` over the repository content) instead of the
    # whole tree: CI has node_modules/.venv/.build directories, and scanning
    # those would make this test slow without adding coverage. A tracked file
    # that no longer exists (staged deletion) is skipped.
    listing = subprocess.run(
        ["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True
    ).stdout.split(b"\0")
    hits: list[str] = []
    for raw in listing:
        if not raw:
            continue
        rel = raw.decode("utf-8")
        path = ROOT / rel
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        if legacy in text:
            hits.append(rel)
    assert hits == [], f"{legacy} 仍有残留引用：" + ", ".join(hits)


def test_default_build_command_whitelist_has_exactly_eight_commands():
    default = _strip_flag_blocks(_classifier_body())
    commands = set(re.findall(r'case "([a-z_]+)"', default))
    assert commands == PRODUCTION_COMMANDS
    # 未知命令必须走 E_CMD_UNKNOWN，而不是被当作已知命令静默忽略。
    assert "default: return nil" in default
    assert '"E_CMD_UNKNOWN"' in PIPELINE.read_text(encoding="utf-8")
    # 分派必须真的用这个分类器；否则命令面检查会与运行路径脱节。
    dispatch = PIPELINE.read_text(encoding="utf-8")
    assert "guard let command = classifyServeCommand(" in dispatch
    assert 'switch (obj["cmd"] as? String)' not in dispatch


def test_harness_commands_exist_only_behind_the_compile_flag():
    body = _classifier_body()
    default = _strip_flag_blocks(body)
    gated = _flag_blocks(body)
    assert (
        re.findall(r'case "([a-z_]+)"', gated)
        and set(re.findall(r'case "([a-z_]+)"', gated)) == HARNESS_COMMANDS
    )
    for name in HARNESS_COMMANDS:
        assert name not in default, f"{name} 泄露到默认构建命令面"
        assert f'case "{name}"' in gated
    # 即使误开，也不能复用历史协议里的 play / record 名字。
    for legacy in ('case "play"', 'case "record"'):
        assert legacy not in PIPELINE.read_text(encoding="utf-8")
        assert legacy not in ENTRY.read_text(encoding="utf-8")


def test_harness_enum_cases_are_compiled_only_behind_the_flag():
    enum = _block(ENTRY.read_text(encoding="utf-8"), "enum ServeCommand")
    default = _strip_flag_blocks(enum)
    gated = _flag_blocks(enum)
    assert "harnessPlayWav" not in default
    assert "harnessRecordPair" not in default
    assert "harnessPlayWav" in gated and "harnessRecordPair" in gated


def test_bridge_ready_reports_test_harness_only_when_compiled_in():
    text = PIPELINE.read_text(encoding="utf-8")
    start = text.index('"ev": "bridge_ready"')
    end = text.index("emitLine(ready)", start) + len("emitLine(ready)")
    ready = text[start:end]
    assert "test_harness" not in _strip_flag_blocks(ready)
    assert re.search(r'ready\["test_harness"\]\s*=\s*true', _flag_blocks(ready))


def test_harness_reuses_the_production_player_node():
    text = PIPELINE.read_text(encoding="utf-8")
    harness = _flag_blocks(text)
    assert "harnessPlayWav" in harness and "harnessRecordPair" in harness
    # 同一个 AVAudioEngine / AVAudioPlayerNode 图：harness 内不得新建引擎或播放节点。
    assert "AVAudioEngine()" not in harness
    assert "AVAudioPlayerNode()" not in harness
    # 生产播放与 harness 都走同一个调度函数（它从 self.playerNode 取节点）。
    assert text.count("AVAudioPlayerNode()") == 1
    play = _block(text, "private func playBuffers(")
    play_wav = _block(text, "func harnessPlayWav(")
    record_pair = _block(text, "func harnessRecordPair(")
    assert "scheduleOnPlayerNode(" in play
    assert "scheduleOnPlayerNode(" in play_wav
    assert "scheduleOnPlayerNode(" in record_pair
    # 参考电平沿用生产路径的 referenceDb，ABAB 的 ERLE 口径不变。
    assert "referenceDb(" in play_wav or "referenceDb(" in _block(text, "private func scheduleOnPlayerNode(")


def test_eval_scripts_use_harness_commands_and_falsify_without_confirmation():
    pairs = {
        "aec_ab2.sh": "harness_play_wav",
        "collect_pair.sh": "harness_record_pair",
    }
    for name, command in pairs.items():
        script = AEC3 / name
        text = script.read_text(encoding="utf-8")
        assert command in text, f"{name} 必须走 {command}"
        assert '"cmd":"play"' not in text and '"cmd":"record"' not in text
        # 证伪锚点：bridge_ready 没回报 test_harness 就判实验作废。
        assert '"test_harness": true' in text, f"{name} 缺 test_harness 证伪断言"
        syntax = subprocess.run(["sh", "-n", str(script)], capture_output=True, text=True, check=False)
        assert syntax.returncode == 0, syntax.stderr


def test_harness_build_is_opt_in_and_default_off():
    text = BUILD.read_text(encoding="utf-8")
    assert 'HARNESS_DEFINE=""' in text
    assert "-D WALLY_AUDIO_TEST_HARNESS" in text
    assert text.index('HARNESS_DEFINE=""') < text.index("-D WALLY_AUDIO_TEST_HARNESS")
    assert 'if [ "${WALLY_AUDIO_TEST_HARNESS:-0}" = "1" ]; then' in text
    assert "$HARNESS_DEFINE" in text


def test_eval_scripts_only_send_whitelisted_commands():
    """脚本发出的每条 cmd 都在白名单里（8 条生产命令 + 2 条 harness 命令）。"""
    allowed = PRODUCTION_COMMANDS | HARNESS_COMMANDS
    for name in ("aec_ab2.sh", "collect_pair.sh"):
        text = (AEC3 / name).read_text(encoding="utf-8").replace('\\"', '"')
        commands = set(re.findall(r'"cmd"\s*:\s*"([a-z_]+)"', text))
        assert commands, name
        assert commands <= allowed, f"{name} 发送了白名单外的命令：{commands - allowed}"


def test_apple_lane_executes_the_classifier_both_ways():
    package = (APPLE / "Package.swift").read_text(encoding="utf-8")
    assert "BridgeCoreHarness" in package
    assert '.define("WALLY_AUDIO_TEST_HARNESS")' in package
    default_test = (APPLE / "Tests" / "BridgeCoreTests" / "ServeCommandTests.swift").read_text(
        encoding="utf-8"
    )
    harness_test = (APPLE / "Tests" / "BridgeCoreHarnessTests" / "ServeCommandHarnessTests.swift").read_text(
        encoding="utf-8"
    )
    assert 'XCTAssertNil(classifyServeCommand("harness_play_wav"))' in default_test
    assert 'XCTAssertEqual(classifyServeCommand("harness_play_wav"), .some(.harnessPlayWav))' in harness_test
    lane = (ROOT / "scripts" / "ci" / "check-apple.sh").read_text(encoding="utf-8")
    assert "--out-harness" in lane
    assert "-D WALLY_AUDIO_TEST_HARNESS" in lane
