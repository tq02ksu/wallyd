"""系统播报的固定模板（审批复述 / 未听清收尾 / 澄清追问）。

这条路径**不接收任意自由文本**：调用方给的是结构化的审批字段，robotd 用固定模板
渲染成一句话。理由见 ``docs/design/GH-19.md``：如果它接受 ``text``，它就是
``robot_speak`` 的免审批版本，审批门会被直接绕过。

GH-49 增加 ``clarification``：agentd 只传规则摘要与结构化的 ``missing`` / ``candidates``，
正文仍由这里渲染。这样「澄清必须被说出口」不会把任意用户原文带进免审批通道。

GH-53 增加 ``approval_unheard``：复述次数用尽时的固定收尾句；审批参数仍要先过
``announce_lexicon`` 的安全词表，含糊或未按词表读法的内容一律拒绝。
"""

from __future__ import annotations

import re

from robotd.announce_lexicon import LexiconError, validate_args_summary

APPROVAL_REPEAT = "approval_repeat"
APPROVAL_UNHEARD = "approval_unheard"
CLARIFICATION = "clarification"
SUPPORTED_KINDS = frozenset({APPROVAL_REPEAT, APPROVAL_UNHEARD, CLARIFICATION})

#: 走审批复述模板的 kind。``clarification`` 有自己的渲染函数，不能混进来。
APPROVAL_KINDS = frozenset({APPROVAL_REPEAT, APPROVAL_UNHEARD})

CLARIFICATION_REASONS = frozenset(
    {"missing_arguments", "capability_unavailable", "precondition", "ambiguous"}
)

#: 参数字段名 → 更自然的中文。**只做固定映射，不解析自由文本**；未知字段原样念出。
_MOUTH_SLOT = {"target_track_id": "目标（track）"}

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")

#: 暂停超时的系统提示。**固定文本，不接受调用方输入**：它不是 ``robot_speak`` 的
#: 免审批版本，只是 robotd 对自己状态的如实说明。
PAUSE_EXPIRED_TEXT = "等太久了，我先停下了。"


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
    if kind not in APPROVAL_KINDS:
        raise ValueError(f"不支持的播报类型 {kind!r}；只允许 {sorted(APPROVAL_KINDS)}")
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


def render_clarification(
    *,
    reason: str,
    action_label: str | None = None,
    missing: tuple[str, ...] | list[str] = (),
    candidates: tuple[str, ...] | list[str] = (),
    more: bool = False,
) -> str:
    """把结构化的澄清字段渲染成一句可念的追问。

    ``missing`` 只接受参数字段名，``candidates`` 只接受规则摘要；这里不做任何
    用户原文拼接。候选超过 3 条时调用方应只传前两条并把 ``more`` 设为 true。
    """
    if reason not in CLARIFICATION_REASONS:
        raise ValueError(f"不支持的澄清原因 {reason!r}；只允许 {sorted(CLARIFICATION_REASONS)}")

    if reason == "ambiguous":
        labels = [_one_line(c, field="candidates[]", max_len=80) for c in list(candidates)[:3]]
        if not labels:
            return "我没听清你想做什么，请再说一次。"
        if len(labels) == 1:
            return f"你是想「{labels[0]}」{'，还是别的' if more else ''}？"
        if len(labels) == 2:
            return f"你是想「{labels[0]}」，还是「{labels[1]}」{'，还是别的' if more else ''}？"
        return f"你是想「{labels[0]}」，「{labels[1]}」，还是「{labels[2]}」？"

    label = _one_line(action_label, field="action_label", max_len=80) if action_label else None
    names = [_one_line(m, field="missing[]", max_len=64) for m in list(missing)[:8]]

    if reason == "capability_unavailable":
        if label:
            return f"这台机器人现在不能「{label}」。"
        return "这台机器人现在不能做这件事。"
    if reason == "precondition":
        if label:
            return f"现在还不能「{label}」，请先处理前提条件。"
        return "现在还做不了，请先处理前提条件。"
    if names:
        spoken = "、".join(_MOUTH_SLOT.get(name, name) for name in names)
        if label:
            return f"要「{label}」，还需要你补充：{spoken}。请说清楚后再试一次。"
        return f"还需要你补充：{spoken}。请说清楚后再试一次。"
    if label:
        return f"我没听清「{label}」，请再说一次。"
    return "我没听清你想做什么，请再说一次。"
