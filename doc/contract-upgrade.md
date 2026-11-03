---
title: 接口契约升级方案 — 从「散文协议」到「可发现 + 可断言」
type: project
description: 把两条只有散文的边界（板侧线协议、模型帧）补上机器可读形状与可跑门禁：wire-protocol.yaml 管板侧 op/事件/常量并用 SimBoard 做白盒断言，model-frames.yaml 给模型输出定最小 schema 并立「厂商格式不得直通 Agent」红线。含现状清点表、漂移证据、spec 骨架与门禁设计。
tags: [project, robot, contract, protocol, design]
domain: robot
project: macmini-robot
sources: []
generated: { by: assistant:workbuddy, at: 2026-10-18T23:05:00+08:00 }
relations:
  - predicate: part-of
    target: /projects/robot/README.md
  - predicate: depends-on
    target: /projects/robot/contracts/openapi.yaml
  - predicate: depends-on
    target: /projects/robot/doc/decisions/0005-contract-upgrade-v2.md
  - predicate: depends-on
    target: /projects/robot/doc/communication-protocol.md
---

# 接口契约升级方案

> 决策与理由见 [[decisions/0005-contract-upgrade-v2|ADR-0005]]。本文只写**是什么、长什么样、怎么验**。
> 上位文书：[[communication-protocol|分层通信与接口设计]]（每两个边界用什么传）。

## 0. 一句话

**`openapi.yaml` 那条路已经做对了**（单一源 → 生成 MCP 工具面与 TS 类型 → `contract:check` 门禁）。
本方案把同样的做法**只补到还没有的两条边界**上：板侧线协议、模型帧。

## 1. 现状清点（2026-10-18 逐文件读代码）

| # | 接口 | 现状载体 | 机器可读 | 门禁 | 本次动作 |
| --- | --- | --- | --- | --- | --- |
| ① | `openapi.yaml` → MCP 工具面 + TS 类型 | 单一源 | ✅ | ✅ | **不动**（标杆） |
| ② | 板侧线协议（op / 字段 / 事件） | 散文 + 代码注释 | ❌ | ❌ | 🔴 **补 `wire-protocol.yaml`** |
| ③ | 内部能力名（`motion.*` / `vision.*`…） | 代码 `register()` | ❌ | ❌ | 🟡 记待办 |
| ④ | 模型帧（`vision.describe` / `vision.find`） | 代码即规格 | ❌ | ❌ | 🔴 **补 `model-frames.yaml`** |
| ⑤ | 原生桥 JSON | 散文 | ❌ | ❌ | ⚪ 保持（单一调用方） |
| ⑥ | 事件名（`task.*` / `speech.*`…） | 散文 + 门禁常量 | ⚠️ | ⚠️ | ⚪ 保持（已有 `V1_SUPPORTED_TYPES`） |

## 2. 板侧线协议已经在漂（证据）

### 2.1 为什么它不在 `openapi.yaml` 里

```js
// contracts/tools/generate.mjs
if ((op.tags ?? []).includes('debug') || op['x-websocket']) continue;
```

边界 B2 的九条 op **一条都没进** `contracts/`。事实源分散四处：协议 §3（散文）、
`firmware/robot_server_v2.py` 的 `handle_json()`、`SimBoard.send()`、`archive/poc-design.md` / `eval/`。

### 2.2 三处实测漂移

| 漂移点 | `communication-protocol.md` §3.2 | `robot_server_v2.py` | `SimBoard` |
| --- | --- | --- | --- |
| `rotate` 参数 | `deg` | **`steps`** | **`steps`** |
| `hello.caps` | 未列 | 无 `ena`（但**有** `ena` op） | 无 `ena`；多了 **`pump`** |
| `status` 字段 | 「…限位、**电压**、固件错误码」 | **无电压、无限位**；有 `ena` / `ena_ms` / `hb_age_ms` | 更少 |

**结论**：不是「将来可能漂」，是**已经漂了**。`hello.caps` 尤其名不副实——
`ena` 有 op 却不申报，`pump` 申报了但只在仿真板成立。
`camera` 字段是**协议有意留白**（靠 `camera.capture` 的桥错误码 `E_CAM_NODEV` 驱动
`devices.camera` 状态），这条要在 spec 里显式写成 `probe: by_operation`，避免被当成遗漏。

### 2.3 `hello` 是什么、不是什么

