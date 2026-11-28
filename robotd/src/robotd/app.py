"""Composition Root：装配、启动关闭与设备注入。

App 只做三件事：

1. 把配置、时钟、板侧、调度器、音频桥装配成进程内对象图；
2. 启动/关闭的生命周期与组件逆序回收（关机先走停止路径）；
3. 把设备对象注入到需要它的模块（板侧 → Task Executive / Safety，语音桥 → AudioRuntime）。

任务转移在 ``robotd.task``，停止策略在 ``robotd.safety``，音频事实在
``robotd.core.audio_runtime``，标定在 ``robotd.device.calibration``。这里不实现业务策略。

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
from typing import Any, Callable

from . import SERVICE_NAME, __version__
from .capabilities import Registry
from .config import Config
from .core.announce import PAUSE_EXPIRED_TEXT
from .core.audio_runtime import (
    DEFAULT_BARGE_IN_ERLE_FLOOR_DB,
    DEFAULT_BARGE_IN_ERLE_MARGIN_DB,
    AudioRuntime,
)
from .core.errors import ErrorCode, RobotdError
from .core.kernel import EventKernel
from .core.state import RobotStateStore
from .core.types import DeviceStatus, now_ms
from .device.calibration import CalibrationService
from .interfaces.ports import BoardPort, Clock
from .motion.arbiter import ResourceArbiter
from .safety.stop import StopCoordinator
from .safety.causes import StopCause
from .task.executive import TaskExecutive

log = logging.getLogger("robotd.app")


class SystemClock:
    def now_ms(self) -> int:
        return now_ms()

    def monotonic_ns(self) -> int:
        import time

        return time.monotonic_ns()


@dataclass
class AppInfo:
    name: str = SERVICE_NAME
    version: str = __version__
    contract_version: int = 1


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

        # ------------------------------------------------ 状态与事件内核
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

        # ------------------------------------------------ 逻辑资源与任务
        self.motion = ResourceArbiter()
        self.tasks = TaskExecutive(
            self.kernel,
            self.motion,
            clock=self.clock,
            board=lambda: self.board,
            pause_max_seconds=config.pause_max_seconds,
            schedule=schedule,
            announcer=self,
        )

        # ------------------------------------------------ 音频
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
            completion=self.tasks,
        )

        # ------------------------------------------------ 安全与设备
        self.safety = StopCoordinator(
            kernel=self.kernel,
            tasks=self.tasks,
            audio=self.audio,
            state=self.state,
            clock=self.clock,
            board=lambda: self.board,
        )
        self.calibration = CalibrationService()

        self._components: list[tuple[str, Any]] = []
        self._started = False
        self._stopping = threading.Event()
        self._lock = threading.Lock()
        #: HTTP 传输层（R09）由调用方装配后挂上，便于健康/诊断读取连接数
        self.transport: Any | None = None

    # ------------------------------------------------------------ 音频端口
    def _audio_emit(self, event_type: str, payload: dict[str, Any]) -> None:
        """语音运行时的唯一写入口：所有语音状态变化都经内核 emit（ADR-0006）。"""
        try:
            self.kernel.emit(event_type, payload)
        except Exception:  # noqa: BLE001
            log.warning("语音事件 %s 处理失败", event_type, exc_info=True)

    def announce_pause_expired(self) -> bool:
        """``SystemAnnouncer`` 端口：暂停超时的固定模板播报。

        返回是否真的交给了 TTS：音频桥不可用时返回 False，由
        ``task.pause_expired.announced`` 如实记录——**不伪造已播报**。
        """
        try:
            resp = self.audio.new_response(task_id=None, kind="pause_expired")
            self.audio.speak(resp, text=PAUSE_EXPIRED_TEXT)
            return True
        except Exception:  # noqa: BLE001
            log.warning("暂停超时提示未能播报（音频桥不可用）", exc_info=True)
            return False

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

    def attach_sim_board(self, board: BoardPort | None = None) -> None:
        """装配仿真板（``--sim``）。

        **设备对象只由 Composition Root 构造**：生产入口调用本方法时不传对象，
        由这里构造 ``SimBoard``；测试可以注入自己的替身。

        板侧主动上报（复位/断链）→ 经 ``on_event`` → Safety 编排/内核 ``emit()``，
        **不让板侧直接改状态**：状态只有内核一个写入点。
        """
        if board is None:
            from .device.sim import SimBoard

            board = SimBoard()
        self.board = board
        if hasattr(board, "_on_event"):
            board._on_event = self.safety.handle_board_event
        log.info("已装配仿真板（--sim）：无硬件，不驱动电机")

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

    def attach_audio_bridge(self, app_path: Path, *, locale: str = "zh_CN", aec: bool = False) -> None:
        """装配常驻语音桥（R14 / ADR-0011）。

        **桥起不来不能让 robotd 起不来**：语音是附加能力，起不来就如实记 ``lost`` +
        原因，`audio.state` 反映真实状态，其余能力（运动、停止）不受影响。
        这比「语音一坏整个守护进程拒绝启动」安全得多——CPU 失控时用户还要能按停止。
        """
        from .device.audio_bridge import AudioBridge, AudioBridgeUnavailable

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
            # 有序关闭也是“桥/宿主退出”这一类停止。
            self.safety.request_stop(
                cause=StopCause.BRIDGE_EXIT,
                detail="robotd 正在关闭，停止运动",
            )
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
