"""能力注册表与调用入口。

分层（plan §2 的依赖纪律）：

- ``api`` 只做协议转换与调用；能力实现在 ``behaviors`` / ``devices`` / ``perception``。
- **能力注册表不是公开工具面**：公开工具面由 ``contracts/openapi.yaml`` 的 operationId 投影
  生成，不因内部新增条目而扩大。这条在旧 POC 里被打破过（`system.capabilities` 等 17 项
  内部能力虽未进 OpenAPI，却经 `/v1/debug/call` 完全可达）。
- 未实现的能力必须显式报 ``E_UNAVAILABLE``，**不受理后返回虚假完成**。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import Enum
from typing import Any, Awaitable, Callable, Mapping

from .core.errors import ErrorCode, RobotdError
from .core.kernel import EventKernel
from .core.types import Exclusivity

log = logging.getLogger("robotd.capabilities")


class Implementation(str, Enum):
    """实现程度。**用来防止把计划写成现状**。"""

    IMPLEMENTED = "implemented"
    PARTIAL = "partial"
    UNIMPLEMENTED = "unimplemented"


@dataclass(frozen=True)
class Capability:
    """一项能力。

    ``name`` 是**内部**名字，不保证等于公开 operationId；投影关系见 ``public_name``。
    """

    name: str
    public_name: str | None
    group: str
    implementation: Implementation
    summary: str
    exclusivity: Exclusivity = Exclusivity.SOFT
    requires_approval: bool = False
    # 审批凭据必须绑定的字段（契约 ``x-requires-approval.params`` 的实现侧镜像）。
    # 摘要规范化由 ``approval_digest`` 执行；这里只保存「绑定哪些字段」。
    approval_params: tuple[str, ...] = ()
    handler: Callable[..., Awaitable[Any]] | None = None
    unavailable_reason: str | None = None

    def check_available(self) -> None:
        if self.implementation is Implementation.UNIMPLEMENTED:
            raise RobotdError(
                ErrorCode.UNAVAILABLE,
                f"{self.name} 尚未实现：{self.unavailable_reason or '无实现'}",
                {"capability": self.name},
            )


def default_capabilities() -> list[Capability]:
    """当前实现进度对应的能力表。

    这份表**故意把未实现的项也列出来**并标 ``UNIMPLEMENTED``：
    调用方能拿到明确的 503 与原因，而不是 404「好像没这个功能」。
    """
    return [
        Capability(
            name="health",
            public_name="robot_health",
            group="discovery",
            implementation=Implementation.IMPLEMENTED,
            summary="服务存活与版本信息",
        ),
        Capability(
            name="robot.state",
            public_name="robot_state",
            group="discovery",
            implementation=Implementation.IMPLEMENTED,
            summary="机器人整体状态快照（含 event_seq 游标）",
        ),
        Capability(
            name="robot.stop",
            public_name="robot_stop",
            group="motion",
            implementation=Implementation.IMPLEMENTED,
            summary="有序停止：本地状态与任务表 + 板侧 stop 帧（无 id、幂等、可抢占）",
            exclusivity=Exclusivity.SOFT,
            requires_approval=False,
        ),
        # GH-74：最小位移切口。开环下发，不声称到位；板侧忙时返回 E_BUSY。
        Capability(
            name="robot.move",
            public_name="robot_move",
            group="motion",
            implementation=Implementation.IMPLEMENTED,
            summary="直线位移原语（距离 mm + 速度 mm/s）；开环下发，不报告是否到位",
            exclusivity=Exclusivity.MOTION,
            requires_approval=True,
            approval_params=("distance_mm", "speed_mm_s"),
        ),
        Capability(
            name="events.subscribe",
            public_name="events_subscribe",
            group="events",
            implementation=Implementation.IMPLEMENTED,
            summary="事件订阅：WS 快照-增量对齐、游标补发与 resync_required",
        ),
        Capability(
            name="task.get",
            public_name="task_get",
            group="tasks",
            implementation=Implementation.IMPLEMENTED,
            summary="查询任务状态",
        ),
        Capability(
            name="task.list",
            public_name="task_list",
            group="tasks",
            implementation=Implementation.IMPLEMENTED,
            summary="列出任务（可按状态过滤）",
        ),
        Capability(
            name="task.cancel",
            public_name="task_cancel",
            group="tasks",
            implementation=Implementation.IMPLEMENTED,
            summary="取消任务：运动任务取消联动 stop（板侧下发强度取决于板侧适配）",
        ),
        Capability(
            name="task.pause",
            public_name="task_pause",
            group="tasks",
            implementation=Implementation.IMPLEMENTED,
            summary=(
                "暂停运动任务：速度归零、位置保持、任务不终结；超过上限自动取消并播报"
                "（板侧 stop 下发强度取决于板侧适配）"
            ),
            requires_approval=False,
        ),
        Capability(
            name="task.resume",
            public_name="task_resume",
            group="tasks",
            implementation=Implementation.IMPLEMENTED,
            summary="从 paused 恢复原任务；不新建任务、不重新签发审批凭据",
            requires_approval=False,
        ),
        Capability(
            name="robot.calibration.get",
            public_name="robot_calibration_get",
            group="odometry",
            implementation=Implementation.UNIMPLEMENTED,
            summary="读取标定参数",
            unavailable_reason="串口与 hello 握手待 R11",
        ),
        Capability(
            name="robot.calibration.set",
            public_name="robot_calibration_set",
            group="odometry",
            implementation=Implementation.UNIMPLEMENTED,
            summary="设置标定参数并下发板侧",
            requires_approval=True,
            approval_params=("steps_per_m", "wheelbase_mm"),
            unavailable_reason="串口与 calib 下发待 R11",
        ),
        Capability(
            name="robot.follow",
            public_name="robot_follow",
            group="behavior",
            implementation=Implementation.UNIMPLEMENTED,
            summary="跟随目标人物（需要快速检测 + track + 安全边界）",
            exclusivity=Exclusivity.MOTION,
            requires_approval=True,
            approval_params=("target_track_id", "target"),
            unavailable_reason="依赖 R15 检测/跟踪、R16 安全边界、R17 闭环",
        ),
        # 语音（R14）：契约行为已实现，实际可用性取决于常驻桥是否就绪。
        # 「实现」与「此刻可用」是两件事：桥没起来时 check_available() 由 app 层
        # 报 E_UNAVAILABLE 并带原因，而不是把能力登记成未实现。
        Capability(
            name="robot.speak",
            public_name="robot_speak",
            group="speech",
            implementation=Implementation.IMPLEMENTED,
            summary="请求播报（分句流式 + 有界队列 + 可打断）",
            requires_approval=True,
            approval_params=("text",),
        ),
        # 审批复述是审批链路本身：免审批，但只接受结构化审批字段并由 robotd 渲染正文。
        # 它不是 Agent 可调用的能力，契约里标了 x-mcp-exclude，不进 MCP 工具面。
        Capability(
            name="robot.announce",
            public_name="robot_announce",
            group="speech",
            implementation=Implementation.IMPLEMENTED,
            summary="系统播报审批复述与澄清追问（免审批；不接受任意自由文本）",
            requires_approval=False,
        ),
        Capability(
            name="speech.listen",
            public_name="speech_listen",
            group="speech",
            implementation=Implementation.IMPLEMENTED,
            summary="流式听音（VAD 端点 + partial/final）",
        ),
        Capability(
            name="speech.abort",
            public_name="speech_abort",
            group="speech",
            implementation=Implementation.IMPLEMENTED,
            summary="中止当前播报（barge-in 的对外能力）；无活动播报时幂等返回 200",
        ),
        Capability(
            name="audio.state",
            public_name="audio_state",
            group="speech",
            implementation=Implementation.IMPLEMENTED,
            summary="音频现状",
        ),
        Capability(
            name="audio.mute",
            public_name="audio_mute",
            group="speech",
            implementation=Implementation.IMPLEMENTED,
            summary="暂停常听",
        ),
        Capability(
            name="audio.unmute",
            public_name="audio_unmute",
            group="speech",
            implementation=Implementation.IMPLEMENTED,
            summary="恢复常听",
        ),
    ]


class Registry:
    def __init__(self, caps: list[Capability] | None = None) -> None:
        self._caps = {c.name: c for c in (caps if caps is not None else default_capabilities())}

    def get(self, name: str) -> Capability:
        cap = self._caps.get(name)
        if cap is None:
            raise RobotdError(ErrorCode.NOT_FOUND, f"未知能力 {name}")
        return cap

    def by_public_name(self, public_name: str) -> Capability:
        for cap in self._caps.values():
            if cap.public_name == public_name:
                return cap
        raise RobotdError(ErrorCode.NOT_FOUND, f"未知操作 {public_name}")

    def all(self) -> list[Capability]:
        return list(self._caps.values())

    def status_report(self) -> list[dict[str, Any]]:
        """诊断视图（**只走 debug 旁路**，不属公开工具面）。"""
        return [
            {
                "name": c.name,
                "public_name": c.public_name,
                "group": c.group,
                "implementation": c.implementation.value,
                "requires_approval": c.requires_approval,
                "approval_params": list(c.approval_params),
                "exclusivity": c.exclusivity.value,
                "unavailable_reason": c.unavailable_reason,
            }
            for c in self._caps.values()
        ]


async def require_approval(cap: Capability, *, approved: bool) -> None:
    """审批门。**属性在契约里，判断在这里**——不依赖 Agent 自觉。

    当前只有一条规则：契约标了 ``x-requires-approval`` 就必须显式带审批。
    审批的**执行责任在 agentd 侧**（ADR-0007），robotd 只做「没有审批就拒绝」。
    """
    if cap.requires_approval and not approved:
        raise RobotdError(
            ErrorCode.APPROVAL,
            f"{cap.public_name or cap.name} 需要审批",
            {"capability": cap.name},
        )


def validate_known_fields(payload: Mapping[str, Any], allowed: set[str]) -> None:
    """未声明字段默认拒绝（契约 §3.1）。

    旧 POC 靠 openapi-backend 做这件事；Python 侧在能力入口再做一次，
    避免「绕过 HTTP 层直接调内部能力」时校验被跳过。
    """
    unknown = sorted(set(payload) - allowed)
    if unknown:
        raise RobotdError(
            ErrorCode.VALIDATION,
            f"未声明字段：{', '.join(unknown)}",
            {"unknown_fields": unknown},
        )


def kernel_of(app: Any) -> EventKernel:
    """便利访问器：capability handler 拿内核统一从这里取，避免各处直接抓 app 属性。"""
    kernel = getattr(app, "kernel", None)
    if not isinstance(kernel, EventKernel):
        raise RobotdError(ErrorCode.INTERNAL, "kernel 未装配")
    return kernel
