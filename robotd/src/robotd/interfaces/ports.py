"""模块之间的窄端口。

这些协议刻意只写 M0 真正用到的能力，不为未来模块预留空接口。
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class Clock(Protocol):
    """可注入时钟。测试用可控时钟，生产用系统时钟。"""

    def now_ms(self) -> int: ...

    def monotonic_ns(self) -> int: ...


@runtime_checkable
class BoardPort(Protocol):
    """板侧适配的最小形状。

    串口实现（R11）与仿真板都只暴露这三个动作；上层拿不到串口、GPIO 或固件细节。
    """

    kind: str

    def request(self, op: str, args: dict[str, Any] | None = None, timeout_ms: int = 500) -> Any: ...

    def notify(self, op: str, args: dict[str, Any] | None = None) -> None: ...

    def close(self) -> None: ...


@runtime_checkable
class TaskCompletionPort(Protocol):
    """音频会话结束 → 任务收尾。

    AudioRuntime 只报「这一轮结束了、怎么结束的」；该不该把任务标成
    completed / failed / cancelled 由 Task Executive 决定。
    """

    def utterance_finished(self, task_id: str | None, outcome: str, reason: str | None) -> None: ...

    def response_finished(self, task_id: str | None, outcome: str) -> None: ...


@runtime_checkable
class SystemAnnouncer(Protocol):
    """固定模板的系统播报（暂停超时等）。返回是否真的交给了 TTS。"""

    def announce_pause_expired(self) -> bool: ...
