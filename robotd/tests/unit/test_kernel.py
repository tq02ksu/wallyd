"""事件内核：序号、订阅竞态、补发窗口、过滤、终态不可回转、内部字段剔除。"""

from __future__ import annotations

import threading

import pytest

from robotd.core.errors import ErrorCode, RobotdError
from robotd.core.kernel import EventKernel, matches_filter
from robotd.core.state import RobotStateStore
from robotd.core.types import FORBIDDEN_PAYLOAD_KEYS, Exclusivity, TaskState


def make_kernel(**kwargs) -> EventKernel:
    st = RobotStateStore(robot_id="test-bot", transport="sim", **kwargs.pop("state_kwargs", {}))
    return EventKernel(state=st, instance_id="inst-test", **kwargs)


def state_fields(snap: dict, *, with_cursor: bool = False) -> dict:
    """快照里真正的状态字段。

    ``ts`` 是「这次读取的时刻」，不是状态；内部失败后仍会发一条 ``state.rejected``，
    所以那条路径还要忽略推进了一格的 ``event_seq`` 游标。
    """
    ignored = {"ts"} if with_cursor else {"ts", "event_seq"}
    return {key: value for key, value in snap.items() if key not in ignored}


def boom_at(step_name: str) -> object:
    """构造一个「归并走到某一步就抛错」的注入点。"""

    def hook(step: str) -> None:
        if step == step_name:
            raise RuntimeError(f"injected reduce failure at {step}")

    return hook


# ---------------------------------------------------------------- 过滤语义
@pytest.mark.parametrize(
    "filters,event_type,expected",
    [
        (["task.*"], "task.started", True),
        (["task.*"], "device.ready", False),
        (["task.started"], "task.started", True),
        (["task.started"], "task.progress", False),
        (["*"], "anything.at_all", True),
        # 「前缀写法不带点」的常见错误：task* 不应匹配 task.started
        (["task*"], "task.started", False),
        ([], "task.started", False),
    ],
)
def test_matches_filter(filters, event_type, expected):
    assert matches_filter(filters, event_type) is expected


# ---------------------------------------------------------------- 序号与封套
def test_seq_is_strictly_increasing():
    k = make_kernel()
    seqs = [k.emit("device.changed", device="pump", state="on").seq for _ in range(5)]
    assert seqs == sorted(seqs)
    assert len(set(seqs)) == 5
    assert k.last_seq == 5


def test_event_id_is_instance_scoped():
    k = make_kernel()
    ev = k.emit("device.changed", device="pump", state="on")
    assert ev.event_id == f"evt_inst-test_{ev.seq}"


def test_timestamp_is_iso_utc_with_milliseconds():
    ev = make_kernel().emit("device.changed", device="pump", state="on")
    assert ev.timestamp.endswith("Z")
    assert "." in ev.timestamp


def test_invalid_event_name_rejected():
    k = make_kernel()
    for bad in ("taskstarted", "Task.Started", ""):
        with pytest.raises(RobotdError):
            k.emit(bad)


# ---------------------------------------------------------------- 内部字段不外泄
def test_internal_keys_are_scrubbed_recursively():
    k = make_kernel()
    ev = k.emit(
        "speech.partial",
        payload={
            "utterance_id": "u1",
            "revision": 2,
            "text": "你好",
            "ts_mono_ns": 12345,
            "nested": {"mono_ns": 9, "keep": 1},
        },
    )
    pub = ev.to_public()
    flat = str(pub)
    assert "ts_mono_ns" not in flat
    assert "mono_ns" not in flat
    assert pub["payload"]["nested"] == {"keep": 1}
    assert pub["payload"]["text"] == "你好"


def test_event_object_keeps_mono_ns_but_public_view_drops_it():
    ev = make_kernel().emit("device.changed", device="pump", state="on")
    assert ev.mono_ns > 0
    assert "mono_ns" not in ev.to_public()


# ---------------------------------------------------------------- 订阅与竞态
def test_subscribe_does_not_replay_events_emitted_before_registration():
    """验收：订阅前 emit 3 条 → 订阅 → ``push`` 收到 0 条。

    订阅的语义是「注册之后才推送」。历史补发由 ``resume()`` 负责；
    ``Handle`` 里不再有恒空的 ``backlog`` 或无人读取的 ``cursor``。
    """
    k = make_kernel()
    for i in range(3):
        k.emit("device.changed", device="pump", state=f"s{i}")
    got: list = []
    handle = k.subscribe(["device.*"], got.append)
    assert handle.snapshot["event_seq"] == k.last_seq == 3
    assert got == []
    assert not hasattr(handle, "backlog")
    assert not hasattr(handle, "cursor")
    # 注册之前的历史只能由 resume() 补发，subscribe() 不碰这段窗口：
    # 两条路径各司其职，同一条事件不会被投递两次。
    verdict, replay = k.resume("inst-test", 0)
    assert verdict == "ok"
    assert [e.seq for e in replay] == [1, 2, 3]
    for i in range(2):
        k.emit("device.changed", device="pump", state=f"late{i}")
    handle.close()
    assert [e.seq for e in got] == [4, 5]
    # 快照 event_seq 之后的事件全收到了 → 没有洞
    assert got[0].seq == handle.snapshot["event_seq"] + 1


