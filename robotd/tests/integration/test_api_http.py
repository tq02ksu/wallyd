"""HTTP 传输层集成测试（R09）。

原则：**不 mock 掉被测层**。这里起一个真的 ``ThreadingHTTPServer`` 绑在随机回环端口上，
用真的 ``http.client`` / ``socket`` 发请求，断言契约要求的形状与状态码。
这样「路由存在但返回错形状」这类问题才会被抓到。

仿真板随每个 App 一起装配（``attach_sim_board``），因此不依赖硬件。
"""

from __future__ import annotations

import http.client
import json
import socket
import threading
from typing import Any

import pytest

from robotd.api.http import (
    DEBUG_OPERATION_IDS,
    MAX_BODY_BYTES,
    PUBLIC_OPERATION_IDS,
    build_routes,
    serve,
)
from robotd.app import App
from robotd.config import Config
from robotd.devices.sim import SimBoard, SimFault


@pytest.fixture()
def live():
    """启动一个真实服务，产出 ``(app, port)``。

    工作目录用项目内路径而非 ``tmp_path``：部分沙箱/受限环境会拦截系统临时目录的 mkdir，
    而 robotd 的 Store 只需要一个可写目录，放在 ``work/test-run`` 下同样干净且可被 gitignore。
    """
    from pathlib import Path

    work = Path(__file__).resolve().parents[2] / "work" / "pytest-live"
    work.mkdir(parents=True, exist_ok=True)
    config = Config(sim=True, http_port=0, debug=True, work_dir=str(work))
    app = App(config)
    app.attach_sim_board(SimBoard())
    app.start()
    server = serve(app, bind="127.0.0.1", port=0, debug=True)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield app, port
    finally:
        server.shutdown()
        server.server_close()
        app.shutdown()
        thread.join(timeout=3)


