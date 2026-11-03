---
title: 接口契约重设计 — robotd 内核、agentd 边界与三个契约面
type: project
description: 不考虑现有实现，从职责出发重新设计三个契约面：robotd 面板面（HTTP/WS）、agentd 面板面（HTTP/WS）、板侧线协议（串口）。含状态字段的权威归属表、事件命名与语义、Task 生命周期、错误模型分层、以及从现状到目标的迁移映射。
tags: [project, robot, contract, protocol, design]
domain: robot
project: macmini-robot
sources: []
generated: { by: assistant:workbuddy, at: 2026-10-18T23:40:00+08:00 }
relations:
  - predicate: part-of
    target: /projects/robot/README.md
  - predicate: depends-on
    target: /projects/robot/doc/decisions/0006-robotd-event-driven-core.md
  - predicate: depends-on
    target: /projects/robot/doc/decisions/0007-agentd-robotd-boundary.md
  - predicate: depends-on
    target: /projects/robot/contracts/openapi.yaml
---

# 接口契约重设计

> **归档：本文是 2026-10-18 的历史提案。其浏览器审批流程与当前“语音确认、调试页只观察”的设计冲突，
> 不作为现行架构或契约依据。**

> 决策见 [[decisions/0006-robotd-event-driven-core|ADR-0006]] 与
> [[decisions/0007-agentd-robotd-boundary|ADR-0007]]。本文只写**长什么样**。
> 前提：**不考虑现有实现**——从职责出发设计，最后再给一张回填映射表（§7）。

## 0. 一句话

**先定「谁是真相」，再定「谁能问、怎么问」。** 接口的形状是状态归属的推论，不是反过来。

> **层与边界编号见 [[layers-and-modules|层与模块关系（唯一口径）]]**：本文的「面 A/B/C」是**契约维度**
> 的编号（有几份需版本化的接口定义），与**链路维度**的边界 B1–B4 是两套编号、多对多关系（该页 §5）。
> 执行位置按该页 §3 是 4 层：L1 固件 / L2 进程内模块 / L3 进程 / L4 交互面。

三个契约面（此前只有第一个是显式的）：

| 契约面 | 边界 | 现状 | 本次 |
| --- | --- | --- | --- |
| **A** robotd 面板面 | 面板/调试工具 → robotd | ✅ `contracts/openapi.yaml` | 补事件面与状态归属 |
| **B** agentd 面板面 | 面板 → agentd | ❌ 只有代码 | 🔴 新增 `contracts/agentd/openapi.yaml` |
| **C** 板侧线协议 | robotd ↔ ESP32 | ⚠️ 只有散文 | 🟡 `wire-protocol.yaml`（ADR-0005 已定，本文不改） |

「agentd → robotd」不是第四个契约面——它是**一条消费路径**，消费的是面 A 的能力与状态。

## 1. 状态归属表（设计一切接口的起点）

原则（来自 `architecture.md` §1 判据 P2）：**每个字段必须能回答「谁说的算」与「谁写的」**。

### 1.1 robotd 的状态（面 A 的核心）

| 字段 | 权威来源 | 唯一写入者 | 类型 |
| --- | --- | --- | --- |
| `pose.{x,y,theta}` | robotd 里程积分 | `motion.done` 事件处理器 | 派生 |
| `pose.valid` | robotd | `device.reset` 事件处理器 | 派生 |
| `mode` | robotd（**合取**） | `deriveMode()` 单点 | 派生 |
| `devices.esp32` | robotd（链路巡检判定） | 巡检结果事件 | 派生 |
| `devices.camera` | 原生桥错误码（robotd 转译） | `camera.capture` 结果事件 | 转译 |
| `devices.pump` | robotd（板侧回读） | `pump.set` 结果事件 | 转译 |
| `odometry.*_commanded` | **ESP32**（发脉冲时同步计数） | 板侧 `stats` 上报 → 事件 | 上游 |
| `odometry.*_actual_encoder` | **ESP32**（编码器） | 同上；未装编码器 = `null` | 上游 |
| `odometry.slip_ratio` | robotd（计算） | 派生事件 | 派生 |
| `task_id` | robotd 任务表 | 任务生命周期事件 | 派生 |
| `firmware` | ESP32（`hello` 自报） | 握手成功事件 | 上游 |
| `calibration` | **robotd**（可下发，ADR-0002） | `calibration.set` 结果事件 | 权威在 robotd |
| `battery` | **无权威源** | 不写（保持 `source: 'unimplemented'`） | ⛔ 禁伪造 |
| ~~`in_position`~~ | ⛔ **不存在** | — | ⛔ 禁伪造（ADR-0004） |
| ~~`is_stalled`~~ | ⛔ **不存在** | — | ⛔ 禁伪造（ADR-0004） |

