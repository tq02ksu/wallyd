---
title: Mac mini 移动机器人 — 分层通信与接口设计
type: project
description: 逐层定义边界通信：应用层 ↔ Runtime（MCP + WS）、Runtime ↔ ESP32（文本行 JSON 串口协议 v2，含心跳看门狗）、Runtime ↔ modeld / 原生桥、面板与内部契约；含 Capability / State / Task / Event 四类最小契约、超时重试与背压策略。
tags: [project, robot, design, protocol]
domain: robot
project: macmini-robot
sources: []
generated: { by: codex/deepseek-v4-pro, at: 2026-10-04T12:00:00+08:00 }
relations:
  - predicate: part-of
    target: /README.md
  - predicate: depends-on
    target: /docs/architecture.md
---

# 分层通信与接口设计

> **2026-10-21 选型更新**：[ADR-0009](decisions/0009-robotd-python-runtime.md) 已确定新架构 robotd
> 使用 Python；本文 Node `worker_threads` / `MessagePort` 细节是迁移前方案，不再作为新架构选型。
> 对外契约、控制时序、状态单点所有权与快慢分离要求保留；Python 控制隔离机制另行设计。

> 承接 [[architecture|架构设计]] §6 的三容器分层与 §8.3 的高层指令原则。
> 本文只回答一件事：**每两个边界之间，用什么传、传什么形状、坏了怎么办。**

## 0. 一页速览：边界 → 传输选型

> **边界编号按 [[layers-and-modules|层与模块关系]] §5 统一为 `B1–B4`**（链路维度）。
> 本文旧稿曾用「边界 A/B/C/D」，为避免与「接口面 A/B/C」（契约维度）撞名，正文已全部换成 B1–B4；
> 对应关系：旧「边界 A」= **B1**、旧「边界 B」= **B2**、旧「边界 C」= **B3**、旧「边界 D」= **B4**。

| 边界 | 方向 | 传输 | 载荷 | 语义 | 选它的理由 |
| --- | --- | --- | --- | --- | --- |
| **B1** 应用层 → Runtime | `agentd` → `robotd` | **MCP**（tools） | JSON-RPC 2.0 | 能力调用：短 RPC + 长任务 | `agentd` 已是 MCP 客户端，工具面天然就是「能力清单」 |
| **B1** Runtime → 应用层 | `robotd` → `agentd` | MCP 读 + **WS 推送** | JSON | State 快照（拉）+ Event 流（推） | MCP 的订阅/通知语义弱，高频遥测不能走它 |
| **B1'** 应用层 ↔ 模型 | `agentd` → `modeld` | OpenAI 兼容 HTTP + MCP | JSON | 请求/响应 | 复用现成客户端，「看/答」专用 |
| **B3** Runtime ↔ 模型 | `robotd` → `modeld` | 同上（HTTP） | JSON + 文件路径 | 请求/响应 | 同一进程边界，不另发明协议 |
| **B2** Runtime ↔ ESP32 | `robotd` ↔ 固件 | **USB CDC 串口** | 换行分隔 JSON / 文本行 | 命令-应答 + 周期心跳 | 实时、免驱、**拔线即停** |
| Runtime 内部 | 模块间 | **进程内函数调用** | — | TS 同步/异步 | 不引入 IPC；靠契约保证日后可外移 |
| **B3** Runtime ↔ 原生桥 | `robotd` → Swift CLI | `spawn` + stdio | JSON | 一次性命令 | 只有原生才能做的事 |
| **B4** 面板 ↔ 三个进程 | 浏览器 → daemons | HTTP + WS（127.0.0.1） | JSON | 读 + 推送 | 面板要实时看设备与日志 |
| `agentd` ↔ Codex Harness | `agentd` ↔ app-server | JSON-RPC | JSON | — | 已有能力，不改 |

> **契约面 ≠ 边界**：`B*` 数的是**通信链路**，`面 A/B/C` 数的是**需要版本化的对外契约**，两者多对多。
> 面 A = B1 的 robotd 侧契约（`contracts/openapi.yaml`）、面 B = B4 的 agentd 侧契约、面 C = B2 的线协议。
> 详见 [[layers-and-modules|层与模块关系]] §5。