- **是**：会话建立、版本协商（`proto` 不匹配 → 降级）、**板级能力与单位换算**（`steps_per_m` /
  `wheelbase_mm` / `calib_source`）、**驱动在位**（`DRIVERS_PRESENT` 经 `drivers` 自报）、
  `drive_motors`。
- **不是**：完整状态。`hello` 没有 `mode` / `pump`（尽管协议 §3.2 说它返回 `caps` 等一堆），
  也没有 `ena`。
- **`hello.caps` 的正确语义**：它声明的是「**能被 `/v1/debug/serial` 触达的 op**」，
  **不是**「能力面」——能力面是 `robot.capabilities`（边界 B1）。两者不可互换。

## 3. `contracts/wire-protocol.yaml` 骨架

```yaml
# 边界 B2（robotd ↔ ESP32）的唯一事实源。
# ⚠️ 本文件**不进** generate.mjs 的 MCP 工具面出口——板侧 op 从设计上不出现在 Agent 眼里（P4 + P5）。
wire_protocol:
  version: 2
  transport: usb_cdc
  framing: jsonl            # 每行一个 JSON 对象，\n 结尾；保留文本行做救急通道
  id: { host: monotonic, echo: true, absent_means: highest_priority }
  units: { distance: m, angle: deg, speed: m_per_s, time: s }   # 以 hello 为唯一声明处

timeouts:
  command_ms: 500
  heartbeat_host_hz_min: 5
  watchdog_board_ms: 300
  stop_deadline_ms: 50          # ADR-0003 承诺值
  watchdog_deadline_ms: 500     # ADR-0003 承诺值

# 板侧实测常量：目前散在固件头部注释里，升级为 spec 的一个区块，固件从生成物取值
board_constants:
  MAX_RATE: 1500.0              # 软件方波能稳的上限
  CHUNK_MS: 250                 # 单次脉冲块目标时长（53ms 块掉速 14%，实测）
  DT_CAP_MS: 500                # 必须 ≥ 脉冲块时长（100ms 掉速 21%，实测）
  POLL_EVERY_STEPS: 24          # 每 24 步查一次串口（8 步/次吃 20% 时间，实测）
  TICK_MS: 20
  ENA_SETTLE_MS: 20
  ENA_HOLD_MS: null             # 见固件
  PROGRESS_EVERY_MS: null
  HEARTBEAT_TIMEOUT_MS: 300

caps:                            # hello.caps 的权威清单
  # agent_visible: 能否经 /v1/debug/serial 触达（false = 纯内部或纯旁路）
  # debug_bypass: P5 旁路，不进 Agent 工具面
  - { op: hello,   agent_visible: true,  debug_bypass: false }
  - { op: move,    agent_visible: true,  debug_bypass: false, approval: via_capability }
  - { op: rotate,  agent_visible: true,  debug_bypass: false }
  - { op: velocity,agent_visible: true,  debug_bypass: false, note: 心跳兼连续控制 }
  - { op: stop,    agent_visible: true,  debug_bypass: true,  note: 免审批、可抢占、无 id 也执行 }
  - { op: status,  agent_visible: true,  debug_bypass: false }
  - { op: calib,   agent_visible: true,  debug_bypass: false, authority: robotd }   # ADR-0002
  - { op: pump,    agent_visible: true,  debug_bypass: false, status: reserved }
  - { op: gimbal,  agent_visible: true,  debug_bypass: false, status: reserved }
  - { op: ena,     agent_visible: true,  debug_bypass: true,  note: 接线核对/量静置电流 }
  - { op: pulse,   agent_visible: true,  debug_bypass: true,  note: 台面判极性 }
  - { op: pins,    agent_visible: true,  debug_bypass: true,  note: 万用表静态测量 }
  - { op: led,     agent_visible: true,  debug_bypass: true }

ops:
  hello:
    request:  { proto: { type: integer, const: 2 } }
    response:
      fw:            { type: string }
      proto:         { type: integer }
      microsteps:    { type: integer }
      steps_per_m:   { type: number }
      wheelbase_mm:  { type: number }
      calib_source:  { type: string, enum: [default, board, host] }
      drive_motors:  { type: boolean }
      drivers:       { type: array, items: { type: string, enum: [L, R] } }   # 从 DRIVERS_PRESENT 自报
      ena:           { type: string }
      caps:          { type: array, items: { type: string }, source: caps }
    notes: |
      不是完整状态：没有 mode / pump。求状态用 status。
      video 设备不在板级 caps（camera 由 camera.capture 的桥错误码驱动 state.devices.camera）。

  rotate:
    request: { steps: { type: integer, note: "⚠️ 是 steps 不是 deg；协议 §3.2 的 deg 是笔误，以本 spec 为准" } }

  status:
    response:
      mode:      { type: string, enum: [idle, moving] }
      pump:      { type: string, enum: [on, off] }
      microsteps:{ type: integer }
      drive_motors: { type: boolean }
      drivers:   { type: array }
      ena:       { type: string }
      ena_ms:    { type: integer, note: 使能已持续时间；防"钉住使能忘了放" }
      remaining: { type: integer, note: 剩余步数（应发口径，非实走） }
      hb_age_ms: { type: integer, note: 距上次心跳毫秒数 }
    notes: |
      ⚠️ 没有 voltage / 限位字段——协议 §3.2 那句"电压、限位"是**尚未实现**的愿景，
      不是现状。按 ADR-0004 的「不可知不许伪造」红线，**在硬件接上之前不得加进契约**。

events:
  boot:            { fields: { fw: string, drive_motors: boolean, steps_per_m: number,
                              wheelbase_mm: number, calib_source: string },
                     note: 会话中途再收到 = 复位；robotd 据此作废 task + pose.valid=false }
  motion.progress: { fields: { p: number } }
  motion.done:     { fields: { steps: integer }, note: "steps = total（本次任务步数），⚠️ 不是累计" }
  motion.aborted:  { fields: { reason: string, hb_age_ms: integer? } }
  ena.release_scheduled: { fields: { in_ms: integer, why: string } }

errors:
  E_BUSY:   { host_action: no_retry }
  E_RANGE:  { host_action: retry_once_after_clamp }
  E_STATE:  { host_action: no_retry }
  E_FW:     { host_action: refuse_motion }
  E_HW:     { host_action: stop_first_then_report, priority: highest }
  E_ARGS:   { host_action: no_retry }
  E_CMD:    { host_action: no_retry }
  E_PARSE:  { host_action: no_retry }
  E_NO_DRIVER: { host_action: no_retry, note: 该侧驱动器不在位 }
```

