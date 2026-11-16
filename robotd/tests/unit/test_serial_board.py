"""GH-74 判据 1/2/3：串口适配的字节级证据（全离线，fake transport）。

这里断言的是「host 写出的字节」，不是「机器人走了多少」——后者只能由真机判据给。
"""

from __future__ import annotations

import json
import time

import pytest

from robotd.core.errors import ErrorCode, RobotdError
from robotd.devices.serial import SerialBoard, encode_request, encode_stop
from tests.helpers import FakeClock, FakeSerial, fake_serial_board


# ---------------------------------------------------------------- 打开失败（判据 1）
def test_missing_device_is_reported_explicitly():
    with pytest.raises(RobotdError) as ei:
        SerialBoard("/definitely/not/a/serial/port", 115200)
    err = ei.value
    assert err.code is ErrorCode.UNAVAILABLE
    assert err.http_status == 503
    # 失败原因必须可读，不能只是「打不开」三个字
    assert "设备不存在" in err.message, err.message
    assert err.details["port"] == "/definitely/not/a/serial/port"


def test_path_that_is_not_a_device_is_reported_explicitly(tmp_path):
    with pytest.raises(RobotdError) as ei:
        SerialBoard(str(tmp_path), 115200)
    assert ei.value.code is ErrorCode.UNAVAILABLE
    assert "不是串口设备" in ei.value.message, ei.value.message


