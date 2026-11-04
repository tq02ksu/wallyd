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
from typing import Any, Protocol

from . import SERVICE_NAME, __version__
from .capabilities import Registry
from .config import Config
from .core.audio_runtime import AudioRuntime
from .core.errors import ErrorCode, RobotdError
from .core.kernel import EventKernel
from .core.state import RobotStateStore
from .core.types import DeviceStatus, Exclusivity, TaskState, now_ms

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


class App:
    """一个 robotd 进程的全部可观测状态都在这里。"""

    def __init__(
        self,
        config: Config,
        *,
        clock: Clock | None = None,
        board: BoardPort | None = None,
        instance_id: str | None = None,
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
        #: HTTP 传输层（R09）由调用方装配后挂上，便于健康/诊断读取连接数
        self.transport: Any | None = None

        # 音频运行时（R14）：桥是可选的，没桥时语音能力如实报 unavailable
        self.audio = AudioRuntime(emit=self._audio_emit)
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

    def request_stop(self, *, reason: str = "stop") -> dict[str, Any]:
        """有序停止的**本地部分**。

        板侧下发在 R08；这里先把「停止」这件事在状态与任务表上落实，
        并明确报告是否真的联系到了板侧——**不把「本地已停」说成「物理已停」**。
        """
        stopped_motion = 0
        for task in self.kernel.list_tasks():
            if task.exclusivity is Exclusivity.MOTION and not task.terminal:
                self.kernel.finish(task.task_id, TaskState.CANCELLED, reason="stop")
                stopped_motion += 1
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
