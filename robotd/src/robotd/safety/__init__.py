"""安全边界：停止原因/确认状态、停止编排、板侧停止上报。

``safety`` 不拥有第二套机器人状态：停止动作仍经内核发 ``safety.*`` 事件，
任务收尾交给 Task Executive，音频打断交给 AudioRuntime。
"""

from .causes import (
    CAUSE_DETAIL,
    LEGACY_REASON_TO_CAUSE,
    STOP_CAUSES,
    StopCause,
    StopState,
    coerce_stop_cause,
    default_detail,
    is_valid_cause,
    legacy_stop_reason,
)
from .stop import StopCoordinator

__all__ = [
    "CAUSE_DETAIL",
    "LEGACY_REASON_TO_CAUSE",
    "STOP_CAUSES",
    "StopCause",
    "StopState",
    "StopCoordinator",
    "coerce_stop_cause",
    "default_detail",
    "is_valid_cause",
    "legacy_stop_reason",
]
