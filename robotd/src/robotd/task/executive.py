"""Task Executive（M0）。

端口/协作方：

- ``EventKernel``：``commit`` 负责原子提交，``read`` 负责持锁只读；
- ``ResourceArbiter``：准入 ``base_motion`` 与 soft 能力；
- ``BoardPort``：暂停前先下发板侧 stop（顺序不能反）；
- ``SystemAnnouncer``：暂停到期时的固定模板播报；
- ``TaskCompletionPort``：本类实现它，音频会话结束时由音频层回调。

所有写方法都在 ``self._lock`` 内完成「读-判定-提交」，因此暂停到期与恢复
不会交错出「刚恢复又被过期回调取消」的结果。
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable

from ..core.errors import ErrorCode, RobotdError
from ..core.kernel import EventKernel
from ..core.state import RobotStateStore
from ..core.types import ActionEpisode, Exclusivity, RobotTask, TaskError, TaskState
from ..interfaces.ports import BoardPort, Clock, SystemAnnouncer
from ..motion.arbiter import ResourceArbiter

log = logging.getLogger("robotd.task")


def _timer_schedule(delay_ms: int, fn: Callable[[], None]) -> threading.Timer:
    """一次性定时（不是轮询）。daemon 线程，进程退出不阻塞。"""
    timer = threading.Timer(max(0, int(delay_ms)) / 1000.0, fn)
    timer.daemon = True
    timer.start()
    return timer


class TaskExecutive:
    """RobotTask 生命周期的唯一决策者。"""

    def __init__(
        self,
        kernel: EventKernel,
        arbiter: ResourceArbiter,
        *,
        clock: Clock,
        board: Callable[[], BoardPort | None],
        pause_max_seconds: float = 120.0,
        schedule: Callable[[int, Callable[[], None]], Any] | None = None,
        announcer: SystemAnnouncer | None = None,
    ) -> None:
        self._kernel = kernel
        self._arbiter = arbiter
        self._clock = clock
        self._board = board
        self._pause_max_seconds = float(pause_max_seconds)
        self._schedule = schedule or _timer_schedule
        self._announcer = announcer
        self._lock = threading.RLock()
        #: 暂停到期调度：task_id → (token, timer)。token 让旧定时器不会误伤重新暂停的任务。
        self._pause_lock = threading.Lock()
        self._pause_timers: dict[str, tuple[int, Any]] = {}
        self._pause_token_seq = 0

    # ------------------------------------------------------------ 读
    def get(self, task_id: str) -> RobotTask:
        return self._kernel.read(lambda state: self._require(state, task_id))

    def list(self) -> list[RobotTask]:
        return self._kernel.read(lambda state: list(state.tasks.values()))

    # ------------------------------------------------------------ 受理
    def submit(self, capability: str, exclusivity: Exclusivity) -> RobotTask:
        """受理任务：准入 + 建任务/动作回合 + ``task.started``，一次原子提交。"""
        created: list[RobotTask] = []

        def plan(state: RobotStateStore) -> dict[str, Any]:
            state.next_task_seq += 1
            task_id = f"t-{state.next_task_seq:04d}"
            task = RobotTask(
                task_id=task_id,
                capability=capability,
                exclusivity=exclusivity,
                state=TaskState.RUNNING,
                episode_id=f"e-{task_id}",
            )
            self._arbiter.admit(state, task)
            state.tasks[task_id] = task
            state.episodes[task.episode_id] = ActionEpisode(
                episode_id=task.episode_id,
                task_id=task_id,
                action=capability,
            )
            state.project_tasks()
            created.append(task)
            return {
                "task_id": task_id,
                "capability": capability,
                "exclusivity": exclusivity.value,
            }

        self._kernel.commit("task.started", plan)
        return created[0]

    # ------------------------------------------------------------ 进度
    def set_progress(self, task_id: str, progress: float, **extra: Any) -> None:
        with self._lock:

            def plan(state: RobotStateStore) -> dict[str, Any] | None:
                task = self._require(state, task_id)
                if task.terminal:
                    # 终态不可回转：晚到的进度事件不得把已完成任务改回 running/progress
                    return None
                task.progress = max(0.0, min(1.0, float(progress)))
                payload: dict[str, Any] = {"task_id": task_id, "progress": task.progress}
                payload.update(extra)
                return payload

            self._kernel.commit("task.progress", plan)

    # ------------------------------------------------------------ 私有
    def _link_ready(self) -> bool:
        return self._kernel.read(lambda state: state.link_ready)

    @staticmethod
    def _require(state: RobotStateStore, task_id: str) -> RobotTask:
        task = state.tasks.get(task_id)
        if task is None:
            raise RobotdError(ErrorCode.NO_TASK, f"无此任务 {task_id}")
        return task

    # ------------------------------------------------------------ 暂停 / 恢复
    def pause(self, task_id: str) -> RobotTask:
        """速度归零、位置保持、任务不终结（GH-48）。

        顺序是刻意的：**先下发板侧停止，成功后才改任务状态**。反过来的话，
        板侧下发失败会留下「daemon 以为暂停了、板子还在跑」的中间态（ADR-0003）。
        """
        with self._lock:
            task = self._pausable(task_id)
            if task.state is TaskState.PAUSED:
                return task  # 幂等：用户可能连说两次「等一下」
            if task.state is not TaskState.RUNNING:
                raise RobotdError(
                    ErrorCode.STATE,
                    f"任务 {task_id} 当前为 {task.state.value}，只有 running 可以暂停",
                    {"task_id": task_id, "state": task.state.value},
                )
            board = self._board()
            if board is None:
                raise RobotdError(
                    ErrorCode.UNAVAILABLE,
                    "无板侧适配，无法确认速度已归零；不进入 paused",
                    {"task_id": task_id},
                )
            if not self._link_ready():
                # 链路不通时不能假装暂停：任务必须提交明确终态，调用方才知道要重新处理。
                self.finish(
                    task_id,
                    TaskState.FAILED,
                    error=TaskError("E_LINK", "板侧链路不可用，无法下发暂停停止"),
                    reason="lost_link",
                )
                raise RobotdError(
                    ErrorCode.LINK,
                    "板侧链路不可用，无法确认速度已归零；任务已按 failed 收尾",
                    {"task_id": task_id},
                )
            try:
                board.notify("stop", {})
            except Exception as exc:  # noqa: BLE001
                self.finish(
                    task_id,
                    TaskState.FAILED,
                    error=TaskError("E_LINK", f"暂停前下发停止失败：{exc}"),
                    reason="lost_link",
                )
                raise RobotdError(
                    ErrorCode.LINK,
                    f"暂停前下发停止失败：{exc}",
                    {"task_id": task_id},
                ) from exc

            expires = self._clock.now_ms() + int(self._pause_max_seconds * 1000)
            paused = self._commit_pause(task_id, expires)
            try:
                self._arm_pause_timer(task_id)
            except Exception as exc:  # noqa: BLE001
                # 不变量：paused 一定有截止时间。定时器都排不上就不能留一个无限期暂停，
                # 按 failed 收尾并如实报内部故障，调用方可以再试。
                log.error("暂停定时器无法建立，任务按内部故障收尾：%s", task_id, exc_info=True)
                self.finish(
                    task_id,
                    TaskState.FAILED,
                    error=TaskError("E_INTERNAL", "无法为暂停建立超时定时器"),
                    reason="internal",
                )
                raise RobotdError(
                    ErrorCode.INTERNAL,
                    "无法为暂停建立超时定时器，任务已按 failed 收尾",
                    {"task_id": task_id},
                ) from exc
            # safety.stopped 只表示停止动作已发生，不是物理静止证明（契约口径）。
            self._kernel.emit("safety.stopped", reason="task_pause", source="host", task_id=task_id)
            return paused

    def resume(self, task_id: str) -> RobotTask:
        """从 paused 回到 running；不新建任务、不重发动作能力、不重签审批凭据。"""
        with self._lock:
            task = self.get(task_id)
            if task.state is TaskState.PAUSED and not self._link_ready():
                raise RobotdError(
                    ErrorCode.LINK,
                    "板侧链路不可用，任务保持 paused（到暂停上限会自动取消）",
                    {"task_id": task_id},
                )
            resumed = self._commit_resume(task_id)
            self.clear_pause_timer(task_id)
            return resumed

    def _commit_pause(self, task_id: str, expires: int) -> RobotTask:
        result: list[RobotTask] = []

        def plan(state: RobotStateStore) -> dict[str, Any] | None:
            task = self._require(state, task_id)
            if task.state is TaskState.PAUSED:
                result.append(task)
                return None
            task.state = TaskState.PAUSED
            task.pause_expires_at = int(expires)
            task._paused_at_mono_ns = time.monotonic_ns()
            state.project_tasks()
            result.append(task)
            return {
                "task_id": task.task_id,
                "capability": task.capability,
                "pause_expires_at": task.pause_expires_at,
            }

        self._kernel.commit("task.paused", plan)
        return result[0]

    def _commit_resume(self, task_id: str) -> RobotTask:
        result: list[RobotTask] = []

        def plan(state: RobotStateStore) -> dict[str, Any] | None:
            task = self._require(state, task_id)
            if task.terminal:
                raise RobotdError(
                    ErrorCode.STATE,
                    f"任务 {task_id} 已终结（{task.state.value}），不能恢复",
                    {"task_id": task_id, "state": task.state.value},
                )
            if task.exclusivity is not Exclusivity.MOTION:
                raise RobotdError(
                    ErrorCode.STATE,
                    f"任务 {task_id} 不是运动任务，不能恢复",
                    {"task_id": task_id, "exclusivity": task.exclusivity.value},
                )
            if task.state is TaskState.RUNNING:
                result.append(task)
                return None
            if task.state is not TaskState.PAUSED:
                raise RobotdError(
                    ErrorCode.STATE,
                    f"任务 {task_id} 当前为 {task.state.value}，只有 paused 可以恢复",
                    {"task_id": task_id, "state": task.state.value},
                )
            started = task._paused_at_mono_ns
            paused_ms = 0 if started is None else max(0, (time.monotonic_ns() - started) // 1_000_000)
            task.state = TaskState.RUNNING
            task.pause_expires_at = None
            task._paused_at_mono_ns = None
            state.project_tasks()
            result.append(task)
            return {
                "task_id": task.task_id,
                "capability": task.capability,
                "paused_ms": paused_ms,
            }

        self._kernel.commit("task.resumed", plan)
        return result[0]

    def _pausable(self, task_id: str) -> RobotTask:
        """pause 前的状态校验。抛 ``E_STATE``/``E_NO_TASK``，不碰板侧。"""
        task = self.get(task_id)
        if task.terminal:
            raise RobotdError(
                ErrorCode.STATE,
                f"任务 {task_id} 已终结（{task.state.value}），不能暂停",
                {"task_id": task_id, "state": task.state.value},
            )
        if task.exclusivity is not Exclusivity.MOTION:
            raise RobotdError(
                ErrorCode.STATE,
                f"任务 {task_id} 不是运动任务，不能暂停",
                {"task_id": task_id, "exclusivity": task.exclusivity.value},
            )
        return task

    # ------------------------------------------------------------ 终态
    def finish(
        self,
        task_id: str,
        state: TaskState,
        *,
        error: TaskError | None = None,
        reason: str | None = None,
    ) -> RobotTask:
        """提交终态。**只提交一次**：已终结的任务重复调用直接返回原记录。"""
        if not state.terminal:
            raise ValueError("finish() 只接受终态")
        # 终态事件名在函数内用字面量表：契约门禁按源码枚举，模块级常量会让它看不见。
        event_map = {
            TaskState.COMPLETED: "task.completed",
            TaskState.FAILED: "task.failed",
            TaskState.CANCELLED: "task.cancelled",
        }
        with self._lock:
            result: list[RobotTask] = []

            def plan(staged: RobotStateStore) -> dict[str, Any] | None:
                task = self._require(staged, task_id)
                if task.terminal:
                    result.append(task)
                    return None
                task.state = state
                task.finished_at = self._clock.now_ms()
                task.error = error
                task.reason = reason
                # paused 的截止时间属于「这次暂停」，任务终结后必须清掉。
                task.pause_expires_at = None
                task._paused_at_mono_ns = None
                if state is TaskState.COMPLETED:
                    task.progress = 1.0
                self._arbiter.release(staged, task)
                episode = staged.episodes.get(task.episode_id)
                if episode is not None and episode.open:
                    episode.close(state.value, reason)
                staged.project_tasks()
                result.append(task)
                return self._finish_payload(task, state, error=error, reason=reason)

            self._kernel.commit(event_map[state], plan)
            return result[0]

    @staticmethod
    def _finish_payload(
        task: RobotTask,
        state: TaskState,
        *,
        error: TaskError | None,
        reason: str | None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"task_id": task.task_id, "capability": task.capability}
        if state is TaskState.FAILED:
            payload["error"] = (error or TaskError("E_INTERNAL", "未提供错误")).to_public()
            payload["reason"] = reason or "unspecified"
        elif state is TaskState.CANCELLED:
            payload["reason"] = reason or "requested"
        return payload

    def expire_paused_task(self, task_id: str, *, announced: bool) -> bool:
        """``paused → cancelled(reason=pause_timeout)`` 的原子收尾（GH-48）。

        整段到期收尾在 Task Executive 的锁内完成，所以 ``resume`` 与暂停到期不会
        交错：恢复先到 → 返回 ``False``；到期先到 → 任务先变 ``cancelled``，
        后续恢复只能拿到 ``409/E_STATE``。时间线事件发不出去也不能把任务留在
        没有定时器的 ``paused``，所以这里吞掉发射异常、照常收尾。
        """
        with self._lock:
            task = self.get(task_id)
            if task.state is not TaskState.PAUSED:
                return False
            try:
                self._kernel.commit(
                    "task.pause_expired",
                    lambda _state: {"task_id": task_id, "announced": announced},
                )
            except Exception:  # noqa: BLE001 - 时间线缺一条也不许留下无上限的 paused
                log.warning("暂停超时事件未能发出 %s（仍按 cancelled 收尾）", task_id, exc_info=True)
            self.finish(task_id, TaskState.CANCELLED, reason="pause_timeout")
            return True

    # ------------------------------------------------------------ 暂停定时器
    def _arm_pause_timer(self, task_id: str) -> None:
        with self._pause_lock:
            self._pause_token_seq += 1
            token = self._pause_token_seq
            timer = self._schedule(
                int(self._pause_max_seconds * 1000),
                lambda: self._on_pause_expired(task_id, token),
            )
            self._pause_timers[task_id] = (token, timer)

    def clear_pause_timer(self, task_id: str) -> None:
        """撤销某任务的暂停到期定时（resume / stop / cancel / 终结时调用）。幂等。"""
        with self._pause_lock:
            entry = self._pause_timers.pop(task_id, None)
        if entry is None:
            return
        cancel = getattr(entry[1], "cancel", None)
        if cancel is not None:
            try:
                cancel()
            except Exception:  # noqa: BLE001 - 取消失败不影响状态；到期回调会自查状态
                log.debug("撤销暂停定时失败 %s", task_id, exc_info=True)

    def _on_pause_expired(self, task_id: str, token: int) -> None:
        """暂停超过上限：转 cancelled 并尽力播报固定提示。

        自查两个条件再动手：定时器仍是这一代（token 相同），且任务确实还在 paused。
        终态转移由 :meth:`expire_paused_task` 在同一把锁里重新确认。
        """
        with self._pause_lock:
            entry = self._pause_timers.get(task_id)
            if entry is None or entry[0] != token:
                return
            self._pause_timers.pop(task_id, None)
        try:
            task = self.get(task_id)
        except RobotdError:
            return
        if task.state is not TaskState.PAUSED:
            return
        # 到期收尾前再下发一次停止：任务要转终态了，不能只改任务表。
        board = self._board()
        if board is not None and self._link_ready():
            try:
                board.notify("stop", {})
            except Exception:  # noqa: BLE001
                log.warning("暂停超时前下发停止失败 %s", task_id, exc_info=True)
        announced = self._announce_pause_expired()
        try:
            expired = self.expire_paused_task(task_id, announced=announced)
        except RobotdError:
            return
        if not expired:
            log.debug("暂停到期时任务已不在 paused，跳过收尾：%s", task_id)

    def _announce_pause_expired(self) -> bool:
        """尽力播报「等太久了，我先停下了」；不伪造已播报。"""
        if self._announcer is None:
            return False
        try:
            return bool(self._announcer.announce_pause_expired())
        except Exception:  # noqa: BLE001
            log.warning("暂停超时提示未能播报（音频桥不可用）", exc_info=True)
            return False

    # ------------------------------------------------------------ 音频完成端口
    def audio_unavailable(self, task_id: str, exc: BaseException) -> RobotTask:
        """受理后音频动作没能开始：按 ``E_UNAVAILABLE`` 失败收尾（策略不在 handler 里）。"""
        return self.finish(
            task_id,
            TaskState.FAILED,
            error=TaskError("E_UNAVAILABLE", str(exc)),
            reason="audio_unavailable",
        )

    def abort_finished(self, task_id: str, *, played: bool) -> RobotTask:
        """``speech.abort`` 正常结束：播报被中止或本来没有播报，都算 completed。"""
        return self.finish(
            task_id,
            TaskState.COMPLETED,
            reason="aborted" if played else "no_active_playback",
        )

    def utterance_finished(self, task_id: str | None, outcome: str, reason: str | None) -> None:
        """一轮「听」结束 → 收尾任务。**失败与取消要分清**（R14）。"""
        if not task_id:
            return
        try:
            if outcome == "failed":
                self.finish(
                    task_id,
                    TaskState.FAILED,
                    error=TaskError("E_UNAVAILABLE", f"语音桥故障：{reason or '未知'}"),
                    reason=reason or "bridge_exit",
                )
            elif outcome == "cancelled":
                self.finish(task_id, TaskState.CANCELLED, reason=reason or "cancelled")
            else:
                self.finish(task_id, TaskState.COMPLETED)
        except Exception:  # noqa: BLE001
            log.debug("收尾听任务 %s 失败（可能已被取消）", task_id, exc_info=True)

    def response_finished(self, task_id: str | None, outcome: str) -> None:
        if not task_id:
            return
        try:
            if outcome == "failed":
                self.finish(
                    task_id,
                    TaskState.FAILED,
                    error=TaskError("E_UNAVAILABLE", "播报期间语音桥退出"),
                    reason="bridge_exit",
                )
            elif outcome == "cancelled":
                self.finish(task_id, TaskState.CANCELLED, reason="interrupted")
            else:
                self.finish(task_id, TaskState.COMPLETED)
        except Exception:  # noqa: BLE001
            log.debug("收尾播报任务 %s 失败（可能已被取消）", task_id, exc_info=True)
