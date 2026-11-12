"""可控时钟与仿板：让单元测试不需要真实时间、相机、Metal、麦克风或串口。"""

from __future__ import annotations

import json
import os
import queue
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable


class FakeClock:
    """可推进的时钟。``now_ms`` 与 ``monotonic_ns`` 同步推进，便于断言时间语义。"""

    def __init__(self, start_ms: int = 1_700_000_000_000) -> None:
        self._ms = start_ms

    def now_ms(self) -> int:
        return self._ms

    def monotonic_ns(self) -> int:
        return (self._ms - 1_700_000_000_000) * 1_000_000

    def advance(self, ms: int) -> None:
        self._ms += ms


class FakeSerial:
    """``pyserial.Serial`` 的最小替身：记录写出的字节，按行注入板侧应答。

    这不是「模拟位移」：它只证明 host 写出的字节序列，不产生任何位置/步数事实。
    ``on_write`` 让测试按命令里的 ``id`` 回填应答；``read_error`` 注入读失败以覆盖断链。
    """

    def __init__(self) -> None:
        self.writes: list[bytes] = []
        self.closed = False
        self.read_error: Exception | None = None
        self.on_write: Callable[[bytes], None] | None = None
        self._incoming: queue.Queue[bytes] = queue.Queue()

    def write(self, data: bytes) -> int:
        raw = bytes(data)
        self.writes.append(raw)
        if self.on_write is not None:
            self.on_write(raw)
        return len(raw)

    def readline(self) -> bytes:
        if self.read_error is not None:
            raise self.read_error
        try:
            return self._incoming.get(timeout=0.01)
        except queue.Empty:
            return b""

    def feed(self, line: bytes) -> None:
        self._incoming.put(line if line.endswith(b"\n") else line + b"\n")

    def feed_json(self, message: dict[str, Any]) -> None:
        self.feed(json.dumps(message, separators=(",", ":")).encode())

    def close(self) -> None:
        self.closed = True


def fake_serial_board(replies: dict[str, dict[str, Any]] | None = None):
    """建一个 ``SerialBoard``，串口是 ``FakeSerial``；默认对每条带 id 的命令回 ``ok``。

    返回 ``(board, fake)``。``replies`` 可按 op 覆盖应答体（例如 ``{"move": {"ok": False,
    "err": {"code": "E_BUSY", "msg": "motion task running"}}}``）。
    """
    from robotd.devices.serial import SerialBoard

    fake = FakeSerial()

    def on_write(raw: bytes) -> None:
        try:
            command = json.loads(raw.decode())
        except (UnicodeDecodeError, json.JSONDecodeError):
            return
        if "id" not in command:
            return
        reply = (replies or {}).get(command.get("op"), {"ok": True, "data": {}})
        fake.feed_json({"id": command["id"], **reply})

    fake.on_write = on_write
    board = SerialBoard(
        "/dev/fake-serial",
        115200,
        open_fn=lambda _port, _baud, _timeout: fake,
        timeout_s=0.01,
    )
    return board, fake


class PseudoBoard:
    """POSIX 伪终端上的「板子」：按行读命令，带 id 的命令回一条 ``ok`` 应答。

    比 ``FakeSerial`` 更接近现场：真的 pyserial、真的 tty 设备路径、真的字节流。
    它不做位移、不报步数，只记录收到的命令。
    """

    def __init__(self) -> None:
        import tty

        self.master, self._slave = os.openpty()
        tty.setraw(self._slave)
        self.path = os.ttyname(self._slave)
        self.received: list[dict[str, Any]] = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        buffer = b""
        while not self._stop.is_set():
            try:
                chunk = os.read(self.master, 4096)
            except OSError:
                return
            if not chunk:
                continue
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                if not line.strip():
                    continue
                command = json.loads(line)
                self.received.append(command)
                if "id" in command:
                    reply = {"id": command["id"], "ok": True, "data": {"fw": "pty-2.0"}}
                    os.write(self.master, (json.dumps(reply, separators=(",", ":")) + "\n").encode())

    def wait_for(self, predicate: Callable[[list[dict[str, Any]]], bool], timeout: float = 3.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate(self.received):
                return True
            time.sleep(0.005)
        return False

    def close(self) -> None:
        self._stop.set()
        for fd in (self.master, self._slave):
            try:
                os.close(fd)
            except OSError:
                pass
        self._thread.join(timeout=1)


@dataclass
class FakeBoard:
    """板侧适配的最小替身。

    ``fail_hello`` / ``fail_stop`` 用来验证「失败必须显式」这条纪律；
    ``calls`` 记录被下发的 op，供断言「没有盲目重发运动指令」。
    """

    kind: str = "sim"
    fail_hello: bool = False
    fail_stop: bool = False
    firmware: str = "sim-2.1"
    calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    closed: bool = False

    def request(self, op: str, args: dict[str, Any] | None = None, timeout_ms: int = 500) -> Any:
        self.calls.append((op, dict(args or {})))
        if op == "hello":
            if self.fail_hello:
                raise TimeoutError("hello timeout")
            return {"fw": self.firmware, "proto": 2, "caps": ["move", "stop"]}
        raise AssertionError(f"测试替身没实现 op={op}")

    def notify(self, op: str, args: dict[str, Any] | None = None) -> None:
        self.calls.append((op, dict(args or {})))
        if op == "stop" and self.fail_stop:
            raise OSError("write failed")

    def close(self) -> None:
        self.closed = True
