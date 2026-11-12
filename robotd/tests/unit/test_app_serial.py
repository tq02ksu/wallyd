"""GH-74：串口装配、``robot_move`` 下发与「打开失败不谎报就绪」。

全离线：板侧是 ``FakeSerial``，断言 host 写出的字节与健康/事件事实。
"""

from __future__ import annotations

import json
import time

import pytest

from robotd.app import App
from robotd.config import Config
from robotd.core.errors import ErrorCode, RobotdError
from robotd.core.types import DeviceStatus
from tests.helpers import FakeClock, fake_serial_board


def serial_app(**kwargs) -> App:
    return App(Config(sim=False, serial_port="/dev/fake-serial"), clock=FakeClock(), **kwargs)


def frames(fake) -> list[dict]:
    return [json.loads(raw) for raw in fake.writes]


# ---------------------------------------------------------------- 打开成功
def test_start_handshakes_and_reports_ready():
    app = serial_app()
    board, fake = fake_serial_board({"hello": {"ok": True, "data": {"fw": "serial-2.0", "proto": 2}}})
    app.attach_board(board)
    app.start()
    try:
        assert app.snapshot()["devices"]["esp32"] == "ready"
        assert app.snapshot()["firmware"] == "serial-2.0"
        assert frames(fake)[0]["op"] == "hello"
        assert app.health()["transport"] == "serial"
        assert app.health()["device_error"] is None
    finally:
        app.shutdown()


def test_move_converts_mm_to_meters_and_writes_one_frame():
    app = serial_app()
    board, fake = fake_serial_board()
    app.attach_board(board)
    app.start()
    try:
        result = app.move(300, 150)
        assert result == {
            "ok": True,
            "dispatched": True,
            "distance_mm": 300.0,
            "speed_mm_s": 150.0,
            "board_ack": True,
        }
        # 判据 2：串口侧收到的字节（「往前走 30 厘米」= 300mm/150mm/s）
        assert fake.writes[-1] == (b'{"id":2,"op":"move","args":{"left":0.3,"right":0.3,"speed":0.15}}\n')
    finally:
        app.shutdown()


def test_move_is_refused_when_link_is_not_ready():
    app = serial_app()
    board, fake = fake_serial_board({"hello": {"ok": True, "data": {"fw": "x"}}})
    app.attach_board(board)
    app.start()
    app.state._apply_link(DeviceStatus.LOST)
    try:
        with pytest.raises(RobotdError) as ei:
            app.move(300, 150)
        assert ei.value.code is ErrorCode.LINK
        assert not any(frame["op"] == "move" for frame in frames(fake))
    finally:
        app.shutdown()


def test_stop_writes_stop_frame_and_cancels_nothing_else():
    app = serial_app()
    board, fake = fake_serial_board()
    app.attach_board(board)
    app.start()
    try:
        app.move(100, 150)
        result = app.request_stop(cause="user_stop_api")
        assert result["board_ack"] is True
        assert fake.writes[-1] == b'{"op":"stop"}\n'
        assert app.kernel.recent_events(5)[-1].type == "safety.stop_requested"
    finally:
        app.shutdown()


# ---------------------------------------------------------------- 打开失败（判据 1）
def test_open_failure_is_visible_and_no_frame_is_written():
    app = serial_app()
    app.mark_board_unavailable("串口打不开（/dev/fake-serial）：设备不存在")
    app.start()
    try:
        health = app.health()
        assert health["esp32"] == "error"
        assert "设备不存在" in health["device_error"]
        snap = app.snapshot()
        assert snap["devices"]["esp32"] == "error"
        assert snap["mode"] == "degraded"
        changed = [e for e in app.kernel.recent_events(10) if e.type == "device.changed"]
        assert changed and changed[-1].payload["reason"].startswith("串口打不开")

        with pytest.raises(RobotdError) as ei:
            app.move(300, 150)
        assert ei.value.code is ErrorCode.UNAVAILABLE
        assert "设备不存在" in ei.value.message
    finally:
        app.shutdown()


# ---------------------------------------------------------------- 断链
def test_device_lost_reports_unknown_stop_with_device_lost_cause():
    app = serial_app()
    board, fake = fake_serial_board()
    app.attach_board(board)
    app.start()
    try:
        fake.read_error = OSError("unplugged")
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            lost = [e for e in app.kernel.recent_events(20) if e.type == "safety.stop_requested"]
            if lost:
                break
            time.sleep(0.005)
        lost = [e for e in app.kernel.recent_events(20) if e.type == "safety.stop_requested"]
        assert lost, "断链后必须发出 safety.stop_requested"
        assert lost[-1].payload["cause"] == "device_lost"
        assert lost[-1].payload["state"] == "unknown"
        assert app.snapshot()["devices"]["esp32"] == "lost"
    finally:
        app.shutdown()
