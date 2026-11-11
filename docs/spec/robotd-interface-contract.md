---
title: robotd 对外接口契约 v1（设计稿）
type: project
description: 定义 Python 迁移后的 robotd 进程边界、HTTP/MCP 能力面、状态快照、WebSocket 事件、任务与安全时序；保持协议语言无关，并区分现状、目标与未实现能力。
tags: [project, robot, contract, api, spec]
domain: robot
project: macmini-robot
status: draft
generated: { by: process:copilot-agent, at: 2026-10-22T07:32:33+08:00 }
relations:
  - predicate: part-of
    target: /README.md
  - predicate: depends-on
    target: /docs/decisions/0006-robotd-event-driven-core.md
  - predicate: depends-on
    target: /docs/decisions/0007-agentd-robotd-boundary.md
  - predicate: depends-on
    target: /docs/decisions/0009-robotd-python-runtime.md
  - predicate: depends-on
    target: /contracts/openapi.yaml
---

# robotd 对外接口契约 v1（设计稿）

> 本文规定 robotd 的**进程边界行为**，供 Python 迁移与后续验收使用。  
> 本文是设计与验收说明，不复制机器可读 schema；HTTP 契约的唯一事实源仍是
> [`contracts/openapi.yaml`](../../contracts/openapi.yaml)，生成物由 `contract:generate` 维护。
> 文中“必须 / 不得”为契约要求；“目标 / 待实现”不代表当前代码已经具备。

## 1. 契约基线与边界

| 项 | 约定 |
| --- | --- |
| 服务 | `robotd`，机器人身体运行时；Python 是新架构实现语言，不进入协议字段 |
| 面向调用方 | `agentd`、可信面板与本机运维工具 |
| 网络面 | HTTP/JSON + WebSocket/JSON；仅绑定 `127.0.0.1`，端口由启动参数/环境配置，当前实现默认 `8787` |
| 机器可读源 | `contracts/openapi.yaml`；`operationId` 是 HTTP 操作及其 MCP 投影的稳定名称 |
| 版本 | REST 路径 `/v1`；WS 消息 `version: 1`；服务实现版本与 ESP32 `protocol` 版本分别报告 |
| 不属于本契约 | robotd 内部 Python 模块、线程/任务调度实现、原生桥私有 JSON、ESP32 串口帧（另有线协议契约） |

`agentd` 不得读取 robotd 的代码、运行时对象或生成文件来构造自己的接口；双方只通过各自拥有的契约和网络交互。
robotd 的 MCP 工具面由本契约的公开操作投影，不因内部能力注册表新增条目而自动扩大。
调试端点是显式维护旁路，不属于 Agent 工具面，也不改变常规接口权限。

本设计遵循 [ADR-0006](../decisions/0006-robotd-event-driven-core.md) 的事件归并与状态单点持有、
[ADR-0007](../decisions/0007-agentd-robotd-boundary.md) 的进程契约隔离，以及
[ADR-0009](../decisions/0009-robotd-python-runtime.md) 的 Python 迁移要求。
ADR-0006 仍标记为 proposed；ADR-0007 已于 2026-10-23 接受。
本稿不声称相应重构已完成，接受边界决策不等于接受 ADR-0006 的内部实现方案。

## 2. 对外操作面

公开 HTTP 路由以 OpenAPI 为准，分为以下几组。`debug` 路由在 `--debug` 下才可用，必须从 MCP 投影中排除。