def call(port: int, method: str, path: str, body: Any = None, headers: dict[str, str] | None = None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    payload = None if body is None else json.dumps(body).encode()
    hdrs = {"content-type": "application/json"} if payload is not None else {}
    hdrs.update(headers or {})
    conn.request(method, path, body=payload, headers=hdrs)
    resp = conn.getresponse()
    raw = resp.read()
    conn.close()
    parsed = None
    if raw:
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = {"__raw__": raw[:200].decode("utf-8", "replace")}
    return resp.status, parsed, dict(resp.getheaders())


# --------------------------------------------------------------------- 路由契约
def test_routes_match_contract_operations():
    """路由表必须与 contracts/openapi.yaml 的 operationId 集合一致。"""
    import yaml
    from pathlib import Path

    root = Path(__file__).resolve().parents[3]
    spec = yaml.safe_load((root / "contracts" / "openapi.yaml").read_text())
    declared: set[str] = set()
    for _path, item in spec["paths"].items():
        for method in ("get", "post", "delete", "put", "patch"):
            op = item.get(method)
            if op and op.get("operationId"):
                declared.add(op["operationId"])
    declared.discard("events_subscribe")  # WS 升级用 GET，但由独立 handler 承接
    assert declared == set(PUBLIC_OPERATION_IDS) | set(DEBUG_OPERATION_IDS), (
        f"契约多出 {declared - (set(PUBLIC_OPERATION_IDS) | set(DEBUG_OPERATION_IDS))}；"
        f"代码多出 {(set(PUBLIC_OPERATION_IDS) | set(DEBUG_OPERATION_IDS)) - declared}"
    )


def test_public_routes_never_include_debug():
    assert not any(op.startswith("debug_") for op in PUBLIC_OPERATION_IDS)
    assert all(op.startswith("debug_") for op in DEBUG_OPERATION_IDS)


def test_debug_routes_absent_without_flag():
    public = build_routes(debug=False)
    assert not any(r.template.startswith("/v1/debug") for r in public)


# --------------------------------------------------------------------- 基本端点
def test_health_and_state_shape(live):
    _app, port = live
    status, health, _ = call(port, "GET", "/v1/health")
    assert status == 200
    assert health["ok"] is True and health["service"] == "robotd"
    assert health["esp32"] == "ready", "仿真板握手后 esp32 必须是 ready，不能停在 starting"

    status, state, _ = call(port, "GET", "/v1/robot/state")
    assert status == 200
    for key in ("robot_id", "mode", "pose", "devices", "battery", "event_seq"):
        assert key in state
    assert state["battery"]["percent"] is None, "无 BMS 时不得估算电量"
    assert state["odometry"]["left_actual_encoder"] is None, "无编码器时不得冒充实走位移"


def test_stop_is_idempotent_and_requires_no_approval(live):
    app, port = live
    for _ in range(3):
        status, body, _ = call(port, "POST", "/v1/robot/stop", {})
        assert status == 200, body
        assert body["stopped"] is True
    assert app.state.mode.value in {"idle", "degraded"}


def test_unimplemented_capability_returns_503_with_reason(live):
    _app, port = live
    status, body, _ = call(port, "POST", "/v1/robot/follow", {"target": "穿红衣服的人"})
    assert status == 503, "未实现能力必须 503，不能 200 假装受理"
    assert body["error"]["code"] == "E_UNAVAILABLE"
    assert body["error"]["details"]["capability"] == "robot.follow"


def test_unknown_field_rejected(live):
    _app, port = live
    status, body, _ = call(port, "POST", "/v1/robot/stop", {"reason": "stop", "save_power": True})
    assert status == 400
    assert body["error"]["code"] == "E_VALIDATION"
    assert "save_power" in body["error"]["message"]


def test_404_vs_405_semantics(live):
    _app, port = live
    status, body, _ = call(port, "GET", "/v1/nope")
    assert status == 404 and body["error"]["code"] == "E_NOT_FOUND"

    # 路径存在但方法不对：仍是 404（契约没有 405），但消息要说清是方法不对
    status, body, _ = call(port, "POST", "/v1/health", {})
    assert status == 404
    assert "POST" in body["error"]["message"]


def test_body_size_limit(live):
    _app, port = live
    huge = {"text": "x" * (MAX_BODY_BYTES + 100)}
    status, body, _ = call(port, "POST", "/v1/robot/speak", huge)
    assert status == 400
    assert body["error"]["code"] == "E_VALIDATION"


def test_non_json_body_rejected(live):
    _app, port = live
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request("POST", "/v1/robot/stop", body=b"not json", headers={"content-type": "application/json"})
    resp = conn.getresponse()
    body = json.loads(resp.read())
    conn.close()
    assert resp.status == 400 and body["error"]["code"] == "E_VALIDATION"


def test_non_loopback_host_rejected(live):
    _app, port = live
    status, body, _ = call(port, "GET", "/v1/health", headers={"Host": "evil.example.com"})
    assert status == 400
    assert body["error"]["code"] == "E_VALIDATION"
    assert "回环" in body["error"]["message"]


def test_no_wildcard_cors(live):
    _app, port = live
    _status, _body, headers = call(port, "GET", "/v1/health")
    assert "access-control-allow-origin" not in {k.lower() for k in headers}


def test_options_not_allowed(live):
    _app, port = live
    status, _body, _ = call(port, "OPTIONS", "/v1/health")
    assert status == 404


# --------------------------------------------------------------------- 任务生命周期
def test_task_get_and_cancel(live):
    app, port = live
    task = app.kernel.new_task(
        "robot.follow", __import__("robotd.core.types", fromlist=["Exclusivity"]).Exclusivity.MOTION
    )
    status, body, _ = call(port, "GET", f"/v1/tasks/{task.task_id}")
    assert status == 200 and body["task_id"] == task.task_id

    status, body, _ = call(port, "DELETE", f"/v1/tasks/{task.task_id}")
    assert status == 200
    assert body["state"] == "cancelled"

    # 再取消一次：终态不可回转，返回原终态而不是报错
    status, body, _ = call(port, "DELETE", f"/v1/tasks/{task.task_id}")
    assert status == 200 and body["state"] == "cancelled"

    status, body, _ = call(port, "GET", "/v1/tasks/nope")
    assert status == 404 and body["error"]["code"] == "E_NO_TASK"


def test_task_list_filter(live):
    app, port = live
    from robotd.core.types import Exclusivity

    t = app.kernel.new_task("speech.listen", Exclusivity.SOFT)
    status, body, _ = call(port, "GET", "/v1/tasks?state=accepted")
    assert status == 200
    assert any(x["task_id"] == t.task_id for x in body["tasks"])


# --------------------------------------------------------------------- 板侧故障
def test_board_lost_makes_state_degraded_and_stop_reports_no_ack(live):
    app, port = live
    board = app.board
    assert isinstance(board, SimBoard)
    board.inject_fault(SimFault.LOST)
    status, state, _ = call(port, "GET", "/v1/robot/state")
    assert status == 200
    assert state["devices"]["esp32"] == "lost"
    assert state["mode"] == "degraded", "链路断开必须是 degraded，不看有没有任务"

    status, body, _ = call(port, "POST", "/v1/robot/stop", {})
    # 契约：未收到板侧应答报 504，不返回 200
    assert status == 504, body
    assert body["error"]["code"] == "E_TIMEOUT"


def test_board_reset_invalidates_pose(live):
    app, port = live
    board = app.board
    assert isinstance(board, SimBoard)
    board.sim_reset()
    _status, state, _ = call(port, "GET", "/v1/robot/state")
    assert state["pose"]["valid"] is False, "板复位后位姿必须作废"
    assert state["odometry"]["left_commanded"] == 0


def test_debug_serial_available_with_flag(live):
    _app, port = live
    status, body, _ = call(port, "POST", "/v1/debug/serial", {"op": "ping"})
    assert status == 200
    assert body["result"]["pong"] is True


def test_debug_serial_rejects_bad_op(live):
    _app, port = live
    status, body, _ = call(port, "POST", "/v1/debug/serial", {"op": "rm -rf /"})
    assert status == 400 and body["error"]["code"] == "E_VALIDATION"


# --------------------------------------------------------------------- WS 辅助
def ws_connect(port: int, path: str = "/v1/events"):
    s = socket.create_connection(("127.0.0.1", port), timeout=5)
    import base64
    import os

    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall(
        (
            f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        ).encode()
    )
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = s.recv(65536)
        if not chunk:
            raise AssertionError("握手期间连接被关闭")
        buf += chunk
    head, rest = buf.split(b"\r\n\r\n", 1)
    return s, head.decode(), rest


def ws_send(s: socket.socket, obj: Any) -> None:
    import os
    import struct

    data = json.dumps(obj).encode()
    mask = os.urandom(4)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    if len(data) < 126:
        header = struct.pack("!BB", 0x81, 0x80 | len(data))
    elif len(data) < (1 << 16):
        header = struct.pack("!BBH", 0x81, 0x80 | 126, len(data))
    else:
        header = struct.pack("!BBQ", 0x81, 0x80 | 127, len(data))
    s.sendall(header + mask + masked)


class WsReader:
    def __init__(self, sock: socket.socket, rest: bytes = b"") -> None:
        self.sock = sock
        self.buf = rest

    def _need(self, n: int) -> bytes:
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise EOFError("连接已关闭")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def read(self) -> dict[str, Any]:
        import struct

        head = self._need(2)
        length = head[1] & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._need(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._need(8))[0]
        return json.loads(self._need(length).decode("utf-8"))


# --------------------------------------------------------------------- WS 语义
def test_ws_handshake_headers(live):
    _app, port = live
    sock, head, _rest = ws_connect(port)
    try:
        lines = head.splitlines()
        assert lines[0].startswith("HTTP/1.1 101")
        assert sum(1 for ln in lines if ln.lower().startswith("connection:")) == 1, (
            "Connection 头只能出现一次"
        )
        assert any(ln.lower().startswith("sec-websocket-accept:") for ln in lines)
    finally:
        sock.close()


def test_ws_hello_then_subscribe_order(live):
    app, port = live
    sock, head, rest = ws_connect(port)
    reader = WsReader(sock, rest)
    try:
        hello = reader.read()
        assert hello["type"] == "hello"
        assert hello["instance_id"] == app.instance_id

        ws_send(sock, {"type": "subscribe", "types": ["*"]})
        accepted = reader.read()
        assert accepted["type"] == "subscription.accepted", (
            f"subscribe 后第一条必须是 accepted，实际 {accepted['type']}（实时事件插队）"
        )
        assert accepted["filters"] == ["*"]
        snapshot = reader.read()
        assert snapshot["type"] == "state.snapshot"
        assert "event_seq" in snapshot["state"]
    finally:
        sock.close()


def test_ws_receives_live_events(live):
    _app, port = live
    sock, _head, rest = ws_connect(port, "/v1/events?types=*")
    reader = WsReader(sock, rest)
    try:
        assert reader.read()["type"] == "hello"
        assert reader.read()["type"] == "subscription.accepted"
        assert reader.read()["type"] == "state.snapshot"
        call(port, "POST", "/v1/robot/stop", {})
        ev = reader.read()
        assert ev["type"] == "event"
        assert ev["event"]["type"] == "safety.stopped"
        assert ev["event"]["version"] == 1
        assert "mono_ns" not in ev["event"], "内部单调时钟不得外泄"
    finally:
        sock.close()


def test_ws_cursor_beyond_last_seq_requires_resync(live):
    _app, port = live
    sock, _head, rest = ws_connect(port, "/v1/events?types=*&resume_from_seq=99999")
    reader = WsReader(sock, rest)
    try:
        assert reader.read()["type"] == "hello"
        msg = reader.read()
        assert msg["type"] == "resync_required"
        assert msg["reason"] == "invalid_cursor"
    finally:
        sock.close()


def test_ws_instance_change_requires_resync(live):
    _app, port = live
    sock, _head, rest = ws_connect(port, "/v1/events?types=*&resume_from_seq=0&instance_id=WRONG")
    reader = WsReader(sock, rest)
    try:
        assert reader.read()["type"] == "hello"
        msg = reader.read()
        assert msg["type"] == "resync_required"
        assert msg["reason"] == "instance_changed"
    finally:
        sock.close()


def test_ws_plain_get_without_upgrade_is_explicit_error(live):
    _app, port = live
    status, body, _ = call(port, "GET", "/v1/events")
    assert status == 400
    assert body["error"]["code"] == "E_VALIDATION"
    assert "WebSocket" in body["error"]["message"]


def test_ws_unmasked_frame_closes(live):
    """RFC 6455：客户端帧必须带掩码。不带就断开，不「宽容处理」。

    服务端会回一个 close 帧（opcode 0x8）再断开。这里只看「连接被关闭或收到 close」，
    不去解析 close 帧的 JSON——它本来就不是 JSON。
    """
    import struct

    _app, port = live
    sock, _head, rest = ws_connect(port)
    try:
        reader = WsReader(sock, rest)
        reader.read()  # hello
        payload = json.dumps({"type": "subscribe"}).encode()
        sock.sendall(struct.pack("!BB", 0x81, len(payload)) + payload)  # 无掩码位
        sock.settimeout(3)
        closed = False
        for _ in range(4):
            head = sock.recv(2)
            if not head:
                closed = True
                break
            if head[0] & 0x0F == 0x8:  # close 帧
                closed = True
                break
        assert closed, "未掩码的客户端帧必须导致连接关闭"
    finally:
        sock.close()


def test_ws_bad_handshake_rejected(live):
    _app, port = live
    s = socket.create_connection(("127.0.0.1", port), timeout=5)
    try:
        s.sendall(
            b"GET /v1/events HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n"
            b"Connection: Upgrade\r\nSec-WebSocket-Version: 8\r\nSec-WebSocket-Key: abc\r\n\r\n"
        )
        data = s.recv(4096)
        assert b"400" in data.split(b"\r\n")[0]
    finally:
        s.close()
