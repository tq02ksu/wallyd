"""``DELETE /v1/tasks/{id}`` 的传输层语义（GH-84 取消策略抽取）。

取消策略（运动任务必须联动 stop，然后才终结任务）已从 HTTP handler 移到
``safety.StopCoordinator.cancel_task``。真实回环 socket 在受限沙箱里不可用，
所以这里直接调用处理函数，把「运动任务先停板再取消」「软任务不碰板侧」
「终态幂等」钉在传输层之上。
"""

from __future__ import annotations

import pytest

from robotd.api.http import RouteContext, _h_task_cancel
from robotd.app import App
from robotd.config import Config
from robotd.core.errors import ErrorCode, RobotdError
from robotd.core.types import Exclusivity, TaskState
from tests.helpers import FakeBoard, FakeClock


def make_app() -> App:
    app = App(
        Config(sim=True, http_port=0, serial_port=""),
        clock=FakeClock(),
        board=FakeBoard(),
    )
    app.start()
    return app


def cancel(app: App, task_id: str) -> dict:
    ctx = RouteContext(
        app=app,
        method="DELETE",
        path=f"/v1/tasks/{task_id}",
        query={},
        params={"task_id": task_id},
        body={},
        handler=None,  # type: ignore[arg-type]
    )
    return _h_task_cancel(ctx)


def test_cancel_motion_task_stops_the_board_before_finishing():
    board = FakeBoard()
    app = App(Config(sim=True, http_port=0, serial_port=""), clock=FakeClock(), board=board)
    app.start()
    task = app.tasks.submit("robot.follow", Exclusivity.MOTION)
    board.calls.clear()

    body = cancel(app, task.task_id)

    assert body["state"] == "cancelled"
    # 只改任务表会让电机继续跑：运动任务取消必须先下发 stop。
    assert ("stop", {}) in board.calls
    assert app.tasks.get(task.task_id).state is TaskState.CANCELLED
    # 运动取消走 stop 编排：原因是结构化的 user_stop_api（与 GH-48 之前一致）。
    assert app.tasks.get(task.task_id).reason == "user_stop_api"
    app.shutdown()


def test_cancel_soft_task_does_not_touch_the_board():
    board = FakeBoard()
    app = App(Config(sim=True, http_port=0, serial_port=""), clock=FakeClock(), board=board)
    app.start()
    task = app.tasks.submit("speech.listen", Exclusivity.SOFT)
    board.calls.clear()

    body = cancel(app, task.task_id)

    assert body["state"] == "cancelled"
    assert [op for op, _ in board.calls] == []
    assert app.tasks.get(task.task_id).reason == "requested"
    app.shutdown()


def test_cancel_is_idempotent_and_unknown_task_is_404():
    app = make_app()
    task = app.tasks.submit("robot.follow", Exclusivity.MOTION)

    first = cancel(app, task.task_id)
    second = cancel(app, task.task_id)

    assert first["state"] == "cancelled"
    assert second["state"] == "cancelled"  # 终态不可回转，重复取消不报错
    with pytest.raises(RobotdError) as err:
        cancel(app, "t-9999")
    assert err.value.code is ErrorCode.NO_TASK
    assert err.value.http_status == 404
    app.shutdown()
