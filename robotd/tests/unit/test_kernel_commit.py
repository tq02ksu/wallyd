"""``EventKernel.commit`` 的原子提交契约（GH-84 要求保留的部分）。

内核只负责「plan 算完 → 一次性发布」：成功时消耗一个序号、进日志、分发；
``plan`` 返回 ``None`` 或抛错时不消耗序号、不改权威状态、不进日志。
任务转移的具体规则由 Task Executive 测（``test_task_executive.py``）。
"""

from __future__ import annotations

import pytest

from robotd.core.errors import EventContractError
from robotd.core.kernel import EventKernel
from robotd.core.state import RobotStateStore


def make_kernel() -> EventKernel:
    state = RobotStateStore(robot_id="test-bot", transport="sim")
    return EventKernel(state=state, instance_id="inst-test")


def state_without_ts(kernel: EventKernel) -> dict:
    return {key: value for key, value in kernel.snapshot().items() if key != "ts"}


def test_commit_publishes_state_sequence_log_and_subscribers():
    kernel = make_kernel()
    seen: list[str] = []
    kernel.subscribe(["*"], lambda ev: seen.append(ev.type))

    event = kernel.commit("safety.stopped", lambda _st: {"reason": "test"})

    assert event is not None
    assert event.seq == 1
    assert kernel.last_seq == 1
    assert [ev.type for ev in kernel.recent_events()] == ["safety.stopped"]
    assert seen == ["safety.stopped"]


def test_commit_plan_sees_the_staged_store_and_writes_land():
    kernel = make_kernel()

    kernel.commit("safety.stopped", lambda st: st.resources.update({"base_motion": "t1"}) or {"ok": True})

    assert kernel.read(lambda st: dict(st.resources)) == {"base_motion": "t1"}


def test_commit_plan_returning_none_commits_nothing():
    kernel = make_kernel()
    before = state_without_ts(kernel)

    assert kernel.commit("safety.stopped", lambda _st: None) is None

    assert kernel.last_seq == 0
    assert kernel.recent_events() == []
    assert state_without_ts(kernel) == before


def test_commit_plan_failure_rolls_back_the_working_copy():
    """``plan`` 抛错时副本丢弃：序号、日志、权威状态都不能留下痕迹。"""
    kernel = make_kernel()
    before = state_without_ts(kernel)

    def plan(st: RobotStateStore) -> dict:
        st.resources["base_motion"] = "ghost"
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        kernel.commit("safety.stopped", plan)

    assert kernel.last_seq == 0
    assert kernel.recent_events() == []
    assert kernel.read(lambda st: dict(st.resources)) == {}
    assert state_without_ts(kernel) == before


def test_commit_rejects_unregistered_event_before_consuming_a_sequence():
    kernel = make_kernel()

    with pytest.raises(EventContractError):
        kernel.commit("task.not_a_real_event", lambda _st: {})

    assert kernel.last_seq == 0
    assert kernel.recent_events() == []
