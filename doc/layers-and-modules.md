---
title: Mac mini 移动机器人 — 层与模块关系（唯一口径）
type: project
description: 全项目「层」的统一口径：4 层执行位置（L1 固件 / L2 进程内模块 / L3 进程 / L4 交互面）、模块按交互方式分四类（请求应答 / 感知事件源 / 整流派生 / 适配）、层与模块的映射表、边界命名 B1–B4 与接口面 A–C 的对应，以及四个正交维度（职权 / 执行位置 / 时间 / 部署）的区分。凡其它文档说「某层」，一律以本页为准。
tags: [project, robot, architecture, glossary]
domain: robot
project: macmini-robot
sources: []
generated: { by: process:copilot, at: 2026-10-20T17:46:27+08:00 }
relations:
  - predicate: part-of
    target: /projects/robot/README.md
  - predicate: depends-on
    target: /projects/robot/doc/architecture.md
  - predicate: depends-on
    target: /projects/robot/doc/architecture.md
  - predicate: depends-on
    target: /projects/robot/doc/decisions/0003-timing-constraints-layering.md
  - predicate: depends-on
    target: /projects/robot/doc/archive/interface-redesign.md
---

# 层与模块关系（唯一口径）

> **本页是全项目「层」这个词的唯一解释。** 其它文档出现「固件层 / Runtime / 应用层 / 边界 B / 面 A」
> 这类说法时，含义一律按本页，不再各自解释。新增文档若需要新层，先改本页。
>
> 起因：文档里曾同时存在四套互不相通的数法——`architecture.md` 的四层（交互/认知/执行/基础，**按软件职责**）、
> `architecture.md` 的三容器（robotd/modeld/agentd，**按部署**）、
> `communication-protocol.md` 的边界 A–D（**按链路**）、归档提案 `[[archive/interface-redesign]]` 的面 A–C（**按对外契约**）。
> 四套都自洽，但「几层」这个问题在不同文档里会得到不同答案（§2 有清点）。

## 1. 一句话

**「层」有四种数法，它们是四个正交维度，永远不要跨维度相加。**
回答「分几层」之前，必须先问清**按哪个维度数**。本页把最常用的那个维度（执行位置）钉死为 4 层。

**定位一个模块要填两个坐标**：① 执行位置（§3，跑在哪）② 交互类型（§4.0，怎么被调用）。
**这两个坐标互相独立**——「robotd 里的基础感知模块、接口是事件流式的」= 执行位置 **L2**、
交互类型 **② 感知/事件源**。

## 2. 四个正交维度（先分清再数）

| 维度 | 回答什么 | 本项目的划分 | 数出来几个 | 权威出处 |
| --- | --- | --- | --- | --- |
| **职权维度** | 某功能**该归谁** | 判据 P1–P5 推出的落点 | 不预先定「层」，由判据**推结论** | [[architecture]] §1 |
| **执行位置**（主口径） | 代码**跑在哪** | **L1 固件 / L2 进程内模块 / L3 进程 / L4 交互面** | **4** | **本页 §3** |
| **交互类型** | 模块**怎么被调用** | 请求应答 / 感知事件源 / 整流派生 / 适配 | 4 类（**与层正交**） | **本页 §4.0** |
| **时间维度** | 约束在**什么时间尺度** | 微秒–毫秒 / 10–100Hz / 秒–分钟 | 3 段（**不是 3 层**） | [[decisions/0003-timing-constraints-layering\|ADR-0003]] |
| **部署维度** | 什么能**独立启停** | robotd / modeld / agentd + 原生桥 + Panel | 3 常驻进程 | [[architecture]] §6.1 |
| **链路维度** | 谁跟谁**通信** | 边界 B1–B4 + 进程间 | 4 边界 | [[communication-protocol]] §0 |

> **常见误读**：① `robotd` 既是「L3 的一个进程」，又是「时间维度里 10–100Hz 那一段的承担者」，
> 还是「部署维度里可独立重启的一个单元」——**这是同一个东西在三个维度里的投影，不是三个东西**。
> ② 同一个 `Perception` 模块，执行位置是 L2、交互类型是 ②、时间尺度在 10–100Hz——
> **三个坐标各填一格，不能拿其中一个当另一个用**。
> ③ `Motion` 是 L2 模块，它运行在 L3 的 robotd 进程内——**模块是层的组成部分，不是层的同级**（§4）。

