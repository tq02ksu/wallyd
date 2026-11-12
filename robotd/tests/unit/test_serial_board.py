"""GH-74 判据 1/2/3：串口适配的字节级证据（全离线，fake transport）。

这里断言的是「host 写出的字节」，不是「机器人走了多少」——后者只能由真机判据给。
"""

from __future__ import annotations

import json
import time

import pytest

from robotd.core.errors import ErrorCode, RobotdError
from robotd.devices.serial import SerialBoard, encode_request, encode_stop
from tests.helpers import FakeSerial, fake_serial_board


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
def test_move_frame_is_json_lines_with_meters():
    board, fake = fake_serial_board()
    try:
        data = board.request("move", {"left": 0.3, "right": 0.3, "speed": 0.15})
    finally:
        board.close()
    assert data == {}
    # 字节级断言：一行 JSON，id 从 1 开始，单位是米（ADR-0004 单点声明）
    assert fake.writes == [b'{"id":1,"op":"move","args":{"left":0.3,"right":0.3,"speed":0.15}}\n']
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
    assert encode_request(7, "move", {"left": 0.3, "right": 0.3, "speed": 0.2}) == (
        b'{"id":7,"op":"move","args":{"left":0.3,"right":0.3,"speed":0.2}}\n'
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
