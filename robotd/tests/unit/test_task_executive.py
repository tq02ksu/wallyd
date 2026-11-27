"""Task Executive：任务/动作回合的权威转移、资源准入与原子提交。"""

from __future__ import annotations

import pytest

from robotd.core.errors import ErrorCode, RobotdError
from robotd.core.kernel import EventKernel
from robotd.core.state import RobotStateStore
from robotd.core.types import Exclusivity, TaskState
from robotd.motion.arbiter import ResourceArbiter
from robotd.task.executive import TaskExecutive
from tests.helpers import FakeBoard, FakeClock


def make_executive(**kernel_kwargs) -> tuple[EventKernel, TaskExecutive]:
    st = RobotStateStore(robot_id="test-bot", transport="sim")
    kernel = EventKernel(state=st, instance_id="inst-task", **kernel_kwargs)
    tasks = TaskExecutive(kernel, ResourceArbiter(), clock=FakeClock(), board=lambda: FakeBoard())
    return kernel, tasks


def test_only_one_motion_task():
    _kernel, tasks = make_executive()
    tasks.submit("robot.follow", Exclusivity.MOTION)
    with pytest.raises(RobotdError) as ei:
        tasks.submit("robot.follow", Exclusivity.MOTION)
    assert ei.value.code is ErrorCode.BUSY
    assert ei.value.http_status == 409


def test_soft_tasks_can_coexist_with_motion():
    _kernel, tasks = make_executive()
    tasks.submit("robot.follow", Exclusivity.MOTION)
    tasks.submit("robot.speak", Exclusivity.SOFT)  # 听得见、说得动
    assert len(tasks.list()) == 2


def test_same_soft_capability_is_deduplicated():
    _kernel, tasks = make_executive()
    tasks.submit("speech.listen", Exclusivity.SOFT)
    with pytest.raises(RobotdError) as ei:
        tasks.submit("speech.listen", Exclusivity.SOFT)
    assert ei.value.code is ErrorCode.BUSY


def test_finish_is_idempotent_and_terminal_never_reverses():
    _kernel, tasks = make_executive()
    task = tasks.submit("robot.follow", Exclusivity.MOTION)
    tasks.finish(task.task_id, TaskState.COMPLETED)
    again = tasks.finish(task.task_id, TaskState.FAILED, reason="late")
    assert again.state is TaskState.COMPLETED
    assert again.error is None


def test_progress_after_terminal_is_ignored():
    _kernel, tasks = make_executive()
    task = tasks.submit("robot.follow", Exclusivity.MOTION)
    tasks.finish(task.task_id, TaskState.CANCELLED, reason="stop")
    tasks.set_progress(task.task_id, 0.9)
    assert tasks.get(task.task_id).progress == 0.0


def test_unknown_task_raises_no_task():
    _kernel, tasks = make_executive()
    with pytest.raises(RobotdError) as ei:
        tasks.get("t-9999")
    assert ei.value.code is ErrorCode.NO_TASK
    assert ei.value.http_status == 404


def test_motion_task_clears_task_id_and_mode_on_finish():
    kernel, tasks = make_executive()
    kernel.state.link_ready = True
    task = tasks.submit("robot.follow", Exclusivity.MOTION)
    assert kernel.snapshot()["mode"] == "moving"
    assert kernel.snapshot()["task_id"] == task.task_id
    tasks.finish(task.task_id, TaskState.COMPLETED)
    snap = kernel.snapshot()
    assert snap["mode"] == "idle"
    assert snap["task_id"] is None


def test_task_lifecycle_events_emitted_in_order():
    kernel, tasks = make_executive()
    seen: list[str] = []
    kernel.subscribe(["task.*"], lambda ev: seen.append(ev.type))
    task = tasks.submit("robot.follow", Exclusivity.MOTION)
    tasks.set_progress(task.task_id, 0.5)
    tasks.finish(task.task_id, TaskState.CANCELLED, reason="stop")
    assert seen == ["task.started", "task.progress", "task.cancelled"]


def test_task_and_action_episode_are_recorded_in_the_same_store():
    """State Store 持有 RobotTask 与 ActionEpisode 的权威记录。"""
    kernel, tasks = make_executive()
    task = tasks.submit("robot.follow", Exclusivity.MOTION)

    def records(state: RobotStateStore):
        return state.tasks[task.task_id], state.episodes[task.episode_id]

    stored_task, episode = kernel.read(records)
    assert stored_task.capability == "robot.follow"
    assert episode.task_id == task.task_id
    assert episode.action == "robot.follow"
    assert episode.open

    tasks.finish(task.task_id, TaskState.COMPLETED)
    _, episode = kernel.read(records)
    assert episode.finished_at is not None
    assert episode.outcome == "completed"