## 3. 执行位置：4 层（主口径，回答「分几层」用这个）

| 层 | 名字 | 是什么 | 包含 | 判据落点 | 权威出处 |
| --- | --- | --- | --- | --- | --- |
| **L1** | **固件层** | 跑在 ESP32-S3 上的 MicroPython 固件 | 命令服务、轨迹规划、加减速、脉冲生成、编码器读取、看门狗、`ENA` 状态机 | P1 微秒–毫秒 | `firmware/robot_server_v2.py` |
| **L2** | **进程内模块层** | daemon 内部的模块，**不各自起进程** | robotd：`DeviceManager` `Motion` `Gimbal` `Nav` `MCP Server`；modeld：`ModelRuntime`；agentd：快速意图路由、Codex 客户端/生命周期管理、`Session` `Workspace` `Approval` `MCP Client`；各进程内置 Config/Event/Log | P1 10–100Hz、P2、P4 | [[architecture]] §7.3 |
| **L3** | **进程层** | daemon 与受管子进程 | 三个常驻 daemon：`robotd`、`modeld`、`agentd`；受管子进程：Codex app-server（由 agentd 管理，用户无感）、`robot-mcp`、Swift 原生桥 | P3 故障隔离、可回收 | [[architecture]] §6.1 |
| **L4** | **交互面层** | 人与外部系统看到的面 | Panel（浏览器）、调试工具；Swift 原生桥是进程适配边界，不是用户交互面 | P3 人控入口、P5 旁路 | [[architecture]] §5 |

**两条硬规则**：

1. **L2 不能与 L3 并列数**。`Motion` 是 `robotd` 里面的东西——说「robotd 层和 Motion 层」是错的。
   L3 是**容器**，L2 是**容器里的内容**。C4 模型里对应 L2 容器 / L3 组件，同构。
2. **L3 数量变化不影响 L1/L2 的定义**。今天把 `Nav` 外移成第 4 个进程，L2 少一个模块、L3 多一个进程，
   **层的数目不变**（仍是 4 层）。层是**位置类别**，不是**实例个数**。

### 3.1 物理设备的位置（常被问）

TB6600、步进电机、舵机、摄像头、电池**不是「层」**——它们是 L1 固件驱动或 L4 之外的外部硬件，
画图时置于最下方，但**不进层的编号**（[[architecture]] §2 的总览图里它们是「USB 以下」那一栏）。

## 4. 层 ↔ 模块 ↔ 进程 映射表（本页核心）

### 4.0 模块按「交互方式」分四类（关键：分类与层无关）

「执行位置」（§3）回答**跑在哪**；这里补另一个正交的问题——**模块之间怎么交互**。
两者**完全独立**：任何一层的模块都可能属于任一交互类型。定位一个模块时，要同时填两个坐标。

| 类型 | 交互形态 | 核心语义 | 是否持有真相 | 典型接口 | 例子 |
| --- | --- | --- | --- | --- | --- |
| **① 请求/应答型** | 调用 → 返回 | 「做这件事」 | 否（执行者） | `move(...)` `rotate(...)` | `Motion`、`Gimbal` |
| **② **感知/事件源型** ★ | **订阅 → 持续推流** | 「现在是这样的」 | **是**（它产出的事实） | `subscribe(cb)` / 事件流 | **`Perception`（基础感知）**、`Audio` 的 VAD 流 |
| **③ 整流/派生型** | 输入流 → 输出流 | 「把多路输入合成为一份事实」 | 是（派生事实） | 订阅上游 + `deriveMode()` | robotd 内核对事件流的归并（ADR-0006） |
| **④ 适配型** | 协议 A → 协议 B | 「翻译」 | 否 | — | `MCP Server`、`robot-mcp`、Swift 桥 |

> **② 型的判定特征**：它**不回答单次调用**，而是**持续产出事实流**。它的调用方不「请求」，
> 而是「订阅」——收到的是**连续的状态迁移**，不是一次结果。
> 这正是 [[decisions/0006-robotd-event-driven-core\|ADR-0006]] 说的「对外只暴露订阅语义，
> 快照 = 订阅的第 0 帧」。