**总原则**：契约只存在于进程边界上；进程内不序列化、不模拟消息总线。这样将来把某个模块外移成进程或接 ROS 2，只需要给同一份契约换一个 transport。

## 1. 判据在通信侧的落点

判据本体（元规则 + P1–P5）在 [[architecture|架构设计]] §1「职责边界判据」——**别在这里另立规矩**，
本节只说明它对通信的影响。四条落点，图上看不出来的问题都出在这里：

1. **快慢分离（目标设计，当前 POC 未实现）**。应用层秒级、`Nav` 10–50Hz、ESP32 负责脉冲与看门狗。
   `robotd` 主线程处理 HTTP/Panel/配置；独立 `worker_threads` Control Worker 持有 `Nav` / `Motion` / 串口与运动状态，
   通过有界 `MessagePort` 与主线程交换消息，不共享可变状态。实时路径不等待网络、模型、磁盘或面板请求。
   目标 tick 为 20ms（50Hz，可按策略降到 10Hz），单 tick 计算预算 ≤ 周期的 80%；感知只取最新样本，
   不在 tick 内等待抓帧/推理。错过 tick 丢弃过期样本；运动输出超过 100ms 未更新则发软件 `robot_stop`。
   `robot_stop` 端到端目标 ≤50ms；Worker/host 停滞时由板侧看门狗兜底，停机目标 ≤500ms（实测约 420ms）。
   Node Worker 是软实时隔离，不提供硬实时保证；STEP/DIR 和失联停机仍必须由 ESP32 实现。
   具体方案见 [[decisions/0008-robotd-control-worker|ADR-0008]]。
2. **安全链按实现状态区分**。已验证的是固件心跳看门狗（300ms 阈值，实测约 420ms 停机）；
   `robot_stop` 是面板/软件可调用的有序停止。USB 断开停机待装车验证；`estop` 固件命令及独立硬件急停断能路径
   尚未实现/验证。硬件急停必须独立于 daemon、Worker、串口与软件 `robot_stop`，不能将软件按钮称为物理急停。
3. **Task 语义与抢占**。`move`/`rotate`/`status` 是毫秒级 RPC；`navigate` / `follow` 是秒到分钟级任务，
   一律返回 `task_id` + 进度事件。**`stop` 是唯一、幂等、可抢占的最高优先级命令**，能打断任何任务。
   机器人只有一个身体 → 同一时刻只允许一个运动任务；`RobotState.mode` 就是这把互斥锁（见 [[architecture|架构设计]] §9.2）。
4. **真相归属**。「谁说的算」必须唯一：步数 = ESP32 的真相；位姿 / 模式 / 电量 = Runtime 的真相；
   「能做什么」= Runtime 的能力清单；Agent 只被允许看 Runtime 报出的事实。串口重连或断电重启后，
   **以 Runtime 重新握手得到的状态为准**，不做增量重放。
   **标定参数（`steps_per_m` / `wheelbase_mm`）的权威在 Runtime**（ADR-0002）：板侧只持运行时值
   与可选的持久化副本，host 通过 `calib` 下发覆盖 —— 这条把「步数=板子」与「单位换算=host」接上：
   板子负责**发脉冲并数脉冲**，host 负责**决定一个脉冲值多少米**。

推论：**应用层有两个入口**——Agent，以及可信的「人 / 确定性流程」。正常任务与物理动作审批通过语音交互；
调试页只用于开发排障，并可提供软件 `robot_stop` 等安全旁路。全部流量都过 LLM，就会出现「Agent 挂起时车既不能动、也没法停」。

**对能力面的直接约束（P4 粒度 + P5 旁路）**：

- **robotd** Agent 可调用的正式工具名以 `contracts/openapi.yaml` 的 `operationId` 为唯一来源，生成的 MCP 名称使用
  snake_case（当前已有 `robot_stop`、`robot_follow` 等）；OpenAPI 尚未定义的 `robot_move`、
  `robot_navigate`、`gimbal_look_at` 等只能标为规划项，不能当作已暴露工具。
