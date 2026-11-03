"""core —— 类型、错误、状态与事件归并。

纪律（ADR-0006 + plan R05）：

1. **状态只有一个写入点**：``EventKernel`` 的归并路径。任何其他地方（HTTP handler、
   capability run、设备回调）都只能 ``emit`` 事件，不能直接改 ``state``。
2. **派生量只推导一次**：``mode`` 由 ``derive_mode()`` 唯一推导，不允许各处重复三元表达式。
3. **内部时钟不外泄**：``ts_mono_ns`` 只用于进程内排序，绝不进公开 payload。
4. **不知道就是不知道**：``unknown`` / ``null`` / ``unimplemented`` 是一等状态，
   不得为了让字段「看起来完整」而填估算值。

模块组成：
- ``errors``  —— 稳定错误码与 HTTP 映射
- ``types``   —— 公开 DTO 与内部记录
- ``state``   —— RobotState 的权威持有与派生
- ``kernel``  —— 事件归并、序号、保留日志、订阅分发
"""

from __future__ import annotations

from .errors import ErrorCode, RobotdError, http_status_for
from .kernel import EventKernel, Subscription
from .state import RobotStateStore, derive_mode
from .types import (
    Event,
    Pose,
    RobotMode,
    Task,
    TaskError,
    TaskState,
    now_ms,
)

__all__ = [
    "ErrorCode",
    "RobotdError",
    "http_status_for",
    "EventKernel",
    "Subscription",
    "RobotStateStore",
    "derive_mode",
    "Event",
    "Pose",
    "RobotMode",
    "Task",
    "TaskError",
    "TaskState",
    "now_ms",
]