**按此分类给模块填两个坐标**（示例）：

| 模块 | 执行位置（§3） | 交互类型（本节） |
| --- | --- | --- |
| `Motion` | L2 | ① 请求/应答（规划中的 OpenAPI `robot_move` 返回 `task_id`）+ 也推 `motion.*` 事件 |
| `Perception`（基础感知） | L2（robotd 内） | **② 感知/事件源**（订阅式，推 `perception.*`） |
| `Audio`（VAD 流） | L2（robotd 内） | **② 感知/事件源**（`speech.*` 流） |
| robotd 内核（事件归并） | L2 | ③ 整流/派生（`deriveMode()`） |
| `MCP Server` | L2 | ④ 适配 |
| Swift 原生桥 | L3 子进程 | ④ 适配（同时是 ② 的数据源） |

> **② 型模块的三条接口约束**（区别于 ① 型，必须显式写进契约）：
> 1. **有订阅起始帧**。订阅后**立刻**推一帧当前状态（等价于快照），不能让订阅方「先 GET 一次」——否则就退化成轮询。
> 2. **带单调 `seq`**，出现 gap → 重拉快照，不依赖补发（补发是尽力而为）。
> 3. **不提供「查询当前值」的 getter 作为主路径**。要么订阅，要么读整流器的快照；
>    直接 getter 会诱导调用方丢弃时间上下文，与 P2「不许拼状态」冲突。
>
> 这三条与历史提案「面 A」对 `/v1/events` 的规定是**同一条纪律**（[[archive/interface-redesign]] §2.2）。

### 4.1 映射表

**读法**：一行 = 一个模块，它属于哪层、跑在哪个进程、碰不碰硬件、对不对外。

| 模块 / 组件 | 执行位置 | 所属进程（L3） | 交互类型（§4.0） | 碰硬件 | 对外可见 | 真相归属（P2） |
| --- | --- | --- | --- | --- | --- | --- |
| 固件命令服务 + 状态机 | **L1** | （ESP32，进程外） | ① + ② | ✅ 直接 | ❌ 只对面 C | 步数 / 引脚电平 / 编码器 |
| `DeviceManager` | L2 | robotd | ① + ② | ✅ 经桥 | 设备列表工具待进入 OpenAPI | 设备枚举结果 |
| ├ `ESP32` | L2 | robotd | ① | ✅ 串口 | 规划中：`robot_detect` / `robot_flash` | 链路就绪 |
| ├ `Camera` | L2 | robotd | ① | ✅ 经 Swift 桥 | 规划中：`camera_list` / `camera_capture` | 摄像头可用性 |
| └ `Audio` | L2 | robotd | **②**（VAD 流）+ ①（转写/合成） | ✅ 经 Swift 桥 | 当前以 OpenAPI operationId 为准（如 `audio_state`、`speech_listen`、`robot_speak`） | 音频设备状态 |
| ★ `Perception`（基础感知） | L2 | robotd | **② 感知/事件源** | ✅（经 `Camera` / `ESP32`） | 规划中：`perception_*` 事件流 | **感知事实**（「看到了什么」） |
| `Motion` | L2 | robotd | ①（返回 `task_id`）+ ②（进度事件） | ✅ 经 ESP32 | 规划中：`robot_move` / `robot_rotate` / `robot_stop` / `robot_state` | 位姿 / 任务（**标定值权威在此**，ADR-0002） |
| `Gimbal` | L2 | robotd | ① | ✅ 经 ESP32 | 规划中：`gimbal_look_at` | 云台角度 |
| `Nav` | L2 | robotd | ① + 消费 ② | ❌（纯计算） | 规划中：`robot_navigate`；取消使用 `task_cancel` 或 `robot_stop` | 导航策略输出 |
| `MCP Server` | L2 | robotd | ④ 适配 | ❌ | ✅（工具面） | — |
| `ModelRuntime` | L2 | modeld | ①（`vision.*` 请求/应答） | ❌（跑模型） | ✅ `vision.*` | 推理结果 |
| 快速意图路由 | L2 | agentd | ①（明确指令 → 已发布能力） | ❌ | ❌（内部策略） | 指令到能力的映射；不持有机器人状态 |
| `Codex` | L2 | agentd | ① + ② | ❌ | ✅（经 Panel） | 会话 / turn |
| `Session` / `Workspace` | L2 | agentd | ① | ❌ | ✅ | 会话与上下文 |
| `Approval` | L2 | **agentd**（消费方是 robot-mcp） | ① 挂起式（目标：等待语音确认） | ❌ | 目标：robot-mcp 内部 `POST /api/approvals`；用户确认走 robotd 音频事件 | **审批结论（唯一权威）；调试页只观察** |
| `MCP Client` | L2 | agentd | ④ 适配 | ❌ | ❌ | — |
| Config / Event / Log（内置） | L2 | **每个** daemon 各一套 | ③ 整流 | ❌ | 部分 | 各进程自己的配置与事件 |
| `robot-mcp`（适配器） | L3（子进程） | agentd spawn | ④ 适配 | ❌ | ❌（Agent 的工具面载体） | — |
| Swift 原生桥 | L3（子进程） | robotd spawn | ④ 适配 | ✅ | ❌ | 相机 / 语音 / USB 描述符 |
| Panel | L4 | 浏览器 | ① + ② 消费 | ❌ | ✅ | 人的输入 |