- `Nav.goTo()` 这类模块内部方法名不是 Agent 工具，也不是旧名/别名；产品显示标签（如“导航”“跟随”）同样不是 API 名称。
- **禁止**出现 `motor_set_pwm` / `gpio_write` / `servo_pwm` / `ena_set` 这类「硬件怎么被操作」的接口。
- **脱机 `ENA` 不进能力面**：它是固件运动状态机的内部动作（判据推论见 architecture §1）。
  固件保留 `{"op":"ena"}` 只是**调试旁路**——供接线核对极性、实测脱机前后静置电流，
  **不映射成 MCP tool**，Agent 看不到。
- 调试/测试开关（`--no-heartbeat`、`ena` op、维修模式脱机）统一按 P5 处理：显式命名、
  不进口径文档的常规链路、不进 Agent 工具面。

## 2. 边界 B1：应用层 ↔ Runtime（`agentd` ↔ `robotd`）

传输：**MCP 走能力调用，WS 走状态与事件**。两者都只绑定 `127.0.0.1`，`robotd` 永不出网。

**为什么必须拆成两条**：MCP 的 tool call 是请求-应答，适合 `robot_move(...)` 这种"调用一次拿一个结果"；
但机器人状态是持续的（20Hz 位姿、电量、任务进度），用 MCP 轮询会让 Agent 的上下文被遥测塞满，且延迟不可控。

### 2.1 能力调用（MCP tools）

- 工具名 = OpenAPI `operationId`（snake_case），粒度停在**机器人语义**，不下沉到硬件。当前契约中的工具名以
  `contracts/openapi.yaml` 为准；规划中的 `robot_move` / `robot_rotate` / `robot_navigate` 等须先加入契约。
- **禁止**暴露 `motor_set_pwm` / `gpio_write` / `servo_pwm`——Agent 一旦捏引脚，边界就白划了。
- 设计目标是提供能力发现接口，返回协议版本、能力清单、单位与量程；在它进入 OpenAPI 前，不将 `robot.capabilities`
  写成当前已发布工具。
- 泵控等语义 primitive 若实施，应作为 OpenAPI operationId（如规划中的 `pump_set`）；`water_plant` 不留在 Runtime，
  那是应用层 skill，由 Agent 组合已定义的 Robot Skills 完成。

### 2.2 状态与事件

| 内容 | 通道 | 频率 | 规则 |
| --- | --- | --- | --- |
| 状态快照 `State` | WS 推送 + 可随时拉取 | **1Hz**（变化时立即推） | 只推给 Agent 的"摘要态"，不含 20Hz 原始遥测 |
| 内部遥测 | `robotd` 内部 | 10–20Hz | **不出进程**，面板按需订阅 |
| 事件 `Event` | WS 推送 | 状态迁移 / 任务节点 / 安全事件 | 只推"有意义"的：模式变化、任务完成/失败、限位、欠压 |

给 Agent 的快照要**有界**：位姿、模式、电量、设备就绪位、当前任务 id。原始帧序列、串口日志属于面板。

### 2.3 重试与幂等（这条最容易被写错）

- **读操作**（状态、能力发现、规划中的相机采集前探测）：可自动重试，指数退避。
- **物理动作**（运动、泵控、导航）：**禁止自动重试**。超时不代表没执行，
  盲目重发会让车多走一段。
- 超时后的正确动作是：先 `status` / `task.get` 询问当前状态，再决定补发或放弃。
- 审批门（[[architecture|架构设计]] §10.6）挂在**物理动作**上，不挂在查询上。
- 审批是正常业务流程：机器人先用 TTS 复述动作与关键参数，用户通过语音明确确认/拒绝；
  调试页只观察，不作为审批依赖。当前 POC 的面板点击仅为临时测试手段，目标实现见 architecture §10.6。

## 3. 边界 B2：Runtime ↔ ESP32（串口协议 v2）　→ 接口面 C

