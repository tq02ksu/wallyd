"""GH-74 判据 2/3 的连续证据：HTTP（agentd 的请求形状）→ robotd → 真实串口字节。

agentd 侧「句子 → 请求体」由 ``agentd/tests/unit/move-chain.mjs`` 断言；这里接着证明
同一个请求体经审批门进入 robotd 后，真的以契约字节写进串口设备（POSIX pty 扮演板子）。

需要回环 bind；受限沙箱会以 EPERM 拒绝，此时 skip（CI 会真跑）。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import http.client
import json
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest

from robotd.api.http import serve
from robotd.app import App
from robotd.approval import CREDENTIAL_HEADER
from robotd.approval import enforce_approval
from robotd.approval_digest import approval_args_digest
from robotd.config import Config
from robotd.core.errors import ErrorCode, RobotdError
from robotd.devices.serial import SerialBoard
from tests.helpers import PseudoBoard

pytest.importorskip("serial")
pytestmark = pytest.mark.skipif(not hasattr(os, "openpty"), reason="需要 POSIX pty")

MOVE_PARAMS = ("distance_mm", "speed_mm_s")
MOVE_ARGS = {"distance_mm": 300, "speed_mm_s": 150}


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def mint_credential(secret_hex: str, capability: str, args: dict[str, Any], params: tuple[str, ...]) -> str:
    now = time.time()
    payload = {
        "issuer": "agentd",
        "capability": capability,
        "args_digest": approval_args_digest(args, list(params)),
        "issued_at": _iso(now),
        "expires_at": _iso(now + 60),
        "nonce": uuid.uuid4().hex,
    }
    segment = _b64url(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode())
    signature = hmac.new(bytes.fromhex(secret_hex), segment.encode("ascii"), hashlib.sha256).digest()
    return f"{segment}.{_b64url(signature)}"


class Call:
    def __init__(self, port: int) -> None:
        self.port = port

    def post(self, path: str, body: dict[str, Any], credential: str | None = None) -> tuple[int, Any]:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"content-type": "application/json"}
        if credential:
            headers[CREDENTIAL_HEADER] = credential
        conn.request("POST", path, body=json.dumps(body).encode(), headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
        conn.close()
        return resp.status, json.loads(raw) if raw else None


@pytest.fixture()
def serial_server(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    secret = _write_key(tmp_path, monkeypatch)

    board_side = PseudoBoard()
    config = Config(sim=False, serial_port=board_side.path, http_port=0, work_dir=str(tmp_path / "work"))
    app = App(config)
    app.attach_board(SerialBoard(board_side.path, config.serial_baud, timeout_s=0.05))
    app.start()
    try:
        server = serve(app, bind="127.0.0.1", port=0)
    except (PermissionError, OSError) as exc:  # 沙箱禁止回环 bind
        app.shutdown()
        board_side.close()
        pytest.skip(f"环境不允许回环 bind：{exc}")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield Call(server.server_address[1]), board_side, secret
    finally:
        server.shutdown()
        server.server_close()
        app.shutdown()
        board_side.close()
        thread.join(timeout=3)


def _write_key(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    monkeypatch.setenv("WALLY_APP_DATA_DIR", str(tmp_path / "appdata"))
    secret = uuid.uuid4().hex * 2
    key_path = tmp_path / "appdata" / "robot" / "agentd" / "approval-signing-key"
    key_path.parent.mkdir(parents=True)
    key_path.write_text(secret + "\n", encoding="utf-8")
    return secret


def test_minted_credential_binds_the_contract_params(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """不需要 socket：证明 agentd 形状的凭据与 robot_move 的审批参数完全对齐。"""
    secret = _write_key(tmp_path, monkeypatch)
    work_dir = tmp_path / "work"
    enforce_approval(
        header_value=mint_credential(secret, "robot_move", MOVE_ARGS, MOVE_PARAMS),
        capability="robot_move",
        approval_params=MOVE_PARAMS,
        body=MOVE_ARGS,
        work_dir=work_dir,
    )
    with pytest.raises(RobotdError) as ei:
        enforce_approval(
            header_value=mint_credential(secret, "robot_move", MOVE_ARGS, MOVE_PARAMS),
            capability="robot_move",
            approval_params=MOVE_PARAMS,
            body={"distance_mm": 301, "speed_mm_s": 150},
            work_dir=work_dir,
        )
    assert ei.value.code is ErrorCode.APPROVAL
    assert ei.value.details["reason"] == "args_digest_mismatch"


def test_move_needs_approval_then_writes_contract_frame(serial_server):
    call, board_side, secret = serial_server

    status, body = call.post("/v1/robot/move", MOVE_ARGS)
    assert status == 403, (status, body)
    assert body["error"]["code"] == "E_APPROVAL"
    assert not any(cmd.get("op") == "move" for cmd in board_side.received)

    credential = mint_credential(secret, "robot_move", MOVE_ARGS, MOVE_PARAMS)
    status, body = call.post("/v1/robot/move", MOVE_ARGS, credential)
    assert status == 200, (status, body)
    assert body["dispatched"] is True
    # 状态字段只承诺「已写出」，不承诺到位（契约 MoveAccepted）。
    assert body["board_ack"] is True

    assert board_side.wait_for(lambda cmds: any(cmd.get("op") == "move" for cmd in cmds))
    move = next(cmd for cmd in board_side.received if cmd.get("op") == "move")
    # 判据 2：串口侧收到的就是契约帧（300mm / 150mm·s⁻¹ → 0.3m / 0.15m·s⁻¹）
    assert move == {
        "id": 2,
        "op": "move",
        "args": {"left": 0.3, "right": 0.3, "speed": 0.15},
    }, move


def test_stop_frame_is_idless_and_is_the_last_write(serial_server):
    call, board_side, _secret = serial_server
    status, body = call.post("/v1/robot/stop", {"cause": "user_voice"})
    assert status == 200, (status, body)
    assert board_side.wait_for(lambda cmds: any(cmd.get("op") == "stop" for cmd in cmds))
    stop = next(cmd for cmd in board_side.received if cmd.get("op") == "stop")
    assert stop == {"op": "stop"}, stop
    assert "id" not in stop
    # 判据 3：停止后不再有新帧
    count = len(board_side.received)
    time.sleep(0.2)
    assert len(board_side.received) == count, board_side.received[count:]
