"""GH-48：任务暂停/恢复。

判据映射（docs/design/GH-48.md）：

1. pause → 板侧收到 stop、任务 ``paused``、事件是 ``task.paused``（不是终态事件）；
2. resume → 同一任务恢复，没有第二个 ``task.started``（不存在「取消 + 重建」）；
3. 暂停超时 → ``task.pause_expired`` + ``cancelled(reason=pause_timeout)`` + 尽力播报；
4. paused 期间 stop → 立即 cancelled，且幂等；
5. 反向判据：pause/resume 不新建任务、不调用动作能力。
"""

from __future__ import annotations

import time
from typing import Any, Callable

import pytest

from robotd.app import App
from robotd.config import Config, ConfigError, from_env
from robotd.core.announce import PAUSE_EXPIRED_TEXT
from robotd.core.errors import ErrorCode, RobotdError
from robotd.core.kernel import EventKernel
from robotd.core.state import RobotStateStore
from robotd.core.types import DeviceStatus, Exclusivity, TaskState
from tests.helpers import FakeBoard, FakeClock


class FakeScheduler:
    """可控调度器：不真等 120s，测试里显式触发到期回调。"""

    def __init__(self) -> None:
        self.scheduled: list[tuple[int, Callable[[], None]]] = []
        self.cancelled = 0

    def __call__(self, delay_ms: int, fn: Callable[[], None]) -> Any:
        entry = _FakeTimer(self)
        self.scheduled.append((delay_ms, fn))
        return entry

    def fire_all(self) -> None:
        for _, fn in list(self.scheduled):
            fn()


class _FakeTimer:
    def __init__(self, owner: FakeScheduler) -> None:
        self.owner = owner

    def cancel(self) -> None:
        self.owner.cancelled += 1


class FakeAudio:
    """只记录「交给 TTS 的固定句子」，不启动任何音频桥。"""

    def __init__(self, *, available: bool = True) -> None:
        self.available = available
        self.spoken: list[str] = []

    def new_response(self, *, task_id: Any, kind: str | None = None) -> Any:
        if not self.available:
            raise RuntimeError("语音桥不可用（lost）")
        return object()

    def speak(self, resp: Any, *, text: str, **_: Any) -> None:
        self.spoken.append(text)

    def abort_response(self, reason: str = "stop") -> None:
        """shutdown 的停止路径会调用它；没有播报时是空操作。"""


def make_kernel() -> EventKernel:
    st = RobotStateStore(robot_id="test-bot", transport="sim")
    st._apply_link(DeviceStatus.READY)
    return EventKernel(state=st, instance_id="inst-pause")


def collect(kernel: EventKernel, filters: list[str] | None = None) -> list:
    events: list = []
    kernel.subscribe(filters or ["task.*", "safety.*"], events.append)
    return events


def make_motion_task(kernel: EventKernel) -> str:
    task = kernel.new_task("robot.follow", Exclusivity.MOTION)
    kernel.mark_running(task.task_id)
    return task.task_id


def make_app(*, board: Any = None, audio: FakeAudio | None = None, scheduler: FakeScheduler | None = None):
    cfg = Config(sim=True, serial_port="")
    app = App(
        cfg,
        clock=FakeClock(),
        board=board if board is not None else FakeBoard(),
        schedule=scheduler or FakeScheduler(),
    )
    app.start()
    if audio is not None:
        app.audio = audio  # 只替换播报面，不启动桥
    return app


# ---------------------------------------------------------------- 内核状态机
def test_pause_keeps_task_alive_and_emits_task_paused():
    kernel = make_kernel()
    events = collect(kernel)
    task_id = make_motion_task(kernel)

    paused = kernel.pause_task(task_id, pause_expires_at=1_700_000_120_000)

    assert paused.state is TaskState.PAUSED
    assert paused.terminal is False
    assert paused.finished_at is None
    assert paused.pause_expires_at == 1_700_000_120_000
    assert paused.to_public()["state"] == "paused"
    assert paused.to_public()["pause_expires_at"] == 1_700_000_120_000
    types = [ev.type for ev in events]
    assert "task.paused" in types
    assert "task.cancelled" not in types and "task.completed" not in types
    # 判据 5：暂停不是「取消 + 重建」——任务表里仍只有这一个任务。
    assert [t.task_id for t in kernel.list_tasks()] == [task_id]