| 用途 | 操作 | 语义 |
| --- | --- | --- |
| 发现与状态 | `GET /v1/health`、`GET /v1/robot/state` | 服务信息；一次性取得整体一致状态快照 |
| 标定 | `GET/PUT /v1/robot/odometry/calibration` | 读取或更新 robotd 权威的标定值；更新会下发板侧，不能静默部分成功 |
| 运动/行为 | `POST /v1/robot/follow`、`POST /v1/robot/stop` | 跟随返回任务；stop 是无审批、幂等、可抢占的有序停止 |
| 语音 | `POST /v1/robot/speak`、`POST /v1/robot/announce`、`POST /v1/speech/listen`、`GET /v1/audio/state`、`POST /v1/audio/mute`、`POST /v1/audio/unmute` | 请求播报/系统审批复述/流式听音、读常听状态、切换静音 |
| 任务 | `GET /v1/tasks/{task_id}`、`DELETE /v1/tasks/{task_id}` | 查询与取消任务；任务状态变化也经事件流通知 |
| 实时订阅 | `GET /v1/events`（WebSocket Upgrade） | 初始状态同步后接收增量事件 |

`operationId` 是公开工具名，所有物理动作的审批属性必须由契约明确表达，不能依赖 Agent 自行判断。
当前 `robot_speak`、`robot_follow` 和标定写操作标记为需审批；`robot_stop` 与只读操作不需审批。
`robot_announce` 是审批链路自身的系统播报：**免审批**、只接受结构化审批字段、标 `x-mcp-exclude`
不进入 Agent 工具面；不能用 `robot_speak` 做审批复述，否则会递归。
`motion.estop` **不在 v1 公开面**：硬件/固件急停路径尚未实现并验证前，不得以软件 stop 冒充急停。
`motion.move`、`motion.rotate`、`robot.capabilities` 等未进入公开 OpenAPI 的能力也不因内部已有代码而被视为本契约已发布。

`robot_follow` 是 robotd 提供的机器人语义能力：调用方表达“跟随哪个目标”，robotd 负责目标跟踪、跟随控制、
运动任务与安全停止；它不是通用自然语言接口。自然语言 ASR 结果由 robotd 以事件提供给 agentd，
明确的简单指令可由 agentd 快速路由到该 operation，无需经过 Codex Harness。目标人物无法可靠确定时，
由 agentd 澄清后再调用。快速路由不得绕过 `x-requires-approval`；以上职责描述是目标边界，接口存在不代表
人物感知、跟踪或跟随闭环已经完整实现。

## 3. 请求、响应与错误

### 3.1 调用语义

- 请求体为 JSON；OpenAPI schema 是输入校验与 MCP 输入 schema 的唯一来源。未声明字段默认拒绝。
- 短操作同步返回结果；耗时行为立即返回 `{ "task_id": "...", "status": "accepted" }`，后续进度与终态通过任务查询及事件流获取。
- 机器人同一时刻只允许一个运动任务。冲突返回 HTTP `409` / `E_BUSY`，不得排队后悄悄执行。
- 超时不代表动作未执行。**物理动作不得自动重试**；调用方先读取状态或任务，再由用户/上层逻辑决定后续动作。
- 只读请求可安全重试。重复的停止请求必须保持幂等。

### 3.2 错误封装

所有错误使用统一 JSON 形状：

```json
{
  "ok": false,
  "error": {
    "code": "E_BUSY",
    "message": "运动任务正在运行",
    "details": {}
  }
}
```

`details` 可省略。至少统一以下映射：输入校验失败 `400/E_VALIDATION`；忙碌 `409/E_BUSY`；
任务不存在 `404/E_NO_TASK`；调试旁路关闭 `403/E_DEBUG_OFF`；内部故障 `5xx/E_INTERNAL`。
板侧、相机、模型或语音故障必须保留稳定错误码并明确失败，不得返回成功形状或编造替代结果。

## 4. 状态快照

`GET /v1/robot/state` 是 robotd 对机器人整体状态的**单次一致性视图**。调用方不得拆成多个查询再拼接状态。
所有状态字段只有 robotd 一个权威快照；写入由事件处理路径归并，传输 handler 只读状态。

### 4.1 字段和权威

