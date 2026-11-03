"""可控时钟与仿板：让单元测试不需要真实时间、相机、Metal、麦克风或串口。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


class FakeClock:
    """可推进的时钟。``now_ms`` 与 ``monotonic_ns`` 同步推进，便于断言时间语义。"""

    def __init__(self, start_ms: int = 1_700_000_000_000) -> None:
        self._ms = start_ms

    def now_ms(self) -> int:
        return self._ms

    def monotonic_ns(self) -> int:
        return (self._ms - 1_700_000_000_000) * 1_000_000

    def advance(self, ms: int) -> None:
        self._ms += ms


@dataclass
class FakeBoard:
    """板侧适配的最小替身。

    ``fail_hello`` / ``fail_stop`` 用来验证「失败必须显式」这条纪律；
    ``calls`` 记录被下发的 op，供断言「没有盲目重发运动指令」。
    """

    kind: str = "sim"
    fail_hello: bool = False
    fail_stop: bool = False
    firmware: str = "sim-2.1"
    calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    closed: bool = False

    def request(self, op: str, args: dict[str, Any] | None = None, timeout_ms: int = 500) -> Any:
        self.calls.append((op, dict(args or {})))
        if op == "hello":
            if self.fail_hello:
                raise TimeoutError("hello timeout")
            return {"fw": self.firmware, "proto": 2, "caps": ["move", "stop"]}
        raise AssertionError(f"测试替身没实现 op={op}")

    def notify(self, op: str, args: dict[str, Any] | None = None) -> None:
        self.calls.append((op, dict(args or {})))
        if op == "stop" and self.fail_stop:
            raise OSError("write failed")

    def close(self) -> None:
        self.closed = True
