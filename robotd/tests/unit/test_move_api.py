"""GH-74：``robot_move`` 的传输层校验（不 bind 端口，直接调处理函数）。

HTTP 级 403/200 由 ``tests/integration/test_api_http.py`` 在 CI（可 bind 回环）覆盖；
这里钉住请求形状与「链路未就绪不写帧」这两条判定。
"""

from __future__ import annotations

import json

import pytest

from robotd.api.http import RouteContext, _h_move
from robotd.app import App
from robotd.config import Config
from robotd.core.errors import ErrorCode, RobotdError
from tests.helpers import FakeClock, fake_serial_board


def make_app(*, board=None) -> App:
    app = App(Config(sim=False, serial_port="/dev/fake-serial"), clock=FakeClock())
    if board is not None:
        app.attach_board(board)
        app.start()
    return app


def call(app: App, body: dict) -> dict:
    ctx = RouteContext(
        app=app,
        method="POST",
        path="/v1/robot/move",
        query={},
        params={},
        body=body,
        handler=None,  # 审批门在传输层；本测试只验证处理函数与能力入口
    )
    return _h_move(ctx)


def test_default_speed_is_the_contract_default_and_frame_is_written():
    board, fake = fake_serial_board()
    app = make_app(board=board)
    try:
        result = call(app, {"distance_mm": 300})
        assert result["distance_mm"] == 300.0
        assert result["speed_mm_s"] == 150.0
        assert fake.writes[-1] == (b'{"id":2,"op":"move","args":{"left":0.3,"right":0.3,"speed":0.15}}\n')
    finally:
        app.shutdown()


@pytest.mark.parametrize(
    "body, fields",
    [
        ({}, "distance_mm"),
        ({"distance_mm": 0}, "distance_mm"),
        ({"distance_mm": 5001}, "distance_mm"),
        ({"distance_mm": 300, "speed_mm_s": 49}, "speed_mm_s"),
        ({"distance_mm": 300, "speed_mm_s": 401}, "speed_mm_s"),
        ({"distance_mm": 300, "left_m": 0.3}, "left_m"),
    ],
)
def test_invalid_or_unknown_fields_are_rejected_without_writing(body, fields):
    board, fake = fake_serial_board()
    app = make_app(board=board)
    try:
        with pytest.raises(RobotdError) as ei:
            call(app, body)
        assert ei.value.code is ErrorCode.VALIDATION
        assert fields in ei.value.message
        assert not any(json.loads(raw).get("op") == "move" for raw in fake.writes)
    finally:
        app.shutdown()


def test_unavailable_board_rejects_move_and_there_is_nothing_to_write():
    app = make_app()
    app.mark_board_unavailable("串口打不开（/dev/fake-serial）：设备不存在")
    app.start()
    try:
        with pytest.raises(RobotdError) as ei:
            call(app, {"distance_mm": 300})
        assert ei.value.code is ErrorCode.UNAVAILABLE
        assert "设备不存在" in ei.value.message
    finally:
        app.shutdown()