| 字段 | 契约语义与来源 |
| --- | --- |
| `robot_id`, `version` | 稳定机器人标识与状态 schema 版本 |
| `mode` | robotd 根据设备链路状态与任务状态统一推导；不得由调用方自行合成 |
| `pose` | robotd 里程积分估计，含 `valid`；板子复位等使来源失效时必须设为无效 |
| `odometry` | `source`、左右轮应发计数；只有真实编码器接入后才允许提供实走计数/丢步比，否则对应值为 `null` |
| `devices` | robotd 对设备可观测性的归一化状态；未探测为 `unknown`，不得将未知改报为缺席或就绪 |
| `battery` | 未接 BMS 时必须明确 `source: "unimplemented"`，测量值为 `null`，不得估算或伪造 |
| `task_id` | 当前独占运动任务 id；无活动任务为 `null` |
| `firmware`, `transport` | 最近握手得到的固件标识及 transport 类型；未知时使用 `null` / 明确未知值 |
| `ts` | 快照生成时间，Unix epoch 毫秒 |
| `event_seq` | **目标新增字段**：生成快照时已提交的全局事件序号，用作 WS 同步游标 |

Pose 的坐标系、角度单位及运动字段单位必须在机器可读契约中逐字段声明；不得隐含单位。
板级运动单位以握手 `hello` 声明为准（米 / 弧度 / 秒），标定字段名称中的单位后缀不构成另一套换算口径。

以下字段当前不可由系统可靠观测，**不得加入状态**：轴已到位、物理静止、堵转（除非有经硬件验证的传感器信号）。
板侧“应发步数”不是实际位移证明。`E_HW` 只能由可观测硬件故障产生，不能由超时或模型推断。

### 4.2 同步一致性

快照及其 `event_seq` 必须在同一事件归并序列中读取。WS 订阅以该游标为边界：
先得到订阅确认和初始快照，再按序收到 `seq > event_seq` 的增量。
若服务端无法从保留日志补齐游标之后的事件，必须发出 `resync_required`；客户端重拉完整快照，
不可用部分事件自行修补状态。

当前实现的 `GET /v1/robot/state` 尚未返回 `event_seq`，WS 也尚未提供带游标的初始快照/明确补发失败信号；
这属于迁移验收缺口，不应误认为已实现。

## 5. 任务生命周期与停止

任务响应与状态至少采用以下生命周期：

```text
accepted → running → completed | failed | cancelled
```

`accepted` 是受理响应，不代表已经开始运动。终态不可再转移。任务对象包含 `task_id`、`capability`、
`state`、`progress`、`started_at`、`finished_at`、`cancelable`；时间戳为 Unix epoch 毫秒。
任务仅保证在 robotd 当前进程生命周期内可查询；进程重启后，调用方必须重新读取状态，不能假设任务持久化。

`DELETE /v1/tasks/{task_id}` 取消指定任务；运动任务被取消后还必须确认执行 stop 路径。
`POST /v1/robot/stop` 是独立的有序停止操作：无需 task id、无需审批、幂等、可抢占普通任务。
它不代表硬件急停，不保证断开驱动使能。急停必须是单独语义、独立优先级和独立验收，不在当前 v1 声称可用。

## 6. WebSocket 事件流

连接 `GET /v1/events` 并完成 WebSocket Upgrade。消息均为 UTF-8 JSON 文本帧。

### 6.1 控制消息与事件封套

客户端可发起订阅：

```json
{
  "type": "subscribe",
  "event_types": ["task.*", "device.*"],
  "instance_id": "robotd-boot-abc",
  "resume_from_seq": 42
}
```

支持精确事件名及 `prefix.*`。服务端先返回 `hello`（版本、服务名、`instance_id`、最新序号、支持的事件类型），
再返回 `subscription.accepted`；随后发送初始快照控制帧：

```json
{ "type": "state.snapshot", "version": 1, "event_seq": 42, "state": { "robot_id": "macmini-robot" } }
```

服务端在捕获快照游标时开始缓冲后续事件，先发送快照，再按序发送 `seq > event_seq` 的匹配事件，
避免快照与订阅之间的竞态。取消订阅使用 `unsubscribe`，保活使用 `ping` / `pong`。
客户端提供的 `resume_from_seq` 仅在 `instance_id` 相同且日志仍覆盖该游标时有效；否则服务端发
`resync_required`，并以新快照重新建立基线。
订阅期间重连补发是有限日志上的尽力而为，不是持久事件存储。

