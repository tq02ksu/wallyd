---
title: ADR-0006 robotd 以事件循环为内核、状态单点持有；进程间以「订阅」而非「查询」互联
type: project
description: 回答「robotd 该不该做成消息队列为底层」——不该引消息中间件，该做的是「事件循环内核 + 状态单点持有 + 契约化订阅」。内核对串口/子进程/定时器/HTTP 四类输入做统一事件归并，所有派生状态由事件变更驱动；对外只暴露「订阅一次拿到状态 + 增量」的组合语义，禁止调用方自己拼状态。
tags: [adr, robot, architecture, event-driven, state]
domain: robot
project: macmini-robot
adr_status: proposed
date: 2026-10-18
sources: []
generated: { by: assistant:workbuddy, at: 2026-10-18T23:40:00+08:00 }
relations:
  - predicate: part-of
    target: /projects/robot/README.md
  - predicate: depends-on
    target: /projects/robot/doc/decisions/0007-agentd-robotd-boundary.md
  - predicate: depends-on
    target: /projects/robot/doc/communication-protocol.md
  - predicate: relates-to
    target: /projects/robot/src/runtime/robot-runtime.ts
---

# ADR-0006 robotd 以事件循环为内核、状态单点持有

## 背景

当前 robotd 的运行时（`src/runtime/robot-runtime.ts`，1918 行）已经在做**事实上的事件归并**，
但这件事没有被命名、也没有被约束成纪律。逐行读代码可以看出它实际有四类输入源：

| 输入源 | 进入方式 | 代码位置 |
| --- | --- | --- |
| 板侧串口行 | `BoardLink.onLine()` → `request` 应答配对 + `'ev'` 事件 | `robot-runtime.ts:468` |
| 原生桥子进程 | `spawnNDJSON()` / `runBridge()` 回调 | `robot-runtime.ts:162` |
| 定时器 | `setInterval` 20ms 板侧 tick（SimBoard）、1s 状态广播、2s 链路巡检 | `constructor()` |
| HTTP 请求 | `transport/http-server.ts` 调 `runtime.invoke()` | `http-server.ts:222` |

派生态则由这些事件**就地改写**：`onBoardEvent()` 里改 `state.mode`、`activeTask.progress`；
`integrate()` 里累加 `state.pose`；`onBoardReset()` 里把 `pose.valid` 置 false。
**事件与状态的因果关系已经存在，但散落在 6 个方法里，没有单一入口，也没有「谁改了状态」的记录。**

用户提出的问题「底层 robotd 是不是应该做成消息队列为底层的架构，状态在 robotd 里维护」，
指向的正是这个未被命名的现状。需要在两条路之间做决定。

## 决策驱动

- **P2 真相归属**：状态必须有唯一权威。当前 `state` 是单一对象、由 `Runtime` 持有——**这一点已经是对的**，
  不能因为引入中间件而破坏它。
- **P1 时间尺度**：机器人有一个 20ms 级 tick。任何引入网络跳转或持久化队列的方案都会把这条时间线拉长。
- **P3 后果归属**：断连时谁兜底。中间件挂掉时，「车还能不能停」必须有确定答案。
- **实测约束**：拓扑是**单机、单进程、单串口、两个电机**（`architecture.md` §1），
  不存在多生产者/多消费者，也不存在跨机分布。
- **已有的正确做法**：`communication-protocol.md` §0 已明确写「**契约只存在于进程边界上；
  进程内不序列化、不模拟消息总线**」。这条纪律不能被推翻，只能被更精确地表述。

## 考虑的选项

- **A. 引入真正的消息中间件**（Redis Streams / NATS / MQTT / ZeroMQ）作为 robotd 内核。
  - **否决**。为「两个电机」的拓扑引入一个需要运维、会独立崩溃、要处理重连与持久化的第三方组件，
    收益是「解耦」——但当前**没有第二个消费者**需要解耦。更严重的是它违反 P3：
    中间件挂掉时，串口心跳路径多了一跳，看门狗停机时间不再可控。
    这也是 `communication-protocol.md` §8 拒绝 ROS 2 / zenoh 的同一条理由。
- **B. 进程内消息队列（内存 topic + 订阅者）替代直接函数调用。**
  - **部分采纳，但不是「底层架构」**。见下面的决定第 1 条：事件**分发**要收紧，
    但**内部模块之间仍然直接调用**——为单一消费者加一层队列只增加延迟与调试难度。
- **C. 保持现状（事件散落、状态就地改写），只补文档说明。**
  - **否决**。已经能看出代价：`state.mode` 在 `onBoardEvent` / `finishTask` / `setEsp32` /
    `newTask` / `onBoardReset` 五处被写，每处都要重新推导「链路优先于空闲」这条合取规则
    （代码里已经出现三处 `this.state.devices.esp32 === 'ready' ? 'idle' : 'degraded'` 的重复）。
    这是 P2「同一事实不许两层各存一份」在**单进程内的版本**——同一规则多份副本。
