"""最小 WebSocket 服务端实现（RFC 6455 子集，纯标准库）。

为什么自己写而不是装 ```websockets```：

- robotd 的运行期依赖**刻意为零**（见 ``pyproject.toml``）。仿真机与被测机不一定能装包。
- 本项目只需要「文本帧 + ping/pong + close」这一小块；不涉及扩展、分片重组的二进制流。

支持的语义（够用且不偷工减料）：

- 握手：校验 ``Upgrade`` / ``Connection`` / ``Sec-WebSocket-Version: 13`` / ``Sec-WebSocket-Key``；
  **回 101 并带上 Sec-WebSocket-Accept**，不匹配就回 400。
- 客户端帧**必须带掩码**（RFC 要求），否则断开——这不是可选项。
- 分片：支持 continuation 帧拼装文本消息；控制帧不得分片。
- 控制帧：ping → 自动 pong；close → 回 close 并关闭。
- 发送：单条消息一个帧（不拆），带发送锁；``send_timeout`` 超时即视为慢客户端并断开，
  由调用方摘除订阅。
"""

from __future__ import annotations

import base64
import hashlib
import logging
import socket
import struct
import threading
import time
from dataclasses import dataclass

log = logging.getLogger("robotd.api.ws")

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
OP_CONT = 0x0
OP_TEXT = 0x1
OP_BINARY = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA


class WsProtocolError(Exception):
    """握手或帧格式不合规。调用方应直接断开连接，不尝试「修复」。"""


@dataclass(frozen=True)
class Handshake:
    key: str
    path: str
    headers: dict[str, str]