def test_paused_motion_task_does_not_report_moving_mode():
    kernel = make_kernel()
    task_id = make_motion_task(kernel)
    assert kernel.snapshot()["mode"] == "moving"

    kernel.pause_task(task_id, pause_expires_at=1)

    # paused 仍占槽位（task_id 还在），但身体没在动。
    assert kernel.snapshot()["mode"] == "idle"
    assert kernel.snapshot()["task_id"] == task_id
    # 设备事件重算 mode 时也不能把 paused 说成 moving。
    kernel.emit("device.changed", device="pump", state="off")
    assert kernel.snapshot()["mode"] == "idle"


def test_pause_is_idempotent_and_does_not_duplicate_events():
    kernel = make_kernel()
    task_id = make_motion_task(kernel)
    kernel.pause_task(task_id, pause_expires_at=1)
    events = collect(kernel)

    again = kernel.pause_task(task_id, pause_expires_at=2)

    assert again.state is TaskState.PAUSED
    assert [ev.type for ev in events] == []


def test_resume_restores_same_task_without_restart():
    kernel = make_kernel()
    task_id = make_motion_task(kernel)
    kernel.pause_task(task_id, pause_expires_at=1)
    events = collect(kernel)

    resumed = kernel.resume_task(task_id)

    assert resumed.state is TaskState.RUNNING
    assert resumed.task_id == task_id
    assert resumed.pause_expires_at is None
    assert "pause_expires_at" not in resumed.to_public()
    types = [ev.type for ev in events]
    assert types == ["task.resumed"]
    assert events[0].payload["paused_ms"] >= 0
    # 判据 5：没有第二个 task.started，任务数不变。
    assert [t.task_id for t in kernel.list_tasks()] == [task_id]
    assert kernel.snapshot()["mode"] == "moving"


def test_resume_is_idempotent_while_running():
    kernel = make_kernel()
    task_id = make_motion_task(kernel)
    events = collect(kernel)
    assert kernel.resume_task(task_id).state is TaskState.RUNNING
    assert events == []


@pytest.mark.parametrize("terminal", [TaskState.COMPLETED, TaskState.FAILED, TaskState.CANCELLED])
def test_terminal_task_cannot_pause_or_resume(terminal):
    kernel = make_kernel()
    task_id = make_motion_task(kernel)
    kernel.finish(task_id, terminal)
    with pytest.raises(RobotdError) as pause_err:
        kernel.pause_task(task_id, pause_expires_at=1)
    assert pause_err.value.code is ErrorCode.STATE
    with pytest.raises(RobotdError) as resume_err:
        kernel.resume_task(task_id)
    assert resume_err.value.code is ErrorCode.STATE


def test_soft_task_cannot_pause():
    kernel = make_kernel()
    task = kernel.new_task("speech.listen", Exclusivity.SOFT)
    kernel.mark_running(task.task_id)
    with pytest.raises(RobotdError) as err:
        kernel.pause_task(task.task_id, pause_expires_at=1)
    assert err.value.code is ErrorCode.STATE


def test_soft_task_cannot_resume_either():
    """契约写的是 409/E_STATE：不能因为 soft 任务本来就 running 就返回 200。"""
    kernel = make_kernel()
    task = kernel.new_task("speech.listen", Exclusivity.SOFT)
    kernel.mark_running(task.task_id)
    with pytest.raises(RobotdError) as err:
        kernel.resume_task(task.task_id)
    assert err.value.code is ErrorCode.STATE


def test_accepted_task_cannot_pause():
    kernel = make_kernel()
    task = kernel.new_task("robot.follow", Exclusivity.MOTION)
    with pytest.raises(RobotdError) as err:
        kernel.pause_task(task.task_id, pause_expires_at=1)
    assert err.value.code is ErrorCode.STATE


