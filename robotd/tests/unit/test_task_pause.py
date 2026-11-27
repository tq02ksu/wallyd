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
from robotd.motion.arbiter import ResourceArbiter
from robotd.task.executive import TaskExecutive
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


class TaskRig:
    """Kernel + Task Executive 的最小装配（板侧就绪、假调度器、假时钟）。"""

    def __init__(self, *, schedule: Any = None) -> None:
        st = RobotStateStore(robot_id="test-bot", transport="sim")
        st._apply_link(DeviceStatus.READY)
        self.kernel = EventKernel(state=st, instance_id="inst-pause")
        self.board = FakeBoard()
        self.tasks = TaskExecutive(
            self.kernel,
            ResourceArbiter(),
            clock=FakeClock(),
            board=lambda: self.board,
            pause_max_seconds=120.0,
            schedule=schedule or FakeScheduler(),
        )

    def submit_motion(self) -> str:
        return self.tasks.submit("robot.follow", Exclusivity.MOTION).task_id


def collect(kernel: EventKernel, filters: list[str] | None = None) -> list:
    events: list = []
    kernel.subscribe(filters or ["task.*", "safety.*"], events.append)
    return events


def make_motion_task(tasks: TaskExecutive) -> str:
    return tasks.submit("robot.follow", Exclusivity.MOTION).task_id


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
    rig = TaskRig()
    events = collect(rig.kernel)
    task_id = rig.submit_motion()

    paused = rig.tasks.pause(task_id)

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
    assert [t.task_id for t in rig.tasks.list()] == [task_id]


def test_paused_motion_task_does_not_report_moving_mode():
    rig = TaskRig()
    task_id = rig.submit_motion()
    assert rig.kernel.snapshot()["mode"] == "moving"

    rig.tasks.pause(task_id)

    # paused 仍占槽位（task_id 还在），但身体没在动。
    assert rig.kernel.snapshot()["mode"] == "idle"
    assert rig.kernel.snapshot()["task_id"] == task_id
    # 设备事件重算 mode 时也不能把 paused 说成 moving。
    rig.kernel.emit("device.changed", device="pump", state="off")
    assert rig.kernel.snapshot()["mode"] == "idle"


def test_pause_is_idempotent_and_does_not_duplicate_events():
    rig = TaskRig()
    task_id = rig.submit_motion()
    rig.tasks.pause(task_id)
    events = collect(rig.kernel)

    again = rig.tasks.pause(task_id)

    assert again.state is TaskState.PAUSED
    assert [ev.type for ev in events] == []


def test_resume_restores_same_task_without_restart():
    rig = TaskRig()
    task_id = rig.submit_motion()
    rig.tasks.pause(task_id)
    events = collect(rig.kernel)

    resumed = rig.tasks.resume(task_id)

    assert resumed.state is TaskState.RUNNING
    assert resumed.task_id == task_id
    assert resumed.pause_expires_at is None
    assert "pause_expires_at" not in resumed.to_public()
    types = [ev.type for ev in events]
    assert types == ["task.resumed"]
    assert events[0].payload["paused_ms"] >= 0
    # 判据 5：没有第二个 task.started，任务数不变。
    assert [t.task_id for t in rig.tasks.list()] == [task_id]
    assert rig.kernel.snapshot()["mode"] == "moving"


def test_resume_is_idempotent_while_running():
    rig = TaskRig()
    task_id = rig.submit_motion()
    events = collect(rig.kernel)
    assert rig.tasks.resume(task_id).state is TaskState.RUNNING
    assert events == []


@pytest.mark.parametrize("terminal", [TaskState.COMPLETED, TaskState.FAILED, TaskState.CANCELLED])
def test_terminal_task_cannot_pause_or_resume(terminal):
    rig = TaskRig()
    task_id = rig.submit_motion()
    rig.tasks.finish(task_id, terminal)
    with pytest.raises(RobotdError) as pause_err:
        rig.tasks.pause(task_id)
    assert pause_err.value.code is ErrorCode.STATE
    with pytest.raises(RobotdError) as resume_err:
        rig.tasks.resume(task_id)
    assert resume_err.value.code is ErrorCode.STATE


def test_soft_task_cannot_pause():
    rig = TaskRig()
    task = rig.tasks.submit("speech.listen", Exclusivity.SOFT)
    with pytest.raises(RobotdError) as err:
        rig.tasks.pause(task.task_id)
    assert err.value.code is ErrorCode.STATE


def test_soft_task_cannot_resume_either():
    """契约写的是 409/E_STATE：不能因为 soft 任务本来就 running 就返回 200。"""
    rig = TaskRig()
    task = rig.tasks.submit("speech.listen", Exclusivity.SOFT)
    with pytest.raises(RobotdError) as err:
        rig.tasks.resume(task.task_id)
    assert err.value.code is ErrorCode.STATE


