"""Execution Resource Arbiter（M0 最小实现）。

规则（与原内核任务表一致，只是不再由内核持有）：

- ``motion`` 任务独占 ``base_motion``：同一时刻至多一个未终结的运动任务，冲突
  ``409/E_BUSY``；暂停中的任务仍持有资源（新运动任务照样冲突），但不让
  ``mode`` 变成 moving。
- ``soft`` 任务按 capability 去重（``soft:<capability>``）：同一类软任务不能并行，
  不同类之间、以及与运动任务之间可以并存（「听」与「说」必须能同时存在）。

准入与释放都作用在 State Store 的工作副本上，由调用方在同一个原子提交里完成。
"""

from __future__ import annotations

from ..core.errors import ErrorCode, RobotdError
from ..core.state import BASE_MOTION, RobotStateStore
from ..core.types import Exclusivity, RobotTask

__all__ = ["BASE_MOTION", "ResourceArbiter"]


def soft_resource(capability: str) -> str:
    return f"soft:{capability}"


class ResourceArbiter:
    """M0 的逻辑资源准入。无内部可变状态：权威归属存在 State Store 里。"""

    def admit(self, state: RobotStateStore, task: RobotTask) -> None:
        if task.exclusivity is Exclusivity.MOTION:
            self._admit_motion(state, task)
            return
        self._admit_soft(state, task)

    def release(self, state: RobotStateStore, task: RobotTask) -> None:
        for resource, owner in list(state.resources.items()):
            if owner == task.task_id:
                state.resources.pop(resource, None)

    # ------------------------------------------------------------ 私有
    def _admit_motion(self, state: RobotStateStore, task: RobotTask) -> None:
        owner = self._live_owner(state, BASE_MOTION)
        if owner is not None:
            raise RobotdError(
                ErrorCode.BUSY,
                f"运动任务 {owner.task_id} 正在运行",
                {"task_id": owner.task_id},
            )
        state.resources[BASE_MOTION] = task.task_id

    def _admit_soft(self, state: RobotStateStore, task: RobotTask) -> None:
        resource = soft_resource(task.capability)
        owner = self._live_owner(state, resource)
        if owner is not None:
            raise RobotdError(
                ErrorCode.BUSY,
                f"同类任务 {owner.task_id} 正在运行",
                {"task_id": owner.task_id},
            )
        state.resources[resource] = task.task_id

    @staticmethod
    def _live_owner(state: RobotStateStore, resource: str) -> RobotTask | None:
        """资源持有者；持有者已终结/不存在时顺手释放（自愈，不让资源泄漏）。"""
        owner_id = state.resources.get(resource)
        if owner_id is None:
            return None
        owner = state.tasks.get(owner_id)
        if owner is None or owner.terminal:
            state.resources.pop(resource, None)
            return None
        return owner
