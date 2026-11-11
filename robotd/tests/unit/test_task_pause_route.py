"""``POST /v1/tasks/{id}/pause|resume`` 的传输层语义（GH-48）。

集成测试会起真实回环 socket；受限沙箱里 AF_INET 建 socket 会被拒绝，所以这里直接
调用处理函数，把「路由存在 / 免审批 / 状态码」钉在传输层之上、能力门之内。
真实 HTTP 形状仍由 ``tests/integration/test_api_http.py`` 覆盖。
"""

from __future__ import annotations

import pytest

from robotd.api.http import RouteContext, _h_stop, _h_task_pause, _h_task_resume, build_routes
from robotd.app import App
from robotd.config import Config
from robotd.core.errors import ErrorCode, RobotdError
from robotd.core.types import Exclusivity, TaskState
from tests.helpers import FakeBoard, FakeClock


class FakeScheduler:
    def __init__(self) -> None:
        self.scheduled: list[tuple[int, object]] = []

    def __call__(self, delay_ms: int, fn) -> object:
        class T:
            def cancel(self) -> None:
                pass

        self.scheduled.append((delay_ms, fn))
        return T()


def make_app() -> App:
    app = App(
        Config(sim=True, http_port=0, serial_port=""),
        clock=FakeClock(),
        board=FakeBoard(),
        schedule=FakeScheduler(),
    )
    app.start()
    return app


def call(app: App, handler, task_id: str, body: dict | None = None) -> dict:
    ctx = RouteContext(
        app=app,
        method="POST",
        path=f"/v1/tasks/{task_id}/pause",
        query={},
        params={"task_id": task_id},
        body=body or {},
        handler=None,  # type: ignore[arg-type]
    )
    return handler(ctx)


def motion_task(app: App) -> str:
    task = app.kernel.new_task("robot.follow", Exclusivity.MOTION)
    app.kernel.mark_running(task.task_id)
    return task.task_id


def test_routes_are_resource_subpaths_and_do_not_require_approval():
    routes = {r.operation_id: r for r in build_routes(debug=False)}
    assert routes["task_pause"].template == "/v1/tasks/{task_id}/pause"
    assert routes["task_resume"].template == "/v1/tasks/{task_id}/resume"
    assert routes["task_pause"].method == "POST"
    assert routes["task_resume"].method == "POST"
    # resume 没有改变任何被确认过的参数：不允许在路由层要求审批。
    assert routes["task_pause"].requires_approval is False
    assert routes["task_resume"].requires_approval is False


def test_pause_then_resume_through_handlers():
    app = make_app()
    task_id = motion_task(app)

    paused = call(app, _h_task_pause, task_id)
    assert paused["state"] == "paused"
    resumed = call(app, _h_task_resume, task_id)
    assert resumed["task_id"] == task_id
    assert resumed["state"] == "running"
    assert [t.task_id for t in app.kernel.list_tasks()] == [task_id]
    app.shutdown()


def test_pause_rejects_unknown_body_fields():
    app = make_app()
    task_id = motion_task(app)
    with pytest.raises(RobotdError) as err:
        call(app, _h_task_pause, task_id, {"seconds": 5})
    assert err.value.code is ErrorCode.VALIDATION
    app.shutdown()


def test_pause_terminal_task_is_state_conflict():
    app = make_app()
    task_id = motion_task(app)
    app.kernel.finish(task_id, TaskState.COMPLETED)
    with pytest.raises(RobotdError) as err:
        call(app, _h_task_pause, task_id)
    assert err.value.code is ErrorCode.STATE
    app.shutdown()


def test_stop_handler_cancels_paused_task():
    app = make_app()
    task_id = motion_task(app)
    call(app, _h_task_pause, task_id)

    ctx = RouteContext(
        app=app,
        method="POST",
        path="/v1/robot/stop",
        query={},
        params={},
        body={"reason": "stop"},
        handler=None,  # type: ignore[arg-type]
    )
    _h_stop(ctx)

    assert app.kernel.get_task(task_id).state is TaskState.CANCELLED
    app.shutdown()