现状：`wallyd/scripts/` 里的 MicroPython 服务器是**文本行 + `OK:` / `ERR:`**（`hello` /
`move` / `rotate` / `stop` / `status` / `led`），跑通链路用。v2 在它之上加"结构化 + 可寻址 + 心跳"，
**并保留文本行作为救急通道**（拿串口终端敲 `status` 仍然有用）。

### 3.1 帧格式

传输：USB CDC；每行一个 JSON 对象，`\n` 结尾。三类消息：

```text
命令（host → board，带 id）   {"id":7,"op":"move","args":{"left":0.30,"right":0.30,"speed":0.2}}
应答（board → host，同 id）   {"id":7,"ok":true,"data":{"task":null,"steps":[1000,1050]}}
失败（board → host，同 id）   {"id":7,"ok":false,"err":{"code":"E_BUSY","msg":"motion task running"}}
推送 / 事件（board → host）   {"ev":"motion.done","steps":[1000,1050],"ts":123456}
```

- `id` 由 host 单调递增；board 原样回填。**没有 id 的命令 = 最高优先级**（`stop` 专用）。
- 一个 `id` 只允许一次应答；重连后 `id` 归零，board 不记忆历史。

### 3.2 命令集（v2 最小集）

| 命令 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `hello` | `proto: 2` | `fw` / `proto` / `caps` / `steps_per_m` / `wheelbase_mm` / `calib_source` / `limits` | **握手**：版本、板级能力、单位换算全在这 |
| `move` | `left` / `right`（米）、`speed`（m/s）、`accel` | `steps` 或 `task` | 差速位移；轨迹规划在板侧 |
| `rotate` | `deg` | `steps` | 原地旋转 |
| `velocity` | `v` / `w` | `ok` | **心跳兼连续控制**，10Hz；受看门狗约束 |
| `stop` | — | `ok` | 幂等、可抢占、**无 id 也执行** |
| `status` | — | 模式、步数、限位、电压、固件错误码 | 只读 |
| `calib` | `steps_per_m` / `wheelbase_mm` / `persist` | 回读后的值 + `calib_source` + `persisted` | **标定下发**（ADR-0002）：改运行时变量，**不刷固件**；`persist:true` 才写盘 |
| `pump` | `state: on\|off` 或 `ms` | `ok` | 预留扩展位 |
| `gimbal` | `pan` / `tilt` | `ok` | 预留扩展位 |

命名沿用 [[architecture|架构设计]] §5.3 的语义：**host 发"做什么"，板子做"怎么做"**。
单位在 `hello` 里统一声明（米 / 弧度 / 秒），host 侧负责把 Agent 的语义换算成米——**板子不懂语义**。

**标定值归属（ADR-0002）**：`steps_per_m` / `wheelbase_mm` 的**权威在 robotd**（可配置、可热更新），
板侧只是执行者与（可选）持久化者。`hello` 回读板侧当前值供 host 比对；host 用 `calib` 下发覆盖，
**不再需要重刷固件**。`calib_source` 标明当前值来自 `default`（出厂）/ `board`（掉电读回）/ `host`（本次覆盖）。

### 3.3 心跳与看门狗（安全核心）

- host 在**有运动意图时**必须持续发 `velocity`（或 `keepalive`），≥5Hz；
- 板侧 **300ms 未收到即自主停机**，规则写死在固件里，不依赖上位机状态；
- 看门狗**只影响运动**，不影响 `status` 应答与断线重连；
- `stop` 不受心跳影响——任何时候发都立即停。

### 3.4 错误模型

| 码 | 含义 | host 侧动作 |
| --- | --- | --- |
| `E_BUSY` | 已有运动任务在跑 | 不重发；先 `stop` 或等 `motion.done` |
| `E_RANGE` | 参数越界（超速、超步数） | 收敛参数后重发一次；连续两次失败上报 Agent |
| `E_STATE` | 当前模式下不允许（如未回零） | 转成 Agent 可读的失败原因，不重试 |
| `E_FW` | 协议版本不匹配 | **拒绝下发运动命令**，只允许 `status` 与刷固件 |
| `E_HW` | 限位 / 堵转 / 欠压 / 驱动异常 | 先停机再上报；安全类事件直推面板 |