事件统一封套：

```json
{
  "version": 1,
  "type": "task.progress",
  "event_id": "evt_robotd-boot-abc_43",
  "seq": 43,
  "timestamp": "2026-10-21T23:32:33.879Z",
  "payload": { "task_id": "t-123", "progress": 0.4 }
}
```

`hello` 还必须包含每次 robotd 进程启动时生成的 `instance_id`。`seq` 在该实例运行期内严格递增；
重启后序号可重新开始，调用方通过 `instance_id` 识别新序列。`event_id` 跨实例唯一，建议由 `instance_id` 与 `seq` 组合生成。
`timestamp` 为 UTC ISO 8601；若内部使用单调时钟，仅用于内部时序，不得泄漏进 Agent 可见 payload。
订阅经过过滤时，未看到某些全局 `seq` 不代表丢包；事件流不替代状态快照。发现补发不可用或状态不确定时，
客户端重新读取 `/v1/robot/state`。

`seq` 只在事件**已经生效**时才分配：事件先在一份归并工作副本上校验、再一次性发布状态。
校验失败的 `emit` 不消耗序号、不写保留日志、不分发，因此「补齐 `seq`」永远对应一次真实的因果变化；
契约不合法的调用方输入直接按 `E_VALIDATION` 拒绝，归并内部失败则发一条 `state.rejected`
（`{type, payload_keys, reason}`，不含 payload 原文）说明这次迁移没有生效。

### 6.2 事件类别

公开事件至少覆盖以下有业务意义的变化；字段以 OpenAPI 的 WS schema / 事件登记表进一步机器化。

| 类别 | 事件示例 | 最低必要信息 |
| --- | --- | --- |
| 任务 | `task.started`, `task.progress`, `task.paused`, `task.resumed`, `task.pause_expired`, `task.completed`, `task.failed`, `task.cancelled` | `task_id`、能力名、进度或终态/错误；暂停带 `pause_expires_at`，恢复带 `paused_ms` |
| 运动/安全 | `motion.plan`, `safety.stopped`, `safety.stop_requested`, `safety.slowdown` | 计划摘要、停止动作、结构化停止原因与确认状态；`slowdown` 仅在减速状态变化时发；不宣称实际到位 |
| 设备 | `device.ready`, `device.lost`, `device.recovered`, `device.reset`, `device.changed` | 设备名、变化/原因、可确认的固件信息 |
| 状态 | `state.rejected` | 被拒事件的 `type`、`payload_keys` 与 `reason`；不含 payload 原文 |
| 视觉 | `vision.*`, `camera.*`, `people.*`, `person.*` | 观测、有效性与时间信息；不得把模型原始格式直接作为稳定能力契约 |
| 语音 | `speech.*`, `audio.state` | utterance/task 关联、partial revision 或 final 文本、音频状态 |

事件只表达已发生的增量；当前状态以快照为准。部分识别文本须带修订号并标明 `partial`，
不得与 `final` 混淆。模型输出必须有 `grounded` 等来源有效性标记；`grounded=false` 时不得当作视觉观测。
内部字段（包括 `ts_mono_ns`、模型自检中间文本）不得出现在 Agent 可见事件中。

## 7. 安全、背压与时间约束

