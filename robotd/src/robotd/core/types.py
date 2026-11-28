"""公开 DTO 与内部记录。

分两层的理由（plan R05 第一条）：内部记录可以带单调时钟、取消句柄这类东西，
公开 DTO 不能。这里用 ``dataclass`` 显式写出 ``to_public()``，而不是靠「小心别漏」。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Mapping


def now_ms() -> int:
    """Unix epoch 毫秒。**公开时间戳一律用它**，不用 monotonic。"""
    return int(time.time() * 1000)


def iso_utc(ms: int) -> str:
    """Unix ms → UTC ISO 8601（毫秒精度，Z 结尾）。契约 §6.1 的事件 timestamp 格式。"""
    secs, rem = divmod(int(ms), 1000)
    base = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(secs))
    return f"{base}.{rem:03d}Z"


class RobotMode(str, Enum):
    IDLE = "idle"
    MOVING = "moving"
    DEGRADED = "degraded"


class TaskState(str, Enum):
    ACCEPTED = "accepted"
    RUNNING = "running"
    #: 运动任务的中间态：速度归零、位置保持、任务不终结。
    #: 既不是 ``cancelled``/``completed``，也不是 ``superseded``（GH-48）。
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"

    @property
    def terminal(self) -> bool:
        return self in (TaskState.COMPLETED, TaskState.FAILED, TaskState.CANCELLED)


class Exclusivity(str, Enum):
    """任务互斥类别。

    ``motion`` 独占（同一时刻仅一个，竞争返回 409/E_BUSY）；
    ``soft`` 按类别去重但可与运动任务并存——语音「听」与「说」必须能同时存在，
    否则播报期间听不到用户开口，打断（barge-in）无从谈起。
    """

    MOTION = "motion"
    SOFT = "soft"


class DeviceStatus(str, Enum):
    UNKNOWN = "unknown"
    STARTING = "starting"
    READY = "ready"
    ABSENT = "absent"
    ERROR = "error"
    LOST = "lost"


@dataclass(frozen=True)
class Pose:
    """里程积分估计。坐标系：x 向前、y 向左、theta 逆时针为正；单位米与弧度。"""

    x: float = 0.0
    y: float = 0.0
    theta: float = 0.0
    valid: bool = True

    def invalidate(self) -> "Pose":
        return Pose(self.x, self.y, self.theta, valid=False)

    def to_public(self) -> dict[str, Any]:
        return {"x": self.x, "y": self.y, "theta": self.theta, "valid": self.valid}


@dataclass(frozen=True)
class TaskError:
    code: str
    message: str
    details: Mapping[str, Any] = field(default_factory=dict)

    def to_public(self) -> dict[str, Any]:
        out: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.details:
            out["details"] = dict(self.details)
        return out


@dataclass
class RobotTask:
    """任务记录（State Store 的权威记录之一）。

    受理即在同一次 ``task.started`` 提交里落成 ``running``；``ACCEPTED`` 仍保留在枚举里
    以兼容契约取值，但 M0 不再有「受理后不发事件地改成 running」的第二写入点。
    终态不可再转移（``finish()`` 幂等，重复调用只保留第一次）。
    """

    task_id: str
    capability: str
    exclusivity: Exclusivity
    state: TaskState = TaskState.ACCEPTED
    progress: float = 0.0
    started_at: int = field(default_factory=now_ms)
    finished_at: int | None = None
    cancelable: bool = True
    error: TaskError | None = None
    reason: str | None = None
    #: 仅 ``paused`` 时有值：本次暂停的自动取消截止时间（Unix epoch 毫秒）。
    pause_expires_at: int | None = None
    #: 内部：单调时钟起点，仅用于进程内测时长，不进公开 DTO
    _t0_mono_ns: int = field(default_factory=time.monotonic_ns, repr=False)
    #: 内部：本次暂停开始的单调时钟；用于 ``task.resumed.paused_ms``，不进公开 DTO
    _paused_at_mono_ns: int | None = field(default=None, repr=False)
    #: 内部：本任务唯一动作回合的 id（M0 一个任务执行一个动作）；不进公开 DTO
    episode_id: str = field(default="", repr=False)

    @property
    def terminal(self) -> bool:
        return self.state.terminal

    def to_public(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "task_id": self.task_id,
            "capability": self.capability,
            "state": self.state.value,
            "progress": round(self.progress, 4),
            "started_at": self.started_at,
            "cancelable": self.cancelable,
            "exclusivity": self.exclusivity.value,
        }
        if self.finished_at is not None:
            out["finished_at"] = self.finished_at
        if self.error is not None:
            out["error"] = self.error.to_public()
        # 只有 paused 才暴露截止时间：其它状态下这个字段没有意义，不留在响应里当噪声。
        if self.state is TaskState.PAUSED:
            out["pause_expires_at"] = self.pause_expires_at
        return out


#: 兼容旧导入名；权威类型名是 ``RobotTask``。
Task = RobotTask


@dataclass
class ActionEpisode:
    """一次动作回合的权威记录。

    M0 的一个 RobotTask 只执行一个动作（`capability`），因此受理时同时开一条
    episode，任务转终态时在同一把锁里收尾。它不是公开 DTO：对外仍只看 RobotTask。
    `outcome` 取终态取值（completed / failed / cancelled），未知就是 None。
    """

    episode_id: str
    task_id: str
    action: str
    started_at: int = field(default_factory=now_ms)
    finished_at: int | None = None
    outcome: str | None = None
    reason: str | None = None

    @property
    def open(self) -> bool:
        return self.finished_at is None

    def close(self, outcome: str, reason: str | None = None) -> None:
        self.finished_at = now_ms()
        self.outcome = outcome
        self.reason = reason


@dataclass(frozen=True)
class Event:
    """已提交的公开事件（封套 + payload）。

    ``mono_ns`` 留在对象上但**不参与 to_public()**：它只用于进程内排序与诊断。
    """

    type: str
    seq: int
    event_id: str
    timestamp: str
    payload: Mapping[str, Any]
    mono_ns: int = field(default=0, repr=False)

    def to_public(self) -> dict[str, Any]:
        return {
            "version": 1,
            "type": self.type,
            "event_id": self.event_id,
            "seq": self.seq,
            "timestamp": self.timestamp,
            "payload": dict(self.payload),
        }


#: 不允许出现在公开 payload 里的键。事件归并路径会拒收带这些键的 payload，
#: 而不是「发出去再希望没人看」。
FORBIDDEN_PAYLOAD_KEYS = frozenset({"ts_mono_ns", "mono_ns", "model_text", "self_check_text"})


def scrub_payload(payload: Mapping[str, Any]) -> dict[str, Any]:
    """剔除内部字段并返回新 dict。

    递归处理嵌套 dict/list：内部字段可能藏在 ``audio.state`` 这类嵌套 payload 里。
    明确规定是**剔除**而不是报错，因为有些 payload 由桥的输出直接构造，
    桥会带自己的内部字段；剔除后仍是完整语义。
    """
    if not isinstance(payload, Mapping):
        return {}
    out: dict[str, Any] = {}
    for key, value in payload.items():
        if key in FORBIDDEN_PAYLOAD_KEYS:
            continue
        if isinstance(value, Mapping):
            out[key] = scrub_payload(value)
        elif isinstance(value, list):
            out[key] = [scrub_payload(v) if isinstance(v, Mapping) else v for v in value]
        else:
            out[key] = value
    return out
