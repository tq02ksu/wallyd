"""审批凭据 ``args_digest`` 的规范化实现（Python 侧）。

规则本体在 ``contracts/approval-digest.json``：本模块只执行规则，不重新定义规则。
TS/Node 侧实现是 ``contracts/tools/approval-digest.mjs``，两者必须逐字节一致
（同一组 args 得到同一个 ``sha256:<hex>``）。#18 复算凭据摘要时直接 import 本模块，
不要另写一份。

规则（由规则文件定死）：

- 只取 ``approval_params`` 声明的字段，未声明的额外字段一律排除；
- 键按 Unicode 码点升序排序；
- 数字用 JSON 最简形式（``2`` 不写 ``2.0``、不用科学计数法）；
- 缺失字段按 ``null`` 参与；
- 字符串不做 trim / 大小写折叠；
- 规范化结果 UTF-8 编码后取 SHA-256，形如 ``sha256:<hex>``。
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from decimal import Decimal
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping, Sequence

__all__ = [
    "RULES_PATH",
    "approval_args_digest",
    "canonical_approval_args",
    "load_rules",
]

_DEFAULT_RULES_PATH = Path(__file__).resolve().parents[3] / "contracts" / "approval-digest.json"
RULES_PATH = Path(os.environ.get("ROBOTD_APPROVAL_DIGEST_RULES", _DEFAULT_RULES_PATH))

_SUPPORTED = {
    "field_selection": ("approval_params_only",),
    "unlisted_fields": ("exclude",),
    "missing_fields": ("null",),
    "key_order": ("unicode_code_point_ascending",),
    "number_format": ("json_minimal_no_exponent",),
    "string_normalization": ("none",),
    "string_escaping": ("json_minimal",),
    "encoding": ("utf-8",),
}


@lru_cache(maxsize=1)
def _load_rules_cached(path: str) -> dict[str, Any]:
    rules = json.loads(Path(path).read_text(encoding="utf-8"))
    _validate_rules(rules)
    return rules


def load_rules(path: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    """读取并校验规范化规则文件。"""
    target = Path(path) if path is not None else RULES_PATH
    return _load_rules_cached(str(target))


def _validate_rules(rules: Mapping[str, Any]) -> None:
    if not isinstance(rules, Mapping):
        raise ValueError("approval-digest 规则必须是对象")
    version = rules.get("version")
    # 与 TS 侧 `rules.version !== 1` 对齐：1.0 也不算 1，避免两端对同一份规则判断不同。
    if not isinstance(version, int) or isinstance(version, bool) or version != 1:
        raise ValueError(f"approval-digest 规则 version 不受支持：{version!r}")
    algorithm = rules.get("algorithm")
    if not isinstance(algorithm, str) or not algorithm:
        raise ValueError("approval-digest 规则缺 algorithm")
    if not isinstance(rules.get("digest_prefix"), str):
        raise ValueError("approval-digest 规则缺 digest_prefix")
    for key, allowed in _SUPPORTED.items():
        value = rules.get(key)
        if value not in allowed:
            raise ValueError(f"approval-digest 规则 {key}={value!r} 不受支持（允许：{', '.join(allowed)}）")


_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
}


def _quote(value: str) -> str:
    out = ['"']
    for char in value:
        code = ord(char)
        escaped = _ESCAPES.get(char)
        if escaped is not None:
            out.append(escaped)
        elif 0xD800 <= code <= 0xDFFF:
            raise ValueError("字符串含孤立代理项，无法 UTF-8 编码")
        elif code < 0x20:
            out.append(f"\\u{code:04x}")
        else:
            out.append(char)
    out.append('"')
    return "".join(out)


def _expand_exponent(text: str) -> str:
    return format(Decimal(text), "f")


def _format_number(value: int | float) -> str:
    if isinstance(value, bool):  # pragma: no cover - 调用方先处理 bool
        raise TypeError("bool 不是审批摘要里的数字")
    if isinstance(value, int):
        return str(value)
    if math.isnan(value) or math.isinf(value):
        raise ValueError(f"args 含非有限数字 {value!r}，JSON 无法表达")
    if value == 0:
        return "0"
    text = repr(float(value))  # Python 的最短往返表示
    if "e" in text or "E" in text:
        text = _expand_exponent(text)
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


def _canonical_value(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return _format_number(value)
    if isinstance(value, str):
        return _quote(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_canonical_value(item) for item in value) + "]"
    if isinstance(value, Mapping):
        items = sorted(((str(key), item) for key, item in value.items()), key=lambda pair: pair[0])
        body = ",".join(f"{_quote(key)}:{_canonical_value(item)}" for key, item in items)
        return "{" + body + "}"
    raise TypeError(f"args 含不可序列化的值：{type(value).__name__}")


def canonical_approval_args(
    args: Mapping[str, Any],
    approval_params: Sequence[str],
    rules: Mapping[str, Any] | None = None,
) -> str:
    """计算审批参数的规范化 JSON 文本。

    只取 ``approval_params`` 声明的字段；未声明的字段一律排除；缺失字段按 null 参与。
    """
    active = rules if rules is not None else load_rules()
    _validate_rules(active)
    if not isinstance(args, Mapping):
        raise TypeError("args 必须是对象")
    if isinstance(approval_params, str) or any(
        not isinstance(param, str) or not param for param in approval_params
    ):
        raise TypeError("approval_params 必须是字符串序列")
    keys = sorted(approval_params)
    if len(set(keys)) != len(keys):
        raise ValueError("approval_params 含重复字段")
    body = ",".join(f"{_quote(key)}:{_canonical_value(args.get(key))}" for key in keys)
    canonical = "{" + body + "}"
    canonical.encode(active["encoding"])
    return canonical


def approval_args_digest(
    args: Mapping[str, Any],
    approval_params: Sequence[str],
    rules: Mapping[str, Any] | None = None,
) -> str:
    """审批参数摘要：``sha256:<hex>``。"""
    active = rules if rules is not None else load_rules()
    canonical = canonical_approval_args(args, approval_params, active)
    digest = hashlib.new(active["algorithm"], canonical.encode(active["encoding"])).hexdigest()
    return f"{active['digest_prefix']}{digest}"
