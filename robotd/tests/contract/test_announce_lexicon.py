"""审批复述词表的跨端一致性（GH-53 判据 1）。

规则本体是 ``contracts/announce-lexicon.json``；robotd 的 Python 实现与
``contracts/tools/announce-lexicon.mjs`` 必须对同一输入给出逐字节相同的输出。
这里也验证「改一处数字读法，两端同时变」——不是口头承诺。
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from robotd.announce_lexicon import (
    LEXICON_PATH,
    LexiconError,
    format_args_summary,
    load_lexicon,
    validate_args_summary,
)

REPO = Path(__file__).resolve().parents[3]
CLI = REPO / "contracts" / "tools" / "announce-lexicon-cli.mjs"


def run_cli(payload: dict, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["node", str(CLI), *args],
        input=json.dumps(payload, ensure_ascii=False),
        capture_output=True,
        text=True,
        check=False,
    )


def run_cli_batch(cases: list[dict]) -> list[str]:
    """一次 node 进程比较大量整数，避免 200+ 次进程启动把契约测试拖成分钟级。"""
    res = run_cli({"cases": cases}, "--batch")
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


def test_lexicon_is_the_contract_owned_single_source():
    assert LEXICON_PATH == REPO / "contracts" / "announce-lexicon.json"
    lex = load_lexicon()
    assert lex["version"] == 1
    assert lex["args_summary"]["max_chars"] == 60
    assert lex["repeat"]["max_attempts"] == 3
    assert lex["implementations"]["typescript"] == "contracts/tools/announce-lexicon.mjs"
    assert lex["implementations"]["python"] == "robotd/src/robotd/announce_lexicon.py"


def test_openapi_length_and_kinds_match_the_lexicon():
    spec = json.loads((REPO / "contracts" / "generated" / "openapi.json").read_text(encoding="utf-8"))
    schema = spec["components"]["schemas"]["AnnounceRequest"]
    lex = load_lexicon()
    assert schema["x-announce-lexicon"] == "announce-lexicon.json"
    assert schema["properties"]["args_summary"]["maxLength"] == lex["args_summary"]["max_chars"]
    assert "approval_repeat" in schema["properties"]["kind"]["enum"]
    assert "approval_unheard" in schema["properties"]["kind"]["enum"]


def test_every_approval_param_has_a_lexicon_reading():
    tools = json.loads((REPO / "contracts" / "generated" / "mcp-tools.json").read_text(encoding="utf-8"))
    lex = load_lexicon()
    declared = [p for tool in tools for p in tool.get("approvalParams", [])]
    assert declared, "契约里没有 approvalParams，投影断了"
    missing = sorted(param for param in declared if param not in lex["fields"])
    assert not missing, f"这些审批字段没有词表读法，两端无法拼复述：{missing}"


@pytest.mark.parametrize(
    ("args", "fields", "expected"),
    [
        ({"speed_mps": 0.15}, ["speed_mps"], "速度零点一五米每秒"),
        ({"max_distance_m": 30}, ["max_distance_m"], "最远距离三十米"),
        ({"wheelbase_mm": 350}, ["wheelbase_mm"], "轴距三百五十毫米"),
        ({"target_track_id": "t7"}, ["target_track_id", "target"], "目标：t7"),
        # 目标 ID 允许以 m 开头；不能被「英文单位缩写」规则误伤。
        ({"target_track_id": "m7"}, ["target_track_id"], "目标：m7"),
    ],
)
def test_python_and_typescript_render_identically(args, fields, expected):
    assert format_args_summary(args, fields) == expected
    res = run_cli({"args": args, "fields": fields})
    assert res.returncode == 0, res.stderr
    assert res.stdout.strip() == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (0, "零"),
        (1, "一"),
        (9, "九"),
        # 10–19 必须读「十」「十五」，不能丢「十」只留个位（review 复现的缺陷）。
        (10, "十"),
        (11, "十一"),
        (15, "十五"),
        (19, "十九"),
        (20, "二十"),
        (99, "九十九"),
        (100, "一百"),
        (101, "一百零一"),
        (110, "一百一十"),
        (115, "一百一十五"),
        (1000, "一千"),
        # 零后的低位组要保留「一十」：一万零一十五，而不是一万零十五。
        (1015, "一千零一十五"),
        (10015, "一万零一十五"),
        (100000, "十万"),
        (1000000, "一百万"),
        (-15, "负十五"),
    ],
)
def test_standard_mandarin_reading_golden(value, expected):
    got = format_args_summary({"steps_per_m": value}, ["steps_per_m"])
    assert got == f"每米步数{expected}"
    res = run_cli({"args": {"steps_per_m": value}, "fields": ["steps_per_m"]})
    assert res.returncode == 0, res.stderr
    assert res.stdout.strip() == got


def test_every_integer_in_review_range_matches_typescript():
    """0..200 全区间 + 万位边界：两份实现必须逐字节相同，不能靠手挑样例。"""
    values = list(range(201)) + [10000, 10015, 100000, 1000000]
    cases = [{"args": {"steps_per_m": value}, "fields": ["steps_per_m"]} for value in values]
    python_outputs = [format_args_summary(case["args"], case["fields"]) for case in cases]
    assert run_cli_batch(cases) == python_outputs


def test_changing_one_digit_reading_changes_both_sides(tmp_path: Path):
    """判据 1 的可证伪版本：改词表一处，Python 与 TS 的输出同时变。"""
    lex = json.loads(Path(LEXICON_PATH).read_text(encoding="utf-8"))
    baseline_py = format_args_summary({"speed_mps": 0.15}, ["speed_mps"])
    baseline_js = run_cli({"args": {"speed_mps": 0.15}, "fields": ["speed_mps"]})
    assert baseline_js.stdout.strip() == baseline_py

    lex["digits"]["1"] = "幺"
    changed = tmp_path / "announce-lexicon.json"
    changed.write_text(json.dumps(lex, ensure_ascii=False), encoding="utf-8")

    after_py = format_args_summary({"speed_mps": 0.15}, ["speed_mps"], load_lexicon(changed))
    after_js = run_cli({"args": {"speed_mps": 0.15}, "fields": ["speed_mps"]}, "--rules", str(changed))
    assert after_js.returncode == 0, after_js.stderr
    assert after_py == "速度零点幺五米每秒"
    assert after_js.stdout.strip() == after_py
    assert after_py != baseline_py


@pytest.mark.parametrize(
    "summary",
    [
        "走一点点",
        "大约二米",
        "左右",
        "0.15 米每秒",
        "2.0 米",
        "1e-3 米",
        "０.１５ 米",
        "第八Ⅷ步",
        "二 m",
        "甲" * 61,
    ],
)
def test_python_and_typescript_reject_the_same_summaries(summary):
    with pytest.raises(LexiconError):
        validate_args_summary(summary)
    res = run_cli({"summary": summary}, "--validate")
    assert res.returncode != 0, f"TS 侧没有拒绝 {summary!r}"


def test_unknown_or_unmapped_fields_are_rejected():
    with pytest.raises(LexiconError, match="没有词表读法"):
        format_args_summary({"servo_pin": 3}, ["servo_pin"])
    with pytest.raises(LexiconError, match="小数位"):
        format_args_summary({"speed_mps": 0.1234}, ["speed_mps"])
    with pytest.raises(LexiconError, match="超过 60 字"):
        format_args_summary({"text": "甲" * 60}, ["text"])


if __name__ == "__main__":  # pragma: no cover
    sys.exit(pytest.main([__file__, "-q"]))
