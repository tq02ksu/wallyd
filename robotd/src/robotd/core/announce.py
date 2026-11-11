"""系统播报的固定模板（审批复述）。

这条路径**不接收任意自由文本**：调用方给的是结构化的审批字段，robotd 用固定模板
渲染成一句话。理由见 ``docs/design/GH-19.md``：如果它接受 ``text``，它就是
``robot_speak`` 的免审批版本，审批门会被直接绕过。
"""

from __future__ import annotations

import re

from robotd.announce_lexicon import LexiconError, validate_args_summary

APPROVAL_REPEAT = "approval_repeat"
APPROVAL_UNHEARD = "approval_unheard"
SUPPORTED_KINDS = frozenset({APPROVAL_REPEAT, APPROVAL_UNHEARD})

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


def _one_line(value: str, *, field: str, max_len: int) -> str:
    text = (value or "").strip()
    if not text:
        raise ValueError(f"{field} 不能为空")
    if len(text) > max_len:
        raise ValueError(f"{field} 超过 {max_len} 字符上限")
    if _CONTROL_CHARS.search(text):
        raise ValueError(f"{field} 含控制字符/换行")
    return text


def render_announcement(*, kind: str, action_label: str, args_summary: str) -> str:
    """把审批字段渲染成固定句子。未知 kind 一律拒绝，不猜。"""
    if kind not in SUPPORTED_KINDS:
        raise ValueError(f"不支持的播报类型 {kind!r}；只允许 {sorted(SUPPORTED_KINDS)}")
    label = _one_line(action_label, field="action_label", max_len=80)
    summary = _one_line(args_summary, field="args_summary", max_len=60)
    try:
        summary = validate_args_summary(summary)
    except LexiconError as exc:
        raise ValueError(str(exc)) from exc
    if kind == APPROVAL_UNHEARD:
        # 复述次数用尽：固定收尾句，不把参数再念一遍，也不接受任何自由文本。
        return "我没有听清，这次没有执行。"
    return f"请确认：{label}。参数：{summary}。请说确认。"
