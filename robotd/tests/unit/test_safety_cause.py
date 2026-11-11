"""结构化停止原因（GH-57）。

本文件只读 ``safety.stop_requested.cause`` / ``state``，不 grep 中文 detail。
板侧路径全部经 ``App._board_event``（fake transport / SimBoard）进入，
不在 agentd 或测试里另写一套安全判定。
"""

from __future__ import annotations

import pytest

from robotd.api.http import RouteContext, _h_stop
from robotd.app import App
from robotd.config import Config
from robotd.core.errors import RobotdError
from robotd.core.safety import STOP_CAUSES, StopCause, StopState
from robotd.core.types import Exclusivity
from robotd.devices.sim import SimBoard, SimFault
from tests.helpers import FakeBoard, FakeClock


def make_app(**kwargs) -> App:
    cfg = kwargs.pop("config", Config(sim=True, serial_port=""))
    return App(cfg, clock=FakeClock(), **kwargs)


def stop_events(app: App) -> list:
    return [ev for ev in app.kernel.recent_events(200) if ev.type == "safety.stop_requested"]


def last_stop(app: App):
    events = stop_events(app)
    assert events, "没有 safety.stop_requested 事件"
    return events[-1]


def call_stop(app: App, body: dict) -> dict:
    ctx = RouteContext(
        app=app,
        method="POST",
        path="/v1/robot/stop",
        query={},
        params={},
        body=body,
        handler=None,  # type: ignore[arg-type]
    )
    return _h_stop(ctx)


@pytest.mark.parametrize("cause", sorted(STOP_CAUSES))
def test_production_stop_path_can_emit_every_required_cause(cause):
    app = make_app(board=FakeBoard())
    app.start()
    app.report_safety_stop(cause=cause)
    ev = last_stop(app)
    assert ev.payload["cause"] == cause
    expected = "unknown" if cause == StopCause.DEVICE_LOST.value else "confirmed"
    assert ev.payload["state"] == expected
    assert isinstance(ev.payload["detail"], str) and ev.payload["detail"]


def test_http_stop_accepts_structured_cause():
    app = make_app(board=FakeBoard())
    app.start()
    result = call_stop(app, {"cause": "user_voice", "detail": "语音停止"})
    assert result["cause"] == "user_voice"
    assert last_stop(app).payload["cause"] == "user_voice"


def test_http_stop_rejects_unknown_cause():
    app = make_app(board=FakeBoard())
    app.start()
    with pytest.raises(RobotdError) as ei:
        call_stop(app, {"cause": "not_a_cause"})
    assert ei.value.code.value == "E_VALIDATION"


def test_legacy_reason_still_maps_to_user_stop_api():
    app = make_app(board=FakeBoard())
    app.start()
    call_stop(app, {"reason": "stop"})
    assert last_stop(app).payload["cause"] == StopCause.USER_STOP_API.value


def test_device_lost_is_unknown_not_confirmed():
    """反向判据：把 unknown 改成 confirmed，本测试必须变红。"""
    board = SimBoard()
    app = make_app()
    app.attach_sim_board(board)
    app.start()

    board.inject_fault(SimFault.LOST)

    ev = last_stop(app)
    assert ev.payload["cause"] == StopCause.DEVICE_LOST.value
    assert ev.payload["state"] == StopState.UNKNOWN.value, (
        "链路已断、无法确认板侧停稳时必须诚实报 unknown，不得默认 confirmed"
    )


def test_board_watchdog_over_healthy_transport_is_confirmed():
    board = SimBoard()
    app = make_app()
    app.attach_sim_board(board)
    app.start()
    task = app.kernel.new_task("robot.follow", Exclusivity.MOTION)

    board.sim_board_stop("watchdog")

    ev = last_stop(app)
    assert ev.payload["cause"] == StopCause.WATCHDOG_TIMEOUT.value
    assert ev.payload["state"] == StopState.CONFIRMED.value
    assert ev.payload["task_id"] == task.task_id
    assert app.kernel.get_task(task.task_id).state.value == "cancelled"


def test_board_watchdog_with_lost_transport_is_unknown():
    board = SimBoard()
    app = make_app()
    app.attach_sim_board(board)
    app.start()

    board.inject_fault(SimFault.LOST)
    board.sim_board_stop("watchdog")

    ev = last_stop(app)
    assert ev.payload["cause"] == StopCause.WATCHDOG_TIMEOUT.value
    assert ev.payload["state"] == StopState.UNKNOWN.value


def test_board_reports_obstacle_as_structured_cause():
    board = SimBoard()
    app = make_app()
    app.attach_sim_board(board)
    app.start()

    board.sim_board_stop("obstacle")

    ev = last_stop(app)
    assert ev.payload["cause"] == StopCause.OBSTACLE.value
    assert ev.payload["state"] == StopState.CONFIRMED.value


def test_unknown_board_stop_reason_is_internal_error_not_guessed():
    board = SimBoard()
    app = make_app()
    app.attach_sim_board(board)
    app.start()

    board.sim_board_stop("something_we_do_not_know")

    assert last_stop(app).payload["cause"] == StopCause.INTERNAL_ERROR.value


def test_shutdown_stop_is_bridge_exit():
    app = make_app(board=FakeBoard())
    app.start()
    app.shutdown()
    assert last_stop(app).payload["cause"] == StopCause.BRIDGE_EXIT.value


def test_request_stop_rejects_unknown_explicit_cause():
    app = make_app(board=FakeBoard())
    app.start()
    with pytest.raises(RobotdError):
        app.request_stop(cause="not_a_cause")
