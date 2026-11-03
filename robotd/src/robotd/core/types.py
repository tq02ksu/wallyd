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
class Task:
    """任务记录。

    ``accepted`` 阶段存在但极短：受理即返回 ``task_id``，随后在同一归并路径里转 ``running``。
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
    #: 内部：单调时钟起点，仅用于进程内测时长，不进公开 DTO
    _t0_mono_ns: int = field(default_factory=time.monotonic_ns, repr=False)

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
        return out


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