**安全类错误（`E_HW`）优先级高于一切**：板子先停机、再上报，host 不参与决策。

### 3.5 版本协商

每次 `robotd` 启动都跑一遍 `hello`。`proto` 不匹配时进入**降级模式**：只读 + 刷固件，不允许运动。
这条对应 [[architecture|架构设计]] §13 的风险 R7（接口契约漂移）。

## 4. 边界 B3：Runtime ↔ modeld 与原生桥

**modeld**：复用 OpenAI 兼容 HTTP（`/v1/chat/completions`）+ MCP（`vision.*`）。

- **图像传输**：同一台机器上优先传**文件路径**（临时文件进 `work/`），不用 base64 撑爆请求体；
  HTTP 接口的 base64 只作兼容路径保留。
  （POC 实现：能力面 `vision.describe` 的 `image` 收**路径或 data URL**，路径→base64 的转换
  由 robotd 在 HTTP 边界做——`mlx_vlm.server` 只认 OpenAI 的 data URL 形态。）
- **必须有不进控制回路的自觉**：单帧 0.3–3s，`Nav` 永远不等 modeld；
  「看一眼」是异步的，`v/ω` 是本地算的。
- **取消与超时**：默认 10s 超时 + `AbortSignal` 取消；超时返回 `E_MODEL_TIMEOUT`。
- **降级要显式**：modeld 不可用时返回 `E_MODEL_DOWN`，而不是让 Agent 自己猜画面内容——
  「模型挂了但 Agent 编了个答案」比直接失败危险得多。
- **投喂要显式**：`image` 路径读不到返回 `E_IMAGE`；不带图的调用返回值里 `grounded=false`
  ——**真模型没有像素也会自信地描述一个不存在的画面**（POC 实测：问"画面里有几个人"，
  它答"一个坐长椅的女性、一个站着的男性"），调用方不得把这种文本当观测。
- **单飞**：同一进程边界同时只允许一个推理在飞，多余的**排队**而非并发（真模型是重活，
  并发既抢内存又把延迟摊给所有调用方）。
- **谁可以调**：两层都可以（Runtime 用于视觉、Agent 用于问答），
  但**只有经由 Runtime 的输出才能触发物理动作**。

**原生桥**：沿用 [[architecture|架构设计]] §8.4 的契约——`spawn(binary, [subcommand], {input: JSON})`，
stdout 回 `{"ok":true,"data":...}`。进程一次性退出，无常驻状态，失败即重启；桥内禁止写 `raw/`，
临时产物一律进 `work/`。

现有两座桥：

| 桥 | 谁 spawn | 为什么必须是原生的 |
| --- | --- | --- |
| `serial-bridge.py` | robotd | Node 没有 ioctl，清不掉 DTR/RTS ⇒ 串口开一次就复位板子 |
| `uvc_capture.swift` | robotd（规划中的 `camera_capture`） | UVC 抓帧只有 AVFoundation 这一条路；TS 侧只拿"路径 + 尺寸 + 耗时" |
| `mac_speech.swift` | robotd（`speech_listen` / `robot_speak`） | ASR/TTS 只有系统 API（`SpeechAnalyzer` / `AVSpeechSynthesizer`）这一条路；**语音不引模型**（§6.4） |

相机桥的额外约定（2026-10-09）：**stdout 恰好一行 JSON**（诊断一律走 stderr），错误码
`E_CAM_NODEV / E_CAM_OPEN / E_CAM_PERM / E_CAM_TIMEOUT / E_CAM_WRITE`；**授权不是 authorized 时
AVFoundation 静默不出帧**（不是报错），所以超时信息里必须带 `camera_authorization`。
帧落 `work/poc/frames/`，预览走调试旁路 `GET /api/debug/frame`（只服务该目录、名字只取 basename）。