### 1.2 `mode` 的合取规则（单点推导）

```
mode = degraded                     若 devices.esp32 ≠ ready        （链路优先）
     = moving | navigating          若有运动类任务在跑              （任务态）
     = error                        若最近一次硬件错误未清除        （错误态）
     = idle                         否则
```

**优先级**：`degraded` > `error` > `moving`/`navigating` > `idle`。
理由：降级意味着「运动能力被拒」，它必须是最高优先的对外事实——否则上层会继续发运动指令。

> 现状缺陷：这个规则在 `robot-runtime.ts` 的 5 处被重复实现，其中 3 处是
> `this.state.devices.esp32 === 'ready' ? 'idle' : 'degraded'` 的近似。收敛为一个函数。

### 1.3 agentd 的状态（面 B 的核心）

agentd **不持有** robotd 的状态，只持有**对 robotd 的观测结论**：

| 字段 | 含义 | 与 robotd 状态的关系 |
| --- | --- | --- |
| `robotd.{url, ok}` | 探测结论 | agentd 自己判定 |
| `robotd.last_seen_at` | 最后一次探测成功时间 | agentd 自己判定 |
| `robotd.observed.{mode, firmware}` | **观测到**的值 | robotd 状态的**快照副本**，带时间戳 |
| `harness.{bin, approval_mode, running}` | agentd 自己的 | — |
| `run.*` | agentd 自己的 | — |
| `approvals.*` | agentd 自己的 | — |
| `daemon.{pid, http, ws_clients}` | agentd 自己的 | — |

**关键设计**：`robotd.observed` 必须带 `at`（观测时刻），并明确它是**可能过期的副本**。
这比现状更诚实——现状 `robotdInfo.mode` 是 2s 轮询的产物，但字段名不体现这一点。

## 2. 面 A：robotd 接口重设计

### 2.1 资源划分

按**真相归属**划分资源，而不是按代码模块：

```
/v1/health                   服务自身（robotd 的存活，不含机器人状态）
/v1/state                    机器人的状态快照（§1.1 全部字段）
/v1/events                   状态与事件的订阅流（WS）
/v1/capabilities             能力清单（「能做什么」）
/v1/tasks                    任务列表
/v1/tasks/{id}               单任务（GET / DELETE=取消）
/v1/calibration              标定参数（GET / PUT）
/v1/motion/*                 运动能力（见 §2.3）
/v1/audio/*                  音频能力
/v1/vision/*                 视觉能力
/v1/debug/*                  P5 旁路（不进 Agent 工具面）
```

### 2.2 状态与事件的关系（核心设计）

**`GET /v1/state` 与 `/v1/events` 是同一份真相的两种视图，不是两个可选方案。**

| | 快照 | 增量 |
| --- | --- | --- |
| 端点 | `GET /v1/state` | `WS /v1/events` |
| 语义 | 订阅的「第 0 帧」 | 订阅的后续帧 |
| 携带 | 全部字段 | 只有变化的部分 + `seq` |
| 用途 | 首连对齐 / gap 后重对齐 | 持续跟踪 |

**契约规定**：

1. 订阅后**立刻**应收到一帧等价于 `GET /v1/state` 的内容（当前 `handleV1Upgrade` 已推 `hello`
   但**未推 state**——这是一处缺口：客户端必须先 GET 一次，但契约没写这个义务）。
2. 事件带单调 `seq`。**出现 gap → 重拉快照**，不依赖补发（补发是尽力而为）。
3. **禁止**调用方把多个查询拼成一个状态（各自的 `ts` 不同，无一致性保证）。
4. 快照 1Hz 推送（变化时立即），**原始遥测不出进程**（面板按需订阅 `/v1/debug/*`）。

### 2.3 能力与返回类型

每项能力必须声明 `returns`：

| `returns` | 含义 | 返回 | 举例 |
| --- | --- | --- | --- |
| `rpc` | 同步完成，毫秒级 | 结果本身 | `calibration.get` |
| `task` | 异步，秒到分钟级 | `{task_id}` + 进度事件 | `motion.move` |
| `state` | 读操作 | 状态片段 | `state.get` |