> **一个模块只允许出现在一行**。若某功能需要在两个进程里各有一份，说明它违反 P2——应改为
> 「一个持有真相 + 一个持有观测副本」，并在表里分成两行（如 `Approval` 与 robot-mcp 的客户端角色）。
>
> ★ `Perception` 是**示例名**：若项目里已有等价的感知模块（如把 `Camera` 的连续抓帧 + 判定
> 收敛成事件流的那一层），**用现有名字替换，不要为它新造模块**；关键不是名字，而是它是 **② 型**
> 且**真相归属是感知事实本身**。

## 5. 边界命名统一（链路维度）

**此前有两套命名并存**，本页统一为 **B1–B4**（Boundary），并把「接口面 A/B/C」作为**契约维度的编号**保留：

| 统一名 | 链路 | 传输 | 契约面 | 契约文件 | 旧叫法 |
| --- | --- | --- | --- | --- | --- |
| **B1** | agentd ↔ robotd | MCP + WS | **面 A** | `contracts/openapi.yaml` | 边界 A |
| **B2** | robotd ↔ ESP32 | USB CDC JSON-Lines | **面 C** | `contracts/wire-protocol.yaml`（待建） | 边界 B |
| **B3** | robotd ↔ 原生桥 / modeld | spawn+stdio / HTTP | （散文） | — | 边界 C |
| **B4** | 面板 ↔ 各 daemon | HTTP + WS（127.0.0.1） | **面 B** | `agentd/contracts/openapi.yaml`（已建） | 边界 D |
| — | agentd ↔ modeld | OpenAI 兼容 HTTP + MCP | — | — | 无独立边界号 |

**两组编号为什么不能合并**：`B*` 是**链路**（有几个通信对），`面 *` 是**对外契约**（有几份需要版本化的接口定义）。
agentd → robotd 这条链路同时**消费**面 A（robotd 的能力与状态）与面 B（审批门），所以 4 条链路 ≠ 3 个面，
两者的对应关系是**多对多**，不要一对一硬套。

> **命名变更说明（2026-10-19）**：`communication-protocol.md` 正文的「边界 B」= 本页 **B2**，
> 「边界 A」= **B1**、「边界 C」= **B3**、「边界 D」= **B4**。该文档已按本页口径同步。

## 6. 时间维度：3 段，不是 3 层

[[decisions/0003-timing-constraints-layering|ADR-0003]] 的判据 P1 把时间尺度划成三段，**它与执行位置是
多对一的**：L2 与 L3 共同落在「10–100Hz / 秒级」这一段里。

| 时间尺度 | 谁必须在此 | 依据 |
| --- | --- | --- |
| 微秒–毫秒 | **L1 固件**：脉冲、`ENA` 时序、看门狗（`HEARTBEAT_TIMEOUT_MS=300`，实测 420ms 停机）、`stop`（最坏 ~20ms） | 实测注释，`firmware/robot_server_v2.py` |
| 10–100Hz | **L3 的 robotd**：目标由 Control Worker 承载 `Nav` / `Motion`，10–50Hz；当前 POC 尚未实现 Worker 隔离 | ADR-0002 / ADR-0003 / ADR-0008 |
| 秒–分钟 | **L3 的 agentd + L4**：任务规划、语义决策 | [[architecture]] §1 P1 |