def test_terminal_finish_emits_no_second_event():
    kernel, tasks = make_executive()
    task = tasks.submit("robot.follow", Exclusivity.MOTION)
    tasks.finish(task.task_id, TaskState.CANCELLED, reason="stop")
    before = kernel.last_seq
    events: list = []
    kernel.subscribe(["task.*"], events.append)

    tasks.finish(task.task_id, TaskState.FAILED, reason="late")

    assert kernel.last_seq == before
    assert events == []


def test_rejected_admission_commits_nothing():
    """准入失败（E_BUSY）不消耗序号、不留任务/回合记录。"""
    kernel, tasks = make_executive()
    tasks.submit("robot.follow", Exclusivity.MOTION)
    seq = kernel.last_seq

    with pytest.raises(RobotdError):
        tasks.submit("robot.follow", Exclusivity.MOTION)

    assert kernel.last_seq == seq
    assert len(kernel.read(lambda state: state.tasks)) == 1
    assert len(kernel.read(lambda state: state.episodes)) == 1


# ---------------------------------------------------------------- 音频完成策略
def test_utterance_completion_maps_outcomes_to_task_states():
    """收尾策略从 App 移到这里：失败/取消/completed 必须分得清。"""
    _kernel, tasks = make_executive()

    failed = tasks.submit("speech.listen", Exclusivity.SOFT)
    tasks.utterance_finished(failed.task_id, "failed", "engine_error")
    record = tasks.get(failed.task_id)
    assert record.state is TaskState.FAILED
    assert record.reason == "engine_error"
    assert record.error is not None and record.error.code == "E_UNAVAILABLE"
    assert "engine_error" in record.error.message

    cancelled = tasks.submit("speech.listen", Exclusivity.SOFT)
    tasks.utterance_finished(cancelled.task_id, "cancelled", "speaking")
    record = tasks.get(cancelled.task_id)
    assert record.state is TaskState.CANCELLED
    assert record.reason == "speaking"

    completed = tasks.submit("speech.listen", Exclusivity.SOFT)
    tasks.utterance_finished(completed.task_id, "completed", None)
    assert tasks.get(completed.task_id).state is TaskState.COMPLETED


def test_completion_port_ignores_unknown_or_missing_task_ids():
    """自动续听轮没有任务；晚到的完成回调不能炸掉音频层。"""
    _kernel, tasks = make_executive()
    tasks.utterance_finished(None, "completed", None)
    tasks.response_finished(None, "completed")
    tasks.utterance_finished("t-9999", "completed", None)
    tasks.response_finished("t-9999", "completed")


def test_response_completion_maps_outcomes_to_task_states():
    _kernel, tasks = make_executive()

    failed = tasks.submit("robot.speak", Exclusivity.SOFT)
    tasks.response_finished(failed.task_id, "failed")
    record = tasks.get(failed.task_id)
    assert record.state is TaskState.FAILED
    assert record.reason == "bridge_exit"
    assert record.error is not None and record.error.code == "E_UNAVAILABLE"

    interrupted = tasks.submit("robot.speak", Exclusivity.SOFT)
    tasks.response_finished(interrupted.task_id, "cancelled")
    record = tasks.get(interrupted.task_id)
    assert record.state is TaskState.CANCELLED
    assert record.reason == "interrupted"

    completed = tasks.submit("robot.speak", Exclusivity.SOFT)
    tasks.response_finished(completed.task_id, "completed")
    assert tasks.get(completed.task_id).state is TaskState.COMPLETED


def test_audio_start_failure_and_abort_outcomes_live_in_the_executive():
    """handler 只调端口：失败收尾与 abort 语义由 Task Executive 决定。"""
    _kernel, tasks = make_executive()

    broken = tasks.submit("robot.speak", Exclusivity.SOFT)
    tasks.audio_unavailable(broken.task_id, RuntimeError("bridge lost"))
    record = tasks.get(broken.task_id)
    assert record.state is TaskState.FAILED
    assert record.reason == "audio_unavailable"
    assert record.error is not None
    assert record.error.code == "E_UNAVAILABLE"
    assert record.error.message == "bridge lost"

    idle_abort = tasks.submit("speech.abort", Exclusivity.SOFT)
    tasks.abort_finished(idle_abort.task_id, played=False)
    record = tasks.get(idle_abort.task_id)
    assert record.state is TaskState.COMPLETED
    assert record.reason == "no_active_playback"

    played_abort = tasks.submit("speech.abort", Exclusivity.SOFT)
    tasks.abort_finished(played_abort.task_id, played=True)
    assert tasks.get(played_abort.task_id).reason == "aborted"


def test_episode_outcome_follows_the_audio_completion():
    kernel, tasks = make_executive()
    task = tasks.submit("speech.listen", Exclusivity.SOFT)
    tasks.utterance_finished(task.task_id, "cancelled", "speaking")
    episode = kernel.read(lambda state: state.episodes[task.episode_id])
    assert episode.outcome == "cancelled"
    assert episode.reason == "speaking"
    assert not episode.open