**状态变更能力的额外要求**：凡 `returns: rpc` 但**有副作用**（`pump.set` / `calibration.set`），
其副作用必须经**事件**反映，不得由调用方从返回值推断（§1.1 的「唯一写入者=事件处理器」）。
> 这是 ADR-0006 第 1 条落到接口层的具体形式。

### 2.4 Task 生命周期

```
         ┌──────────────────────────────────────────────┐
         │                                              │
created ─► running ─┬─► completed        （正常结束）    │
         (started) │                                   │
                   ├─► failed           （错误 / 超时 / 板侧复位）
                   ├─► cancelled        （stop / task.cancel / 抢占）
                   └─► superseded       （被更高优先级任务取代）★新增
```

- `superseded` 是本次**新增的状态**（现状只有 4 个）。理由：`stop` 抢占后原任务记
  `cancelled` 是**语义失真**——它不是被取消的，是被取代的。上层的重试策略对这两者应该不同。
- **`stop` vs `estop` 的取消语义**（ADR-0004 已定）：`stop` → `cancelled`；
  `estop` → `cancelled` 且**事件携带 `estop: true`**，供上层区分。

```jsonc
// Task 的对外形状（契约字段）
{ "task_id": "t-abc123",
  "capability": "motion.move",
  "state": "running",            // 上面 5 个之一
  "progress": 0.4,               // 0..1，仅 running 时有意义
  "started_at": 1760000000000,
  "finished_at": null,
  "cancelable": true,            // 能否被 cancel（estop 永远能）
  "error": null,                 // 仅 failed 时非 null，形状见 §2.5
  "superseded_by": null }        // ★新增：仅 superseded 时非 null
```

### 2.5 错误模型分层

**这是现状最混乱的一处**：`invoke()` 只认 `throw` 判失败，但 `robot-mcp.ts` 又按
`res.ok || body.ok === false` 双重判断，两套并存。重新分层：

| 层 | 触发 | HTTP | 形状 | 上层的正确反应 |
| --- | --- | --- | --- | --- |
| **契约层** | 参数不合 schema | `400` | `E_SCHEMA` | 改参数重试一次 |
| **业务层** | 状态不允许 / 忙 / 找不到 | `409` `404` | `E_STATE` `E_BUSY` `E_NO_TASK` | **不重试**，先查状态 |
| **上游层** | 板子/桥/模型返回错误 | `502` | `E_BOARD` `E_BRIDGE` `E_MODEL` | 按上游错误码决策 |
| **降级层** | 板侧失联 / 协议不匹配 | `503` | `E_DEGRADED` `E_FW` | **拒发运动**，只读 |
| **适配器层** | 代码 bug（不该发生） | `500` | `E_INTERNAL` | 上报，不重试 |

**统一形状**（现状已如此，保留并强制）：

```jsonc
{ "ok": false,
  "error": {
    "code": "E_STATE",
    "message": "人类可读",
    "layer": "business",        // ★新增：contract|business|upstream|degraded|adapter
    "retriable": false,         // ★新增：契约直接告诉上层能不能重试
    "detail": {}                // 可选：上游原始错误
  } }
```

**`retriable` 进契约是本次的关键改进**：现状「物理动作不重试」这条纪律写在
`communication-protocol.md` §2.3 的散文里，而**契约字段里没有任何东西强制它**。
把 `retriable` 变成返回字段后，`robot-mcp.ts` 与 Agent 都能**读到**这个判断，而不是靠背文档。

## 3. 面 B：agentd 接口重设计（新增）

### 3.1 与面 A 的本质区别

面 A 回答「**机器人现在怎样、能做什么**」；面 B 回答「**大脑在做什么、需要你决定什么**」。

| 问 | 面 A（robotd） | 面 B（agentd） |
| --- | --- | --- |
| 状态 | 机器人的状态（真相） | 大脑的状态 + 对身体的观测结论 |
| 能力 | 机器人能做什么 | **Agent 被允许做什么**（含审批要求） |
| 任务 | 机器人正在执行什么 | **Agent 正在思考什么**（run / turn） |
| 干预 | `stop`（停运动） | **approve / deny**（批准动作）+ `stop`（中断思考） |

### 3.2 资源划分

```
/healthz                       agentd 自身存活
/api/state                     agentd 状态（§1.3）
/api/tools                     ★Agent 视角的权限表（不是 robotd 能力清单的转发）
/api/runs                      Agent 运行列表
/api/runs/{id}                 单次运行
/api/runs/{id}/transcript      原始 NDJSON 转写
/api/approvals                 待审批（GET）+ 挂起式请求（POST）
/api/approvals/{id}            结论回填（POST）
```