def test_submit_lands_running_in_one_event():
    """GH-84：accepted → running 不再是不发事件的第二写入点。"""
    rig = TaskRig()
    task = rig.tasks.submit("robot.follow", Exclusivity.MOTION)
    assert task.state is TaskState.RUNNING
    assert [ev.type for ev in rig.kernel.recent_events()] == ["task.started"]


def test_paused_task_still_holds_motion_slot():
    rig = TaskRig()
    task_id = rig.submit_motion()
    rig.tasks.pause(task_id)
    with pytest.raises(RobotdError) as err:
        rig.tasks.submit("robot.follow", Exclusivity.MOTION)
    assert err.value.code is ErrorCode.BUSY


def test_finish_clears_pause_deadline():
    rig = TaskRig()
    task_id = rig.submit_motion()
    rig.tasks.pause(task_id)
    rig.tasks.finish(task_id, TaskState.CANCELLED, reason="stop")
    task = rig.tasks.get(task_id)
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
    task_id = make_motion_task(app.tasks)
    board.calls.clear()

    started = time.monotonic()
    paused = app.tasks.pause(task_id)
    elapsed = time.monotonic() - started

    assert paused.state is TaskState.PAUSED
    assert ("stop", {}) in board.calls
    # 判据 1：暂停调用同步下发 stop，300ms 内归零意图已经交给板侧。
    assert elapsed < 0.3, f"pause took {elapsed:.3f}s"
    assert app.tasks.get(task_id).state is TaskState.PAUSED
    app.shutdown()


def test_paused_is_not_mute_and_soft_tasks_still_start():
    """判据 5：暂停只改运动任务，不挡澄清/播报（它不是 mute）。"""
    app = make_app()
    task_id = make_motion_task(app.tasks)
    app.tasks.pause(task_id)

    assert app.audio.muted is False
    soft = app.tasks.submit("speech.listen", Exclusivity.SOFT)
    assert soft.task_id
    app.shutdown()


def test_pause_without_board_is_unavailable_and_keeps_task_running():
    app = App(Config(sim=True, serial_port=""), clock=FakeClock(), board=None)
    task_id = make_motion_task(app.tasks)
    with pytest.raises(RobotdError) as err:
        app.tasks.pause(task_id)
    assert err.value.code is ErrorCode.UNAVAILABLE
    assert app.tasks.get(task_id).state is TaskState.RUNNING


def test_pause_with_unready_link_fails_task_instead_of_pretending_paused():
    app = App(Config(sim=True, serial_port=""), clock=FakeClock(), board=FakeBoard())
    task_id = make_motion_task(app.tasks)  # 未 start()：link 不是 ready
    with pytest.raises(RobotdError) as err:
        app.tasks.pause(task_id)
    assert err.value.code is ErrorCode.LINK
    task = app.tasks.get(task_id)
    assert task.state is TaskState.FAILED
    assert task.reason == "lost_link"


def test_board_stop_failure_does_not_enter_paused():
    board = FakeBoard(fail_stop=True)
    app = make_app(board=board)
    task_id = make_motion_task(app.tasks)
    with pytest.raises(RobotdError) as err:
        app.tasks.pause(task_id)
    assert err.value.code is ErrorCode.LINK
    assert app.tasks.get(task_id).state is TaskState.FAILED
    app.shutdown()


def test_pause_without_a_deadline_never_stays_paused():
    """不变量：paused 一定有截止时间。定时器建不起来就按内部故障收尾。"""

    class BrokenScheduler(FakeScheduler):
        def __call__(self, delay_ms: int, fn: Callable[[], None]) -> Any:
            raise RuntimeError("no timer")

    app = make_app(scheduler=BrokenScheduler())
    task_id = make_motion_task(app.tasks)

    with pytest.raises(RobotdError) as err:
        app.tasks.pause(task_id)

    assert err.value.code is ErrorCode.INTERNAL
    task = app.tasks.get(task_id)
    assert task.state is TaskState.FAILED
    assert task.reason == "internal"
    app.shutdown()


def test_pause_expiry_cancels_and_announces_fixed_sentence():
    scheduler = FakeScheduler()
    audio = FakeAudio()
    board = FakeBoard()
    app = make_app(board=board, audio=audio, scheduler=scheduler)
    events = collect(app.kernel)
    task_id = make_motion_task(app.tasks)
    app.tasks.pause(task_id)
    assert [d for d, _ in scheduler.scheduled] == [120_000]
    stops_after_pause = sum(1 for op, _ in board.calls if op == "stop")

    scheduler.fire_all()

    task = app.tasks.get(task_id)
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
    task_id = make_motion_task(app.tasks)
    app.tasks.pause(task_id)

    scheduler.fire_all()

    expired = next(ev for ev in events if ev.type == "task.pause_expired")
    assert expired.payload == {"task_id": task_id, "announced": False}
    assert app.tasks.get(task_id).state is TaskState.CANCELLED
    app.shutdown()


