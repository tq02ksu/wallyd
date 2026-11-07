"""审批参数摘要规范化规则的**可执行**一致性测试（GH-22 判据 3 / 4 / 9）。

规则本体是 ``contracts/approval-digest.json``；Python 实现
``robotd.approval_digest`` 与 TS 实现 ``contracts/tools/approval-digest.mjs``
都必须遵守它。这里逐条验证六条规则，并跑一次跨端逐字节比对。
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from robotd.approval_digest import (
    RULES_PATH,
    approval_args_digest,
    canonical_approval_args,
    load_rules,
)

REPO = Path(__file__).resolve().parents[3]
CLI = REPO / "contracts" / "tools" / "approval-digest-cli.mjs"


# ---------------------------------------------------------------- 规则来源
def test_rules_file_is_the_machine_readable_source():
    rules = load_rules()
    assert rules["version"] == 1
    assert rules["algorithm"] == "sha256"
    assert rules["digest_prefix"] == "sha256:"
    assert rules["field_selection"] == "approval_params_only"
    assert rules["unlisted_fields"] == "exclude"
    assert rules["missing_fields"] == "null"
    assert rules["key_order"] == "unicode_code_point_ascending"
    assert rules["number_format"] == "json_minimal_no_exponent"
    assert rules["string_normalization"] == "none"


def test_unsupported_rule_value_is_rejected():
    """规则文件是唯一真值：改成两边不认识的取值必须失败，而不是各自解释。"""
    broken = dict(load_rules())
    broken["missing_fields"] = "omit"
    with pytest.raises(ValueError):
        canonical_approval_args({"text": "你好"}, ["text"], broken)


# ---------------------------------------------------------------- 六条规则
def test_rule_1_only_declared_fields_are_hashed():
    """未声明的额外字段一律排除（判据 4 选“排除”）。"""
    only = approval_args_digest({"text": "前进 2 米"}, ["text"])
    with_extra = approval_args_digest({"text": "前进 2 米", "voice": "x", "rate": 2}, ["text"])
    assert only == with_extra
    assert canonical_approval_args({"text": "t", "voice": "x"}, ["text"]) == '{"text":"t"}'


def test_rule_2_keys_sorted_by_unicode_code_point():
    assert canonical_approval_args({"b": 2, "a": 1}, ["b", "a"]) == '{"a":1,"b":2}'
    # 码点排序：U+FF5E 之后是 U+1F600（UTF-16 代码单元顺序会把它排错）
    assert canonical_approval_args({"~": 1, "😀": 2}, ["~", "😀"]) == '{"~":1,"😀":2}'
    # 嵌套对象同样按键排序；数组保持顺序（不排序、不去重）
    assert (
        canonical_approval_args({"meta": {"z": 2, "a": [3, 1, 2]}}, ["meta"])
        == '{"meta":{"a":[3,1,2],"z":2}}'
    )


def test_rule_3_numbers_use_minimal_json_form():
    assert canonical_approval_args({"n": 2.0}, ["n"]) == '{"n":2}'
    assert approval_args_digest({"n": 2.0}, ["n"]) == approval_args_digest({"n": 2}, ["n"])
    assert canonical_approval_args({"n": 1e-7}, ["n"]) == '{"n":0.0000001}'
    assert canonical_approval_args({"n": 1e21}, ["n"]) == '{"n":1000000000000000000000}'
    assert canonical_approval_args({"n": 1.5e-7}, ["n"]) == '{"n":0.00000015}'
    assert canonical_approval_args({"n": -0.0}, ["n"]) == '{"n":0}'
    assert canonical_approval_args({"n": 0.1}, ["n"]) == '{"n":0.1}'


def test_rule_4_missing_fields_participate_as_null():
    assert canonical_approval_args({}, ["text"]) == '{"text":null}'
    assert approval_args_digest({}, ["text"]) == approval_args_digest({"text": None}, ["text"])
    assert approval_args_digest({}, ["text"]) != approval_args_digest({"text": ""}, ["text"])


def test_rule_5_strings_are_not_normalized():
    assert approval_args_digest({"text": " 前进 "}, ["text"]) != approval_args_digest({"text": "前进"}, ["text"])
    assert approval_args_digest({"text": "Hello"}, ["text"]) != approval_args_digest(
        {"text": "hello"}, ["text"]
    )
    assert canonical_approval_args({"text": 'a"b\\c\n'}, ["text"]) == '{"text":"a\\"b\\\\c\\n"}'


def test_rule_6_utf8_then_sha256_with_prefix():
    canonical = canonical_approval_args({"text": "前进 2 米"}, ["text"])
    expected = "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    assert approval_args_digest({"text": "前进 2 米"}, ["text"]) == expected
    # 固定向量：规则（排序 / 数字 / 字符串处理）一改，这里必须红，而不是悄悄换摘要。
    assert expected == "sha256:4df086c2a2eb87c717aeef50ae04a5e4172381ed71d7ab2b78bb397a3f986c06"


def test_duplicate_approval_params_are_rejected():
    with pytest.raises(ValueError):
        canonical_approval_args({"text": "x"}, ["text", "text"])


def test_rules_path_points_at_contract_owned_file():
    assert RULES_PATH == REPO / "contracts" / "approval-digest.json"


def test_every_declared_approval_param_set_is_digestible():
    """契约里声明的每一组 approvalParams 都能被规范化实现直接消费（#18 的接入前提）。"""
    tools = json.loads((REPO / "contracts" / "generated" / "mcp-tools.json").read_text(encoding="utf-8"))
    declared = [tool for tool in tools if "approvalParams" in tool]
    assert declared, "生成物里没有任何 approvalParams，契约投影断了"
    for tool in declared:
        params = tool["approvalParams"]
        assert json.loads(canonical_approval_args({}, params)) == {param: None for param in params}