**「一行 JSON」的一个例外（2026-10-10）**：`mac_speech.swift stream` 是**流式**的，stdout 吐
**NDJSON**（`{"ev":"ready"}` → 反复 `{"ev":"partial","text":…}` → `{"ev":"final","text":…}`）。
原因是它要"边说边出字"——一行一行的最终结果满足不了。两条约定：① 停止方式是 **stdin 收到 `stop`
或 EOF**，所以 robotd 必须**保持子进程 stdin 打开**（用 `ignore` 喂 /dev/null 会让它刚开始就收尾，
实测踩到）；② 这类桥**不能套超时**，时长由参数（`--max-seconds`）和"谁关 stdin"决定。

## 5. 边界 B4：面板与进程内部　→ 接口面 B

- **面板**：REST 读配置与状态，WS 推状态、任务、日志；绑定 `127.0.0.1` + 启动时随机 token，
  不监听 `0.0.0.0`。
- **面板是开发 / 排障入口**：软件 `robot_stop`、模式切换（维护 / 遥控）必须能**绕开 Agent** 直接打到 `robotd`，
  但调试页不是日常任务入口或审批依赖；正常物理动作通过语音审批。软件停止不是物理急停；
  独立硬件急停路径尚未实现/验证，见第 1 节安全状态说明。
- **进程内部**：模块之间只允许通过 **Capability 接口**互相调用，签名固定为
  `(args, ctx) => Promise<Result | Task>`；禁止 import 对方的实现细节。
  这样"把 `Nav` 外移成一个进程"就只是给同一份契约换 transport，而非重写。

## 6. 统一契约：Capability / State / Task / Event

四类东西就是全部。Agent 的闭环 = 查能力 → 看状态 → 调工具 → 跟任务 → 收事件。

```jsonc
// 1) Capability —— “能做什么”
{ "name": "robot_move",
  "args": { "left_m": 0.3, "right_m": 0.3, "speed_mps": 0.2 },
  "returns": "rpc | task",
  "requires_approval": true }

// 2) State —— “现在怎样”（快照，覆盖语义）
{ "ts": 1760000000.000, "mode": "idle | moving | navigating | degraded | error",
  "pose": { "x": 0.0, "y": 0.0, "theta": 0.0 },
  "battery": { "voltage": 12.4, "percent": 72 },
  "devices": { "esp32": "ready", "camera": "ready", "pump": "off" },
  "task_id": null }

// 3) Task —— “正在做什么”（增量，带生命周期）
{ "task_id": "t-abc123", "capability": "robot_navigate", "state": "running",
  "progress": 0.4, "started_at": 1760000000.000, "cancelable": true }

// 4) Event —— “发生了什么”（增量，不重放）
{ "ev": "task.completed", "task_id": "t-abc123", "ts": 1760000031.500 }
```

约定：

- **State 是合取，Event 是增量**。重连后先拉一份 State 对齐，再订阅 Event；Event 带单调序号，
  出现 gap 就重新拉 State，而不是等重放。
- **Task 必须可取消**（`robot_stop` 或 `task_cancel`），且只有一个运动任务在跑。
- `requires_approval` 是能力的属性，不是 Agent 的自觉——审批门读它。

## 7. 超时 / 重试 / 背压一览

| 边界 | 超时 | 重试 | 背压 / 限流 |
| --- | --- | --- | --- |
| `agentd` → `robotd`（tool） | 短 RPC 2s；长任务立即返回 `task_id` | 只读可重试；物理动作不重试 | 同一时刻一个运动任务 |
| `robotd` → `agentd`（State/Event） | — | gap → 重拉 State | 状态 1Hz；事件只推有意义者 |
| `robotd` → `modeld` | 10s + 取消 | 不自动重试（重跑一次图更贵） | 单飞：同时只允许一个推理请求排队 |
| `robotd` ↔ ESP32 | 命令 500ms | 读可重试；运动不重试 | 发送队列长度上限；满则丢弃非安全命令 |
| 面板 ↔ daemons | 5s | 可重试 | 日志打折输出（丢弃重复行） |

## 8. 为什么现在不引入 ROS 2 / zenoh

