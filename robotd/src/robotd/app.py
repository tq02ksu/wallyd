"""应用装配与生命周期。

R04 的全部要求都在这里落地：

- 入口 / ``--sim`` / 真机模式 / 回环绑定 / 配置优先级 / 启动校验
- 依赖注入：时钟、设备、模型都由外部传入 → 单元与仿真测试不需要相机、Metal、麦克风、串口
- 启动失败与部分初始化清理、信号关闭、子进程回收
- **关机先走停止路径**：``shutdown()`` 先请求停止运动，再关设备与子进程

## 明确未实现的部分

板侧适配（R07/R11）、控制隔离（R02）、感知（R15）。
本模块**不伪造**这些：``board`` 为 None 时状态里 ``devices.esp32`` 保持 ``unknown``/``starting``，
能力表里对应项报 ``E_UNAVAILABLE``。这是「宁可明确报错，也不返回虚假完成」的落点。
"""

from __future__ import annotations

import logging
import os
import signal
import socket
import sys
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from types import FrameType
from typing import Any, Callable, Protocol

from . import SERVICE_NAME, __version__
from .capabilities import Registry
from .config import Config
from .core.audio_runtime import (
    DEFAULT_BARGE_IN_ERLE_FLOOR_DB,
    DEFAULT_BARGE_IN_ERLE_MARGIN_DB,
    AudioRuntime,
)
from .core.announce import PAUSE_EXPIRED_TEXT
from .core.errors import ErrorCode, RobotdError
from .core.kernel import EventKernel
from .core.state import RobotStateStore
from .core.types import DeviceStatus, Exclusivity, Task, TaskError, TaskState, now_ms

log = logging.getLogger("robotd.app")


class Clock(Protocol):
    """可注入时钟。默认实现直接用 ``time``；测试里换成可控时钟。"""

    def now_ms(self) -> int: ...

    def monotonic_ns(self) -> int: ...


class SystemClock:
    def now_ms(self) -> int:
        return now_ms()

    def monotonic_ns(self) -> int:
        import time

        return time.monotonic_ns()


class BoardPort(Protocol):
    """板侧适配接口的**最小形状**。

    完整接口（hello / 应答关联 / 分包粘包 / 迟到应答）在 R07 定义。
    这里只声明 app 需要的三个动作，避免 app 依赖具体实现。
    """

    kind: str

    def request(self, op: str, args: dict[str, Any] | None = None, timeout_ms: int = 500) -> Any: ...

    def notify(self, op: str, args: dict[str, Any] | None = None) -> None: ...

    def close(self) -> None: ...


@dataclass
class AppInfo:
    name: str = SERVICE_NAME
    version: str = __version__
    contract_version: int = 1


def _timer_schedule(delay_ms: int, fn: Callable[[], None]) -> threading.Timer:
    """一次性定时（不是轮询）。daemon 线程，进程退出不阻塞。"""
    timer = threading.Timer(max(0, int(delay_ms)) / 1000.0, fn)
    timer.daemon = True
    timer.start()
    return timer


