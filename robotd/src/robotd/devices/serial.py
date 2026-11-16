"""真机串口适配（R11 的最小切口，GH-74）。

线协议复用 ``docs/communication-protocol.md`` §3 的 JSON-Lines，不另立一套：

    命令    {"id":7,"op":"move","args":{"left":2400,"right":2400,"speed":0.15}}
    应答    {"id":7,"ok":true,"data":{"steps":2400,"eta_ms":2000}}
    失败    {"id":7,"ok":false,"err":{"code":"E_BUSY","msg":"..."}}
    推送    {"ev":"motion.done","steps":2400,"ts":123456}
    stop    {"op":"stop"}            ← 无 id：契约规定的最高优先级命令

⚠️ **单位以板子实核为准**：`firmware/robot_server_v2.py`（板侧 `poc-2.0`）对
`move.left/right` 执行 `int(args["left"])`，即**步数**；`speed` 是 m/s（板侧再乘
`steps_per_m` 得脉冲速率）。`docs/communication-protocol.md` §3.2 写的是米，
与在板固件不一致；robotd 按 `hello.steps_per_m` 把毫米换算成步数后下发，
doc 的差异已在本文件与 PR 说明里标明，待人工定夺（不擅自改线协议）。

纪律：

- **打开失败必须显式**：抛 ``E_UNAVAILABLE`` 并带可读原因（设备不存在/权限不足/不是设备），
  由装配层决定退出还是降级；这里绝不 ``except: pass`` 后假装链路可用。
- **单位单点声明**（ADR-0004）：板侧只认 ``hello`` 声明的米/秒。调用方传入什么单位由
  能力层负责换算，本模块不猜。
- **不做重发**：物理动作超时只报超时，不自动重发（文档 §2.3）。
- 读线程只做两件事：把带 id 的应答交回等待者、把板侧推送转成事件；它不修改任何状态，
  状态仍然只有内核一个写入点。
"""

from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any, Callable, Protocol

from ..core.errors import ErrorCode, RobotdError

log = logging.getLogger("robotd.devices.serial")

EventHandler = Callable[[str, dict[str, Any]], None]

#: 运动期间的心跳间隔。契约要求 ≥5Hz；10Hz 给看门狗（300ms）留足够余量。
HEARTBEAT_INTERVAL_S = 0.1
#: 板侧推送这两个事件即表示本次运动结束，心跳应立刻停。
_MOTION_END_EVENTS = frozenset({"motion.done", "motion.aborted"})


class SerialPortLike(Protocol):
    """``pyserial.Serial`` 在本模块用到的形状（测试用 ``FakeSerial`` 实现同一份）。"""

    def write(self, data: bytes) -> int: ...

    def readline(self) -> bytes: ...

    def close(self) -> None: ...


