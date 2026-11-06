"""事件归并内核：**状态的唯一写入点**。

结构（ADR-0006 的三条规定）：

1. 串口行、子进程事件、定时器 tick、HTTP 请求 → 先转成内部事件 → 进入 ``emit()`` 一个入口；
2. 派生状态由 ``_reduce()`` 在锁内改写；外部只能读 ``snapshot()``；
3. 对外只暴露「快照 + 增量」：``snapshot()`` 与 ``subscribe()`` 在**同一把锁**内取游标，
   所以订阅不存在竞态（旧实现 `v1Replay` 在 `accepted` 之后才读日志，期间新事件已推走）。

为什么用 ``threading.RLock`` 而不是 asyncio：Python 控制隔离机制**尚未定案**（R02）。
本内核只保证「同一时刻只有一个写入者」这条不变量，不声称任何时序保证；
等 R02 给出结论后，替换锁实现或把内核放进独立进程，对外接口不变。
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping

from .errors import ErrorCode, EventContractError, RobotdError
from .state import RobotStateStore, StateRejection
from .types import (
    DeviceStatus,
    Event,
    Exclusivity,
    Task,
    TaskError,
    TaskState,
    iso_utc,
    now_ms,
    scrub_payload,
)

log = logging.getLogger("robotd.kernel")


#: 事件名合法形状：``category.name``，全小写、下划线分隔
def _valid_event_type(name: str) -> bool:
    if not name or "." not in name:
        return False
    head, _, tail = name.partition(".")
    return bool(head and tail) and all(ch.islower() or ch.isdigit() or ch in "._" for ch in name)


def matches_filter(filters: Iterable[str], event_type: str) -> bool:
    """订阅过滤：精确名 / ``prefix.*`` / ``*``。

    契约 §6.1 语义。注意「过滤会制造序号空缺」——看不到某个 seq 不代表丢包。
    """
    for f in filters:
        if f == "*" or f == event_type:
            return True
        if f.endswith(".*"):
            prefix = f[:-1]  # 保留点号：task.* → "task."
            if event_type.startswith(prefix):
                return True
    return False


@dataclass
class Subscription:
    """一个订阅者。``push`` 抛错即视为断开，由内核摘除（慢订阅者不阻塞归并）。"""

    filters: set[str] = field(default_factory=set)
    push: Callable[[Event], None] = lambda _ev: None
    #: 已投递游标，用于诊断「这个订阅者落后多少」
    delivered_seq: int = 0

    def accepts(self, event_type: str) -> bool:
        return matches_filter(self.filters, event_type)


class EventKernel:
    """事件归并、序号分配、保留日志、订阅分发、任务表。"""

    def __init__(
        self,
        *,
        state: RobotStateStore,
        instance_id: str,
        event_log_max: int = 1000,
    ) -> None:
        self.state = state
        self.instance_id = instance_id
        self._lock = threading.RLock()
        self._seq = 0
        self._log: deque[Event] = deque(maxlen=event_log_max)
        self._log_max = event_log_max
        self._subs: dict[int, Subscription] = {}
        self._next_sub_id = 1
        self._tasks: dict[str, Task] = {}
        self._task_seq = 0
        #: 当前独占运动任务（同一时刻至多一个）
        self._motion_task: Task | None = None
        #: 被拒事件的形状记录（``{type, payload_keys, reason}``），不含 payload 原文
        self._rejections: deque[dict[str, Any]] = deque(maxlen=event_log_max)
        #: 归并步骤钩子：唯一的可注入失败点（测试用它模拟「算到一半出错」）
        self.reduce_step_hook: Callable[[str], None] | None = None

    # ------------------------------------------------------------ 只读属性
    @property
    def last_seq(self) -> int:
        return self._seq

    @property
    def replay_window(self) -> int:
        return self._log_max

    def oldest_seq(self) -> int:
        """保留窗口内最早一条的序号；窗口为空时返回 ``last_seq + 1``。"""
        with self._lock:
            return self._log[0].seq if self._log else self._seq + 1

    # ------------------------------------------------------------ 快照
    def snapshot(self) -> dict[str, Any]:
        """一致性快照：状态与 ``event_seq`` 在同一把锁内取。"""
        with self._lock:
            self.state.event_seq = self._seq
            return self.state.snapshot(event_seq=self._seq)

    # ------------------------------------------------------------ 任务
    def new_task(self, capability: str, exclusivity: Exclusivity) -> Task:
        """受理任务。

        互斥规则：
        - ``motion``：全进程唯一；已有未终结的运动任务 → 409/E_BUSY（不排队）。
        - ``soft``：按 capability 去重；与运动任务可并存。
        """
        with self._lock:
            if exclusivity is Exclusivity.MOTION and self._motion_task is not None:
                raise RobotdError(
                    ErrorCode.BUSY,
                    f"运动任务 {self._motion_task.task_id} 正在运行",
                    {"task_id": self._motion_task.task_id},
                )
            if exclusivity is Exclusivity.SOFT:
                for t in self._tasks.values():
                    if t.exclusivity is Exclusivity.SOFT and not t.terminal and t.capability == capability:
                        raise RobotdError(
                            ErrorCode.BUSY,
                            f"同类任务 {t.task_id} 正在运行",
                            {"task_id": t.task_id},
                        )
            self._task_seq += 1
            task = Task(
                task_id=f"t-{self._task_seq:04d}",
                capability=capability,
                exclusivity=exclusivity,
            )
            self._tasks[task.task_id] = task
            if exclusivity is Exclusivity.MOTION:
                self._motion_task = task
                self.state.recompute_mode(has_motion_task=True)
                self.state._apply_task_id(task.task_id)
            self._emit_locked(
                "task.started",
                {
                    "task_id": task.task_id,
                    "capability": capability,
                    "exclusivity": exclusivity.value,
                },
            )
            return task

    def mark_running(self, task_id: str) -> Task:
        """``accepted → running``。重复调用无副作用。"""
        with self._lock:
            task = self._require_task(task_id)
            if task.state is TaskState.ACCEPTED:
                task.state = TaskState.RUNNING
            return task

    def set_progress(self, task_id: str, progress: float, **extra: Any) -> None:
        with self._lock:
            task = self._require_task(task_id)
            if task.terminal:
                # 终态不可回转：晚到的进度事件不得把已完成任务改回 running/progress
                return
            task.progress = max(0.0, min(1.0, float(progress)))
            payload: dict[str, Any] = {"task_id": task_id, "progress": task.progress}
            payload.update(extra)
            self._emit_locked("task.progress", payload)

    def finish(
        self,
        task_id: str,
        state: TaskState,
        *,
        error: TaskError | None = None,
        reason: str | None = None,
    ) -> Task:
        """提交终态。**只提交一次**：已终结的任务重复调用直接返回原对象。

        这条是 R06 的核心：取消、自然结束、故障三者竞争时，谁先到谁算，
        后面的不许把 completed 改写成 failed。
        """
        if not state.terminal:
            raise ValueError("finish() 只接受终态")
        with self._lock:
            task = self._require_task(task_id)
            if task.terminal:
                return task
            task.state = state
            task.finished_at = now_ms()
            task.error = error
            task.reason = reason
            if state is TaskState.COMPLETED:
                task.progress = 1.0
            if self._motion_task is task:
                self._motion_task = None
                self.state._apply_task_id(None)
                self.state.recompute_mode(has_motion_task=False)

            event_map = {
                TaskState.COMPLETED: "task.completed",
                TaskState.FAILED: "task.failed",
                TaskState.CANCELLED: "task.cancelled",
            }
            payload: dict[str, Any] = {
                "task_id": task.task_id,
                "capability": task.capability,
            }
            if state is TaskState.FAILED:
                payload["error"] = (error or TaskError("E_INTERNAL", "未提供错误")).to_public()
                payload["reason"] = reason or "unspecified"
            elif state is TaskState.CANCELLED:
                payload["reason"] = reason or "requested"
            self._emit_locked(event_map[state], payload)
            return task

    def get_task(self, task_id: str) -> Task:
        with self._lock:
            return self._require_task(task_id)

    def list_tasks(self) -> list[Task]:
        with self._lock:
            return list(self._tasks.values())

    def _require_task(self, task_id: str) -> Task:
        task = self._tasks.get(task_id)
        if task is None:
            raise RobotdError(ErrorCode.NO_TASK, f"无此任务 {task_id}")
        return task

    # ------------------------------------------------------------ 事件入口
    def emit(self, event_type: str, payload: Mapping[str, Any] | None = None, **fields: Any) -> Event:
        """**唯一的事件入口**。四类输入源都走这里。

        ``fields`` 是 payload 的便捷写法（``emit("device.ready", device="esp32")``）。
        payload 里的内部字段会被 ``scrub_payload`` 剔除——不是静默丢弃：
        剔除后照常发布，语义完整，只是不泄漏内部时间戳。
        """
        with self._lock:
            merged: dict[str, Any] = dict(payload or {})
            merged.update(fields)
            return self._emit_locked(event_type, merged)

    def _emit_locked(self, event_type: str, payload: Mapping[str, Any]) -> Event:
        """**先算后发**：归并在工作副本上完成，成功后才分配序号并发布。

        顺序是刻意的：

        1. 契约校验（事件名 + 归并规则依赖的枚举值，如设备名）——不合法就是调用方写错了，
           整条事件不存在；
        2. ``state._stage()`` 取工作副本（pending），``_reduce()`` 只改副本；
        3. 全部算成功后才 ``state._publish()``、分配 ``seq``、进保留日志、分发。

        因此归并失败不会留下「日志里有、订阅者没收到、状态没改」的事件：
        副本扔掉，``seq`` 不消耗，日志不追加。``pending`` 坐落在工作副本里，
        ``snapshot()`` / ``resume()`` / 订阅者从结构上就读不到它。
        """
        if not _valid_event_type(event_type):
            raise EventContractError(ErrorCode.VALIDATION, f"事件名不合规：{event_type!r}")
        clean = scrub_payload(payload)

        staged = self.state._stage()
        try:
            self._reduce(event_type, clean, staged)
        except StateRejection as rejection:
            if rejection.contract:
                # 调用方写错了事件内容：这条事件「没发生过」，不消耗序号、不进日志。
                self._record_rejection(event_type, clean, rejection.reason)
                raise EventContractError(
                    ErrorCode.VALIDATION,
                    f"事件 {event_type} 不符合契约：{rejection.reason}",
                ) from None
            self._publish_rejection(event_type, clean, rejection.reason)
            raise
        except Exception:  # noqa: BLE001 - 先回滚，再让调用方看到真实故障
            self._publish_rejection(event_type, clean, "reduce_failed")
            raise

        return self._publish_locked(event_type, clean, staged=staged)

    def _publish_locked(
        self,
        event_type: str,
        payload: Mapping[str, Any],
        *,
        staged: RobotStateStore | None = None,
    ) -> Event:
        """提交一条事件：状态 → 序号 → 保留日志 → 分发。"""
        if staged is not None:
            # 状态只在发布这一刻生效
            self.state._publish(staged)
        self._seq += 1
        seq = self._seq
        event = Event(
            type=event_type,
            seq=seq,
            event_id=f"evt_{self.instance_id}_{seq}",
            timestamp=iso_utc(now_ms()),
            payload=dict(payload),
            mono_ns=time.monotonic_ns(),
        )
        self._log.append(event)
        self._dispatch_locked(event)
        return event

    def _dispatch_locked(self, event: Event) -> None:
        """分发：慢订阅者抛错即摘除，绝不让它阻塞归并路径。"""
        dead: list[int] = []
        for sub_id, sub in self._subs.items():
            if not sub.accepts(event.type):
                continue
            try:
                sub.push(event)
                sub.delivered_seq = event.seq
            except Exception:  # noqa: BLE001 - 订阅者故障不应影响状态
                log.warning("subscription %s push failed, dropping", sub_id, exc_info=True)
                dead.append(sub_id)
        for sub_id in dead:
            self._subs.pop(sub_id, None)

    # ------------------------------------------------------------ 拒绝记录
    @staticmethod
    def _rejection_record(event_type: str, payload: Mapping[str, Any], reason: str) -> dict[str, Any]:
        """拒绝记录只保留形状：事件名、payload 的键名、稳定原因码。

        不复制 payload 的值——把被拒输入原样再发一遍，等于绕过 ``scrub_payload``
        把内部字段重新发布出去。
        """
        return {
            "type": event_type,
            "payload_keys": sorted(str(key) for key in payload),
            "reason": reason,
        }

    def _record_rejection(self, event_type: str, payload: Mapping[str, Any], reason: str) -> dict[str, Any]:
        record = self._rejection_record(event_type, payload, reason)
        self._rejections.append(record)
        log.warning("归并拒绝事件 %s：%s", event_type, reason)
        return record

    def _publish_rejection(self, event_type: str, payload: Mapping[str, Any], reason: str) -> None:
        """归并内部失败：原事件丢弃，发一条 ``state.rejected`` 说明迁移没生效。

        ``state.rejected`` 自身没有归并规则，不会递归失败；发布它失败也不能掩盖
        原始故障，所以这里只记日志。
        """
        record = self._record_rejection(event_type, payload, reason)
        try:
            self._publish_locked("state.rejected", record)
        except Exception:  # noqa: BLE001
            log.error("发布 state.rejected 失败", exc_info=True)

    def rejections(self) -> list[dict[str, Any]]:
        """最近被拒事件的形状记录（诊断用，不含 payload 原文）。"""
        with self._lock:
            return [dict(record) for record in self._rejections]

    # ------------------------------------------------------------ 归并规则
    def _reduce(self, event_type: str, payload: Mapping[str, Any], state: RobotStateStore) -> None:
        """事件 → 状态。**这是唯一允许写 state 的地方**。

        ``state`` 是本次 emit 的工作副本（pending）：规则全部算成功、返回之后
        内核才把它发布成权威状态。抛错即整条事件作废，副本丢弃。

        每条规则都写明「这条事件凭什么改这个字段」。没有规则的事件只进日志、
        不改状态——它们仍然是增量，客户端能收到。
        """
        t = event_type
        p = payload

        if t == "device.ready":
            device = p.get("device")
            if device == "esp32":
                state._apply_link(DeviceStatus.READY, p.get("firmware"))
            else:
                state._apply_device(str(device), "ready")
            state.recompute_mode(has_motion_task=self._motion_task is not None)
            self._reduce_step("device.ready.apply")

        elif t == "device.lost":
            device = str(p.get("device"))
            state._apply_device(device, "lost")
            state.recompute_mode(has_motion_task=self._motion_task is not None)
            self._reduce_step("device.lost.apply")

        elif t == "device.recovered":
            device = str(p.get("device"))
            state._apply_device(device, "ready")
            state.recompute_mode(has_motion_task=self._motion_task is not None)
            self._reduce_step("device.recovered.apply")

        elif t == "device.reset":
            # 板复位：板侧步数归零 → 位姿与里程来源失效。**不自动续跑旧任务**：
            # 任务终止由 app 层在收到本事件后显式 finish(failed, reason=board_reset)，
            # 内核不替上层决定「哪个任务该失败」。
            if str(p.get("device")) == "esp32":
                state._apply_link(DeviceStatus.READY, p.get("firmware"))
                self._reduce_step("device.reset.link")
                state._invalidate_pose()
                self._reduce_step("device.reset.pose")
                state._reset_odometry()
                self._reduce_step("device.reset.odometry")

        elif t == "device.changed":
            device = str(p.get("device"))
            if device == "pump":
                state.pump = str(p.get("state", "unknown"))
            self._reduce_step("device.changed.apply")

        elif t in ("motion.plan",):
            # 计划只记「要发多少步」，不改 pose：应发步数不是实际位移。
            pass

        elif t == "safety.stopped":
            # 停止不等于物理静止，也不等于任务终结（终结由 finish 决定）
            pass

    def _reduce_step(self, name: str) -> None:
        """归并步骤钩子：唯一的可注入失败点。

        ``name`` 说明失败发生在哪一步（例如 ``device.reset.pose`` 表示链路已应用、
        位姿已作废、里程尚未复位）。钩子抛错时内核回滚整条事件，外部只能看到
        「状态没变 + 一条 ``state.rejected``」。
        """
        if self.reduce_step_hook is not None:
            self.reduce_step_hook(name)

    # ------------------------------------------------------------ 诊断读取
    def recent_events(self, limit: int = 100) -> list[Event]:
        """保留窗口内最近 ``limit`` 条事件（旧的在前）。只给调试旁路用。"""
        with self._lock:
            items = list(self._log)[-max(1, limit) :]
        return items

    # ------------------------------------------------------------ 订阅
    def subscribe(self, filters: Iterable[str], push: Callable[[Event], None]) -> "Handle":
        """注册订阅者。

        返回的 ``Handle.snapshot`` 与本次注册在**同一把锁**内取得：快照的
        ``event_seq`` 就是订阅起点，之后每条匹配事件都会 ``push``。

        **不回放历史**：更早的事件是否可补发由 ``resume()`` 判定，两条路径不重叠，
        避免同一条事件被补发一次、又被订阅回放一次。因此也不存在
        「快照与订阅之间的竞态」——快照即起点。
        """
        with self._lock:
            sub = Subscription(filters=set(filters), push=push)
            sub_id = self._next_sub_id
            self._next_sub_id += 1
            snapshot = self.snapshot()
            self._subs[sub_id] = sub
            return Handle(self, sub_id, sub, snapshot, self.instance_id, snapshot["event_seq"])

    def unsubscribe(self, sub_id: int) -> None:
        with self._lock:
            self._subs.pop(sub_id, None)

    def resume(self, instance_id: str | None, from_seq: int | None) -> tuple[str, list[Event]]:
        """判定补发是否可能。

        返回 ``(verdict, events)``，verdict ∈ ``{"ok", "instance_changed", "cursor_expired",
        "invalid_cursor"}``。**判不出来就说判不出来**，不猜：
        宁可让客户端重拉快照，也不给它一段有洞的事件流去自行修补状态。
        """
        with self._lock:
            if from_seq is None:
                return "ok", []
            if instance_id is not None and instance_id != self.instance_id:
                return "instance_changed", []
            if not isinstance(from_seq, int) or from_seq < 0:
                return "invalid_cursor", []
            if from_seq > self._seq:
                return "invalid_cursor", []
            if from_seq + 1 < self.oldest_seq():
                return "cursor_expired", []
            return "ok", [ev for ev in self._log if ev.seq > from_seq]

    # ------------------------------------------------------------ 诊断
    def stats(self) -> dict[str, Any]:
        with self._lock:
            return {
                "instance_id": self.instance_id,
                "last_seq": self._seq,
                "oldest_seq": self.oldest_seq(),
                "log_size": len(self._log),
                "log_max": self._log_max,
                "subscriptions": len(self._subs),
                "tasks": len(self._tasks),
                "rejections": len(self._rejections),
            }


@dataclass
class Handle:
    """订阅句柄。``close()`` 幂等。"""

    kernel: EventKernel
    sub_id: int
    sub: Subscription
    snapshot: dict[str, Any]
    instance_id: str
    cursor: int
    _closed: bool = False

    def close(self) -> None:
        if not self._closed:
            self.kernel.unsubscribe(self.sub_id)
            self._closed = True

    def __enter__(self) -> "Handle":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
