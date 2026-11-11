"""停止原因与确认状态的结构化定义（GH-57）。

``safety.stop_requested.cause`` 是上层可判定的唯一事实；自由文本 ``detail``
只供人阅读。安全判定仍然全部留在 robotd：这里只定义 robotd 自己能够产生的
原因取值与确认状态，不引入第二套安全状态，也不让 agentd 参与决策。
"""

from __future__ import annotations

from enum import Enum
from typing import Any


class StopCause(str, Enum):
    """停止原因。取值必须与 ``contracts/events.json`` 的枚举保持一致。"""

    USER_VOICE = "user_voice"
    USER_STOP_API = "user_stop_api"
    OBSTACLE = "obstacle"
    WATCHDOG_TIMEOUT = "watchdog_timeout"
    PARAM_OUT_OF_RANGE = "param_out_of_range"
    OBSERVATION_STALE = "observation_stale"
    DEVICE_LOST = "device_lost"
    BRIDGE_EXIT = "bridge_exit"
    INTERNAL_ERROR = "internal_error"


STOP_CAUSES: frozenset[str] = frozenset(cause.value for cause in StopCause)


class StopState(str, Enum):
    """停止请求的确认状态。

    - ``requested``：robotd 已受理，但没有可确认的板侧应答（例如仿真无板）；
    - ``confirmed``：板侧确实应答了停止；
    - ``unknown``：无法确认板侧已停稳（链路断开或停止写入失败），**不得**升级成 confirmed。
    """

    REQUESTED = "requested"
    CONFIRMED = "confirmed"
    UNKNOWN = "unknown"


#: 旧客户端/旧内部调用仍用 ``reason``。这里做单点归一，避免每处调用各写一份映射。
LEGACY_REASON_TO_CAUSE: dict[str, StopCause] = {
    "stop": StopCause.USER_STOP_API,
    "user": StopCause.USER_STOP_API,
    "api": StopCause.USER_STOP_API,
    "task_cancel": StopCause.USER_STOP_API,
    "voice": StopCause.USER_VOICE,
    "watchdog": StopCause.WATCHDOG_TIMEOUT,
    "obstacle": StopCause.OBSTACLE,
    "range": StopCause.PARAM_OUT_OF_RANGE,
    "stale": StopCause.OBSERVATION_STALE,
    "device_lost": StopCause.DEVICE_LOST,
    "bridge_exit": StopCause.BRIDGE_EXIT,
    "shutdown": StopCause.BRIDGE_EXIT,
    "startup": StopCause.BRIDGE_EXIT,
    "internal": StopCause.INTERNAL_ERROR,
    "internal_error": StopCause.INTERNAL_ERROR,
}


def coerce_stop_cause(value: Any) -> StopCause:
    """把显式 cause 或旧的 reason 归一成 ``StopCause``。

    显式 cause 必须是枚举值；非法值不是「猜一个」而是失败，避免上层把拼错的原因
    当成默认 API 停止。旧 ``reason`` 的未知值仍按 ``user_stop_api`` 兼容处理。
    """

    if isinstance(value, StopCause):
        return value
    text = str(value or "").strip()
    if text in STOP_CAUSES:
        return StopCause(text)
    return LEGACY_REASON_TO_CAUSE.get(text, StopCause.USER_STOP_API)


def is_valid_cause(value: Any) -> bool:
    if isinstance(value, StopCause):
        return True
    return str(value or "") in STOP_CAUSES


CAUSE_DETAIL: dict[StopCause, str] = {
    StopCause.USER_VOICE: "用户语音请求停止",
    StopCause.USER_STOP_API: "用户通过停止接口请求停止",
    StopCause.OBSTACLE: "检测到障碍物，安全路径请求停止",
    StopCause.WATCHDOG_TIMEOUT: "板侧看门狗超时并主动停机",
    StopCause.PARAM_OUT_OF_RANGE: "控制参数越界，安全路径拒绝继续运动",
    StopCause.OBSERVATION_STALE: "观测过期，安全路径不再使用旧指令",
    StopCause.DEVICE_LOST: "板侧链路丢失，无法确认机器人已停稳",
    StopCause.BRIDGE_EXIT: "宿主/语音桥退出，停止运动",
    StopCause.INTERNAL_ERROR: "robotd 内部错误，安全路径请求停止",
}


def default_detail(cause: StopCause) -> str:
    return CAUSE_DETAIL.get(cause, "停止请求")


#: 旧 ``safety.stopped.reason`` 的取值域（契约已登记）。结构化原因只在
#: ``safety.stop_requested.cause``；这条事件保留旧枚举是为了不破坏已登记契约。
def legacy_stop_reason(cause: StopCause) -> str:
    if cause is StopCause.WATCHDOG_TIMEOUT:
        return "watchdog"
    if cause is StopCause.DEVICE_LOST:
        return "link_lost"
    return "stop"