# ---------------------------------------------------------------- 帧
def encode_request(request_id: int, op: str, args: dict[str, Any] | None = None) -> bytes:
    """一条带 id 的命令帧。紧凑分隔符让字节级断言可读、稳定。"""
    message = {"id": int(request_id), "op": op, "args": dict(args or {})}
    return (json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def encode_stop() -> bytes:
    """停机帧：**没有 id**，板侧不等队列、不关联应答（契约 §3.1）。"""
    return (json.dumps({"op": "stop"}, separators=(",", ":")) + "\n").encode("utf-8")


def _describe_open_error(exc: BaseException) -> str:
    """把 pyserial/OS 的异常翻成现场能直接行动的原因。"""
    text = str(exc)
    if isinstance(exc, FileNotFoundError) or "No such file or directory" in text or "[Errno 2]" in text:
        return "设备不存在"
    if isinstance(exc, PermissionError) or "Permission denied" in text or "[Errno 13]" in text:
        return "权限不足（检查设备属主/组或系统授权）"
    if isinstance(exc, IsADirectoryError) or "Is a directory" in text or "[Errno 21]" in text:
        return "路径不是串口设备（是目录）"
    return text or type(exc).__name__


def _open_pyserial(port: str, baud: int, timeout_s: float) -> SerialPortLike:
    try:
        import serial  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover - 依赖存在时不会走到
        raise RobotdError(
            ErrorCode.UNAVAILABLE,
            "缺少 pyserial：真机串口需要 `pip install pyserial`（或安装 robotd[serial]）",
            {"port": port},
        ) from exc
    return serial.Serial(port=port, baudrate=int(baud), timeout=float(timeout_s), write_timeout=1.0)


def _map_board_code(raw: Any) -> ErrorCode:
    try:
        return ErrorCode(str(raw))
    except ValueError:
        return ErrorCode.BOARD


class _Pending:
    __slots__ = ("event", "reply")

    def __init__(self) -> None:
        self.event = threading.Event()
        self.reply: dict[str, Any] | None = None


class SerialBoard:
    """``BoardPort`` 的真机实现：一行一条 JSON，应答按 id 关联。"""

    kind = "serial"

    def __init__(
        self,
        port: str,
        baud: int = 115200,
        *,
        on_event: EventHandler | None = None,
        timeout_s: float = 0.1,
        open_fn: Callable[[str, int, float], SerialPortLike] | None = None,
    ) -> None:
        if not port:
            raise RobotdError(ErrorCode.UNAVAILABLE, "串口路径为空", {"port": port})
        opener = open_fn or _open_pyserial
        try:
            self._port = opener(port, int(baud), float(timeout_s))
        except RobotdError:
            raise
        except Exception as exc:  # noqa: BLE001 - 任何打开失败都必须带原因上报
            reason = _describe_open_error(exc)
            raise RobotdError(
                ErrorCode.UNAVAILABLE,
                f"串口打不开（{port}）：{reason}",
                {"port": port, "reason": reason},
            ) from exc

        self._port_name = port
        self._on_event = on_event
        self._write_lock = threading.Lock()
        self._id_lock = threading.Lock()
        self._pending_lock = threading.Lock()
        self._id = 0
        self._pending: dict[int, _Pending] = {}
        self._closed = threading.Event()
        self._lost = False
        self._hb_stop = threading.Event()
        self._hb_lock = threading.Lock()
        self._hb_thread: threading.Thread | None = None
        self._reader = threading.Thread(target=self._read_loop, name="robotd-serial", daemon=True)
        self._reader.start()
        log.info("串口已打开：%s @ %s（等待 hello 握手）", port, baud)

    # ------------------------------------------------------------ BoardPort
    def set_event_handler(self, handler: EventHandler | None) -> None:
        """装配层在 App 建好之后注入上抛通道。"""
        self._on_event = handler

    def request(self, op: str, args: dict[str, Any] | None = None, timeout_ms: int = 500) -> Any:
        if self._closed.is_set():
            raise RobotdError(ErrorCode.LINK, "串口已关闭，无法下发指令", {"op": op})
        if self._lost:
            raise RobotdError(ErrorCode.LINK, "串口链路已丢失，无法下发指令", {"op": op})

        with self._id_lock:
            self._id += 1
            request_id = self._id
        waiter = _Pending()
        with self._pending_lock:
            self._pending[request_id] = waiter
        try:
            self._write(encode_request(request_id, op, args))
        except BaseException:
            with self._pending_lock:
                self._pending.pop(request_id, None)
            raise

        timeout_s = max(1, int(timeout_ms)) / 1000.0
        if not waiter.event.wait(timeout_s):
            with self._pending_lock:
                self._pending.pop(request_id, None)
            raise RobotdError(
                ErrorCode.TIMEOUT,
                f"板侧 {op} 应答超时（{int(timeout_ms)}ms）；指令可能已执行，禁止自动重发",
                {"op": op, "timeout_ms": int(timeout_ms)},
            )

        if waiter.reply is None:
            # 读线程在等待期间判定链路丢失：如实报 LINK，不伪造一个「板侧拒绝」。
            raise RobotdError(
                ErrorCode.LINK,
                f"串口链路丢失，{op} 未收到应答",
                {"op": op, "port": self._port_name},
            )
        reply = waiter.reply
        if reply.get("ok") is not True:
            err = reply.get("err") or {}
            board_code = err.get("code")
            raise RobotdError(
                _map_board_code(board_code),
                f"板侧拒绝 {op}：{err.get('msg') or board_code or '未知原因'}",
                {"op": op, "board_code": board_code},
            )
        return reply.get("data")

    def notify(self, op: str, args: dict[str, Any] | None = None) -> None:
        """单向通知。``stop`` 走无 id 帧：不等应答，也不与排队命令关联。"""
        if op == "stop":
            # 先停心跳：否则 stop 之后还会继续发 velocity，把看门狗续上。
            self.stop_heartbeat()
        if self._closed.is_set():
            return
        if op == "stop":
            self._write(encode_stop())
            return
        message = {"op": op, "args": dict(args or {})}
        self._write((json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n").encode())

    # ------------------------------------------------------------ 运动心跳
    def start_heartbeat(self, duration_ms: int | None = None) -> None:
        """运动期间按 10Hz 发 ``velocity``，直到收到结束推送或到达安全上限。

        为什么必须有：固件 `poc-2.0` 在有运动意图时，300ms 收不到 `velocity`
        就自主停机（`motion.aborted reason=watchdog`）。而 `move` 是**有界步数**
        的一次性命令，中间不会有别的流量，所以 30cm 这种动作必然被看门狗打断——
        除非 host 持续喂心跳（契约 §3.3 就是这么要求的）。

        **不能用固件回填的 `eta_ms` 当截止时间**：实测板侧实际速率比标称慢
        （串口轮询与脉冲循环串行，2400 步标称 2s、实测 3~5s），按 eta 停心跳会在
        运动完成前断供，反而触发看门狗。所以默认**不设时限**，只靠
        `motion.done` / `motion.aborted` 收尾；`duration_ms` 仅作为测试用的上限，
        缺省取 30s 安全上限（与固件 `ENAGED_MAX_MS` 同量级）。
        """
        self.stop_heartbeat()
        self._hb_stop.clear()
        cap_ms = 30000.0 if duration_ms is None else max(300.0, float(duration_ms))
        deadline = time.monotonic() + cap_ms / 1000.0

        def loop() -> None:
            while not self._hb_stop.is_set():
                if time.monotonic() >= deadline:
                    break
                if self._closed.is_set() or self._lost:
                    break
                try:
                    with self._id_lock:
                        self._id += 1
                        request_id = self._id
                    # 不登记等待者：应答会被读线程按「迟到应答」忽略（debug 级），
                    # 心跳失败也不抛给调用方——运动是否真的还在跑，由板侧推送判定。
                    self._write(encode_request(request_id, "velocity"))
                except Exception:  # noqa: BLE001 - 写失败意味着链路已坏，退出即可
                    break
                self._hb_stop.wait(HEARTBEAT_INTERVAL_S)

        thread = threading.Thread(target=loop, name="robotd-serial-hb", daemon=True)
        self._hb_thread = thread
        thread.start()

    def stop_heartbeat(self) -> None:
        """停止心跳。可重入、可从读线程调用（会 join，但线程在 0.1s 内必然退出）。"""
        self._hb_stop.set()
        with self._hb_lock:
            thread, self._hb_thread = self._hb_thread, None
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=0.5)

    def close(self) -> None:
        if self._closed.is_set():
            return
        self.stop_heartbeat()
        self._closed.set()
        try:
            self._port.close()
        except Exception:  # noqa: BLE001 - 关闭失败不阻断关机
            log.warning("关闭串口 %s 失败", self._port_name, exc_info=True)
        if self._reader.is_alive():
            self._reader.join(timeout=0.5)

    # ------------------------------------------------------------ 内部
    def _write(self, frame: bytes) -> None:
        with self._write_lock:
            if self._closed.is_set():
                raise RobotdError(ErrorCode.LINK, "串口已关闭，无法写入")
            try:
                self._port.write(frame)
            except Exception as exc:  # noqa: BLE001
                self._mark_lost(f"写入失败：{exc}")
                raise RobotdError(
                    ErrorCode.LINK,
                    f"写入串口失败：{exc}",
                    {"port": self._port_name},
                ) from exc

    def _read_loop(self) -> None:
        # 缓冲区按**完整行**切分：readline 在超时时可能返回半行，半行不是一条消息。
        buffer = b""
        while not self._closed.is_set():
            try:
                raw = self._port.readline()
            except Exception as exc:  # noqa: BLE001
                self._mark_lost(f"读取失败：{exc}")
                return
            if not raw:
                time.sleep(0.005)
                continue
            buffer += raw if isinstance(raw, bytes) else str(raw).encode("utf-8", "replace")
            while b"\n" in buffer:
                chunk, buffer = buffer.split(b"\n", 1)
                self._handle_line(chunk)

    def _handle_line(self, chunk: bytes) -> None:
        line = chunk.decode("utf-8", "replace").strip()
        if not line:
            return
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            log.warning("串口收到非 JSON 行（已忽略）：%r", line[:200])
            return
        if not isinstance(message, dict):
            return
        if isinstance(message.get("ev"), str):
            self._emit_push(message)
        elif "id" in message:
            self._deliver(message)

    def _deliver(self, message: dict[str, Any]) -> None:
        try:
            request_id = int(message["id"])
        except (TypeError, ValueError):
            log.warning("串口应答 id 不是整数（已忽略）：%r", message.get("id"))
            return
        with self._pending_lock:
            waiter = self._pending.pop(request_id, None)
        if waiter is None:
            # 迟到/重复应答：不关联任何请求，也不制造新事实
            log.debug("忽略无等待者的应答 id=%s", request_id)
            return
        waiter.reply = message
        waiter.event.set()

    def _emit_push(self, message: dict[str, Any]) -> None:
        event_type = str(message["ev"])
        payload = {k: v for k, v in message.items() if k != "ev"}
        if event_type in _MOTION_END_EVENTS:
            # 板侧说这次运动结束了（无论完成还是被看门狗中止）→ 立刻停心跳，
            # 不再给一个已经停下的运动续命。
            self.stop_heartbeat()
        handler = self._on_event
        if handler is None:
            log.debug("板侧推送 %s 没有接收者（已丢弃）", event_type)
            return
        try:
            handler(event_type, payload)
        except Exception:  # noqa: BLE001 - 推送处理失败不能杀死读线程
            log.warning("处理板侧推送 %s 失败", event_type, exc_info=True)

    def _mark_lost(self, reason: str) -> None:
        """链路丢失只报一次：失败所有等待者，再上抛 ``device.lost``。"""
        with self._pending_lock:
            if self._lost:
                return
            self._lost = True
            pending = list(self._pending.values())
            self._pending.clear()
        for waiter in pending:
            waiter.event.set()
        log.error("串口链路丢失（%s）", reason)
        handler = self._on_event
        if handler is not None:
            try:
                handler("device.lost", {"device": "esp32", "reason": "device_lost"})
            except Exception:  # noqa: BLE001
                log.warning("上报 device.lost 失败", exc_info=True)
