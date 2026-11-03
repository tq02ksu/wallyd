"""状态推导与「不知道就是不知道」的红线。"""

from __future__ import annotations

import pytest

from robotd.core.state import RobotStateStore, derive_mode
from robotd.core.types import DeviceStatus, Pose, RobotMode


def make_store(**kwargs) -> RobotStateStore:
    return RobotStateStore(robot_id="test-bot", transport="sim", **kwargs)


# ---------------------------------------------------------------- derive_mode 唯一推导
@pytest.mark.parametrize(
    "link_ready,task,expected",
    [
        (False, False, RobotMode.DEGRADED),
        (False, True, RobotMode.DEGRADED),  # 链路优先于任务
        (True, False, RobotMode.IDLE),
        (True, True, RobotMode.MOVING),
    ],
)
def test_derive_mode_is_link_first(link_ready, task, expected):
    assert derive_mode(link_ready=link_ready, has_motion_task=task) is expected


def test_recompute_uses_the_same_function():
    st = make_store()
    st.link_ready = False
    assert st.recompute_mode(has_motion_task=True) is RobotMode.DEGRADED
    st.link_ready = True
    assert st.recompute_mode(has_motion_task=True) is RobotMode.MOVING
    assert st.recompute_mode(has_motion_task=False) is RobotMode.IDLE


# ---------------------------------------------------------------- 红线：不凭空造数
def test_battery_is_unimplemented_with_null_measurements():
    st = make_store()
    pub = st.snapshot()
    assert pub["battery"] == {"source": "unimplemented", "voltage": None, "percent": None}


def test_battery_rejects_partial_data():
    st = make_store()
    st._apply_battery({"voltage": 12.4})  # 只有电压没有比例
    assert st.snapshot()["battery"]["source"] == "unimplemented"
    assert st.snapshot()["battery"]["voltage"] is None


def test_odometry_never_substitutes_commanded_for_actual():
    st = make_store()
    st._apply_odometry(left_commanded=800, right_commanded=800)
    odo = st.snapshot()["odometry"]
    assert odo["left_commanded"] == 800
    assert odo["left_actual_encoder"] is None
    assert odo["slip_ratio"] is None


def test_camera_starts_unknown_not_absent():
    st = make_store()
    assert st.snapshot()["devices"]["camera"] == DeviceStatus.UNKNOWN.value


def test_pump_starts_unknown():
    assert make_store().snapshot()["devices"]["pump"] == "unknown"


# ---------------------------------------------------------------- pose 失效语义
def test_pose_invalidate_is_sticky_until_explicitly_reset():
    st = make_store()
    st._apply_pose(Pose(x=1.0, y=2.0, theta=0.5))
    st._invalidate_pose()
    assert st.snapshot()["pose"]["valid"] is False
    # 读数还在，只是被标为不可信
    assert st.snapshot()["pose"]["x"] == 1.0
    st._apply_pose(Pose())  # 显式回零
    assert st.snapshot()["pose"]["valid"] is True


def test_board_reset_clears_odometry_and_invalidates_pose():
    st = make_store()
    st._apply_pose(Pose(x=0.7))
    st._apply_odometry(left_commanded=1234, right_commanded=1234)
    st._reset_odometry()
    st._invalidate_pose()
    pub = st.snapshot()
    assert pub["odometry"]["left_commanded"] == 0
    assert pub["pose"]["valid"] is False


# ---------------------------------------------------------------- 快照字段完整性
def test_snapshot_contains_all_required_fields():
    st = make_store()
    pub = st.snapshot()
    for key in (
        "robot_id",
        "version",
        "mode",
        "pose",
        "odometry",
        "devices",
        "battery",
        "task_id",
        "firmware",
        "transport",
        "ts",
        "event_seq",
    ):
        assert key in pub, f"缺字段 {key}"


def test_snapshot_has_no_internal_flags():
    st = make_store()
    st.link_ready = True
    assert "link_ready" not in st.snapshot()
    assert "_t0_mono_ns" not in str(st.snapshot())


def test_snapshot_units_are_declared_by_name():
    """角度是弧度、距离是米——靠字段名挡不住，靠 ch/文档；这里锁住「不做度/c 混用」。"""
    st = make_store()
    st._apply_pose(Pose(theta=3.14159))
    assert st.snapshot()["pose"]["theta"] == pytest.approx(3.14159)
