"""权威状态持有与派生。

**唯一写入方式**：``RobotStateStore`` 的 ``apply_*`` 方法由 ``EventKernel`` 调用。
对外只暴露 ``snapshot()``，返回不可变副本。

关键纪律（plan R05、ADR-0006）：

- ``mode`` 由 ``derive_mode()`` **单一推导**：链路不可用 → degraded；有排他运动任务 → moving；
  否则 idle。旧 TS 实现把这条三元表达式抄了五处，这里是唯一副本。
- ``pose.valid`` 只能由板复位 / 标定变更 / 未回零置 false，**不能**被「任务结束」顺带改回 true。
- ``battery`` 无权威源时 ``source=unimplemented`` 且值为 null，永不估算。
- ``odometry`` 未装编码器时实际值为 null，**应发步数不冒充实走位移**。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping

from .types import DeviceStatus, Pose, RobotMode, now_ms


def derive_mode(*, link_ready: bool, has_motion_task: bool) -> RobotMode:
    """``mode`` 的唯一推导函数。

    顺序即优先级：链路优先于任务。链路断了就是 degraded，不管有没有任务在跑——
    因为此时 robotd 已经无法保证「意图送达板侧」。
    """
    if not link_ready:
        return RobotMode.DEGRADED
    if has_motion_task:
        return RobotMode.MOVING
    return RobotMode.IDLE


@dataclass(frozen=True)
class Odometry:
    source: str = "open_loop"
    left_commanded: int = 0
    right_commanded: int = 0
    left_actual_encoder: int | None = None
    right_actual_encoder: int | None = None
    slip_ratio: float | None = None
    ts: int = 0

    def to_public(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "left_commanded": self.left_commanded,
            "right_commanded": self.right_commanded,
            "left_actual_encoder": self.left_actual_encoder,
            "right_actual_encoder": self.right_actual_encoder,
            "slip_ratio": self.slip_ratio,
            "ts": self.ts,
        }


@dataclass(frozen=True)
class Battery:
    source: str = "unimplemented"
    voltage: float | None = None
    percent: float | None = None

    def to_public(self) -> dict[str, Any]:
        return {"source": self.source, "voltage": self.voltage, "percent": self.percent}


@dataclass
class RobotStateStore:
    """机器人整体状态的唯一所有者。

    所有 ``_set_*`` 方法都是私有的设计意图标记：只允许 ``EventKernel`` 调用。
    （Python 没有真正的 private，这里用命名约定 + 单元测试约束，见 tests/unit/test_state.py）
    """

    robot_id: str
    transport: str

    mode: RobotMode = RobotMode.IDLE
    pose: Pose = field(default_factory=Pose)
    odometry: Odometry = field(default_factory=Odometry)
    battery: Battery = field(default_factory=Battery)

    esp32: DeviceStatus = DeviceStatus.STARTING
    camera: DeviceStatus = DeviceStatus.UNKNOWN
    audio: DeviceStatus = DeviceStatus.UNKNOWN
    pump: str = "unknown"

    firmware: str | None = None
    task_id: str | None = None
    ts: int = 0
    event_seq: int = 0
    version: int = 1

    #: 内部标记：是否已握手成功。**不进公开快照**
    link_ready: bool = False

    # ------------------------------------------------------------ 派生
    def recompute_mode(self, *, has_motion_task: bool) -> RobotMode:
        self.mode = derive_mode(link_ready=self.link_ready, has_motion_task=has_motion_task)
        return self.mode

    # ------------------------------------------------------------ 快照
    def snapshot(self, *, event_seq: int | None = None, ts: int | None = None) -> dict[str, Any]:
        """一致性快照。

        ``event_seq`` 由调用方（EventKernel）在**同一把锁内**传入，保证「快照 ↔ 游标」
        原子对应。这里不自己去问 kernel 要序号，避免两次读取之间插入新事件。
        """
        stamp = now_ms() if ts is None else ts
        seq = self.event_seq if event_seq is None else event_seq
        self.ts = stamp
        return {
            "robot_id": self.robot_id,
            "version": self.version,
            "mode": self.mode.value,
            "pose": self.pose.to_public(),
            "odometry": self.odometry.to_public(),
            "devices": self.devices_public(),
            "battery": self.battery.to_public(),
            "task_id": self.task_id,
            "firmware": self.firmware,
            "transport": self.transport,
            "ts": stamp,
            "event_seq": seq,
        }

    def devices_public(self) -> dict[str, Any]:
        return {
            "esp32": self.esp32.value,
            "camera": self.camera.value,
            "audio": self.audio.value,
            "pump": self.pump,
        }

    # ------------------------------------------------------------ 受控写入
    def _apply_link(self, status: DeviceStatus, firmware: str | None = None) -> None:
        self.esp32 = status
        self.link_ready = status is DeviceStatus.READY
        if firmware is not None:
            self.firmware = firmware

    def _apply_device(self, device: str, status: str) -> None:
        if device == "camera":
            self.camera = DeviceStatus(status)
        elif device == "audio":
            self.audio = DeviceStatus(status)
        elif device == "esp32":
            self._apply_link(DeviceStatus(status))
        elif device == "pump":
            self.pump = status
        else:
            raise KeyError(f"未知设备 {device}")

    def _apply_pose(self, pose: Pose) -> None:
        self.pose = pose

    def _invalidate_pose(self) -> None:
        self.pose = self.pose.invalidate()

    def _apply_odometry(self, **changes: Any) -> None:
        self.odometry = Odometry(
            source=changes.get("source", self.odometry.source),
            left_commanded=changes.get("left_commanded", self.odometry.left_commanded),
            right_commanded=changes.get("right_commanded", self.odometry.right_commanded),
            left_actual_encoder=changes.get("left_actual_encoder", self.odometry.left_actual_encoder),
            right_actual_encoder=changes.get("right_actual_encoder", self.odometry.right_actual_encoder),
            slip_ratio=changes.get("slip_ratio", self.odometry.slip_ratio),
            ts=now_ms(),
        )

    def _reset_odometry(self) -> None:
        """板复位：板侧步数归零，本地「应发」计数不再对应任何真实位移。"""
        self.odometry = Odometry(ts=now_ms())

    def _apply_battery(self, payload: Mapping[str, Any]) -> None:
        # 只有真正接上 BMS 并读到值时才允许改这两个数字
        voltage = payload.get("voltage")
        percent = payload.get("percent")
        if voltage is None or percent is None:
            self.battery = Battery()
            return
        self.battery = Battery(
            source=str(payload.get("source", "bms")), voltage=float(voltage), percent=float(percent)
        )

    def _apply_task_id(self, task_id: str | None) -> None:
        self.task_id = task_id

    def _apply_firmware(self, firmware: str | None) -> None:
        self.firmware = firmware