def test_paused_task_still_holds_motion_slot():
    kernel = make_kernel()
    task_id = make_motion_task(kernel)
    kernel.pause_task(task_id, pause_expires_at=1)
    with pytest.raises(RobotdError) as err:
        kernel.new_task("robot.follow", Exclusivity.MOTION)
    assert err.value.code is ErrorCode.BUSY


def test_finish_clears_pause_deadline():
    kernel = make_kernel()
    task_id = make_motion_task(kernel)
    kernel.pause_task(task_id, pause_expires_at=123)
    kernel.finish(task_id, TaskState.CANCELLED, reason="stop")
    task = kernel.get_task(task_id)
    assert task.pause_expires_at is None
    assert task.to_public()["state"] == "cancelled"


# ---------------------------------------------------------------- 配置上限
def test_pause_max_seconds_is_bounded_and_env_overridable():
    """暂停上限是失效保护参数：配置不能把它写没，也不能无声放大。"""
    with pytest.raises(ConfigError):
        Config(pause_max_seconds=0).validate()
    with pytest.raises(ConfigError):
        Config(pause_max_seconds=601).validate()
    assert from_env(Config(), {"ROBOTD_PAUSE_MAX_SECONDS": "45"}).pause_max_seconds == 45.0
    assert Config().pause_max_seconds == 120.0


# ---------------------------------------------------------------- App 编排
def test_pause_stops_board_before_marking_paused():
    board = FakeBoard()
    app = make_app(board=board)
    task_id = make_motion_task(app.kernel)
    board.calls.clear()

    started = time.monotonic()
    body = app.pause_task(task_id)
    elapsed = time.monotonic() - started

    assert body["state"] == "paused"
    assert ("stop", {}) in board.calls
    # 判据 1：暂停调用同步下发 stop，300ms 内归零意图已经交给板侧。
    assert elapsed < 0.3, f"pause took {elapsed:.3f}s"
    assert app.kernel.get_task(task_id).state is TaskState.PAUSED
    app.shutdown()


def test_paused_is_not_mute_and_soft_tasks_still_start():
    """判据 5：暂停只改运动任务，不挡澄清/播报（它不是 mute）。"""
    app = make_app()
    task_id = make_motion_task(app.kernel)
    app.pause_task(task_id)

    assert app.audio.muted is False
    soft = app.kernel.new_task("speech.listen", Exclusivity.SOFT)
    assert soft.task_id
    app.shutdown()


def test_pause_without_board_is_unavailable_and_keeps_task_running():
    app = App(Config(sim=True, serial_port=""), clock=FakeClock(), board=None)
    task_id = make_motion_task(app.kernel)
    with pytest.raises(RobotdError) as err:
        app.pause_task(task_id)
    assert err.value.code is ErrorCode.UNAVAILABLE
    assert app.kernel.get_task(task_id).state is TaskState.RUNNING


def test_pause_with_unready_link_fails_task_instead_of_pretending_paused():
    app = App(Config(sim=True, serial_port=""), clock=FakeClock(), board=FakeBoard())
    task_id = make_motion_task(app.kernel)  # 未 start()：link 不是 ready
    with pytest.raises(RobotdError) as err:
        app.pause_task(task_id)
    assert err.value.code is ErrorCode.LINK
    task = app.kernel.get_task(task_id)
    assert task.state is TaskState.FAILED
    assert task.reason == "lost_link"


def test_board_stop_failure_does_not_enter_paused():
    board = FakeBoard(fail_stop=True)
    app = make_app(board=board)
    task_id = make_motion_task(app.kernel)
    with pytest.raises(RobotdError) as err:
        app.pause_task(task_id)
    assert err.value.code is ErrorCode.LINK
    assert app.kernel.get_task(task_id).state is TaskState.FAILED
    app.shutdown()