def test_subscription_registered_inside_lock_no_interleaving():
    """并发下快照与订阅之间不能丢事件。"""

    k = make_kernel()
    delivered: list = []
    errors: list[BaseException] = []

    def subscribe_many():
        try:
            for _ in range(20):
                k.subscribe(["*"], delivered.append).close()
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    def emit_many():
        for i in range(50):
            k.emit("device.changed", device="pump", state=f"v{i}")

    threads = [threading.Thread(target=subscribe_many), threading.Thread(target=emit_many)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors


def test_dead_subscriber_is_dropped_not_blocking():
    k = make_kernel()
    good: list = []
    k.subscribe(["*"], lambda _ev: (_ for _ in ()).throw(RuntimeError("boom")))
    k.subscribe(["*"], good.append)
    k.emit("device.changed", device="pump", state="on")
    k.emit("device.changed", device="pump", state="off")
    assert len(good) == 2  # 坏的被摘掉，好的照收
    assert k.stats()["subscriptions"] == 1


# ---------------------------------------------------------------- 补发判定
def test_resume_ok_within_window():
    k = make_kernel()
    for _ in range(5):
        k.emit("device.changed", device="pump", state="on")
    verdict, events = k.resume("inst-test", 2)
    assert verdict == "ok"
    assert [e.seq for e in events] == [3, 4, 5]


def test_resume_instance_changed():
    k = make_kernel()
    k.emit("device.changed", device="pump", state="on")
    verdict, events = k.resume("inst-other", 0)
    assert verdict == "instance_changed"
    assert events == []


def test_resume_cursor_expired():
    k = make_kernel(event_log_max=4)
    for _ in range(10):
        k.emit("device.changed", device="pump", state="on")
    verdict, events = k.resume("inst-test", 1)
    assert verdict == "cursor_expired"
    assert events == []


def test_resume_invalid_cursor():
    k = make_kernel()
    assert k.resume("inst-test", 999)[0] == "invalid_cursor"
    assert k.resume("inst-test", -1)[0] == "invalid_cursor"


# ---------------------------------------------------------------- 任务语义
def test_only_one_motion_task():
    k = make_kernel()
    k.new_task("robot.follow", Exclusivity.MOTION)
    with pytest.raises(RobotdError) as ei:
        k.new_task("robot.follow", Exclusivity.MOTION)
    assert ei.value.code is ErrorCode.BUSY
    assert ei.value.http_status == 409


def test_soft_tasks_can_coexist_with_motion():
    k = make_kernel()
    k.new_task("robot.follow", Exclusivity.MOTION)
    k.new_task("robot.speak", Exclusivity.SOFT)  # 听得见、说得动
    assert len(k.list_tasks()) == 2


def test_same_soft_capability_is_deduplicated():
    k = make_kernel()
    k.new_task("speech.listen", Exclusivity.SOFT)
    with pytest.raises(RobotdError):
        k.new_task("speech.listen", Exclusivity.SOFT)


def test_finish_is_idempotent_and_terminal_never_reverses():
    k = make_kernel()
    t = k.new_task("robot.follow", Exclusivity.MOTION)
    k.mark_running(t.task_id)
    k.finish(t.task_id, TaskState.COMPLETED)
    again = k.finish(t.task_id, TaskState.FAILED, reason="late")
    assert again.state is TaskState.COMPLETED
    assert again.error is None


def test_progress_after_terminal_is_ignored():
    k = make_kernel()
    t = k.new_task("robot.follow", Exclusivity.MOTION)
    k.finish(t.task_id, TaskState.CANCELLED, reason="stop")
    k.set_progress(t.task_id, 0.9)
    assert k.get_task(t.task_id).progress == 0.0


def test_unknown_task_raises_no_task():
    k = make_kernel()
    with pytest.raises(RobotdError) as ei:
        k.get_task("t-9999")
    assert ei.value.code is ErrorCode.NO_TASK
    assert ei.value.http_status == 404


def test_motion_task_clears_task_id_and_mode_on_finish():
    k = make_kernel()
    k.state.link_ready = True
    t = k.new_task("robot.follow", Exclusivity.MOTION)
    assert k.snapshot()["mode"] == "moving"
    assert k.snapshot()["task_id"] == t.task_id
    k.finish(t.task_id, TaskState.COMPLETED)
    snap = k.snapshot()
    assert snap["mode"] == "idle"
    assert snap["task_id"] is None


def test_task_lifecycle_events_emitted_in_order():
    k = make_kernel()
    seen: list[str] = []
    k.subscribe(["task.*"], lambda ev: seen.append(ev.type))
    t = k.new_task("robot.follow", Exclusivity.MOTION)
    k.set_progress(t.task_id, 0.5)
    k.finish(t.task_id, TaskState.CANCELLED, reason="stop")
    assert seen == ["task.started", "task.progress", "task.cancelled"]


# ---------------------------------------------------------------- 归并与状态
def test_device_ready_drives_state_and_mode():
    k = make_kernel()
    k.state.link_ready = False
    k.emit("device.ready", device="esp32", firmware="poc-2.1", after="connect")
    snap = k.snapshot()
    assert snap["devices"]["esp32"] == "ready"
    assert snap["firmware"] == "poc-2.1"
    assert snap["mode"] == "idle"


def test_device_lost_degrades_mode():
    k = make_kernel()
    k.emit("device.ready", device="esp32", firmware="poc-2.1")
    k.emit("device.lost", device="esp32", reason="timeout")
    assert k.snapshot()["mode"] == "degraded"


def test_board_reset_invalidates_pose_and_resets_odometry():
    k = make_kernel()
    k.emit("device.ready", device="esp32", firmware="poc-2.1")
    from robotd.core.state import Odometry
    from robotd.core.types import Pose

    k.state._apply_pose(Pose(x=1.2))
    k.state._apply_odometry(left_commanded=500, right_commanded=500)
    k.emit("device.reset", device="esp32", firmware="poc-2.1", pose_valid=False, odometry_reset=True)
    snap = k.snapshot()
    assert snap["pose"]["valid"] is False
    assert snap["odometry"]["left_commanded"] == 0
    assert isinstance(k.state.odometry, Odometry)


def test_motion_plan_does_not_move_pose():
    """应发步数不冒充实走位移。"""
    k = make_kernel()
    before = k.snapshot()["pose"]
    k.emit("motion.plan", task_id="t-1", left_steps=800, right_steps=800)
    assert k.snapshot()["pose"] == before


def test_snapshot_cursor_matches_last_seq():
    k = make_kernel()
    for _ in range(7):
        k.emit("device.changed", device="pump", state="on")
    snap = k.snapshot()
    assert snap["event_seq"] == k.last_seq == 7


# ---------------------------------------------------------------- 归并失败：先算后发（GH-17）
def test_invalid_device_name_rejected_without_side_effects():
    """验收 1：未知 device 是契约错误——不动序号、不进日志、不补发、不改状态。"""
    k = make_kernel()
    pushed: list = []
    k.subscribe(["*"], pushed.append)
    before = k.snapshot()

    with pytest.raises(ValueError) as ei:
        k.emit("device.lost", device="lidar")

    # 统一错误体：不再是越过 RobotdError 的 builtins.KeyError → 500/E_INTERNAL
    assert isinstance(ei.value, RobotdError)
    assert ei.value.code is ErrorCode.VALIDATION
    assert ei.value.http_status == 400

    assert k.last_seq == 0
    assert len(k._log) == 0
    assert k.resume("inst-test", 0) == ("ok", [])
    assert pushed == []
    assert state_fields(k.snapshot(), with_cursor=True) == state_fields(before, with_cursor=True)
    assert ei.value.to_public()["error"]["code"] == "E_VALIDATION"


def test_failed_emit_does_not_consume_seq():
    """失败不消耗序号：下一条成功事件仍然紧接上一条，「补 seq」对应真实因果。"""
    k = make_kernel()
    with pytest.raises(ValueError):
        k.emit("device.lost", device="lidar")

    ev = k.emit("device.ready", device="esp32", firmware="poc-2.1")
    assert ev.seq == 1
    assert k.last_seq == 1
    assert [item.seq for item in k.resume("inst-test", 0)[1]] == [1]


def test_rejection_record_keeps_keys_not_values():
    """被拒事件只留形状：{type, payload_keys, reason}，不含 payload 原文。"""
    k = make_kernel()
    with pytest.raises(ValueError):
        k.emit("device.lost", device="lidar")

    [record] = k.rejections()
    assert record == {"type": "device.lost", "payload_keys": ["device"], "reason": "unknown_device"}
    assert "lidar" not in str(record)
    assert k.stats()["rejections"] == 1


def test_pending_state_invisible_during_reduce():
    """验收 1：归并只写工作副本；发布之前 snapshot() 看不到 pending 状态。"""
    k = make_kernel()
    k.emit("device.ready", device="esp32", firmware="poc-2.1")
    seen: list[dict] = []

    def hook(step: str) -> None:
        if step == "device.reset.link":
            # 同一线程重入 RLock：读到的是权威状态，不是 pending 副本
            seen.append(k.snapshot())

    k.reduce_step_hook = hook
    k.emit("device.reset", device="esp32", firmware="poc-3.0", pose_valid=False, odometry_reset=True)
    k.reduce_step_hook = None

    assert seen and seen[0]["firmware"] == "poc-2.1"
    assert seen[0]["pose"]["valid"] is True
    # 只有发布那一刻才生效
    assert k.snapshot()["firmware"] == "poc-3.0"
    assert k.snapshot()["pose"]["valid"] is False


def test_device_reset_failure_restores_pose_and_odometry():
    """验收 3：device.reset 中途失败，pose 与 odometry 回到 emit 之前。"""
    from robotd.core.types import Pose

    k = make_kernel()
    k.emit("device.ready", device="esp32", firmware="poc-2.1")
    k.state._apply_pose(Pose(x=1.2, y=0.3, theta=0.1))
    k.state._apply_odometry(left_commanded=500, right_commanded=500)
    before = k.snapshot()

    k.reduce_step_hook = boom_at("device.reset.pose")
    with pytest.raises(RuntimeError, match="injected reduce failure"):
        k.emit(
            "device.reset",
            device="esp32",
            firmware="poc-9.9",
            pose_valid=False,
            odometry_reset=True,
        )
    k.reduce_step_hook = None

    after = k.snapshot()
    assert after["pose"] == before["pose"]
    assert after["pose"]["valid"] is True
    assert after["odometry"]["left_commanded"] == 500
    assert after["odometry"]["right_commanded"] == 500
    assert after["firmware"] == "poc-2.1"
    assert k.state.esp32.value == "ready"


def test_injected_reduce_failure_publishes_state_rejected_event():
    """验收 4/5：注入式归并失败，原事件丢弃，改发一条 state.rejected。"""
    k = make_kernel()
    pushed: list = []
    k.subscribe(["*"], pushed.append)
    first = k.emit("device.ready", device="esp32", firmware="poc-2.1")
    before = k.snapshot()

    k.reduce_step_hook = boom_at("device.reset.odometry")
    with pytest.raises(RuntimeError, match="injected reduce failure"):
        k.emit(
            "device.reset",
            device="esp32",
            firmware="poc-9.9",
            pose_valid=False,
            odometry_reset=True,
        )
    k.reduce_step_hook = None

    # 被拒事件本身不进日志、不补发；只有说明「这次归并没有生效」的 state.rejected
    assert [ev.type for ev in k._log] == ["device.ready", "state.rejected"]
    assert [ev.type for ev in pushed] == ["device.ready", "state.rejected"]
    verdict, replay = k.resume("inst-test", first.seq)
    assert verdict == "ok"
    assert [(ev.seq, ev.type) for ev in replay] == [(first.seq + 1, "state.rejected")]
    assert k.last_seq == first.seq + 1

    # 状态回到 emit 之前（游标推进了一条 state.rejected，其余字段逐字段相同）
    assert state_fields(k.snapshot()) == state_fields(before)
    assert k.stats()["rejections"] == 1

    rejected = k._log[-1]
    assert set(rejected.payload) == {"type", "payload_keys", "reason"}
    assert rejected.payload["type"] == "device.reset"
    assert rejected.payload["payload_keys"] == ["device", "firmware", "odometry_reset", "pose_valid"]
    assert rejected.payload["reason"] == "reduce_failed"
    assert not (set(rejected.payload) & FORBIDDEN_PAYLOAD_KEYS)
    assert "poc-9.9" not in str(rejected.to_public())


def test_state_rejected_has_no_payload_values():
    """验收 5：state.rejected 只带键名与原因，不带被拒 payload 的值。"""
    k = make_kernel()
    k.reduce_step_hook = boom_at("device.lost.apply")
    with pytest.raises(RuntimeError):
        k.emit("device.lost", device="camera", reason="unplugged-secret-marker")
    k.reduce_step_hook = None

    [record] = k.rejections()
    assert record == {
        "type": "device.lost",
        "payload_keys": ["device", "reason"],
        "reason": "reduce_failed",
    }
    assert "unplugged-secret-marker" not in str(record)
