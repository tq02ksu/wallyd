"""robotd —— 机器人身体运行时（Python 实现）。

迁移期约定（见 docs/spec/robotd-development-plan.md 与 ADR-0009）：

- 本包与旧的 TypeScript POC（``src/``）**并存**，两者可分别测试；
  但**同一个串口只能有一个实际持有者**，不得同时连真机。
- 对外契约只有一份：``contracts/openapi.yaml``（+ ``contracts/events.json``）。
  本包不定义第二套对外形状。
- 当前实现程度：工程骨架 + 事件归并内核的最小实现（R04/R05 起步）。
  HTTP/WS 传输、板侧适配、控制隔离**尚未实现**，见 ``Capability`` 的枚举。
"""

from __future__ import annotations

__all__ = ["__version__", "PROTO_VERSION", "SERVICE_NAME", "CONTRACT_VERSION"]

#: 服务实现版本，对应契约 RobotState.version / Health.version
__version__ = "0.1.0"
CONTRACT_VERSION = 1

#: 板侧线协议版本（与 firmware/robot_server_v2.py 的 PROTO 一致）
PROTO_VERSION = 2

SERVICE_NAME = "robotd"