### 3.3 `/api/tools` 重新定义（本次最实质的接口改动）

**现状**：`mcpTools.map(t => ({ tool, capability: t.name, group: 'robot', ... }))`
——它是一张 robotd 契约的转发表，`group` 硬编码 `'robot'`。

**重设计**：这张表回答「**Agent 现在能做什么、要什么条件**」，因此必须包含三类信息：

```jsonc
{ "tools": [
    { "tool": "motion_move",              // Agent 实际看到的工具名
      "capability": "motion.move",        // 底层能力名
      "provider": "robotd",               // ★归属：谁提供（robotd | modeld | agentd）
      "group": "motion",                  // ★真实分组（不再硬编码 'robot'）
      "returns": "task",
      "requires_approval": true,          // 是否需要人批准
      "available": true,                  // ★当前可用吗（板侧失联时运动类应为 false）
      "unavailable_reason": null,         // ★不可用原因（E_DEGRADED 等）
      "inputSchema": { } } ] }
```

**`available` 是本设计的关键新增**：现状 Agent 只有「工具存在/不存在」两态，
但实际上板侧失联时 `motion.move` **存在但不可用**（会回 `E_DEGRADED`）。
让工具面**如实反映可用性**，Agent 就不会浪费一次审批去调一个注定失败的接口。

> 这符合 P2：「不可观测的事实不许伪造」的反面是「**可观测的事实必须如实上报**」。可用性是可观测的。

### 3.4 审批门是 agentd 面 B 的一等公民（本设计的核心安全机制）

审批是**唯一一处**「人的决定进入自动流程」的接口，因此它在契约里必须显式、精确：

```jsonc
// POST /api/approvals —— 挂起式请求（robot-mcp 调）
// ⚠️ 这个请求会 HANG，直到面板给出结论或超时。契约必须写清，否则调用方会设错超时。
请求： { "capability": "motion.move",
         "args": { "left_m": 0.3, "right_m": 0.3 },
         "requester": "robot-mcp",
         "timeout_ms": 120000 }          // 可选，默认 120s
响应： { "ok": true, "id": "ap-xxx",
         "approved": false,
         "status": "timeout",            // approved|denied|timeout|cancelled
         "decided_by": "system" }
```

**契约必须写明的三条**：

1. **超时按拒绝处理**（`approved: false`）——**安全默认**。这条现在是硬编码在 `createApproval`
   的 `setTimeout` 里，契约里没有。必须显式化：调用方不得因超时而认为「没答复=可以走」。
2. **结论只有四种**：`approved` / `denied` / `timeout` / `cancelled`。新增第四种
   （`cancelled` = 运行被中断，所有待审批一起作废，`cancelPendingApprovals`）——现状有实现，无契约。
3. **同一 capability 可以并发多条待审批**，各自独立 settle。契约不得假设「一次只有一个」。

**审批门的分层图**：

```
Agent 想调 motion.move（requires_approval=true）
   │
   ▼ robot-mcp.ts 拦截
   │
   ▼ POST /api/approvals  ──► agentd 挂起 ──► WS 推给面板 ──► 人在面板点「同意」
   │                                                              │
   ▼ 这里才是真正调用 robotd ◄── approved=true ◄──────────────────┘
```

**关键**：**审批门不在 robot-mcp 层做判断**，它只负责「把问题转给拥有审批权的那一层」
（`robot-mcp.ts` 头注释原文）。这个设计是对的，本条只是把它写进契约。

## 4. 事件命名与语义（三面共用）

### 4.1 命名规则

```
<域>.<对象>.<动作>          域 = task | motion | device | safety | speech | audio | vision | board
```

| 域 | 事件 | 载荷要点 |
| --- | --- | --- |
| `task` | `.started` `.progress` `.completed` `.failed` `.cancelled` `.superseded`★ | `task_id` `capability` |
| `motion` | `.planned` `.progress` `.done` `.aborted` | `steps` `eta_ms` `reason` |
| `device` | `.ready` `.lost` `.recovered` `.reset` `.changed` | `device` `reason` |
| `safety` | `.stopped` `.estop`★ `.watchdog_fired` | `reason` `hb_age_ms` |
| `speech` | `.started` `.partial` `.final` `.tts_started` `.tts_chunk_*` `.tts_finished` `.interrupted` | `text` `revision` |
| `audio` | `.state` `.vad_calibrated` `.endpoint` | 门限/电平 |
| `board` | `.tx` `.rx` `.log` | 原始行（仅 `--debug`） |