# ---------------------------------------------------------------- 跨端一致性
CROSS_END_CASES = [
    {"args": {"text": "前进 2 米", "voice": "x"}, "approvalParams": ["text"]},
    {"args": {}, "approvalParams": ["text"]},
    {"args": {"text": None}, "approvalParams": ["text"]},
    {"args": {"b": 2, "a": 1.0}, "approvalParams": ["b", "a"]},
    {"args": {"n": 1e-7, "m": 1e21}, "approvalParams": ["n", "m"]},
    {"args": {"text": ' 引号"与\\反斜杠\n'}, "approvalParams": ["text"]},
    {"args": {"text": "😀 ~"}, "approvalParams": ["text"]},
    {"args": {"meta": {"z": 2, "a": [3, "x", None, True]}}, "approvalParams": ["meta"]},
    {
        "args": {"target": "人", "target_track_id": "t-1", "max_speed_mps": 0.15},
        "approvalParams": ["target_track_id", "target", "max_speed_mps"],
    },
    {
        "args": {"steps_per_m": 3200.0, "wheelbase_mm": 120, "persist": True},
        "approvalParams": ["steps_per_m", "wheelbase_mm", "persist"],
    },
]


def test_python_and_typescript_digests_are_byte_identical():
    """判据 9：同一组 args 两端各算一次，摘要字符串完全相等。"""
    node = shutil.which("node")
    if node is None:  # pragma: no cover - 离线环境也可能没有 node
        pytest.skip("node 不可用，无法运行 TS 侧实现")
    python_side = [approval_args_digest(c["args"], c["approvalParams"]) for c in CROSS_END_CASES]
    proc = subprocess.run(
        [node, str(CLI)],
        input=json.dumps({"cases": CROSS_END_CASES}),
        capture_output=True,
        text=True,
        cwd=REPO,
        check=True,
    )
    ts_side = json.loads(proc.stdout)["digests"]
    assert ts_side == python_side
