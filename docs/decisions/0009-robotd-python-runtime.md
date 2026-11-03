---
title: ADR-0009 robotd 新架构采用 Python，为感知与 SLAM 扩展准备
type: project
description: robotd 从以 TypeScript 编排与 I/O 为主的路线转向 Python，优先服务感知、定位与导航扩展；保留模型进程隔离与现有对外契约，具体控制隔离方案另行设计。
tags: [adr, robot, architecture, runtime]
domain: robot
project: macmini-robot
adr_status: accepted
date: 2026-10-21
sources: []
generated: { by: process:copilot-agent, at: 2026-10-21T07:38:05+08:00 }
relations:
  - predicate: part-of
    target: /README.md
---

# ADR-0009 robotd 新架构采用 Python，为感知与 SLAM 扩展准备

## 背景

现有 `robotd` 是 TypeScript POC，承担设备、状态、任务与运动控制编排；原选型以 HTTP、
面板与 I/O 开发便利为主要考虑。随着目标扩展到快速视觉感知、定位建图与自主导航，
需要重新选择身体侧运行时的主要开发语言。用户于 2026-10-21 确认新架构采用 Python。

当前设计优先使用 macOS Vision，YOLO 是类别不足时的候选扩展，SLAM 尚未实现；
不能将这些候选能力表述为已接入。MiniCPM 由独立 `modeld` 承载，模型延迟证据见
[视觉延迟实测](../../eval/vision-latency.md)，不构成将其纳入控制周期的依据。

## 决策驱动

- 身体侧未来要连接图像处理、快速检测、里程计、SLAM 与导航，降低 Python / 原生算法库的接入成本。
- 保持身体状态、串口与运动任务的单点所有权，不因语言迁移改变职责边界。
- 慢推理和重计算不阻塞控制、停止与心跳路径；最终失联停机仍由 ESP32 负责。
- 保留现有对外契约及行为，让语言迁移与新算法接入可以分别验证。

## 考虑的选项

- **A. 保持 TypeScript robotd，算法全部通过 Python / C++ 桥接**：延续当前投入，
  但身体侧算法扩展时需持续维护跨语言适配。
- **B. Python 作为 robotd 主语言，重计算使用原生库或独立工作进程**：更贴近感知与导航开发方式，
  代价是现有 TS 实现迁移、部署依赖和控制隔离设计。
- **C. Python robotd 与 MiniCPM 合并为单进程**：减少一个服务边界，
  但模型故障、内存压力和重启会影响身体运行时；语言统一不要求进程合并。

## 决定

选择 **B**：**新架构的 `robotd` 以 Python 开发**。本条接受语言方向，不代表迁移已经完成。

- `robotd` 仍是身体运行时，不是某个模型；管理设备、状态、任务与运动，并编排感知、定位和导航。
  SLAM 是定位建图能力，YOLO 是检测能力，均不替代 `robotd`。
- Python 负责运行时与算法编排；重计算可由 C++ / 原生库 / 推理后端承担，不要求纯 Python 实现。
  本次不选定 YOLO、SLAM 实现、ROS 2、传感器组合或新增工作进程拓扑。
- `modeld` 保持独立进程，主要供 `robotd` 调用 MiniCPM 等慢速语义模型；
  `agentd` 可以独立配置可选的更高级模型，不要求全部模型经 `modeld` 统一接入。
  `agentd`、Panel 的 TS 选型及 Swift 原生桥不因本条改变；更高级模型的配置仍须遵守本地数据约束。
- 保留 HTTP / WS、MCP 能力面与 ESP32 线协议；语言迁移本身不改变工具名、审批、错误、
  任务生命周期或停止语义。契约仍以 `contracts/openapi.yaml` 为单一来源。
- [ADR-0008](0008-robotd-control-worker.md) 的 Node `worker_threads` 目标方案被本条取代；
  快慢分离、单写者、有界背压、停止优先和板侧看门狗要求继续保留。
  Python 的具体控制隔离机制另行设计，不能直接把 Python 线程等同于 Node Worker。
- 控制周期不等待模型、抓帧或 SLAM；感知与定位异步提供带时间戳、有效性的最新结果，
  过期或不可用时显式降级并按策略停止，不积压旧帧或运动指令。
  原有控制周期与停止时延目标不因迁移放宽，达标前不宣称具备相应保证。

## 后果

- **好**：身体侧围绕 Python 组织感知与导航开发，减少将算法接入 TS 的胶水；
  模型与控制仍可独立演进和重启。
- **坏**：需要迁移现有 TS 运行时及适配层，维护 Python 环境，并重新验证控制调度与故障处理；
  选用的原生库仍须核实 macOS / Apple Silicon 支持。
- **中性**：项目不再追求宿主侧统一 TS；现有 TS POC、启动脚本和历史实测保留，迁移前继续描述现状。
  SLAM 能否落地还依赖传感器、标定、时间同步与实际算法支持，不由语言选型保证。

## 怎么验证

以下是后续迁移的验收条件，不是本次已完成的测试：

- 用相同契约用例验证 Python 版本的状态查询、事件订阅、审批、任务互斥、取消、停止和错误行为，
  与现有实现对照；仿真通过后再做真机回归。
- 在 HTTP / 面板负载、感知输入过载和慢模型推理期间测控制周期与停止时延，
  按[架构设计 §10.5](../architecture.md#105-移动控制vlm-不负责开车导航策略层-nav)的预算验收。
- 注入模型进程退出、推理超时、感知/位姿过期、控制路径停滞及串口断连；
  断言明确报错或降级，控制失效时停止运动心跳，由板侧看门狗兜底。
- 验证串口与运动状态只有一个写入者；普通队列有界，停止请求不被普通任务或慢推理阻塞。
- 在目标 Mac 上验证候选感知/SLAM 后端的安装、运行和输入输出；证据落 `eval/`，
  原始数据及临时材料落项目 `work/`，再据此确定具体算法与隔离机制。

## 相关资料

- [架构设计](../architecture.md) §6、§10.3、§10.5 —— 原语言分工与感知/导航边界
- [分层通信与接口设计](../communication-protocol.md) —— 对外契约与控制时序要求
- [ADR-0001](0001-vision-fast-slow.md) —— 快速检测与慢速语义理解分离
- [ADR-0006](0006-robotd-event-driven-core.md) —— 事件归并与状态单点持有（proposed）
- [ADR-0008](0008-robotd-control-worker.md) —— 被取代的 Node Control Worker 方案
- [视觉延迟实测](../../eval/vision-latency.md) —— 现有硬件上的感知路径证据
