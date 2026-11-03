# 实现规范与方案

此目录收录面向具体能力、可供实现与验收使用的技术方案。项目总体边界与跨模块架构以
[`../architecture.md`](../architecture.md) 和 [`../communication-protocol.md`](../communication-protocol.md)
为准；本目录文件不得覆盖这些单一事实源。

- [摄像头自动检测与配置（macOS / UVC 判定）](camera-detection.md) - 摄像头可用性判定、采集配置与排错步骤
- [robotd 对外接口契约 v1（设计稿）](robotd-interface-contract.md) - Python 迁移后的 HTTP/MCP、状态、WebSocket 事件、任务与安全时序约定
- [robotd Python 模块开发计划与任务清单](robotd-development-plan.md) - 六阶段任务表、依赖关系、逐任务 checklist 与迁移放行条件
- [robotd TS→Python 迁移差异矩阵](robotd-migration-matrix.md) - R01 产出：operationId/事件/桥/板侧依赖逐项登记、判定与承接任务
- [agentd 详细功能与用户界面设计（草案）](agentd-functional-design.md) - 意图与任务编排、独立高级模型配置、总览/任务/事件/设置线框、持久历史与安全边界
- [agentd 开发任务清单与界面交付计划](agentd-development-plan.md) - 六阶段 20 项首版任务、依赖与逐项验收；先交付可看可配入口，再开放动作闭环