def compute_accept(key: str) -> str:
    digest = hashlib.sha1((key + GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def parse_handshake(headers: dict[str, str], path: str) -> Handshake:
    """从已解析的请求头判定是否为合法 WS 升级请求。"""
    upgrade = headers.get("upgrade", "").lower()
    connection = headers.get("connection", "").lower()
    version = headers.get("sec-websocket-version", "")
    key = headers.get("sec-websocket-key", "").strip()
    if upgrade != "websocket":
        raise WsProtocolError("缺少 Upgrade: websocket")
    if "upgrade" not in [t.strip() for t in connection.split(",")]:
        raise WsProtocolError("缺少 Connection: Upgrade")
    if version != "13":
        raise WsProtocolError(f"不支持的 WebSocket 版本 {version!r}（只支持 13）")
    if not key:
        raise WsProtocolError("缺少 Sec-WebSocket-Key")
    try:
        raw = base64.b64decode(key, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise WsProtocolError("Sec-WebSocket-Key 不是合法 base64") from exc
    if len(raw) != 16:
        raise WsProtocolError("Sec-WebSocket-Key 解码后必须为 16 字节")
    return Handshake(key=key, path=path, headers=headers)


def handshake_response(key: str, *, extra_headers: dict[str, str] | None = None) -> bytes:
    lines = [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        f"Sec-WebSocket-Accept: {compute_accept(key)}",
    ]
    for k, v in (extra_headers or {}).items():
        lines.append(f"{k}: {v}")
    return ("\r\n".join(lines) + "\r\n\r\n").encode("ascii")


def _frame_header(opcode: int, length: int, *, fin: bool = True) -> bytes:
    b0 = (0x80 if fin else 0x00) | (opcode & 0x0F)
    if length < 126:
        return struct.pack("!BB", b0, length)
    if length < (1 << 16):
        return struct.pack("!BBH", b0, 126, length)
    return struct.pack("!BBQ", b0, 127, length)


class WebSocket:
    """一条已升级的连接。**非线程安全的部分已用锁保护**：``send_text`` 可被多线程调用。"""

    def __init__(self, sock: socket.socket, *, max_message_bytes: int = 1 << 20) -> None:
        self.sock = sock
        self.sock.settimeout(None)
        self._send_lock = threading.Lock()
        self._closed = False
        self._max_message_bytes = max_message_bytes

    # ------------------------------------------------------------ 发送
    def send_text(self, text: str, *, timeout_s: float | None = 5.0) -> None:
        self._send_frame(OP_TEXT, text.encode("utf-8"), timeout_s=timeout_s)

    def send_pong(self, payload: bytes = b"") -> None:
        self._send_frame(OP_PONG, payload, timeout_s=2.0)

    def close(self, code: int = 1000, reason: str = "") -> None:
        if self._closed:
            return
        body = struct.pack("!H", code) + reason.encode("utf-8")[:120]
        try:
            self._send_frame(OP_CLOSE, body, timeout_s=1.0)
        except Exception:  # noqa: BLE001 - 关闭路径不再抛
            pass
        self._closed = True
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass

    def _send_frame(self, opcode: int, payload: bytes, *, timeout_s: float | None) -> None:
        if self._closed:
            return
        data = _frame_header(opcode, len(payload)) + payload
        with self._send_lock:
            old = self.sock.gettimeout()
            try:
                if timeout_s is not None:
                    self.sock.settimeout(timeout_s)
                self.sock.sendall(data)
            except (socket.timeout, TimeoutError) as exc:
                self._closed = True
                raise WsProtocolError("发送超时（慢客户端）") from exc
            except OSError as exc:
                self._closed = True
                raise WsProtocolError(f"发送失败：{exc}") from exc
            finally:
                try:
                    self.sock.settimeout(old)
                except OSError:
                    pass

    # ------------------------------------------------------------ 接收
    def recv_message(self) -> str | None:
        """阻塞读一条完整文本消息。对端关闭 / 协议错误返回 ``None``。

        内部循环处理分片与 ping；只把**完整文本消息**交给调用方。
        """
        buf = bytearray()
        opcode_of_message: int | None = None
        while True:
            head = self._recv_exact(2)
            if head is None:
                return None
            b0, b1 = head[0], head[1]
            fin = bool(b0 & 0x80)
            opcode = b0 & 0x0F
            masked = bool(b1 & 0x80)
            length = b1 & 0x7F
            if length == 126:
                ext = self._recv_exact(2)
                if ext is None:
                    return None
                length = struct.unpack("!H", ext)[0]
            elif length == 127:
                ext = self._recv_exact(8)
                if ext is None:
                    return None
                length = struct.unpack("!Q", ext)[0]

            if not masked:
                log.warning("客户端帧未带掩码，按 RFC 断开")
                self.close(1002, "client frames must be masked")
                return None
            mask = self._recv_exact(4)
            if mask is None:
                return None
            payload = self._recv_exact(length) if length else b""
            if payload is None:
                return None
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload)) if length else b""

            if opcode == OP_CLOSE:
                self.close(1000, "")
                return None
            if opcode == OP_PING:
                try:
                    self.send_pong(payload)
                except WsProtocolError:
                    return None
                continue
            if opcode == OP_PONG:
                continue
            if opcode in (OP_TEXT, OP_BINARY):
                if opcode_of_message is not None:
                    log.warning("分片未完成又收到新消息，断开")
                    self.close(1002, "new message before continuation")
                    return None
                opcode_of_message = opcode
                buf.extend(payload)
            elif opcode == OP_CONT:
                if opcode_of_message is None:
                    log.warning("收到孤立 continuation 帧，断开")
                    self.close(1002, "unexpected continuation")
                    return None
                buf.extend(payload)
            else:
                log.warning("未知 opcode %s，断开", opcode)
                self.close(1002, f"unknown opcode {opcode}")
                return None

            if len(buf) > self._max_message_bytes:
                self.close(1009, "message too big")
                return None

            if fin:
                if opcode_of_message == OP_BINARY:
                    # 本项目只用文本帧；二进制消息不静默丢弃，明确拒绝
                    self.close(1003, "binary frames not supported")
                    return None
                try:
                    return buf.decode("utf-8")
                except UnicodeDecodeError:
                    self.close(1007, "invalid utf-8")
                    return None
                finally:
                    buf.clear()
                    opcode_of_message = None

    def _recv_exact(self, n: int) -> bytes | None:
        chunks = bytearray()
        while len(chunks) < n:
            try:
                part = self.sock.recv(n - len(chunks))
            except (socket.timeout, TimeoutError):
                continue
            except OSError:
                return None
            if not part:
                return None
            chunks.extend(part)
        return bytes(chunks)


def pump_idle_wait(seconds: float) -> None:
    """给测试用的小工具：等待，但可被更短的超时打断。"""
    time.sleep(seconds)