def test_pause_without_a_deadline_never_stays_paused():
    """不变量：paused 一定有截止时间。定时器建不起来就按内部故障收尾。"""

    class BrokenScheduler(FakeScheduler):
        def __call__(self, delay_ms: int, fn: Callable[[], None]) -> Any:
            raise RuntimeError("no timer")

    app = make_app(scheduler=BrokenScheduler())
    task_id = make_motion_task(app.kernel)

    with pytest.raises(RobotdError) as err:
        app.pause_task(task_id)

    assert err.value.code is ErrorCode.INTERNAL
    task = app.kernel.get_task(task_id)
    assert task.state is TaskState.FAILED
    assert task.reason == "internal"
    app.shutdown()


def test_pause_expiry_cancels_and_announces_fixed_sentence():
    scheduler = FakeScheduler()
    audio = FakeAudio()
    board = FakeBoard()
    app = make_app(board=board, audio=audio, scheduler=scheduler)
    events = collect(app.kernel)
    task_id = make_motion_task(app.kernel)
    app.pause_task(task_id)
    assert [d for d, _ in scheduler.scheduled] == [120_000]
    stops_after_pause = sum(1 for op, _ in board.calls if op == "stop")

    scheduler.fire_all()

    task = app.kernel.get_task(task_id)
    assert task.state is TaskState.CANCELLED
    assert task.reason == "pause_timeout"
    types = [ev.type for ev in events]
    assert "task.pause_expired" in types
    expired = next(ev for ev in events if ev.type == "task.pause_expired")
    assert expired.payload == {"task_id": task_id, "announced": True}
    cancelled = next(ev for ev in events if ev.type == "task.cancelled")
    assert cancelled.payload["reason"] == "pause_timeout"
    assert audio.spoken == [PAUSE_EXPIRED_TEXT]
    # 收尾前再下发一次停止：转终态不能只改任务表。
    assert sum(1 for op, _ in board.calls if op == "stop") == stops_after_pause + 1
    app.shutdown()


def test_pause_expiry_without_audio_bridge_reports_not_announced():
    """桥不可用时不伪造「已播报」：announced=false，但取消仍然发生。"""
    scheduler = FakeScheduler()
    app = make_app(audio=FakeAudio(available=False), scheduler=scheduler)
    events = collect(app.kernel)
    task_id = make_motion_task(app.kernel)
    app.pause_task(task_id)

    scheduler.fire_all()

    expired = next(ev for ev in events if ev.type == "task.pause_expired")
    assert expired.payload == {"task_id": task_id, "announced": False}
    assert app.kernel.get_task(task_id).state is TaskState.CANCELLED
    app.shutdown()


def test_pause_expiry_after_resume_is_a_noop():
    scheduler = FakeScheduler()
    audio = FakeAudio()
    app = make_app(audio=audio, scheduler=scheduler)
    task_id = make_motion_task(app.kernel)
    app.pause_task(task_id)
    app.resume_task(task_id)

    scheduler.fire_all()

    assert app.kernel.get_task(task_id).state is TaskState.RUNNING
    assert audio.spoken == []
    app.shutdown()


def test_pause_expiry_still_cancels_when_the_event_cannot_be_emitted(monkeypatch):
    """事件写不进去只是时间线缺一条，任务不能因此留在没有定时器的 paused。"""
    scheduler = FakeScheduler()
    audio = FakeAudio()
    app = make_app(audio=audio, scheduler=scheduler)
    task_id = make_motion_task(app.kernel)
    app.pause_task(task_id)

    # 到期收尾是内核里的一次原子转移（检查 paused 与转终态同锁），
    # 所以注入点在 ``_emit_locked``，不是 ``emit``。
    real_emit = app.kernel._emit_locked

    def flaky_emit(type_: str, payload: Any):
        if type_ == "task.pause_expired":
            raise RuntimeError("event log unavailable")
        return real_emit(type_, payload)

    monkeypatch.setattr(app.kernel, "_emit_locked", flaky_emit)

    scheduler.fire_all()

    assert app.kernel.get_task(task_id).state is TaskState.CANCELLED
    assert app.kernel.get_task(task_id).reason == "pause_timeout"
    app.shutdown()


