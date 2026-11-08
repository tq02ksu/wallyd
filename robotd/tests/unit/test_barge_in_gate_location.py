"""GH-5 判据 4：打断判定的单点门禁（枚举扫源码，不是抽查）。

两个方向都要守住：

1. ``robotd/src/`` 里出现 ``barge_in`` 的地方只允许是 ``AudioRuntime``——防止 V06 在
   桥之外、或别处再长出一份「要不要停播」的判断；
2. ``agentd/src/`` 里读 ``aec_erle_db`` 的地方只允许 ``robotd-event-bridge.ts`` 的那一条
   审批 settle 证据判定。**那一处不是违规、不得删除**：它判的是「这句话是不是回声」，
   不是「要不要停播」。断言显式排除它并注明理由，否则这道门禁会逼着执行轮删掉 V08 的证据链。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
ROBOTD_SRC = ROOT / "robotd" / "src"
AGENTD_SRC = ROOT / "agentd" / "src"
AUDIO_RUNTIME = "robotd/src/robotd/core/audio_runtime.py"
AGENTD_ECHO = "agentd/src/agentd/robotd-event-bridge.ts"


def _lines(root: Path, pattern: re.Pattern[str]) -> list[tuple[str, int, str]]:
    hits: list[tuple[str, int, str]] = []
    for path in sorted(root.rglob("*")):
        if path.suffix not in {".py", ".ts"} or not path.is_file():
            continue
        rel = path.relative_to(ROOT).as_posix()
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            if pattern.search(line):
                hits.append((rel, number, line.strip()))
    return hits


def test_barge_in_decisions_only_live_in_audio_runtime():
    # 只看「判定」标记：判定原因字面量、判定函数、门限属性。配置项/转发参数不是判定。
    markers = re.compile(r'"barge_in"|speech_db_barge_in|_barge_in_verdict')
    hits = _lines(ROBOTD_SRC, markers)
    offenders = [f"{rel}:{number} {line}" for rel, number, line in hits if rel != AUDIO_RUNTIME]
    assert offenders == [], f"打断判定只能出现在 AudioRuntime：{offenders}"


def test_audio_runtime_owns_the_threshold():
    text = (ROOT / AUDIO_RUNTIME).read_text(encoding="utf-8")
    assert "speech_db_barge_in" in text
    assert "barge_in_erle_margin_db" in text
    # 门限只在这里算；别处不得再出现同一份算式（配置项与文档里的符号不算第二份门限）。
    others = [
        f"{rel}:{number}"
        for rel, number, _line in _lines(
            ROBOTD_SRC, re.compile(r"ambient_db\s*\+\s*(self\.)?barge_in_erle_margin_db")
        )
        if rel != AUDIO_RUNTIME
    ]
    assert others == [], f"ambient_db 门限算式只允许在 AudioRuntime：{others}"


def test_agentd_reads_erle_only_for_the_approval_settle_echo_fact():
    hits = _lines(AGENTD_SRC, re.compile(r"aec_erle_db"))
    files = {rel for rel, _number, _line in hits}
    # robotd-event-bridge.ts:264 的 echo 证据链显式保留（见文件头说明）；其余文件不得新增。
    assert files == {AGENTD_ECHO}, f"agentd 读 aec_erle_db 的位置超出约定：{sorted(files)}"

    comparisons = [line for _rel, _number, line in hits if re.search(r"aec_erle_db\s*[<>]", line)]
    assert len(comparisons) == 1, f"agentd 只允许一条 ERLE 比较（settle 的回声证据）：{comparisons}"
    # 这一条必须同时是「这一轮是否发生在播报期间」的 settle 证据，不是停播判定。
    assert "during_tts" in comparisons[0]
    assert "ECHO_ERLE_MAX_DB" in comparisons[0]


def test_agentd_never_decides_barge_in_from_erle():
    """agentd 可以消费 speech.*，但不得自己算「要不要停播」。"""
    text = (ROOT / AGENTD_ECHO).read_text(encoding="utf-8")
    assert "cancel_speaking" not in text
    assert "stop_speak" not in text
    # 门限算式只允许在 robotd；agentd 里出现 ambient_db + 之类的算式就是第二份门限
    hits = _lines(AGENTD_SRC, re.compile(r"speech_db_barge_in|barge_in_erle_margin"))
    assert hits == []


def test_speech_gate_is_registered_in_the_event_contract():
    events = json.loads((ROOT / "contracts" / "events.json").read_text(encoding="utf-8"))
    registered = {event["type"]: event for event in events["events"]}
    gate = registered["speech.gate"]
    payload = gate["payload"]
    assert payload["decision"]["enum"] == ["pass", "suppressed"]
    assert "barge_in" in payload["reason"]["enum"]
    assert "no_erle" in payload["reason"]["enum"]
    for field in ("utterance_id", "decision", "reason"):
        assert payload[field]["required"] is True
    for field in ("db", "aec_erle_db", "threshold_db"):
        assert field in payload


def test_tts_cancelled_reason_enum_separates_barge_in_and_user_cancel():
    """GH-6：不新增事件类型，但 ``reason`` 的取值必须能区分「谁打断的」。"""
    events = json.loads((ROOT / "contracts" / "events.json").read_text(encoding="utf-8"))
    registered = {event["type"]: event for event in events["events"]}
    payload = registered["speech.tts_cancelled"]["payload"]
    reason = payload["reason"]

    assert reason["required"] is True
    assert isinstance(reason["enum"], list)
    assert "barge_in" in reason["enum"]
    assert "user_cancel" in reason["enum"]
    assert "barge_in" != "user_cancel"
    # 计数对账字段必须仍可用；dropped 只在桥真的丢弃时出现。
    assert payload["played"]["type"] == "integer"
    assert payload["dropped"]["required"] is False


def test_speech_interrupted_is_never_emitted_by_robotd():
    """GH-6 裁决 C：沿用 ``speech.tts_cancelled``，不得再 emit ``speech.interrupted``。

    登记表里保留它（历史契约），但生产代码零 emit。若有人把判定搬回一个「判断类事件」，
    这条会先红。
    """
    hits = _lines(ROBOTD_SRC, re.compile(r"speech\.interrupted"))
    assert hits == [], f"robotd 不得 emit speech.interrupted：{hits}"