### 3.1 跨层参数的两处收口

ADR-0003 定的两个**跨层参数**在 spec 里有了单一住处（`timeouts` 区块）：

| 参数 | 值 | 归属说明 |
| --- | --- | --- |
| 速度指令更新频率 | host **≥5Hz** | **契约层**要求；与板侧内部 50Hz（`TICK_MS=20`）是**两层不同频率**，各自独立 |
| 打断延迟上限 | `stop` **≤50ms**、看门狗 **≤500ms** | 承诺值；实测为 ~20ms / 420ms，留 2× 余量 |

`velocity` 的**双身份**必须写进 spec 的 `notes`：它是心跳（喂狗）**兼**连续控制（`v` / `w`），
**发它不等于下速度指令**——避免 host 以为喂了狗就控制了速度。

## 4. `contracts/model-frames.yaml` 骨架

```yaml
# 边界 B3 的模型帧契约。核心红线：**厂商格式不得直通 Agent**。
model_frames:
  version: 1

vision.describe:
  response:
    text:      { type: string, maxLength: 400 }
    model:     { type: string }
    grounded:  { type: boolean, required: true,
                 note: "= 这帧有没有真的给像素。grounded=false 时 text 是模型凭空描述，
                        **不得当观测**（实测：问'画面里有几个人'它答'一个坐椅上的女性…'）" }
  internal: [ ts_mono_ns ]      # 原生桥时钟，不进 Agent 可见面

vision.find:
  response:
    target:     { type: string }
    frame:      { type: string }
    candidates: { type: array,
                  items: { box: {x1,y1,x2,y2 0..1000 归一化},
                           crop: string?,
                           self_check: { enum: [agree, deny, unclear, error] },
                           self_check_text: { internal: true } } }   # 模型自检中间态
    uncertain:  { type: boolean }
    note:       { type: string }
    elapsed_ms: { type: integer }
  internal: [ self_check_text, ts_mono_ns ]

redlines:
  - "模型的原始输出只能进 raw / note 字段，带 model 与 elapsed_ms，
     **不得成为能力面的形状**（P4：Agent 看到的是观测，不是模型怎么说话）"
  - "grounded 是必填字段；调用方不得在 grounded=false 时把 text 当观测"
  - "同模型自检（self_check）只是弱证据：压得住'为回答而编造'，压不住'真的认错'"
```