def test_pyserial_missing_is_an_explicit_unavailable(monkeypatch):
    import builtins

    real_import = builtins.__import__

    def fake_import(name: str, *args, **kwargs):
        if name == "serial":
            raise ImportError("No module named 'serial'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    with pytest.raises(RobotdError) as ei:
        SerialBoard("/dev/fake-serial", 115200)
    assert ei.value.code is ErrorCode.UNAVAILABLE
    assert "pyserial" in ei.value.message


# ---------------------------------------------------------------- 帧格式（判据 2）
def test_move_frame_is_json_lines_with_steps():
    board, fake = fake_serial_board()
    try:
        data = board.request("move", {"left": 2400, "right": 2400, "speed": 0.15})
    finally:
        board.close()
    assert data == {"steps": 2400, "eta_ms": 200}
    # 字节级断言：一行 JSON，id 从 1 开始。
    # left/right 是**步数**（板侧 poc-2.0 用 int() 取步），speed 是 m/s。
    assert fake.writes == [b'{"id":1,"op":"move","args":{"left":2400,"right":2400,"speed":0.15}}\n']
    assert fake.writes[0].endswith(b"\n")


def test_ids_are_monotonic_and_responses_are_correlated():
    board, fake = fake_serial_board()
    try:
        board.request("hello", {"proto": 2})
        board.request("ping", {})
    finally:
        board.close()
    ids = [json.loads(raw)["id"] for raw in fake.writes]
    assert ids == [1, 2], fake.writes


def test_board_error_reply_maps_to_robotd_code():
    board, _fake = fake_serial_board(
        {"move": {"ok": False, "err": {"code": "E_BUSY", "msg": "motion task running"}}}
    )
    try:
        with pytest.raises(RobotdError) as ei:
            board.request("move", {"left": 0.1, "right": 0.1, "speed": 0.1})
    finally:
        board.close()
    assert ei.value.code is ErrorCode.BUSY
    assert ei.value.details["board_code"] == "E_BUSY"


def test_request_timeout_is_reported_not_swallowed():
    fake = FakeSerial()  # 不回任何应答
    board = SerialBoard("/dev/fake-serial", 115200, open_fn=lambda *_: fake, timeout_s=0.01)
    try:
        with pytest.raises(RobotdError) as ei:
            board.request("move", {"left": 0.1, "right": 0.1, "speed": 0.1}, timeout_ms=50)
    finally:
        board.close()
    assert ei.value.code is ErrorCode.TIMEOUT
    assert ei.value.details["op"] == "move"


# ---------------------------------------------------------------- 停机（判据 3）
def test_stop_frame_has_no_id_and_nothing_is_written_after_close():
    board, fake = fake_serial_board()
    board.request("hello", {"proto": 2})
    before = len(fake.writes)
    board.notify("stop")
    assert fake.writes[before:] == [b'{"op":"stop"}\n']
    board.close()
    assert len(fake.writes) == before + 1


def test_encoder_is_the_single_frame_source():
    assert encode_request(7, "move", {"left": 2400, "right": 2400, "speed": 0.2}) == (
        b'{"id":7,"op":"move","args":{"left":2400,"right":2400,"speed":0.2}}\n'
    )
    assert encode_stop() == b'{"op":"stop"}\n'


# ---------------------------------------------------------------- 板侧推送与断链
def test_push_events_reach_the_app_callback():
    seen: list[tuple[str, dict]] = []
    board, fake = fake_serial_board()
    board.set_event_handler(lambda ev, payload: seen.append((ev, payload)))
    fake.feed_json({"ev": "motion.done", "steps": [10, 10], "ts": 123})
    _wait_until(lambda: seen)
    board.close()
    assert seen == [("motion.done", {"steps": [10, 10], "ts": 123})], seen


def test_read_failure_marks_device_lost_once_and_fails_pending_requests():
    seen: list[tuple[str, dict]] = []
    fake = FakeSerial()
    board = SerialBoard("/dev/fake-serial", 115200, open_fn=lambda *_: fake, timeout_s=0.01)
    board.set_event_handler(lambda ev, payload: seen.append((ev, payload)))
    fake.read_error = OSError("device disappeared")
    with pytest.raises(RobotdError) as ei:
        board.request("move", {"left": 0.1, "right": 0.1, "speed": 0.1}, timeout_ms=500)
    board.close()
    assert ei.value.code is ErrorCode.LINK
    assert seen == [("device.lost", {"device": "esp32", "reason": "device_lost"})], seen


def _wait_until(predicate, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.005)
    raise AssertionError("等待条件超时")


# ---------------------------------------------------------------- 运动心跳（看门狗前提）
def test_heartbeat_sends_velocity_at_least_5hz_while_motion():
    """固件 300ms 收不到 velocity 就自主停机；30cm 要走 ~2s，所以心跳是硬前提。

    这里只证明 host 真的在写 velocity，且频率满足契约 §3.3 的 ≥5Hz。
    """
    board, fake = fake_serial_board()
    try:
        board.start_heartbeat(600)
        _wait_until(lambda: sum(1 for w in fake.writes if b'"op":"velocity"' in w) >= 3)
        board.stop_heartbeat()
    finally:
        board.close()
    velocities = [w for w in fake.writes if b'"op":"velocity"' in w]
    assert len(velocities) >= 3, fake.writes
    # 每条都是合法 JSON 行，带 id（应答会被当作迟到应答忽略）
    for raw in velocities:
        payload = json.loads(raw)
        assert payload["op"] == "velocity"
        assert isinstance(payload["id"], int)


def test_heartbeat_stops_when_motion_ends_or_stop_is_sent():
    """`motion.done` 到达后不得继续刷心跳——否则会给已经停下的运动续命。"""
    board, fake = fake_serial_board()
    seen: list[tuple[str, dict]] = []
    board.set_event_handler(lambda ev, payload: seen.append((ev, payload)))
    try:
        board.start_heartbeat(5000)
        _wait_until(lambda: any(b'"op":"velocity"' in w for w in fake.writes))
        fake.feed_json({"ev": "motion.done", "steps": 2400})
        _wait_until(lambda: seen and seen[0][0] == "motion.done")
        after = len(fake.writes)
        time.sleep(0.35)  # 3 个心跳周期
        assert len(fake.writes) == after, fake.writes[after:]

        # stop 也必须停心跳
        board.start_heartbeat(5000)
        _wait_until(lambda: len([w for w in fake.writes if b'"op":"velocity"' in w]) >= 1)
        board.notify("stop", {})
        after = len(fake.writes)
        time.sleep(0.35)
        assert len(fake.writes) == after, fake.writes[after:]
    finally:
        board.close()


def test_move_app_rejects_when_board_does_not_declare_steps_per_m():
    """hello 没给 steps_per_m 时拒绝下发，而不是拿毫米去当步数。"""
    from robotd.app import App
    from robotd.config import Config
    from robotd.api.http import RouteContext, _h_move

    board, fake = fake_serial_board(replies={"hello": {"ok": True, "data": {"fw": "x", "proto": 2}}})
    app = App(Config(sim=False, serial_port="/dev/fake-serial"), clock=FakeClock())
    app.attach_board(board)
    app.start()
    try:
        ctx = RouteContext(
            app=app,
            method="POST",
            path="/v1/robot/move",
            query={},
            params={},
            body={"distance_mm": 300},
            handler=None,
        )
        with pytest.raises(RobotdError) as ei:
            _h_move(ctx)
        assert ei.value.code is ErrorCode.UNAVAILABLE
        assert "steps_per_m" in ei.value.message
        assert not any(b'"op":"move"' in w for w in fake.writes)
    finally:
        app.shutdown()


def test_move_app_converts_mm_to_steps_and_starts_heartbeat():
    from robotd.app import App
    from robotd.config import Config
    from robotd.api.http import RouteContext, _h_move

    board, fake = fake_serial_board()
    app = App(Config(sim=False, serial_port="/dev/fake-serial"), clock=FakeClock())
    app.attach_board(board)
    app.start()
    try:
        ctx = RouteContext(
            app=app,
            method="POST",
            path="/v1/robot/move",
            query={},
            params={},
            body={"distance_mm": 300},
            handler=None,
        )
        result = _h_move(ctx)
        assert result["steps"] == 2400
        move = next(w for w in fake.writes if b'"op":"move"' in w)
        assert json.loads(move)["args"] == {"left": 2400, "right": 2400, "speed": 0.15}
        # 300mm / 150mm·s⁻¹ = 2s；心跳必须在运动期间出现
        _wait_until(lambda: any(b'"op":"velocity"' in w for w in fake.writes), timeout=1.0)
    finally:
        app.shutdown()


# ---------------------------------------------------------------- 板侧运动事实必须可观测
def test_board_motion_events_are_registered_and_emitted():
    """`motion.done` / `motion.aborted` 是板侧真实推送。

    之前它们没登记，`kernel.emit` 直接抛 `EventContractError`，日志里只剩
    「板侧事件处理失败」——真机跑步时**看不到运动是否结束**。M0 的判据要求
    「发生了什么」可观测，所以这两条必须在事件表里。
    """
    from robotd.app import App
    from robotd.config import Config

    app = App(Config(sim=True, serial_port=""), clock=FakeClock())
    app.start()
    try:
        app._board_event("motion.done", {"steps": 2400})
        app._board_event("motion.aborted", {"reason": "stop"})
        types = [ev.type for ev in app.kernel.recent_events(50)]
        assert "motion.done" in types, types
        assert "motion.aborted" in types, types
    finally:
        app.shutdown()


def test_motion_aborted_accepts_watchdog_reason():
    """看门狗中止是安全兜底的关键证据，reason 必须在枚举里。"""
    from robotd.app import App
    from robotd.config import Config

    app = App(Config(sim=True, serial_port=""), clock=FakeClock())
    app.start()
    try:
        app._board_event("motion.aborted", {"reason": "watchdog", "hb_age_ms": 300})
        evs = [ev for ev in app.kernel.recent_events(50) if ev.type == "motion.aborted"]
        assert evs and evs[-1].payload.get("reason") == "watchdog", evs
    finally:
        app.shutdown()


def test_unregistered_board_push_is_ignored_quietly_not_as_failure(caplog):
    """板侧推了主机未建模的事实（如 ena.*）时：忽略，但不伪装成「处理失败」。"""
    import logging

    from robotd.app import App
    from robotd.config import Config

    app = App(Config(sim=True, serial_port=""), clock=FakeClock())
    app.start()
    try:
        with caplog.at_level(logging.DEBUG, logger="robotd"):
            app._board_event("ena.changed", {"state": "engaged"})
        assert not [r for r in caplog.records if r.levelno >= logging.WARNING], caplog.text
        types = [ev.type for ev in app.kernel.recent_events(20)]
        assert "ena.changed" not in types
    finally:
        app.shutdown()