def test_pause_expiry_after_resume_is_a_noop():
    scheduler = FakeScheduler()
    audio = FakeAudio()
    app = make_app(audio=audio, scheduler=scheduler)
    task_id = make_motion_task(app.tasks)
    app.tasks.pause(task_id)
    app.tasks.resume(task_id)

    scheduler.fire_all()

    assert app.tasks.get(task_id).state is TaskState.RUNNING
    assert audio.spoken == []
    app.shutdown()


def test_pause_expiry_still_cancels_when_the_event_cannot_be_emitted(monkeypatch):
    """事件写不进去只是时间线缺一条，任务不能因此留在没有定时器的 paused。"""
    scheduler = FakeScheduler()
    audio = FakeAudio()
    app = make_app(audio=audio, scheduler=scheduler)
    task_id = make_motion_task(app.tasks)
    app.tasks.pause(task_id)

    # 到期收尾是内核里的一次原子转移（检查 paused 与转终态同锁），
    # 所以注入点在 ``_emit_locked``，不是 ``emit``。
    real_emit = app.kernel._emit_locked

    def flaky_emit(type_: str, payload: Any):
        if type_ == "task.pause_expired":
            raise RuntimeError("event log unavailable")
        return real_emit(type_, payload)

    monkeypatch.setattr(app.kernel, "_emit_locked", flaky_emit)

    scheduler.fire_all()

    assert app.tasks.get(task_id).state is TaskState.CANCELLED
    assert app.tasks.get(task_id).reason == "pause_timeout"
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
    task_id = make_motion_task(app.tasks)
    app.tasks.pause(task_id)

    real_announce = app.announce_pause_expired

    def resume_during_announce() -> bool:
        announced = real_announce()
        app.tasks.resume(task_id)
        return announced

    app.announce_pause_expired = resume_during_announce  # type: ignore[method-assign]

    scheduler.fire_all()

    assert app.tasks.get(task_id).state is TaskState.RUNNING
    types = [ev.type for ev in events]
    assert "task.cancelled" not in types
    assert "task.pause_expired" not in types
    app.shutdown()


def test_expiry_winner_rejects_a_later_resume_with_state_error():
    """反向：到期先到就把任务收成 cancelled，之后的 resume 只能是 409，不许复活。"""
    scheduler = FakeScheduler()
    app = make_app(scheduler=scheduler)
    events = collect(app.kernel)
    task_id = make_motion_task(app.tasks)
    app.tasks.pause(task_id)

    scheduler.fire_all()

    assert app.tasks.get(task_id).state is TaskState.CANCELLED
    with pytest.raises(RobotdError) as err:
        app.tasks.resume(task_id)
    assert err.value.code is ErrorCode.STATE
    # 收尾幂等：再调一次原子转移不得重复发事件，也不得改写已终结的任务。
    assert app.tasks.expire_paused_task(task_id, announced=True) is False
    assert [ev.type for ev in events].count("task.cancelled") == 1
    app.shutdown()


def test_resume_with_unready_link_keeps_task_paused_and_bounded():
    """链路不通时不能声称「已恢复」：任务保持 paused，截止时间照旧生效。"""
    scheduler = FakeScheduler()
    app = make_app(scheduler=scheduler)
    task_id = make_motion_task(app.tasks)
    app.tasks.pause(task_id)
    app.state._apply_link(DeviceStatus.LOST)

    with pytest.raises(RobotdError) as err:
        app.tasks.resume(task_id)

    assert err.value.code is ErrorCode.LINK
    assert app.tasks.get(task_id).state is TaskState.PAUSED
    # 暂停上限没被误撤销：到期仍会收尾。
    assert app.tasks._pause_timers.get(task_id) is not None
    scheduler.fire_all()
    assert app.tasks.get(task_id).state is TaskState.CANCELLED
    app.shutdown()


def test_stop_cancels_paused_task_and_clears_timer():
    scheduler = FakeScheduler()
    app = make_app(scheduler=scheduler)
    task_id = make_motion_task(app.tasks)
    app.tasks.pause(task_id)

    result = app.safety.request_stop(reason="stop")

    assert result["stopped_tasks"] == 1
    assert app.tasks.get(task_id).state is TaskState.CANCELLED
    assert scheduler.cancelled >= 1
    assert app.tasks._pause_timers == {}
    scheduler.fire_all()  # 过期回调不得再动一个已取消任务
    # GH-57 起终态 reason 记结构化 cause；旧的 "stop" 文案映射为 user_stop_api。
    assert app.tasks.get(task_id).reason == "user_stop_api"
    app.shutdown()


def test_pause_then_resume_never_creates_second_task():
    scheduler = FakeScheduler()
    app = make_app(scheduler=scheduler)
    events = collect(app.kernel)
    task_id = make_motion_task(app.tasks)
    app.tasks.pause(task_id)
    app.tasks.resume(task_id)

    assert [t.task_id for t in app.tasks.list()] == [task_id]
    assert [ev.type for ev in events].count("task.started") == 1
    app.shutdown()