### 4.2 语义规定

1. **Event 是增量，不重放**；gap → 重拉快照（§2.2 第 2 条）。
2. **事件不是日志**：只推「有意义的状态迁移」。「Agent 有没有绕过工具面」这类
   诊断信息属 `/v1/debug/*` 或 agentd 的 `run.*`，不进公共事件流。
3. **同一事件不得在两个面上重复定义**。`speech.*` 属面 A（robotd 产生），
   面 B **不得重新定义**，只能转发（当前 agentd 的 `push()` 是转发 `run.*` 与 `approval.*`
   这类 agentd 自己的事件——这个区分是对的，要保持）。
4. **事件名与 HTTP 端点同源**：`/v1/tasks/{id}` 的 `state` 变化必须对应
   `task.{state}` 事件。契约里两者写在一起，不能一处改另一处忘。

## 5. 三个面之间的数据流（完整图）

```
┌─ 人 / 面板 ─────────────────────────────────────────────────────┐
│  HTTP/WS 到 agentd（看 Agent 在做什么、点审批）                  │
│  HTTP/WS 到 robotd（看机器人、手动驾驶、STOP 旁路）              │
└──────┬──────────────────────────────────────┬───────────────────┘
       │ 面 B                                 │ 面 A
       ▼                                      ▼
┌──────────────────────┐   MCP(stdio)  ┌──────────────────────────┐
│ agentd 【大脑】       │◄─────────────►│ robotd 【身体】           │
│  Codex Harness       │   + HTTP/WS   │  事件循环 + 状态单点      │
│  Session/Workspace   │   状态/事件   │  Runtime + 能力           │
│  Approval 审批门 ★   │               │                          │
│  run.* / approval.*  │               │  task.* / motion.* / ... │
└──────────┬───────────┘               └────────────┬─────────────┘
           │ spawn                                  │ 面 C（串口）
           ▼                                        ▼
   ┌───────────────┐                        ┌──────────────────┐
   │ robot-mcp.ts  │ ← 归 agentd 侧          │ ESP32 固件        │
   │ (MCP 适配器)   │                        │ 状态机 + 看门狗   │
   │  + 审批门客户端 │                        └──────────────────┘
   └───────────────┘                                 │
           │                          ┌──────────────┴────────┐
           ▼                          ▼                       ▼
   Codex app-server              TB6600/电机              编码器(未接)
   (外置系统)
```

**读图要点**：

- **面 B 与面 A 是两个独立的对外面**，面板可以分别直连（现状已如此：8787 与 8791）。
- `robot-mcp.ts` 有**两个上游**：robotd（转发工具）与 agentd（问审批）。它是 agentd 侧的适配器。
- **审批门（★）跨了两个面**：它由 agentd 定义（面 B），由 robot-mcp 消费（作为 Agent 的代理）。
  这是设计上**唯一一处**「Agent 的调用路径依赖 agentd」（`agentd.ts` 头注释解释过原因：
  非交互 exec 没有原生审批通道，所以在 MCP 侧做语义等价实现）。
- **ESP32 永远不出现在面 A/B 里**：它的 op 与字段属面 C，Agent 不可见（P4 + P5）。

## 6. 不做什么（以及为什么）

| 不做 | 理由 |
| --- | --- |
| 引入消息中间件（Redis/NATS/MQTT） | ADR-0006「考虑的选项 A」：单机单进程单串口，无第二消费者；中间件挂在心跳路径上会破坏 P3 |
| 把板侧 op 塞进任何 HTTP 契约 | 会经生成器变成 MCP 工具，`pins`/`pulse`/`ena` 漏进 Agent 工具面（P5 + P4） |
| 让 agentd 与 robotd 共用一个 `state` 定义 | 那是「同一事实两层各存一份」（P2）。agentd 的是**观测结论**，带 `at` 时间戳 |
| 给 `battery` 编一个值 | 未接 BMS，无可观测来源（ADR-0004 宁缺勿假） |
| 给状态加 `in_position` / `is_stalled` | 开环 + 无编码器，物理不可观测（ADR-0004） |
| 把 `stop` 与 `estop` 合成一个 | 有序停与急停后果不同，混用会让上层无法表达意图（ADR-0004） |
| 让 `/api/tools` 继续转发 robotd 契约 | 它是 agentd 的端点，形状应由 agentd 定（ADR-0007） |

