---
title: ADR-0008 robotd 用 Control Worker 隔离导航与管理事件循环
type: project
description: 为避免 HTTP、面板和配置工作阻塞 Nav/Motion，目标是在 robotd 内用 worker_threads 隔离控制循环，同时保持运行时状态与串口的单点所有权。
tags: [adr, robot, architecture, runtime, timing]
domain: robot
project: macmini-robot
adr_status: superseded by ADR-0009
date: 2026-10-20
sources: []
generated: { by: process:copilot-agent, at: 2026-10-20T13:05:00+08:00 }
relations:
  - predicate: part-of
    target: /README.md
  - predicate: depends-on
    target: /docs/architecture.md
  - predicate: depends-on
    target: /docs/communication-protocol.md
  - predicate: depends-on
    target: /docs/decisions/0006-robotd-event-driven-core.md
---

# ADR-0008 robotd 用 Control Worker 隔离导航与管理事件循环

> **2026-10-21 已被 [ADR-0009](0009-robotd-python-runtime.md) 取代**：robotd 新架构改用 Python，
> 不再采用本条的 Node `worker_threads` 方案。以下保留原提案；控制时序与安全要求继续有效，
> Python 的具体隔离机制另行设计。

## 背景

`Nav` / `Motion` 需要本地 10–50Hz 控制，而 robotd 同时处理 HTTP、Panel、设备管理与配置。
若这些工作共享一个 Node.js 事件循环，管理面上的同步耗时工作可能延迟控制更新。当前 POC
尚无 Worker 隔离，且导航闭环尚未完成；本文记录目标设计，不声称已经实现。

## 决策驱动

- P1：导航控制在 robotd 本地运行，不等待 Agent、网络或 VLM。
- P2：运行时状态与串口必须有唯一所有者。
- P3：软件调度失效时仍由 ESP32 看门狗自主停机。
- ADR-0006：robotd 继续采用单一事件归并点，不引入消息中间件或共享可变状态。

## 考虑的选项

- **A. 主线程直接运行 Nav / Motion**：当前 POC 形态；线程隔离不足，管理面阻塞会影响控制任务调度。
- **B. `worker_threads` Control Worker**：在同一个 robotd 进程内独立事件循环，消息通信保留单一运行时所有权。
- **C. 独立控制进程 / 消息中间件**：隔离更强，但增加进程部署、协议与故障协调成本；当前单机单板场景不采用。

## 决定

选择 **B（目标方案，状态 proposed）**：

- `robotd` 主线程负责 HTTP、Panel、配置与设备发现；一个 Control Worker 独占串口连接，并持有 `Nav`、
  `Motion`、运行时 `RobotState` 与活动 `Task` 的写权限。
- 主线程与 Worker 通过有界 `MessagePort` 交换命令、配置、State 与 Event；禁止共享可变状态。
- 普通命令队列有界且可背压；软件 `robot_stop` 走独立高优先级通道。Worker 每个控制周期先处理停止请求，
  不在 Nav 计算或网络/模型等待中阻塞。
- Control Worker 的基准周期为 20ms（50Hz），可按策略降至 10Hz；单周期计算预算不超过周期的 80%。
  感知输入采用最新值覆盖，不排队处理过期帧；Nav 输出超过 100ms 未更新时发有序停止。
- `robot_stop` 端到端目标 ≤50ms；若 Worker 或 host 停滞，板侧看门狗停机目标 ≤500ms。
  Worker 只提供软实时隔离；脉冲生成与最终失联停机仍由 ESP32 固件负责。
- 当前 POC 暂不实现此拆分；实现前 ADR 保持 proposed。届时需以控制线程阻塞、命令队列满、Worker 崩溃、
  停止延迟与板侧看门狗测试验证，并按结果接受或修订本 ADR。

## 后果

- **好**：管理面事件循环不再与控制 Worker 共用；状态与串口仍各有唯一所有者；不增加常驻进程或中间件。
- **坏**：引入线程间消息协议、队列背压和 Worker 生命周期管理；Node.js 仍不具备硬实时保证。
- **中性**：Worker 未实现前，POC 不能声称已获得上述隔离或时延保证。

## 怎么验证

- 在管理线程持续施加 HTTP/Panel 负载时，Control Worker 按目标周期运行，周期计算耗时不超过 80% 预算。
- 感知帧输入高于消费速率时，Worker 只处理最新帧，不积压旧帧。
- 普通命令队列满时显式返回过载；`robot_stop` 仍可被高优先级处理。
- Worker 卡死或退出时不再喂运动心跳，板侧在 500ms 内停机；`robot_stop` 端到端延迟不超过 50ms。
- 状态只有 Worker 写入；主线程通过消息收到快照/事件，不直接读写其内部对象。

## 相关资料

- [[../architecture|架构设计]] §6.2、§7.1、§10.5
- [[../communication-protocol|分层通信与接口设计]] §1、§7
- [[0006-robotd-event-driven-core|ADR-0006]] —— 事件归并与单点状态所有权
- [[0003-timing-constraints-layering|ADR-0003]] —— `robot_stop` 与看门狗时延预算