**同步收口已泄漏的帧**（本次一并改）：

| 字段 | 出现在 | 处置 |
| --- | --- | --- |
| `ts_mono_ns` | `robot.speak` / `speech.listen` 事件 | 标 `internal`，不进 Agent 可见面 |
| `self_check_text` | `vision.find` | 标 `internal` |
| `raw` / `text`（模型原话） | `vision.*` | 保留但强制带 `grounded` |

## 5. 门禁设计

现有 `contract:check` 只做一件事：**生成物与 `openapi.yaml` 一致**。升级为三段：

| 段 | 检查 | 依赖真机？ |
| --- | --- | --- |
| ① 一致性 | 生成物 vs `openapi.yaml`（**现有**） | 否 |
| ② **白盒断言** | 起 `robotd:sim`，跑 spec 里每条 op，断言「应答字段 ⊇ spec 声明」且「无未声明字段」 | **否** |
| ③ 红线可检 | 断言 `vision.*` 必带 `grounded`；断言 Agent 可见面**不存在** `internal` 标记项 | 否 |

**② 为什么用 SimBoard 能挡真板漂移**：`SimBoard` 的定位就是「**固件行为的可执行规格**」
（源码注释原文），它和真板是同一套协议的两个实现。用 spec 卡住 SimBoard，就卡住了协议层；
真板一致性靠**装车后单独过一次**（与 ADR-0002 的标定同批）。

**② 的已知前置**：SimBoard 现在**没复刻** `ena` / `pulse` / `pins` / `led` 四个调试旁路 op
（`default: E_CMD`）。白盒断言要么跳过 `debug_bypass: true` 的条目，要么补齐 SimBoard——
后者更好，因为它同时让面板的接线核对流程能在仿真里走通。

## 6. 不做什么（以及为什么）

| 不做 | 理由 |
| --- | --- |
| 把线协议塞进 `openapi.yaml` | 会经 `generate.mjs` 变成 MCP 工具，`pins` / `pulse` / `ena` **漏进 Agent 工具面**，违反 P5 + P4 |
| 把内部能力名导出成契约清单 | 它是 `/v1/debug/*` 旁路的一部分；且 `motion.move` 与 `operationId` 目前靠**命名巧合**一致——记待办，不在本次 |
| 契约化原生桥 JSON | 只有 `robotd` 一个调用方，形状简单（一行 JSON / NDJSON）；扩到两个以上调用方时再补 |
| 给 `status` 加 `voltage` / 限位字段 | 硬件未接——按 ADR-0004「宁缺勿假」**不许**先加字段 |
| 把 `stop` 与 `estop` 合成一个 op | ADR-0004 已否决；本次只是把 `estop` 写进 spec 的**待实现**区 |

## 7. 落地顺序

1. **建两个 spec 文件**（纯文档，无依赖），按上面骨架填全。
2. **修三处已漂**：`rotate` 参数（改协议 §3.2 为 `steps`）、`hello.caps`（按 spec 的 `caps` 生成）、
   `status` 字段描述（删「电压、限位」的愿景表述）。
3. **扩 `contract:check`**：加 ② 白盒断言 + ③ 红线可检两段。
4. **补齐 SimBoard**：复刻 `ena` / `pulse` / `pins` / `led`，让 ② 能全覆盖。
5. **真机核对**（装车后）：跑一遍 spec 全部 op，断言真板应答与 spec 一致。

## 相关页面

- [[decisions/0005-contract-upgrade-v2|ADR-0005 契约升级到 v2]] —— 决策与理由
- [[decisions/0004-serial-contract-redlines|ADR-0004 串口契约红线]] —— 不可知状态红线、`stop`/`estop`
- [[decisions/0003-timing-constraints-layering|ADR-0003 时间约束分层]] —— 两个跨层参数
- [[decisions/0002-closed-loop-layering|ADR-0002 闭环分层]] —— `calib` 权威在 robotd
- [[communication-protocol|分层通信与接口设计]] —— 边界总览（§0）、边界 B2（§3）、边界 B3（§4）
- [[timing-contract-review|时间约束与接口契约 — 现状核实]] —— 三态清单
