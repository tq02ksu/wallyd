"""板侧适配的**仿真实现**与协议形状。

为什么需要它（R07 的最小可交付部分）：

- R03/R05/R06 的内核与状态已实现，但没有任何板侧实现 → ``esp32`` 永远是 ``starting``，
  ``robot.follow`` / ``robot.speak`` 一律 ``E_UNAVAILABLE``，于是 HTTP 层「能连上但什么都做不了」，
  agentd 侧无法端到端验证观测、任务关联与对账。
- 真机串口适配（R11）尚未实现。这里提供一个**明确的仿真板**：它只实现 ``BoardPort``
  约定的三个动作（``request`` / ``notify`` / ``close``），行为可预期、可注入故障，
  并且**不伪装物理事实**——它返回的步数是「应发」，不产生编码器读数。

纪律：

- 仿真板只在 ``--sim`` 下装配；真机模式没有板侧就保持 ``starting``（不假握手）。
- ``fail_mode`` 用于故障注入测试：``reset`` 模拟板复位（触发 ``device.reset``），
  ``lost`` 模拟串口断开。两者都必须让上层看到明确状态，而不是静默继续。
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable

from ..core.errors import ErrorCode, RobotdError

log = logging.getLogger("robotd.devices.sim")


class SimFault(str, Enum):
    NONE = "none"
    LOST = "lost"
    TIMEOUT = "timeout"


@dataclass
class SimBoardState:
    """仿真板内部状态。**不是公开 DTO**：不对外暴露，只用于测试断言与诊断。"""

    steps_left: int = 0
    steps_right: int = 0
    enabled: bool = False
    fault: SimFault = SimFault.NONE
    ops: list[str] = field(default_factory=list)


class SimBoard:
    """无硬件板侧适配。

    ``on_event`` 是上抛通道：板侧主动上报（复位、链路丢失）经它进入内核 ``emit()``，
    不让板侧直接改状态——状态只有内核一个写入点（ADR-0006）。
    """

    kind = "sim"

    def __init__(
        self,
        *,
        on_event: Callable[[str, dict[str, Any]], None] | None = None,
        ack_delay_ms: float = 0.0,
    ) -> None:
        self._lock = threading.Lock()
        self.state = SimBoardState(enabled=True)
        self._on_event = on_event
        self._ack_delay_ms = ack_delay_ms
        self._closed = False

    # ------------------------------------------------------------ BoardPort
    def request(self, op: str, args: dict[str, Any] | None = None, timeout_ms: int = 500) -> Any:
        """同步请求 → 应答。未知 op 明确报错，不返回「假装成功」。"""
        args = args or {}
        with self._lock:
            if self._closed:
                raise RobotdError(ErrorCode.LINK, "仿真板已关闭")
            if self.state.fault is SimFault.LOST:
                raise RobotdError(ErrorCode.LINK, "仿真板链路已丢失")
            if self.state.fault is SimFault.TIMEOUT:
                raise RobotdError(ErrorCode.TIMEOUT, f"仿真板 {op} 应答超时", {"timeout_ms": timeout_ms})
            self.state.ops.append(op)

            if op == "hello":
                return {"fw": "sim-0.1.0", "proto": 2, "enabled": self.state.enabled}
            if op == "ping":
                return {"pong": True}
            if op == "steps":
                left = int(args.get("left", 0))
                right = int(args.get("right", 0))
                self.state.steps_left += left
                self.state.steps_right += right
                return {"accepted": True, "left": left, "right": right}
            if op == "move":
                # 只证明「仿真板收到了 move 命令」；不产生位移/步数事实（无标定、无里程）。
                return {"accepted": True}
            if op == "calib":
                return {"accepted": True, "calib": dict(args)}
            if op == "stop":
                return {"stopped": True}
            raise RobotdError(ErrorCode.VALIDATION, f"仿真板不认识 op={op!r}")

    def notify(self, op: str, args: dict[str, Any] | None = None) -> None:
        """单向通知（无应答）。``stop`` 走这里：停止不等应答。"""
        with self._lock:
            if self._closed:
                return
            if self.state.fault is SimFault.LOST:
                raise RobotdError(ErrorCode.LINK, "仿真板链路已丢失")
            self.state.ops.append(f"notify:{op}")
            if op == "stop":
                self.state.steps_left = 0
                self.state.steps_right = 0

    def close(self) -> None:
        with self._lock:
            self._closed = True

    # ------------------------------------------------------------ 故障注入（仅测试）
    def inject_fault(self, fault: SimFault) -> None:
        with self._lock:
            self.state.fault = fault
        if fault is SimFault.LOST and self._on_event:
            self._on_event("device.lost", {"device": "esp32", "reason": "sim_lost"})

    def clear_fault(self) -> None:
        with self._lock:
            self.state.fault = SimFault.NONE

    def sim_reset(self) -> None:
        """模拟板复位：板侧步数归零，触发 ``device.reset``（pose 必须作废，不自动续跑）。"""
        with self._lock:
            self.state.steps_left = 0
            self.state.steps_right = 0
            fw = "sim-0.1.0"
        if self._on_event:
            self._on_event(
                "device.reset",
                {"device": "esp32", "firmware": fw, "pose_valid": False, "odometry_reset": True},
            )

    def sim_board_stop(self, reason: str = "watchdog") -> None:
        """模拟板侧主动停机上报（GH-57）。

        真实板侧看门狗/障碍物停机由固件产生；仿真板用同一事件形状把它们送进
        ``App._board_event``，让 robotd 的映射路径（而不是测试里的旁路）被覆盖。
        """
        with self._lock:
            self.state.steps_left = 0
            self.state.steps_right = 0
            self.state.enabled = False
        if self._on_event:
            self._on_event("safety.stopped", {"reason": reason, "source": "board"})


def sleep_ms(ms: float) -> None:
    if ms > 0:
        time.sleep(ms / 1000.0)
