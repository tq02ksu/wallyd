"""应用生命周期：注入、启动失败清理、关机先停、能力表不撒谎。"""

from __future__ import annotations

import pytest

from robotd.app import App
from robotd.capabilities import Implementation, Registry, require_approval, validate_known_fields
from robotd.config import Config
from robotd.core.errors import ErrorCode, RobotdError
from robotd.core.types import Exclusivity
from tests.helpers import FakeBoard, FakeClock


def make_app(**kwargs) -> App:
    cfg = kwargs.pop("config", Config(sim=True, serial_port=""))
    return App(cfg, clock=FakeClock(), **kwargs)


# ---------------------------------------------------------------- 依赖注入
def test_app_runs_without_any_hardware():
    app = make_app()
    app.start()
    snap = app.snapshot()
    # 没有板侧：保持 starting，不谎称 ready
    assert snap["devices"]["esp32"] == "starting"
    assert snap["mode"] == "idle"
    app.shutdown()


def test_instance_id_is_per_app_and_appears_in_health():
    a, b = make_app(), make_app()
    assert a.instance_id != b.instance_id
    assert a.health()["instance_id"] == a.instance_id
    assert a.health()["service"] == "robotd"


def test_sim_transport_reported_as_sim():
    app = make_app()
    assert app.snapshot()["transport"] == "sim"
    assert app.health()["transport"] == "sim"


# ---------------------------------------------------------------- 板侧握手
def test_successful_hello_makes_esp32_ready():
    board = FakeBoard()
    app = make_app(board=board)
    app.start()
    assert app.snapshot()["devices"]["esp32"] == "ready"
    assert app.snapshot()["firmware"] == "sim-2.1"
    assert board.calls[0][0] == "hello"
    app.shutdown()


def test_hello_failure_raises_link_error_and_cleans_up():
    board = FakeBoard(fail_hello=True)
    app = make_app(board=board)
    with pytest.raises(RobotdError) as ei:
        app.start()
    assert ei.value.code is ErrorCode.LINK
    assert ei.value.http_status == 503
    # 部分初始化清理：组件被回收过
    assert app._components == []


# ---------------------------------------------------------------- 关机先停
def test_shutdown_cancels_motion_task_first():
    board = FakeBoard()
    app = make_app(board=board)
    app.start()
    task = app.kernel.new_task("robot.follow", Exclusivity.MOTION)
    app.shutdown()
    assert app.kernel.get_task(task.task_id).state.value == "cancelled"
    ops = [op for op, _ in board.calls]
    assert "stop" in ops
    assert board.closed is True


def test_stop_reports_board_ack_truthfully():
    board = FakeBoard()
    app = make_app(board=board)
    app.start()
    assert app.request_stop()["board_ack"] is True

    board2 = FakeBoard(fail_stop=True)
    app2 = make_app(board=board2)
    app2.start()
    assert app2.request_stop()["board_ack"] is False  # 不把本地停止说成已送达


def test_stop_event_is_emitted():
    app = make_app()
    seen: list[str] = []
    app.kernel.subscribe(["safety.*"], lambda ev: seen.append(ev.type))
    app.request_stop()
    assert seen == ["safety.stopped"]


def test_shutdown_is_idempotent():
    app = make_app()
    app.start()
    app.shutdown()
    app.shutdown()  # 第二次不应抛


# ---------------------------------------------------------------- 能力表不撒谎
def test_unimplemented_capabilities_report_unavailable():
    app = make_app()
    cap = app.registry.get("robot.follow")
    assert cap.implementation is Implementation.UNIMPLEMENTED
    with pytest.raises(RobotdError) as ei:
        cap.check_available()
    assert ei.value.code is ErrorCode.UNAVAILABLE
    assert ei.value.http_status == 503


def test_every_public_operation_has_a_capability_entry():
    """契约里的 14 个 HTTP operationId + WS 的 events_subscribe 都必须能在能力表里找到。

    缺条目会退化成 404（「好像没这个功能」），而目标行为是 503 + 明确原因。
    `events_subscribe` 不进 MCP 工具面（`x-websocket`），但仍是一项公开操作。
    """
    registry = Registry()
    public = {c.public_name for c in registry.all() if c.public_name}
    expected = {
        "robot_health",
        "robot_state",
        "robot_calibration_get",
        "robot_calibration_set",
        "robot_speak",
        "robot_announce",
        "speech_listen",
        "speech_abort",
        "audio_state",
        "audio_mute",
        "audio_unmute",
        "robot_follow",
        "robot_stop",
        "task_get",
        "task_list",
        "task_cancel",
        "events_subscribe",
    }
    assert expected == public
    assert registry.by_public_name("robot_stop").name == "robot.stop"


def test_approval_gate_rejects_missing_approval():
    import asyncio

    registry = Registry()
    cap = registry.get("robot.follow")
    with pytest.raises(RobotdError) as ei:
        asyncio.run(require_approval(cap, approved=False))
    assert ei.value.code is ErrorCode.APPROVAL
    asyncio.run(require_approval(cap, approved=True))  # 显式审批才放行


def test_undeclared_fields_are_rejected():
    with pytest.raises(RobotdError) as ei:
        validate_known_fields({"text": "hi", "secret_flag": True}, {"text", "voice"})
    assert ei.value.code is ErrorCode.VALIDATION
    assert ei.value.details["unknown_fields"] == ["secret_flag"]


def test_debug_only_diagnostics_are_not_public_names():
    """诊断视图可以有，但不能被当成公开操作名使用。"""
    app = make_app()
    report = app.registry.status_report()
    assert all(item["implementation"] in {i.value for i in Implementation} for item in report)