class App:
    """一个 robotd 进程的全部可观测状态都在这里。"""

    def __init__(
        self,
        config: Config,
        *,
        clock: Clock | None = None,
        board: BoardPort | None = None,
        instance_id: str | None = None,
        schedule: Callable[[int, Callable[[], None]], Any] | None = None,
    ) -> None:
        self.config = config.validate()
        self.clock: Clock = clock or SystemClock()
        self.board = board
        self.instance_id = instance_id or f"robotd-{uuid.uuid4().hex[:8]}"
        self.info = AppInfo()

        self.state = RobotStateStore(
            robot_id=config.robot_id,
            transport=config.transport_kind,
        )
        if board is not None:
            self.state._apply_link(DeviceStatus.STARTING)
        self.kernel = EventKernel(
            state=self.state,
            instance_id=self.instance_id,
            event_log_max=config.event_log_max,
        )
        self.registry = Registry()

        self._components: list[tuple[str, Any]] = []
        self._started = False
        self._stopping = threading.Event()
        self._lock = threading.Lock()
        #: 暂停到期调度器（可注入假调度器做虚拟时间测试）。
        self._schedule_fn = schedule or _timer_schedule
        self._pause_lock = threading.Lock()
        #: task_id → (token, timer)。token 让旧定时器不会误伤重新暂停的任务。
        self._pause_timers: dict[str, tuple[int, Any]] = {}
        self._pause_token_seq = 0
        #: HTTP 传输层（R09）由调用方装配后挂上，便于健康/诊断读取连接数
        self.transport: Any | None = None

        # 音频运行时（R14）：桥是可选的，没桥时语音能力如实报 unavailable
        # 门限的生效值与「是否被显式覆盖」一起交给运行时：真机上直接看
        # GET /v1/audio/state 就知道判据跑在什么门限下（GH-6 D2）。
        overridden = tuple(
            name
            for name, value, default in (
                ("margin", config.barge_in_erle_margin_db, DEFAULT_BARGE_IN_ERLE_MARGIN_DB),
                ("floor", config.barge_in_erle_floor_db, DEFAULT_BARGE_IN_ERLE_FLOOR_DB),
            )
            if value != default
        )
        self.audio = AudioRuntime(
            emit=self._audio_emit,
            barge_in_erle_margin_db=config.barge_in_erle_margin_db,
            barge_in_erle_floor_db=config.barge_in_erle_floor_db,
            barge_in_erle_overridden=overridden,
            inter_utterance_ms=config.inter_utterance_ms,
        )
        self.audio.on_utterance_done = self._on_utterance_done
        self.audio.on_response_done = self._on_response_done

    def _audio_emit(self, event_type: str, payload: dict[str, Any]) -> None:
        """语音运行时的唯一写入口：所有语音状态变化都经内核 emit（ADR-0006）。"""
        try:
            self.kernel.emit(event_type, payload)
        except Exception:  # noqa: BLE001
            log.warning("语音事件 %s 处理失败", event_type, exc_info=True)

    def _on_utterance_done(self, utt: Any, outcome: str, reason: str | None) -> None:
        """一轮「听」结束 → 收尾任务表。**失败与取消要分清**（R14）。"""
        if not utt.task_id:
            return
        try:
            if outcome == "failed":
                from .core.types import TaskError

                self.kernel.finish(
                    utt.task_id,
                    TaskState.FAILED,
                    error=TaskError("E_UNAVAILABLE", f"语音桥故障：{reason or '未知'}"),
                    reason=reason or "bridge_exit",
                )
            elif outcome == "cancelled":
                self.kernel.finish(utt.task_id, TaskState.CANCELLED, reason=reason or "cancelled")
            else:
                self.kernel.finish(utt.task_id, TaskState.COMPLETED)
        except Exception:  # noqa: BLE001
            log.debug("收尾听任务 %s 失败（可能已被取消）", utt.task_id, exc_info=True)

    def _on_response_done(self, resp: Any, outcome: str) -> None:
        if not resp.task_id:
            return
        try:
            if outcome == "failed":
                from .core.types import TaskError

                self.kernel.finish(
                    resp.task_id,
                    TaskState.FAILED,
                    error=TaskError("E_UNAVAILABLE", "播报期间语音桥退出"),
                    reason="bridge_exit",
                )
            elif outcome == "cancelled":
                self.kernel.finish(resp.task_id, TaskState.CANCELLED, reason="interrupted")
            else:
                self.kernel.finish(resp.task_id, TaskState.COMPLETED)
        except Exception:  # noqa: BLE001
            log.debug("收尾播报任务 %s 失败（可能已被取消）", resp.task_id, exc_info=True)

    # ------------------------------------------------------------ 工具
    def _register_component(self, name: str, component: Any) -> None:
        self._components.append((name, component))

    def _close_components(self) -> None:
        """逆序回收。**单个组件关闭失败不阻断其它组件**——关机路径必须走完。"""
        while self._components:
            name, comp = self._components.pop()
            close = getattr(comp, "close", None)
            if close is None:
                continue
            try:
                close()
            except Exception:  # noqa: BLE001
                log.warning("关闭组件 %s 失败", name, exc_info=True)

    # ------------------------------------------------------------ 健康与状态
    def health(self) -> dict[str, Any]:
        from . import PROTO_VERSION

        return {
            "ok": True,
            "service": self.info.name,
            "version": self.info.contract_version,
            "instance_id": self.instance_id,
            "protocol": PROTO_VERSION,
            "transport": self.config.transport_kind,
            "esp32": self.state.esp32.value,
            "mode": self.state.mode.value,
            "pid": os.getpid(),
            "implementation_version": self.info.version,
        }

    def snapshot(self) -> dict[str, Any]:
        return self.kernel.snapshot()

    # ------------------------------------------------------------ 生命周期
    def start(self) -> None:
        """启动。

        顺序是刻意的：先建立「板侧链路」，再宣告就绪。任一步失败都**不留下半初始化进程**。
        """
        with self._lock:
            if self._started:
                return
            try:
                self._start_board_link()
                self._started = True
                # 只有**真的握手成功**才发 device.ready。没有板侧时保持 starting，
                # 不为了「状态好看」编一个就绪事件。
                if self.state.esp32 is DeviceStatus.READY:
                    self.kernel.emit(
                        "device.ready",
                        device="esp32",
                        firmware=self.state.firmware,
                        after="connect",
                    )
            except Exception:
                # 部分初始化清理：已经拉起的子进程/句柄必须回收，再抛出
                log.error("启动失败，回收已初始化组件", exc_info=True)
                self._close_components()
                raise

    def attach_sim_board(self, board: Any) -> None:
        """装配仿真板（``--sim``）。

        板侧主动上报（复位/断链）→ 经 ``on_event`` → 内核 ``emit()``，
        **不让板侧直接改状态**：状态只有内核一个写入点。仿真板必须由外部注入，
        因为它的故障注入接口只给测试用，不该出现在生产装配路径里。
        """
        self.board = board
        if hasattr(board, "_on_event"):
            board._on_event = self._board_event
        log.info("已装配仿真板（--sim）：无硬件，不驱动电机")

    def _board_event(self, event_type: str, payload: dict[str, Any]) -> None:
        """板侧上报的统一入口。"""
        try:
            self.kernel.emit(event_type, payload)
        except Exception:  # noqa: BLE001
            log.warning("板侧事件 %s 处理失败", event_type, exc_info=True)

    def _start_board_link(self) -> None:
        """建立板侧链路。

        现状：只有仿真板可直接用；真机串口适配在 R11。这里**不做假握手**——
        没有板侧就保持 ``starting``，能力表里相应项报 UNAVAILABLE。
        """
        if self.board is None:
            if not self.config.sim:
                log.warning("未提供板侧适配（R11 未完成）：状态保持 %s", self.state.esp32.value)
            return
        try:
            info = self.board.request("hello", {"proto": 2}, timeout_ms=1500)
        except Exception as exc:  # noqa: BLE001
            self.state._apply_link(DeviceStatus.LOST)
            raise RobotdError(
                ErrorCode.LINK,
                f"板侧 hello 失败：{exc}",
                {"transport": self.config.transport_kind},
            ) from exc
        firmware = None
        if isinstance(info, dict):
            firmware = info.get("fw")
        self.state._apply_link(DeviceStatus.READY, firmware)
        self._register_component("board", self.board)

    # ------------------------------------------------------------ 暂停 / 恢复（GH-48）
    def _pausable(self, task_id: str) -> Task:
        """pause 前的状态校验。抛 ``E_STATE``/``E_NO_TASK``，不碰板侧。"""
        task = self.kernel.get_task(task_id)
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

    def pause_task(self, task_id: str) -> dict[str, Any]:
        """``POST /v1/tasks/{id}/pause``：速度归零、位置保持、任务不终结。

        顺序是刻意的：**先下发板侧停止，成功后才改任务状态**。反过来的话，
        板侧下发失败会留下「daemon 以为暂停了、板子还在跑」的中间态（ADR-0003）。
        """
        task = self._pausable(task_id)
        if task.state is TaskState.PAUSED:
            return task.to_public()  # 幂等：用户可能连说两次「等一下」
        if task.state is not TaskState.RUNNING:
            raise RobotdError(
                ErrorCode.STATE,
                f"任务 {task_id} 当前为 {task.state.value}，只有 running 可以暂停",
                {"task_id": task_id, "state": task.state.value},
            )
        if self.board is None:
            raise RobotdError(
                ErrorCode.UNAVAILABLE,
                "无板侧适配，无法确认速度已归零；不进入 paused",
                {"task_id": task_id},
            )
        if not self.state.link_ready:
            # 链路不通时不能假装暂停：任务必须提交明确终态，调用方才知道要重新处理。
            self.kernel.finish(
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
            self.board.notify("stop", {})
        except Exception as exc:  # noqa: BLE001
            self.kernel.finish(
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

        expires = self.clock.now_ms() + int(self.config.pause_max_seconds * 1000)
        paused = self.kernel.pause_task(task_id, pause_expires_at=expires)
        try:
            self._arm_pause_timer(task_id)
        except Exception as exc:  # noqa: BLE001
            # 不变量：paused 一定有截止时间。定时器都排不上就不能留一个无限期暂停，
            # 按 failed 收尾并如实报内部故障，调用方可以再试。
            log.error("暂停定时器无法建立，任务按内部故障收尾：%s", task_id, exc_info=True)
            self.kernel.finish(
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
        self.kernel.emit("safety.stopped", reason="task_pause", source="host", task_id=task_id)
        return paused.to_public()

    def resume_task(self, task_id: str) -> dict[str, Any]:
        """``POST /v1/tasks/{id}/resume``：从 paused 回到 running。

        **不新建任务、不重发动作能力、不重签审批凭据**：任务 id 与参数都没变。

        链路不通时拒绝恢复并**保持 paused**：恢复意味着「身体可以继续动」，
        板侧联系不上就不能声称已经恢复。任务不因此变成无限期 running——
        这次暂停的截止时间还在，到期会照常转 ``cancelled``。
        """
        task = self.kernel.get_task(task_id)
        if task.state is TaskState.PAUSED and not self.state.link_ready:
            raise RobotdError(
                ErrorCode.LINK,
                "板侧链路不可用，任务保持 paused（到暂停上限会自动取消）",
                {"task_id": task_id},
            )
        resumed = self.kernel.resume_task(task_id)
        self.clear_pause_timer(task_id)
        return resumed.to_public()

    def _arm_pause_timer(self, task_id: str) -> None:
        with self._pause_lock:
            self._pause_token_seq += 1
            token = self._pause_token_seq
            timer = self._schedule_fn(
                int(self.config.pause_max_seconds * 1000),
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
        这样 resume / stop / cancel 的竞态不会让过期回调取消一个已经恢复的任务。
        """
        with self._pause_lock:
            entry = self._pause_timers.get(task_id)
            if entry is None or entry[0] != token:
                return
            self._pause_timers.pop(task_id, None)
        try:
            task = self.kernel.get_task(task_id)
        except RobotdError:
            return
        if task.state is not TaskState.PAUSED:
            return
        # 到期收尾前再下发一次停止：任务要转终态了，不能只改任务表。
        # 板侧早已处于 stop 状态时这条是幂等的；链路不通由看门狗兜底。
        if self.board is not None and self.state.link_ready:
            try:
                self.board.notify("stop", {})
            except Exception:  # noqa: BLE001
                log.warning("暂停超时前下发停止失败 %s", task_id, exc_info=True)
        announced = self._announce_pause_expired()
        # 事件与终态分开兜底：事件发不出去只是时间线缺一条记录，
        # 任务留在 paused 才是真故障（那条暂停已经没有任何定时器兜着了）。
        try:
            self.kernel.emit("task.pause_expired", task_id=task_id, announced=announced)
        except Exception:  # noqa: BLE001
            log.warning("暂停超时事件未能发出 %s（仍按 cancelled 收尾）", task_id, exc_info=True)
        try:
            self.kernel.finish(task_id, TaskState.CANCELLED, reason="pause_timeout")
        except Exception:  # noqa: BLE001
            log.warning("暂停超时收尾失败 %s", task_id, exc_info=True)

    def _announce_pause_expired(self) -> bool:
        """尽力播报「等太久了，我先停下了」。

        返回是否真的交给了 TTS：音频桥不可用时返回 False，由 ``task.pause_expired.announced``
        如实记录——**不伪造已播报**。
        """
        try:
            resp = self.audio.new_response(task_id=None, kind="pause_expired")
            self.audio.speak(resp, text=PAUSE_EXPIRED_TEXT)
            return True
        except Exception:  # noqa: BLE001
            log.warning("暂停超时提示未能播报（音频桥不可用）", exc_info=True)
            return False

    def request_stop(self, *, reason: str = "stop") -> dict[str, Any]:
        """有序停止的**本地部分**。

        板侧下发在 R08；这里先把「停止」这件事在状态与任务表上落实，
        并明确报告是否真的联系到了板侧——**不把「本地已停」说成「物理已停」**。

        系统播报（审批复述）免审批，但**必须能被 stop 打断**：用户说「停」要立刻停，
        不能等桥回应，也不能因为桥不可用就静默成功。``abort_response`` 会立刻发出
        ``speech.tts_cancelled``（带 approval_id），agentd 据此不会开启确认窗口。
        """
        self.audio.abort_response("stop")
        stopped_motion = 0
        for task in self.kernel.list_tasks():
            if task.exclusivity is Exclusivity.MOTION and not task.terminal:
                # stop 仍能打断 paused（它仍是取消，语义不变）；定时器一并撤销。
                self.clear_pause_timer(task.task_id)
                self.kernel.finish(task.task_id, TaskState.CANCELLED, reason="stop")
                stopped_motion += 1
            elif task.capability in {"robot.speak", "robot.announce"} and not task.terminal:
                # 兜底：没有活跃 response 的播报任务（例如桥未接上）也必须收尾为 cancelled，
                # 不能留在 running 让调用方以为还在念。
                self.kernel.finish(task.task_id, TaskState.CANCELLED, reason="stop")
        board_ack: bool | None = None
        if self.board is not None:
            if self.state.link_ready:
                try:
                    self.board.notify("stop", {})
                    board_ack = True
                except Exception:  # noqa: BLE001
                    board_ack = False
            else:
                # 链路本来就不通：**明确记为未送达**，不是 None。
                # None 只用于「没有板侧适配」这一种情况（仿真/骨架期），
                # 否则调用方会把「没联系上」误读成「已停稳」。
                board_ack = False
        self.kernel.emit("safety.stopped", reason=reason, source="host")
        return {
            "ok": True,
            "stopped": True,
            "at": self.clock.now_ms(),
            "board_ack": board_ack,
            "stopped_tasks": stopped_motion,
        }

    def attach_audio_bridge(self, app_path: Path, *, locale: str = "zh_CN", aec: bool = False) -> None:
        """装配常驻语音桥（R14 / ADR-0011）。

        **桥起不来不能让 robotd 起不来**：语音是附加能力，起不来就如实记 ``lost`` +
        原因，`audio.state` 反映真实状态，其余能力（运动、停止）不受影响。
        这比「语音一坏整个守护进程拒绝启动」安全得多——CPU 失控时用户还要能按停止。
        """
        from .devices.audio_bridge import AudioBridge, AudioBridgeUnavailable

        bridge = AudioBridge(
            app_path=app_path,
            work_dir=resolve_work_dir(self.config),
            locale=locale,
            on_event=self.audio.handle_bridge_event,
            aec=aec,
        )
        self.audio.attach(bridge)
        try:
            bridge.start()
        except AudioBridgeUnavailable as exc:
            log.warning("语音桥未就绪：%s", exc)
            self.state._apply_device("audio", "lost")
            self._audio_emit("device.lost", {"device": "audio", "reason": str(exc)})
            # 桥句柄留着：/v1/audio/state 要能报出原因，重新拉起也走同一个对象
            self._register_component("audio_bridge", bridge)
            return
        self.state._apply_device("audio", "ready")
        self._audio_emit(
            "device.ready",
            {
                "device": "audio",
                "reason": "bridge",
                "format": bridge.ready_info.get("asr_format") if bridge.ready_info else None,
            },
        )
        self._register_component("audio_bridge", bridge)
        log.info("语音桥就绪：%s", bridge.ready_info)

    # ------------------------------------------------------------ 音频与语音（R14）
    def audio_state(self) -> dict[str, Any]:
        """音频现状。契约 ``AudioState``。

        **没有数据就填 null/空串**：桥没起来时 ``bridge`` 为 ``unknown``/``lost``，
        ``ambient_db`` 等保持 null——不用估算值把「没测」伪装成「测到了」。
        """
        return self.audio.state()

    def set_audio_muted(self, muted: bool) -> dict[str, Any]:
        return self.audio.set_muted(muted)

    # ------------------------------------------------------------ 标定（R11 之前只读为空）
    def read_calibration(self) -> dict[str, Any]:
        return {
            "available": False,
            "reason": "标定读写依赖板侧握手（R11）",
            "left_steps_per_m": None,
            "right_steps_per_m": None,
            "wheel_base_m": None,
        }

    def write_calibration(self, changes: dict[str, Any]) -> dict[str, Any]:
        raise RobotdError(
            ErrorCode.UNAVAILABLE,
            "标定下发依赖板侧握手（R11），当前不可写",
            {"fields": sorted(changes)},
        )

    # ------------------------------------------------------------ 调试旁路
    def debug_board_request(self, op: str, args: dict[str, Any], timeout_ms: int) -> dict[str, Any]:
        """调试旁路：直接向板侧发请求。

        **不进公开工具面**，且只在 ``--debug`` 下注册路由。这里仍校验 ``op`` 形状，
        避免把它变成任意串口注入入口。
        """
        if not self.config.debug:
            raise RobotdError(ErrorCode.DEBUG_OFF, "调试旁路未开启（需 --debug 启动）")
        if self.board is None:
            raise RobotdError(ErrorCode.UNAVAILABLE, "无板侧适配（R11 未完成）")
        if not op.replace("_", "").isalnum() or len(op) > 32:
            raise RobotdError(ErrorCode.VALIDATION, f"op 形状不合法：{op!r}")
        bounded = max(50, min(int(timeout_ms), 5000))
        result = self.board.request(op, dict(args), timeout_ms=bounded)
        return {"ok": True, "op": op, "result": result, "timeout_ms": bounded}

    def shutdown(self) -> None:
        """关机：**先停止运动**，再回收组件。幂等。"""
        if self._stopping.is_set():
            return
        self._stopping.set()
        try:
            self.request_stop(reason="startup" if not self._started else "stop")
        except Exception:  # noqa: BLE001
            log.warning("关机停止路径失败", exc_info=True)
        self._close_components()
        log.info("robotd 已关闭")

    def install_signal_handlers(self) -> None:
        """SIGINT/SIGTERM → shutdown。只在主线程可用。"""

        def _handler(signum: int, _frame: FrameType | None) -> None:
            log.info("收到信号 %s，开始有序关闭", signal.Signals(signum).name)
            self.shutdown()
            raise SystemExit(0)

        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                signal.signal(sig, _handler)
            except ValueError:  # 非主线程
                log.debug("跳过信号 %s（非主线程）", sig)


def resolve_work_dir(config: Config) -> Path:
    """运行产物目录：默认 ``<项目根>/work``，可由配置覆盖。

    「项目根」按包位置推断（``robotd/src/robotd`` → 上三层），与旧 TS 实现的
    ``HERE/../..`` 是同一条约定；但**不把它写进任何对外字段**。
    """
    if config.work_dir:
        return Path(config.work_dir).expanduser().resolve()
    return Path(__file__).resolve().parents[3] / "work"


def setup_logging(*, json: bool, level: int = logging.INFO) -> None:
    stream = sys.stderr
    if json:
        import json as _json

        class JsonFormatter(logging.Formatter):
            def format(self, record: logging.LogRecord) -> str:
                return _json.dumps(
                    {
                        "t": round(record.created, 3),
                        "level": record.levelname,
                        "src": record.name,
                        "msg": record.getMessage(),
                    },
                    ensure_ascii=False,
                )

        handler: logging.Handler = logging.StreamHandler(stream)
        handler.setFormatter(JsonFormatter())
    else:
        handler = logging.StreamHandler(stream)
        handler.setFormatter(logging.Formatter("[%(name)s] %(message)s"))

    root = logging.getLogger("robotd")
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)
    root.propagate = False


def bind_listener(config: Config) -> socket.socket:
    """创建回环监听 socket（不 accept）。HTTP 传输层在 R09 接上。"""
    from .config import resolve_bind_address

    family, sockaddr = resolve_bind_address(config.bind, config.http_port)
    sock = socket.socket(family, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind(sockaddr)
    except OSError as exc:
        sock.close()
        raise RobotdError(
            ErrorCode.INTERNAL,
            f"无法绑定 {config.bind}:{config.http_port}：{exc.strerror or exc}",
        ) from exc
    sock.listen(64)
    return sock


def utcstamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
