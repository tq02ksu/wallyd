"""有序停止的编排（本地部分）。

停止策略只在这里：打断播报 → 取消运动/播报任务 → 下发板侧 stop → 如实报告
``board_ack`` 与 ``state``。HTTP handler 与 App 都不再实现这套策略。

板侧下发仍只有「有板侧适配 + 链路就绪」才可能确认；**不把「本地已停」说成
「物理已停」**。
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Callable

from ..core.errors import ErrorCode, RobotdError
from ..core.kernel import EventKernel
from ..core.state import RobotStateStore
from ..core.types import Exclusivity, RobotTask, TaskState
from ..interfaces.ports import BoardPort, Clock
from ..task.executive import TaskExecutive
from .causes import (
    LEGACY_REASON_TO_CAUSE,
    STOP_CAUSES,
    StopCause,
    StopState,
    coerce_stop_cause,
    default_detail,
    is_valid_cause,
    legacy_stop_reason,
)

if TYPE_CHECKING:  # pragma: no cover - 只为类型提示，不引入运行期依赖
    from ..core.audio_runtime import AudioRuntime

log = logging.getLogger("robotd.safety")


class StopCoordinator:
    """安全停止的唯一交入口。"""

    def __init__(
        self,
        *,
        kernel: EventKernel,
        tasks: TaskExecutive,
        audio: "AudioRuntime",
        state: RobotStateStore,
        clock: Clock,
        board: Callable[[], BoardPort | None],
    ) -> None:
        self._kernel = kernel
        self._tasks = tasks
        self._audio = audio
        self._state = state
        self._clock = clock
        self._board = board

    # ------------------------------------------------------------ 停止
    def request_stop(
        self,
        *,
        reason: str = "stop",
        cause: str | StopCause | None = None,
        detail: str | None = None,
        state: StopState | str | None = None,
        notify_board: bool = True,
        source: str = "host",
    ) -> dict[str, Any]:
        """有序停止的**本地部分**。

        每次停止都发两条事件：``safety.stopped``（动作发生）与
        ``safety.stop_requested``（结构化原因 + 确认状态）。``cause`` 是唯一判据；
        ``detail`` 只供人读。板侧已主动停机时用 ``notify_board=False``，避免反向再发 stop。
        """
        if cause is not None:
            if isinstance(cause, StopCause):
                stop_cause = cause
            elif is_valid_cause(cause):
                stop_cause = StopCause(str(cause))
            else:
                raise RobotdError(ErrorCode.VALIDATION, f"未知停止原因：{cause!r}")
        else:
            stop_cause = coerce_stop_cause(reason)
        self._audio.abort_response("stop")
        stopped_motion = 0
        stopped_task_id: str | None = None
        for task in self._tasks.list():
            if task.exclusivity is Exclusivity.MOTION and not task.terminal:
                # stop 仍能打断 paused（它仍是取消，语义不变）；定时器一并撤销。
                self._tasks.clear_pause_timer(task.task_id)
                self._tasks.finish(task.task_id, TaskState.CANCELLED, reason=stop_cause.value)
                stopped_motion += 1
                if stopped_task_id is None:
                    stopped_task_id = task.task_id
            elif task.capability in {"robot.speak", "robot.announce"} and not task.terminal:
                # 兜底：没有活跃 response 的播报任务（例如桥未接上）也必须收尾为 cancelled，
                # 不能留在 running 让调用方以为还在念。
                self._tasks.finish(task.task_id, TaskState.CANCELLED, reason=stop_cause.value)
        board_ack: bool | None = None
        board = self._board()
        if notify_board and board is not None:
            if self._state.link_ready:
                try:
                    board.notify("stop", {})
                    board_ack = True
                except Exception:  # noqa: BLE001
                    board_ack = False
            else:
                # 链路本来就不通：**明确记为未送达**，不是 None。
                # None 只用于「没有板侧适配」这一种情况（仿真/骨架期）。
                board_ack = False

        if state is not None:
            stop_state = StopState(state)
        elif not notify_board:
            # 没有向板侧发 stop 的路径（板侧已停 / 链路已断）：默认只能是 unknown，
            # 除非调用方明确给出 confirmed。绝不默认 confirmed。
            stop_state = StopState.UNKNOWN
        elif board_ack is True:
            stop_state = StopState.CONFIRMED
        elif board_ack is False:
            stop_state = StopState.UNKNOWN
        else:
            stop_state = StopState.REQUESTED

        if stop_cause is StopCause.DEVICE_LOST:
            # 设备掉线时没有可信的板侧确认通道：无论调用方怎么传，都只能是 unknown。
            stop_state = StopState.UNKNOWN

        if detail is None:
            detail = default_detail(stop_cause)
            if stopped_motion:
                detail = f"{detail}（终止 {stopped_motion} 个运动任务）"

        self._kernel.emit("safety.stopped", reason=legacy_stop_reason(stop_cause), source=source)
        self._emit_stop_requested(stop_cause, stop_state, detail, stopped_task_id)
        return {
            "ok": True,
            "stopped": True,
            "at": self._clock.now_ms(),
            "board_ack": board_ack,
            "stopped_tasks": stopped_motion,
            "cause": stop_cause.value,
            "state": stop_state.value,
        }

    def report(self, *, cause: str | StopCause, detail: str | None = None) -> dict[str, Any]:
        """安全判定模块（Nav/感知/参数校验）的唯一停机交入口。"""
        if isinstance(cause, StopCause):
            stop_cause = cause
        elif is_valid_cause(cause):
            stop_cause = StopCause(str(cause))
        else:
            raise RobotdError(ErrorCode.VALIDATION, f"未知停止原因：{cause!r}")
        return self.request_stop(cause=stop_cause, detail=detail)

    def cancel_task(self, task_id: str) -> RobotTask:
        """取消任务：运动任务必须联动 stop，只改任务表会让电机继续跑。"""
        task = self._tasks.get(task_id)
        if task.terminal:
            return task
        if task.exclusivity is Exclusivity.MOTION:
            self.request_stop(reason="task_cancel")
        self._tasks.clear_pause_timer(task_id)
        return self._tasks.finish(task_id, TaskState.CANCELLED, reason="requested")

    # ------------------------------------------------------------ 板侧上报
    def handle_board_event(self, event_type: str, payload: dict[str, Any]) -> None:
        """板侧上报的统一入口：停止类进安全编排，其余照常归并。"""
        payload = dict(payload or {})
        if event_type == "safety.stopped" and str(payload.get("source") or "") == "board":
            # 板侧主动停机（看门狗/障碍物/越界等）。板侧已经停了，不能再发 stop；
            # 是否 confirmed 取决于链路是否仍然可用——链路断了就只能诚实报 unknown。
            reason = str(payload.get("reason") or "watchdog")
            cause = coerce_stop_cause(reason)
            if reason not in STOP_CAUSES and reason not in LEGACY_REASON_TO_CAUSE:
                cause = StopCause.INTERNAL_ERROR
            confirmed = self._state.link_ready
            self.request_stop(
                cause=cause,
                notify_board=False,
                state=StopState.CONFIRMED if confirmed else StopState.UNKNOWN,
                detail=f"板侧主动停机（{reason}）",
                source="board",
            )
            return

        if event_type == "safety.stop_requested":
            cause_value = payload.get("cause")
            if is_valid_cause(cause_value):
                state = payload.get("state")
                if state not in {s.value for s in StopState}:
                    state = StopState.CONFIRMED if self._state.link_ready else StopState.UNKNOWN
                self.request_stop(
                    cause=StopCause(str(cause_value)),
                    notify_board=False,
                    state=StopState(str(state)),
                    detail=str(payload.get("detail") or default_detail(StopCause(str(cause_value)))),
                    source="board",
                )
                return
            log.warning("板侧 safety.stop_requested 缺合法 cause：%r", cause_value)
            return

        try:
            self._kernel.emit(event_type, payload)
        except Exception:  # noqa: BLE001
            log.warning("板侧事件 %s 处理失败", event_type, exc_info=True)

        if event_type == "device.lost" and str(payload.get("device")) == "esp32":
            # 串口/链路掉线：主机侧已经无法确认板侧是否停稳。
            # 这不是「已停稳」，也不是「失败」——按契约发 unknown/device_lost。
            self.request_stop(
                cause=StopCause.DEVICE_LOST,
                notify_board=False,
                state=StopState.UNKNOWN,
                detail="板侧链路丢失，无法确认机器人已停稳",
            )

    # ------------------------------------------------------------ 私有
    def _emit_stop_requested(
        self,
        cause: StopCause,
        state: StopState,
        detail: str,
        task_id: str | None = None,
    ) -> None:
        payload: dict[str, Any] = {
            "cause": cause.value,
            "state": state.value,
            "detail": detail,
        }
        if task_id:
            payload["task_id"] = task_id
        self._kernel.emit("safety.stop_requested", payload)