- 服务只绑定回环地址，不监听 `0.0.0.0`；调试旁路必须显式启用，且不得进入公开 MCP 工具面。
- Agent 不得获得串口原语、GPIO/引脚操作、驱动器使能或任意内部方法调用。开发期调试直通不是产品能力。
- 运动命令与状态查询分属不同优先级；停止不得排在普通运动/感知请求之后。
- 慢模型、抓帧、SLAM/定位计算不得阻塞控制更新、stop 或心跳。感知/定位只消费最新有效结果；过期或不可用时显式降级并按策略停止，不积压旧帧与旧指令。
- 运动意图持续期间 host 向板侧发送 `velocity` 的频率至少 `5 Hz`；这与板侧内部 `50 Hz`（`TICK_MS=20`）是不同层的约束。
- 目标时限：有序 `stop` 端到端不超过 `50 ms`；板侧心跳看门狗自主停机不超过 `500 ms`。板侧阈值为 `300 ms`，历史实测约 `420 ms`；上述目标必须在 Python 迁移后复测，通过前不得宣称保证已达标。
- 板侧普通命令应答超时目标 `500 ms`；运动命令超时不得盲目重发。队列必须有界，队满时拒绝/丢弃普通非安全工作并明确报告，停止通道保留最高优先级。

## 8. 兼容与迁移验收

语言迁移不改变公开操作名、参数语义、审批属性、状态归属、任务生命周期、错误语义和 stop 行为。
任何破坏性变更升主版本或新建 `/v2`，不能借 Python 重写顺带改变现有调用方假设。

迁移完成至少满足：

1. OpenAPI 是唯一机器可读契约，生成物可重现且 `npm run contract:check` 通过；Python 实现与契约逐项一致。
2. 仿真/契约测试覆盖所有公开 HTTP 操作、参数校验、错误映射、任务互斥、取消与 stop 抢占。
3. WS 测试验证初始快照和 `event_seq` 边界、事件单调有序、过滤语义、重连补发窗口耗尽时的 `resync_required`。
4. 快照/事件状态回放与权威状态一致；注入板复位时任务失败、位姿失效、状态重新握手。
5. 慢模型、感知过载、串口断连、控制路径停滞等故障下控制与停止不被阻塞；目标机实测 `stop ≤50 ms`、看门狗 `≤500 ms`。
6. 自动检查确认 agentd 不读取 robotd 生成文件；Agent 面不包含 debug/串口/硬件原语、不可知状态字段或内部时间戳。

### 当前需要对齐的实现差异

1. OpenAPI `servers` 当前声明 `8765`，运行时代码默认端口为 `8787`；需以启动配置变量化并在契约文档中避免硬编码旧端口。
2. OpenAPI 当前没有完整定义 WS 消息 schema、快照游标、`resync_required`、任务/状态字段约束；需先补 schema 再生成。
3. 事件实现目前包含 `ts_mono_ns`，与内部字段不得外泄的目标冲突；迁移时移除公开输出。
4. 当前 `GET /v1/robot/state` 不含 `event_seq`；WS 订阅只回放内存日志，日志过期没有明确失败消息。
5. OpenAPI 的状态 schema 过宽（多处 `object` / `string`），且 `estop` 尚未实现；本稿不将其描述成已交付能力。
6. HTTP 处理器当前会将部分未分类异常映射为 `400`；应区分客户端错误与服务端错误，避免把内部故障伪装成请求错误。
7. ADR-0006 记录的状态单写者尚有旧实现例外，Python 迁移必须把状态更新收敛到单一事件归并路径。

## 9. 相关资料

- [分层通信与接口设计](../communication-protocol.md) —— 边界 B1/B2、超时、重试与背压
- [ADR-0003 时间约束分层](../decisions/0003-timing-constraints-layering.md) —— host/板侧频率与停止时限
- [ADR-0004 串口契约红线](../decisions/0004-serial-contract-redlines.md) —— 不可知状态、stop/estop、单位
- [ADR-0006 robotd 事件驱动内核](../decisions/0006-robotd-event-driven-core.md) —— 状态单点与订阅语义
- [ADR-0007 agentd / robotd 边界](../decisions/0007-agentd-robotd-boundary.md) —— 契约所有权
- [ADR-0009 Python runtime](../decisions/0009-robotd-python-runtime.md) —— 迁移不改变外部契约
- [OpenAPI 契约](../../contracts/openapi.yaml) —— 唯一机器可读来源