## 7. 回填映射表（现状 → 目标）

**这张表是给实现用的**：左边是现在真实存在的东西，右边是目标，中间是动作。

| # | 现状 | 目标 | 动作 | 涉及文件 |
| --- | --- | --- | --- | --- |
| 1 | `mode` 在 5 处推导 | `deriveMode()` 单点 | 重构 | `robot-runtime.ts` |
| 2 | `pump.set` 就地改 `state.devices.pump` | 经事件改 | 重构 | `robot-runtime.ts` |
| 3 | `calibrationSet` 就地改 `stepsPerM` | 经事件改 | 重构 | `robot-runtime.ts` |
| 4 | `/v1/events` 订阅后不推初始快照 | 推一帧等价 state | 补实现 | `http-server.ts` |
| 5 | 错误只有 `code` + `message` | 加 `layer` + `retriable` | 扩契约 | `openapi.yaml` + `http-server.ts` |
| 6 | Task 只有 4 个状态 | 加 `superseded` | 扩契约 + 实现 | `openapi.yaml` + `robot-runtime.ts` |
| 7 | agentd 读 robotd 的 `mcp-tools.json` | 立 `contracts/agentd/` | 新增 | `contracts/` + `agentd.ts` |
| 8 | `/api/tools` 转发 robotd 契约、`group` 硬编码 | agentd 自己的形状 + `available` | 重写 | `agentd.ts` |
| 9 | `robot-mcp.ts` 归属含混 | 归 agentd 侧 | 移文件 | `src/` → `src/agentd/` |
| 10 | 审批超时=拒绝硬编码 | 写进契约 | 扩契约 | `contracts/agentd/openapi.yaml` |
| 11 | `robotdInfo.mode` 无时间戳 | 加 `observed.at` | 改字段 | `agentd.ts` |
| 12 | `contract:check` 只查一套 | 查两套 | 扩门禁 | `contracts/tools/check.mjs` |

**依赖顺序**：1–3（robotd 内核，ADR-0006）可独立做；7–12（agentd 边界，ADR-0007）
依赖 5–6（错误与任务状态先定型，否则 agentd 的契约要跟着改两遍）；
4 是孤立的小补丁，随时可做。

## 8. 怎么验证（每条给可执行断言）

| 断言 | 怎么查 |
| --- | --- |
| 无中间件 | `package.json` 的 `dependencies` 不含 redis/nats/mqtt/amqplib/zeromq |
| `mode` 单点 | 全库检索 `'idle' : 'degraded'` 三元，计数应为 0（收敛后） |
| 状态写入唯一 | 检索 `this.state.` 的赋值语句，应全部落在事件处理器内 |
| 快照=增量 | 订阅 events 并把增量应用到快照，与 `GET /v1/state` 比对一致（除 `ts`） |
| 错误带 `layer` | 触发 4 类错误（schema / busy / 板侧断 / 未接 BMS），断言返回都含 `layer` 与 `retriable` |
| agentd 无文件耦合 | `src/agentd.ts` 不出现 `contracts/generated` |
| `/api/tools` 有归属 | 返回项 `provider` 不全是 `robotd`；`available` 在板侧失联时为 `false` |
| 审批超时语义 | 调 `POST /api/approvals` 带 `timeout_ms: 600`，断言 `approved === false && status === 'timeout'` |
| 两个契约各有门禁 | `npm run contract:check` 同时校验 robotd 与 agentd 生成物 |

## 相关页面

- [[layers-and-modules|层与模块关系（唯一口径）]] —— 4 层执行位置、层↔模块↔进程映射、B1–B4 与面 A–C
- [[decisions/0006-robotd-event-driven-core|ADR-0006]] —— robotd 内核：事件循环 + 状态单点
- [[decisions/0007-agentd-robotd-boundary|ADR-0007]] —— agentd / robotd 边界分离
- [[decisions/0004-serial-contract-redlines|ADR-0004]] —— 不可知状态红线、`stop`/`estop`
- [[decisions/0002-closed-loop-layering|ADR-0002]] —— 标定权威在 robotd
- [[communication-protocol|分层通信与接口设计]] —— 边界总览、统一契约（Capability/State/Task/Event）
- [[contract-upgrade|接口契约升级方案]] —— 板侧线协议（面 C）的具体设计
- `contracts/openapi.yaml` —— 面 A 的现行契约
