"""审批复述安全词表的唯一真值执行器（Python 侧）。

规则本体在 ``contracts/announce-lexicon.json``：本模块只执行规则，不重新定义规则。
TS/Node 侧实现是 ``contracts/tools/announce-lexicon.mjs``，两者必须逐字节一致。
"""

from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path
from typing import Any, Mapping, Sequence

LEXICON_PATH = Path(__file__).resolve().parents[3] / "contracts" / "announce-lexicon.json"

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")
_STANDALONE_NUMBER = re.compile(r"(?<![A-Za-z0-9_.:/-])[0-9]+(?:\.[0-9]+)?")
# 只在「中文数字 + 英文单位」这种写法上拦；目标 ID 可能是 m7 / t7，不能被误伤。
_UNIT_ABBREVIATION = re.compile(
    r"(?:[零一二三四五六七八九十百千万点负])\s*(?:m/s|mps|cm|mm|km|deg|ms|m|s)(?![A-Za-z0-9])",
    re.IGNORECASE,
)


class LexiconError(ValueError):
    """词表拒绝：调用方必须把它当成 400/拒绝执行，而不是猜一个读法。"""


def load_lexicon(path: Path | str = LEXICON_PATH) -> dict[str, Any]:
    lexicon = json.loads(Path(path).read_text(encoding="utf-8"))
    _validate_lexicon(lexicon)
    return lexicon


def _validate_lexicon(lexicon: Any) -> None:
    if not isinstance(lexicon, dict):
        raise LexiconError("announce-lexicon 必须是对象")
    if lexicon.get("version") != 1:
        raise LexiconError(f"announce-lexicon version 不受支持：{lexicon.get('version')!r}")
    rules = lexicon.get("args_summary") or {}
    if rules.get("number_format") != "chinese_numeral":
        raise LexiconError(f"不支持的 number_format：{rules.get('number_format')!r}")
    digits = lexicon.get("digits") or {}
    for digit in "0123456789":
        if not isinstance(digits.get(digit), str) or not digits[digit]:
            raise LexiconError(f"digits 缺 {digit} 的读法")
    if not isinstance(rules.get("max_chars"), int) or rules["max_chars"] <= 0:
        raise LexiconError("args_summary.max_chars 必须是正整数")
    if not isinstance(rules.get("max_fields"), int) or rules["max_fields"] <= 0:
        raise LexiconError("args_summary.max_fields 必须是正整数")
    if not isinstance(rules.get("forbidden_phrases"), list):
        raise LexiconError("args_summary.forbidden_phrases 必须是数组")
    if not isinstance(lexicon.get("fields"), dict):
        raise LexiconError("缺 fields")
    repeat = lexicon.get("repeat") or {}
    if not isinstance(repeat.get("max_attempts"), int) or repeat["max_attempts"] <= 0:
        raise LexiconError("repeat.max_attempts 必须是正整数")