这套契约是**语言无关的线协议**（MCP + JSON-RPC + 文本行 JSON），所以将来接 ROS 2 只是给
Runtime 增加一个 transport adapter，而不是重写应用层。反过来说：现在引入 ROS 2 的代价是
Node 侧只有 `rclnodejs` / `rosbridge` 两条非主流路径，且要为 DDS 付出一整套运维成本——
在"一个底盘、两个电机"的阶段不划算。判据与三阶段结论见
[[macmini-robot-precedents|Mac mini 机器人已有先例盘点]] §2026-10-04 与本页 §0。

## 9. 待核实 / 下一步

> **2026-10-04 POC 实测修订**（实现、跑法与证据见 `work/poc/README.md`，不入库）：

- [x] **Codex Harness 的 MCP 传输形态**：POC 走 stdio（`codex exec` 拉起 `robot-mcp`）已验证可用；
  app-server 形态未验。**附带发现**：非交互 exec 的 approval policy 是 `never`，会**在到达 MCP 服务前**
  拒掉所有工具调用——需要 `--approve-for-me` + `-c mcp_servers.<n>.default_tools_approval_mode="auto"`。
- [x] **MCP 能否承载长任务进度**：不能（只有 `tools/call`）。任务进度与事件走 WS 推送，POC 已按此实现并跑通。
- [x] **串口 JSON 行的抖动**：115200 + 板侧 20ms tick 实测稳定（1600 步 / 1.33s 无丢行丢包）；
  921600 未测。
- [x] **心跳频率与看门狗阈值**：`velocity` 5Hz + 板侧 300ms 阈值实测**有效**——故意停心跳时板子在
  **420ms 内**自主停机（含 tick 与轮询延迟）。是否需要收紧待装车后再标定。
- [x] **State 给 Agent 的摘要字段**：POC 按「位姿 / 模式 / 电量 / 设备 / 当前任务」实现，够用，暂不裁剪。

**POC 新增的待核实项**：

- [x] **板子复位/重启后的状态对齐**：固件启动会发 `boot` 事件。POC 原先**不处理**——若复位发生在运动中，
  板侧动作静默中断，而 Runtime 的 task 会**一直停在 running**（之后运动命令全被 `E_BUSY` 顶回，
  只能重启 robotd）；位姿依旧沿用旧值 ⇒ 与"真相归属"纪律（§1 纪律 4）冲突。**POC 已修**（2026-10-05）：
  `robotd` 收到 `boot` / 握手版本变化时——① 作废当前 task 并广播 `task.failed(reason=board_reset)`；
  ② 把 `pose` 标记为 `valid=false`（需回零/重标定）；③ 重新握手（固件可能刚重刷，`proto`/换算可能变）。
  仿真正验用例已过（`sim.reboot` 注入），真机「运动中复位」待验；实现与用例见 `work/poc/README.md`（不入库）。
- [ ] **`steps_per_m` / `wheelbase_mm` 标定**：固件里的 8000 / 120 是占位值，位姿目前只是相对量。
  **2026-10-14 部分推进**：标定值的**下发通道**已打通——协议新增 `calib` op（改运行时变量、不刷固件）、
  REST 新增 `GET/PUT /v1/robot/odometry/calibration`、`hello` 增回 `calib_source`；见 [[decisions/0002-closed-loop-layering|ADR-0002]]。
  **仍待实测**：真实数值标定（轮径 × 细分 → steps/m）、`persist` 掉电读回是否可靠。
- [ ] **电机真实动作**：POC 固件默认 `DRIVE_MOTORS=False`（只点灯），单电机空转与限位/急停未验。
- [ ] **产品化工程项**：目标机无 Node/pyserial（需装运行时）；POC 靠 Node 类型擦除跑 `.ts`，
  未做类型检查——产品要把 Zod/tsc 纳入构建。

## 相关页面

- [[architecture|架构设计（C4）]]
- [[architecture|架构设计文档]]（§5.3 高层指令与低层实时）
- [[architecture|架构设计]] §9.2（`RobotState` 互斥与 Task 生命周期）
- [[stepper-wiring|步进驱动接线与供电]]
- [[macmini-robot-precedents|Mac mini 机器人已有先例盘点]]