- **D. 事件循环内核 + 状态单点持有 + 契约化订阅**（不引中间件，把已有的东西命名并收紧）。
  - **采纳**。

## 决定

选择 **D**。三条具体规定：

### 1. 内核对四类输入做统一事件归并，事件是唯一的因果入口

robotd 内部有一个**事件归并点**：串口行、子进程事件、定时器 tick、HTTP 请求
统一转成内部事件后进入同一个处理入口，再由它改写状态、再投递给订阅者。

- **不引入序列化、不引入网络、不引入持久化**——归并点是进程内的一个函数，不是队列服务。
- **但跨进程边界之后是队列语义**：`/v1/events` 的 WS 订阅流已经是「有 seq、可过滤、可补发」
  的（`http-server.ts:82` 的 `v1Replay`），这一点保持并强化。
- **纪律**：改 `state` 的代码只允许出现在事件处理器里。任何「在 HTTP handler 里直接改 state」
  都是违规（当前 `pump.set` 就是这么写的：`robot-runtime.ts` 里 `run()` 直接
  `this.state.devices.pump = data.pump`）。

### 2. 状态由 robotd 单点持有，且每个字段有唯一「权威声明」

`state` 对象保持单一实例。新增一条要求：**每个字段必须能说出它的权威来源与写入者**。

| 字段 | 权威来源 | 写入者（唯一） |
| --- | --- | --- |
| `pose` | robotd 里程积分 | 事件处理器（`motion.done` / `integrate`） |
| `pose.valid` | robotd（板侧复位会作废它） | `device.reset` 事件处理器 |
| `mode` | robotd（合取：链路态 ∧ 任务态） | **一个**合取函数，不再五处重复 |
| `devices.esp32` | robotd（链路巡检判定） | 链路巡检结果事件 |
| `devices.camera` | 原生桥错误码（robotd 转译） | `camera.capture` 结果事件 |
| `battery` | **无权威源**（未接 BMS） | 保持不变：`source: 'unimplemented'` |
| `task_id` | robotd 任务表 | 任务生命周期事件 |

- **`mode` 的合取规则收敛到一个函数**（这是一条**重构**，不是新能力）：
  现有五处重复的三元表达式合并为 `deriveMode()`。
- **`battery` 保持「未接入」**——按 ADR-0004 的「宁缺勿假」红线，不因为「状态在 robotd 维护」
  就给它编一个值。

### 3. 对外接口只暴露「订阅」，不暴露「拼装」

状态查询与事件订阅**不是两个可以随便选的东西**，而是同一份真相的两种视图：

- `GET /v1/robot/state` = 订阅的**初始快照**（等价于「订阅后立刻收到的那一帧」）。
- `/v1/events` = 该订阅的**增量流**，带单调 `seq`；出现 gap 就重拉快照，不依赖补发。
- **契约禁止**调用方把多个查询结果拼成一个状态（例如「先查 devices 再查 pose 再合并」）——
  因为它们之间没有一致性保证。要一致就读一次快照。

## 后果

- **好**：把已经存在的正确做法命名成纪律，消除 `mode` 三处重复这类**真正存在**的缺陷；
  状态归属表让「这个字段是谁的真相」有了可指认的答案；拒绝中间件的理由被成文，
  以后不会再被反复提出。
- **坏**：第 1 条的纪律要求把 `pump.set` 这类「就地改 state」的写法改成走事件路径——
  是一次**小范围重构**（涉及 `pump.set`、`calibrationSet` 里的 `broadcastState`）。
  第 3 条要求 `openapi.yaml` 明确写出快照与事件流的对应关系，契约文件要改。
- **中性**：**不新增任何运行时依赖**。这是本条最重要的一句话——问题的答案不是「加一个队列」
  而是「把已有的归并点收紧」。

## 怎么验证

- **没有中间件**：断言 `package.json` 的 `dependencies` 里不出现 redis / nats / mqtt / amqplib / zeromq。
- **状态写入唯一**：全库检索 `this.state.` 的**赋值**（非读取），断言只出现在事件处理器内；
  允许的例外清单要短到能列出来（当前 `pump.set` / `calibrationSet` 两个，重构后为 0）。
- **`mode` 单点推导**：断言 `deriveMode` 是唯一推导 `mode` 的函数；全库不再出现
  `esp32 === 'ready' ? 'idle' : 'degraded'` 的重复三元。
- **快照与增量一致**：订阅 `/v1/events`，把收到的增量依次应用到一份快照上，
  与任意时刻 `GET /v1/robot/state` 的结果比对，字段应一致（`ts` 除外）。

## 相关资料

- [[0007-agentd-robotd-boundary|ADR-0007]] —— agentd / robotd 的模块边界与接口重设计（本条的下篇）
- [[communication-protocol|分层通信与接口设计]] §0（进程边界才序列化）、§6（State 合取 / Event 增量）
- [[architecture|架构设计]] §9 分层纪律（快慢分离、真相归属）
- `src/runtime/robot-runtime.ts` —— 四类输入源与状态写入的实际位置