def _int_to_chinese(value: int, lexicon: Mapping[str, Any]) -> str:
    digits = lexicon["digits"]
    if value == 0:
        return digits["0"]

    def four(number: int) -> str:
        units = [
            lexicon["small_units"]["1000"],
            lexicon["small_units"]["100"],
            lexicon["small_units"]["10"],
            "",
        ]
        out = ""
        zero_pending = False
        for index in range(4):
            digit = (number // 10 ** (3 - index)) % 10
            if digit == 0:
                if out:
                    zero_pending = True
                continue
            if zero_pending:
                out += digits["0"]
                zero_pending = False
            out += digits[str(digit)] + units[index]
        return out

    large = lexicon.get("large_units") or {}
    if "10000" in large and value >= 10000:
        high, low = divmod(value, 10000)
        out = _int_to_chinese(high, lexicon) + large["10000"]
        if low > 0:
            # 零之后的低位组保留「一十」：10015 读「一万零一十五」，不是「一万零十五」。
            out += (digits["0"] if low < 1000 else "") + four(low)
        return out
    out = four(value)
    # 只有最高位组省略「一十」的前导「一」：10 → 十，10015 的低位组仍是「一十五」。
    prefix = digits["1"] + lexicon["small_units"]["10"]
    return out[1:] if out.startswith(prefix) else out


def _number_to_chinese(value: Any, lexicon: Mapping[str, Any]) -> str:
    rules = lexicon["args_summary"]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise LexiconError("参数不是有限数字，无法口播")
    if value != value or value in (float("inf"), float("-inf")):
        raise LexiconError("参数不是有限数字，无法口播")
    if abs(value) > rules["max_abs"]:
        raise LexiconError(f"数字 {value} 超过词表上限 {rules['max_abs']}")
    text = str(value)
    if "e" in text.lower():
        raise LexiconError(f"数字 {value} 是科学计数法，审批复述不接受")
    if text in ("-0", "-0.0"):
        text = "0"
    sign = ""
    if text.startswith("-"):
        sign = rules["negative_prefix"]
        text = text[1:]
    int_part, _, frac_part = text.partition(".")
    if len(frac_part) > rules["max_decimals"]:
        raise LexiconError(f"数字 {value} 小数位超过 {rules['max_decimals']} 位，无法安全口播")
    out = sign + _int_to_chinese(int(int_part), lexicon)
    trimmed = frac_part.rstrip("0")
    if trimmed:
        out += rules["decimal_point"] + "".join(lexicon["digits"][c] for c in trimmed)
    return out


def _render_value(value: Any, field: Mapping[str, Any], lexicon: Mapping[str, Any]) -> str:
    rules = lexicon["args_summary"]
    if field.get("type") == "number":
        unit = lexicon.get("units", {}).get(field["unit"], "") if field.get("unit") else ""
        return f"{field['label']}{_number_to_chinese(value, lexicon)}{unit}"
    if isinstance(value, bool):
        return f"{field['label']}{rules['text_separator']}{lexicon['booleans'][str(value).lower()]}"
    if not isinstance(value, str):
        raise LexiconError(f"字段 {field['label']} 的值类型无法口播：{type(value).__name__}")
    text = value.strip()
    if not text:
        raise LexiconError(f"字段 {field['label']} 为空，无法口播")
    if _CONTROL_CHARS.search(text):
        raise LexiconError(f"字段 {field['label']} 含控制字符")
    if rules["field_separator"] in text or rules["text_separator"] in text:
        raise LexiconError(f"字段 {field['label']} 含分隔符，无法保证口播边界")
    if len(text) > rules["max_chars"]:
        raise LexiconError(f"字段 {field['label']} 超过 {rules['max_chars']} 字，无法一次听完")
    return f"{field['label']}{rules['text_separator']}{text}"


def format_args_summary(
    args: Mapping[str, Any],
    fields: Sequence[str],
    lexicon: dict[str, Any] | None = None,
) -> str:
    """把需要用户听见的参数拼成一句可口播、可校验的中文摘要。"""
    lex = lexicon or load_lexicon()
    if not isinstance(args, Mapping):
        raise LexiconError("args 必须是对象")
    if isinstance(fields, (str, bytes)) or any(not isinstance(f, str) or not f for f in fields):
        raise LexiconError("fields 必须是非空字符串数组")
    keys = list(fields) if fields else list(args.keys())
    rendered: list[str] = []
    for key in keys:
        value = args.get(key)
        if value is None:
            continue
        field = lex["fields"].get(key)
        if not field:
            raise LexiconError(f"字段 {key} 没有词表读法，拒绝拼复述")
        rendered.append(_render_value(value, field, lex))
    if not rendered:
        raise LexiconError("没有可播报的参数")
    if len(rendered) > lex["args_summary"]["max_fields"]:
        raise LexiconError(f"参数项 {len(rendered)} 个，超过 {lex['args_summary']['max_fields']} 项上限")
    return validate_args_summary(lex["args_summary"]["field_separator"].join(rendered), lex)


def validate_args_summary(summary: str, lexicon: dict[str, Any] | None = None) -> str:
    """校验一条已拼好的 ``args_summary``；返回 trim 后的文本，失败抛 LexiconError。"""
    lex = lexicon or load_lexicon()
    if not isinstance(summary, str):
        raise LexiconError("args_summary 必须是字符串")
    rules = lex["args_summary"]
    text = summary.strip()
    if not text:
        raise LexiconError("args_summary 不能为空")
    if _CONTROL_CHARS.search(text):
        raise LexiconError("args_summary 含控制字符/换行")
    if len(text) > rules["max_chars"]:
        raise LexiconError(f"args_summary 超过 {rules['max_chars']} 字，必须压缩到一次听完")
    for phrase in rules["forbidden_phrases"]:
        if phrase in text:
            raise LexiconError(f"args_summary 含不确定词「{phrase}」，审批复述必须是确定值")
    if _STANDALONE_NUMBER.search(text):
        raise LexiconError("args_summary 含未按词表读法的阿拉伯数字（禁止科学计数法与 2.0 这类写法）")
    # Python 的 \d 会匹配全角/阿拉伯-印度数字，JS 不会；显式拒绝所有非 ASCII 数字，
    # 否则「０.１５」会在一端被放行、在另一端被拒绝，TTS 的读法也无法保证。
    if any(unicodedata.category(ch).startswith("N") and not ch.isascii() for ch in text):
        raise LexiconError("args_summary 含非 ASCII 数字字符，无法保证两端读法一致")
    if _UNIT_ABBREVIATION.search(text):
        raise LexiconError("args_summary 含英文单位缩写，必须用词表里的中文单位")
    if len(text.split(rules["field_separator"])) > rules["max_fields"]:
        raise LexiconError(f"args_summary 参数项超过 {rules['max_fields']} 项")
    return text


def announce_limits(lexicon: dict[str, Any] | None = None) -> dict[str, int]:
    lex = lexicon or load_lexicon()
    return {
        "max_args_summary_chars": lex["args_summary"]["max_chars"],
        "max_repeats": lex["repeat"]["max_attempts"],
    }