def test_resume_reaching_the_expiry_window_first_is_not_cancelled():
    """到期与 resume 撞车：状态转移是原子的，刚恢复的任务不许被过期回调取消。

    复现点是「预检之后、收尾之前」——回调刚读到 paused、还没转终态时用户说了「继续」。
    旧实现会在读状态之后无条件 ``finish(cancelled)``，把刚恢复的任务杀掉；
    现在终态转移由 ``expire_paused_task`` 在同一把锁里重新确认状态，resume 赢了就不收尾。
    """
    scheduler = FakeScheduler()
    audio = FakeAudio()
    app = make_app(audio=audio, scheduler=scheduler)
    events = collect(app.kernel)
    task_id = make_motion_task(app.kernel)
    app.pause_task(task_id)

    real_announce = app._announce_pause_expired

    def resume_during_announce() -> bool:
        announced = real_announce()
        app.resume_task(task_id)
        return announced

    app._announce_pause_expired = resume_during_announce  # type: ignore[method-assign]

    scheduler.fire_all()

    assert app.kernel.get_task(task_id).state is TaskState.RUNNING
    types = [ev.type for ev in events]
    assert "task.cancelled" not in types
    assert "task.pause_expired" not in types
    app.shutdown()


def test_expiry_winner_rejects_a_later_resume_with_state_error():
    """反向：到期先到就把任务收成 cancelled，之后的 resume 只能是 409，不许复活。"""
    scheduler = FakeScheduler()
    app = make_app(scheduler=scheduler)
    events = collect(app.kernel)
    task_id = make_motion_task(app.kernel)
    app.pause_task(task_id)

    scheduler.fire_all()

    assert app.kernel.get_task(task_id).state is TaskState.CANCELLED
    with pytest.raises(RobotdError) as err:
        app.resume_task(task_id)
    assert err.value.code is ErrorCode.STATE
    # 收尾幂等：再调一次原子转移不得重复发事件，也不得改写已终结的任务。
    assert app.kernel.expire_paused_task(task_id, announced=True) is False
    assert [ev.type for ev in events].count("task.cancelled") == 1
    app.shutdown()


def test_resume_with_unready_link_keeps_task_paused_and_bounded():
    """链路不通时不能声称「已恢复」：任务保持 paused，截止时间照旧生效。"""
    scheduler = FakeScheduler()
    app = make_app(scheduler=scheduler)
    task_id = make_motion_task(app.kernel)
    app.pause_task(task_id)
    app.state._apply_link(DeviceStatus.LOST)

    with pytest.raises(RobotdError) as err:
        app.resume_task(task_id)

    assert err.value.code is ErrorCode.LINK
    assert app.kernel.get_task(task_id).state is TaskState.PAUSED
    # 暂停上限没被误撤销：到期仍会收尾。
    assert app._pause_timers.get(task_id) is not None
    scheduler.fire_all()
    assert app.kernel.get_task(task_id).state is TaskState.CANCELLED
    app.shutdown()


def test_stop_cancels_paused_task_and_clears_timer():
    scheduler = FakeScheduler()
    app = make_app(scheduler=scheduler)
    task_id = make_motion_task(app.kernel)
    app.pause_task(task_id)

    result = app.request_stop(reason="stop")

    assert result["stopped_tasks"] == 1
    assert app.kernel.get_task(task_id).state is TaskState.CANCELLED
    assert scheduler.cancelled >= 1
    assert app._pause_timers == {}
    scheduler.fire_all()  # 过期回调不得再动一个已取消任务
    assert app.kernel.get_task(task_id).reason == "stop"
    app.shutdown()


def test_pause_then_resume_never_creates_second_task():
    scheduler = FakeScheduler()
    app = make_app(scheduler=scheduler)
    events = collect(app.kernel)
    task_id = make_motion_task(app.kernel)
    app.pause_task(task_id)
    app.resume_task(task_id)

    assert [t.task_id for t in app.kernel.list_tasks()] == [task_id]
    assert [ev.type for ev in events].count("task.started") == 1
    app.shutdown()