**跨层参数**（ADR-0003 定的两个，权威在本页，其它文档引用不再重复定义）：

| 参数 | 契约层（L3 host） | 板侧（L1） | 关系 |
| --- | --- | --- | --- |
| 速度指令更新频率 | 运动意图存续期 **≥5Hz** 发 `velocity` | 内部节拍 **50Hz**（`TICK_MS=20`） | **两个不同层的频率，各自独立**，不构成冲突 |
| 打断延迟上限 | `stop` 端到端 **≤50ms** | 看门狗停机 **≤500ms** | 承诺值，均留实测值 2× 余量 |

**工具命名**：Agent 可调用的正式名称以 `contracts/openapi.yaml` 的 `operationId` 为唯一来源，
生成的 MCP 工具名采用 snake_case。内部方法（如 `Nav.goTo()`）、事件 topic（如 `motion.*`）和产品显示名
不是工具别名；未进入 OpenAPI 的能力一律标为规划中。

## 7. 与 C4 模型的对照（避免第二套数法）

`architecture.md` 按 C4 组织（§4–§9）。C4 的 L1–L4 与本页的 L1–L4 **不是同一套编号**，
对照如下——**引用时必须写清是「C4 L2」还是「本页 L3」**：

| C4 层 | 含义 | 本页对应 |
| --- | --- | --- |
| C4 L1 系统上下文 | 平台与外部（人 / Codex / 系统 API） | 本页 L4（交互面）+ 外部系统 |
| C4 L2 容器 | 可运行 / 可部署单元 | 本页 **L3（进程）+ L4 的 Panel** |
| C4 L3 组件 | 容器内部模块 | 本页 **L2（进程内模块）** |
| C4 L4 代码 | 关键接口 / 数据结构 | 契约（面 A/B/C） |

> 因此「C4 L3 组件」= 「本页 L2 进程内模块」，**编号差一位**。这是最容易引错的一处。

## 8. 怎么验证本页被守住

| 断言 | 怎么查 |
| --- | --- |
| 「层」只有一套主口径 | 全库检索「X 层」的说法，凡不在本页 §3 表内的（如「固件层」以外的自造层名）计数应为 0 |
| 不把模块当层 | 检索 `robotd 层` / `Motion 层` 这类并列写法，计数应为 0 |
| 四层定义不随实例数变 | 本页 §3 的 4 层定义不引用具体进程个数；`Nav` 若外移，§4 映射表改一行，§3 不动 |
| 交互类型不与层混用 | 描述模块时同时给出位置（Lx）与类型（①–④）；只给一个坐标的表述应被追问补齐 |
| ② 型模块有订阅起始帧 | 每个 ② 型模块的契约里，订阅后第一帧必须等价于当前快照（同 §4.0 三条约束） |
| 边界命名一致 | 全库检索「边界 B」，应全部指 B2；旧义残留计数为 0 |
| C4 编号带前缀 | 引用 C4 处一律写「C4 Lx」，裸写「Lx」的应指本页口径 |

## 相关页面

- [[architecture|架构设计]] §2 职责边界判据（P1–P5）· §4–§9 C4 视图（引用本页口径）
- [[architecture|架构设计]] §6 三容器 · §7 组件与模块 · §4 C4 总览
- [[communication-protocol|分层通信与接口设计]] §0 边界 → 传输选型（B1–B4）
- [[archive/interface-redesign|历史接口契约重设计提案]] §1 状态归属表 · §2.2 快照与增量 · §5 三面数据流（非现行口径）
- [[decisions/0003-timing-constraints-layering|ADR-0003]] —— 时间维度与两个跨层参数
- [[decisions/0006-robotd-event-driven-core|ADR-0006]] —— L3 的 robotd 内核：事件循环 + 状态单点（订阅语义的出处）
- [[decisions/0007-agentd-robotd-boundary|ADR-0007]] —— L3 进程之间的边界与契约归属
