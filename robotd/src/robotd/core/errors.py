"""稳定错误码。

契约要求（openapi.yaml ``x-robotd-errors``、接口契约 §3.2）：
- 调用方按 ``code`` 分支，**不得解析 message** 猜原因；
- 内部异常一律归 5xx，不伪装成校验失败（旧 POC 的 ``guard`` 把一切非 BUSY/NO_TASK
  都映射成 400，这是迁移时必须改掉的缺陷）；
- ``E_HW`` 只能由可观测硬件信号产生，不能由超时或模型推断。
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Mapping


class ErrorCode(str, Enum):
    # --- 客户端错误 ---
    VALIDATION = "E_VALIDATION"
    BUSY = "E_BUSY"
    NO_TASK = "E_NO_TASK"
    NOT_FOUND = "E_NOT_FOUND"
    APPROVAL = "E_APPROVAL"
    DEBUG_OFF = "E_DEBUG_OFF"
    STATE = "E_STATE"

    # --- 依赖不可用 ---
    UNAVAILABLE = "E_UNAVAILABLE"
    LINK = "E_LINK"
    MODEL_DOWN = "E_MODEL_DOWN"
    AUDIO = "E_AUDIO"
    CAM = "E_CAM"

    # --- 超时 ---
    TIMEOUT = "E_TIMEOUT"
    MODEL_TIMEOUT = "E_MODEL_TIMEOUT"

    # --- 硬件与服务端 ---
    BOARD = "E_BOARD"
    HW = "E_HW"
    INTERNAL = "E_INTERNAL"


_HTTP_STATUS: Mapping[ErrorCode, int] = {
    ErrorCode.VALIDATION: 400,
    ErrorCode.BUSY: 409,
    ErrorCode.NO_TASK: 404,
    ErrorCode.NOT_FOUND: 404,
    ErrorCode.APPROVAL: 403,
    ErrorCode.DEBUG_OFF: 403,
    ErrorCode.STATE: 409,
    ErrorCode.UNAVAILABLE: 503,
    ErrorCode.LINK: 503,
    ErrorCode.MODEL_DOWN: 503,
    ErrorCode.AUDIO: 503,
    ErrorCode.CAM: 503,
    ErrorCode.TIMEOUT: 504,
    ErrorCode.MODEL_TIMEOUT: 504,
    ErrorCode.BOARD: 502,
    ErrorCode.HW: 500,
    ErrorCode.INTERNAL: 500,
}


def http_status_for(code: ErrorCode | str) -> int:
    """错误码 → HTTP 状态。未知码一律 500（不美化）。"""
    try:
        return _HTTP_STATUS[ErrorCode(code)]
    except (ValueError, KeyError):
        return 500


class RobotdError(Exception):
    """robotd 的统一异常。

    ``details`` 会原样进公开错误体的 ``error.details``，所以**只放可公开的事实**
    （板侧原始码、超时值、设备名），不放内部路径、单调时钟、堆栈。
    """

    def __init__(
        self,
        code: ErrorCode | str,
        message: str,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = ErrorCode(code) if not isinstance(code, ErrorCode) else code
        self.message = message
        self.details = dict(details or {})

    @property
    def http_status(self) -> int:
        return http_status_for(self.code)

    def to_public(self) -> dict[str, Any]:
        """转成契约 §3.2 的错误体。"""
        err: dict[str, Any] = {"code": self.code.value, "message": self.message}
        if self.details:
            err["details"] = self.details
        return {"ok": False, "error": err}

    def __repr__(self) -> str:  # pragma: no cover - 调试用
        return f"RobotdError({self.code.value}, {self.message!r})"


def wrap_unexpected(exc: BaseException) -> RobotdError:
    """未分类异常 → 5xx。

    这不是「吞异常」：调用方仍能拿到 5xx 与稳定码 ``E_INTERNAL``，
    只是不能把内部故障伪装成客户端参数错误。
    """
    if isinstance(exc, RobotdError):
        return exc
    return RobotdError(ErrorCode.INTERNAL, f"{type(exc).__name__}: {exc}")


class EventContractError(RobotdError, ValueError):
    """事件不符合契约：调用方写错了事件名或 payload（如未知设备名）。

    同时是 ``ValueError``——调用点可以按普通参数错误处理，测试也可以直接
    ``pytest.raises(ValueError)``；同时是 ``RobotdError``——HTTP 层走统一错误体，
    落 400 ``E_VALIDATION``，而不是被 ``wrap_unexpected`` 收成 500 ``E_INTERNAL``。
    """
