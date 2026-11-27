"""标定读写（R11 之前只读为空）。

标定是设备侧事实：依赖板侧握手与串口素材，不属于 App 的业务逻辑。
当前没有板侧标定通道，所以如实报不可用，不返回估算值。
"""

from __future__ import annotations

from typing import Any

from ..core.errors import ErrorCode, RobotdError


class CalibrationService:
    """标定端口。M0 只有「明确不可用」这一种诚实回答。"""

    def read(self) -> dict[str, Any]:
        return {
            "available": False,
            "reason": "标定读写依赖板侧握手（R11）",
            "left_steps_per_m": None,
            "right_steps_per_m": None,
            "wheel_base_m": None,
        }

    def write(self, changes: dict[str, Any]) -> dict[str, Any]:
        raise RobotdError(
            ErrorCode.UNAVAILABLE,
            "标定下发依赖板侧握手（R11），当前不可写",
            {"fields": sorted(changes)},
        )
