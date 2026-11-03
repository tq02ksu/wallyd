---
title: 机器人 POC — 分层通信链路设计与验证
type: project
description: 把「应用层 → Runtime → ESP32」这条分层通信路线在真机上跑通一遍的 POC 设计与验证记录：分层与文件职责、7 条关键设计决策（MCP 只是接口、串口归原生桥、v2 分片状态机、超时不重试、能力面 vs 调试旁路、State 是合取、宁缺勿造）、四类契约的落地方式、逐条符合性评审（10 项修 8）与实测结果。
tags: [project, robot, design, poc, protocol]
domain: robot
project: macmini-robot
sources: []
generated: { by: codex/deepseek-v4-pro, at: 2026-10-06T01:05:00+08:00 }
relations:
  - predicate: part-of
    target: /projects/robot/README.md
  - predicate: depends-on
    target: /projects/robot/doc/communication-protocol.md
  - predicate: depends-on
    target: /projects/robot/doc/architecture.md
---

# 机器人 POC — 分层通信链路设计与验证

> **归档：本文记录旧版 POC 的设计与验证，不作为当前架构或接口契约。**

> 定位：把 [[communication-protocol|分层通信与接口设计]] 的技术路线**在真机上跑通一遍**，
> 暴露纸面设计看不出的集成坑。代码、验收脚本与使用说明都在本目录
> （2026-10-06 由仓库根 `work/poc/` 转入版本库；运行方式见 [[poc-readme|POC 使用说明]]）。

## 0. 一句话结论

**链路成立**：Codex Harness 经 MCP 工具面下发 `motion.move(0.2m)` → Runtime 换算步数 → 串口协议 v2 →
真机 1600 步跑完 → 位姿更新到 (0.2, 0, 0)。协议 v2、心跳看门狗、Task 抢占、审批门、schema 校验
都在真实硬件上验过；对外四类契约（Capability / State / Task / Event）逐条评审 **10 项修 8 项**，
验收脚本 **35 条在仿真下全过**。

## 1. 范围

**做**：应用层（Codex Harness）→ Runtime → ESP32 这条链的**边界与契约**；机器人身体的对外能力面；
人控调试面板；断链、复位、超时这些**坏了怎么办**的路径。

**不做**（避免误读）：`Nav` 策略层 / SLAM / 云台；~~真实模型~~、~~相机取帧~~（见下方更新）；
BMS 电量；
差速行驶（控制链路已双驱就绪，差速前进/转向**未上台架验**——2026-10-09 右驱接上、固件已改 `("L","R")`）。

> **2026-10-06 更新**：本轮"不做"里的**真实模型已补上**。`run.sh` 现在默认起
> **MiniCPM-V 4.6 4bit**（MLX `mlx_vlm.server`，:8080），robotd 用 `--modeld/--model`
> 指过去；`vision.describe` 新增可选 `image`（本地路径或 data URL），带图即真看图，返回值带
> `grounded` 标明有无像素依据。实测端到端 1.13s/帧（COCO 猫图回答正确）。
> **模型名**：`mlx_vlm.server` 的 `/v1/models` id 就是 `--model` 的原字符串，所以用
> 「cwd=权重目录 + 只传目录名」让它报 `MiniCPM-V-4.6-4bit` 这种干净名字，而不是绝对路径；
> 请求侧按字符串精确匹配，`--model` 必须完全一致。
> **2026-10-09 再更新**：**相机取帧也补上了**——换上的真 UVC 摄像头（见 [[../spec/camera-detection]] §0.4）
> 经新的原生桥 `scripts/uvc_capture.swift` 接成能力 `camera.capture`，帧落 `work/poc/frames/`，
> 面板「视觉」子页可抓帧预览并把路径一键喂给 `vision.describe`。**取帧与描述分开**是刻意的：
> 路径本身就是证据（P2）。
> **同一天又加了"找目标"**：能力 `vision.find(target, image)` = grounding 给框（0–1000 归一化）
> → 裁框（系统自带 `sips`）→ **换个问题复检**（"这块区域里是不是它"，允许回答"没有"）。
> 实测（真机帧）：`键盘` 命中且框准确、`大象`/`遥控器` 模型直接答"没有"；
> **但对图里不存在的「杯子」，模型给了假框、复检也跟着点头 → `found=true` 但错的**。
> 结论：同模型自检压得住"为了回答而编造"，压不住"真的认错"——`found` 目前不能当"确实存在"用，
> 要么加独立信号（系统 Vision 分类 / CLIP 零样本），要么先用带标注数据量化命中率与误报率。
> **仍未做**：把 Agent 接进来（agentd / MCP 还没通电）。
> `modeld.py` 退回纯 stub 角色，其 `--backend mlx` 是早期占位实现、不可用。

### 2026-10-09（续）：三层分工的**修正**——感知只报观测，语义判断归 Agent

触发：用户指出「**系统 VNClassifyImageRequest 这个分类肯定不行**，Agent 要做的事会变化，
不是一个单一场景的机械化处理」，并重申核心目标：

> **Agent 决定做什么，控制系统决定怎么做，ESP32 负责可靠地执行。**

据此修正前面几轮的想法（**前一轮的"校验层"其实是层次错误**）：

| 之前想的 | 修正后 | 为什么 |
| --- | --- | --- |
| 感知层返回 `found: true/false` | 感知层只返回**观测**：候选框 + 同源自检结果 + `uncertain`，不下"确实存在"的结论 | 判"这是不是真的目标"是**语义判断**，属于 Agent；感知层替它拍板就是越层。而且同源自检本就压不住"真的认错"（杯子的假阳性） |
| 用系统 Vision 分类当**独立校验信号** | **撤掉** | ImageNet-1000 是**闭集**：Agent 的目标是开放的（"充电底座"根本不在 1000 类里），拿闭集去验开放声明，只会得到"要么全放行、要么全拦下"的假信号；维护中英标签映射也是把可变场景写死 |
| 「导航里不许调模型」 | 精确化为：**10–50Hz 实时回路**里不许 await 模型；**任务级闭环**（走走看看，秒级）可以，且这正是第一版的形态 | 原话容易被读成"Nav 一概不许碰模型"，那"找目标走过去"就没地方放了；真正的纪律是时间尺度 |
| 由 Agent 逐步决定每步怎么走 | Agent 只给**目标 + 可接受的中止条件**；怎么转、怎么走、什么时候停由控制系统的确定性闭环算 | 就是用户那句话：Agent 决定**做什么**，控制系统决定**怎么做** |

落成的能力：**`nav.approach(target, …)`**（`returns: task`，需审批）——走走看看的确定性闭环：
抓帧 → 找目标 → 框偏就转、框小就前进、框够大幅度过阈值就停；**连续两轮看不到 / 超时 / 超步数 / STOP 立刻停**。
它**不看语义真假**，只跟几何（感知给什么框就跟什么框），中止条件全在控制系统这一层保证。
真机实测（未接轮子）：3 轮 `forward 0.05m`，任务状态 `completed`，15.5s。

同时修掉三个真机才暴露的缺陷：① `motion.*` 的收尾是靠事件做的，导航任务必须自己收尾（否则
`activeTask` 一直挂着，后续运动全被 `E_BUSY` 顶回）；② 收尾发 `stop` 会回一条迟到的
`motion.aborted`，把**下一次**运动任务顶成 `cancelled`——改成不发；③ 任务看门狗（5s 无进度）
本意是查"板侧动作卡住"，对"每轮要抓帧+推理"的导航任务是误判——只对 `motion.*` 挂。

另有两条抓帧侧的实测结论（都与"钉格式"有关）：**这颗 HDI 摄像头只有未压缩 `420v`/`yuvs`**，
钉 1280×720@30 要约 332Mbps、贴着 USB2 上限 ⇒ 出帧时好时坏（现在默认**不钉格式**，让系统协商，
只抓一帧没必要跑满帧率）；且 UVC 会**间歇性第一次不出帧**，抓帧改成最多重试 3 次（只读操作，重试无副作用）。

### 2026-10-09（续 2）：音频接入——按 §6.4 的定案，走系统能力

按 §6.4/§4.3 的原始设计把音频接上了：**robotd 的 Audio 模块 + 原生桥 `native/mac-speech`
（落地为 `projects/robot/scripts/mac_speech.swift`）+ 三个能力**，**不新增进程、不引模型**。

- `audio.list`：麦克风设备与**授权状态**、TTS 音色、ASR locale 与资产状态（已实测 `zh_CN` 资产 `installed`、20 个中文音色）
- `audio.listen`：录 N 秒 → `SpeechAnalyzer` 转写。**入口是"按一下说一句"，不是常听**——原设计链路 B 的触发就是"唤醒/按键"，本期不做 VAD/唤醒词
- `audio.speak`：`AVSpeechSynthesizer` 朗读；按 §4.3 的分级算"会出声"的副作用，**默认需审批**（实测不带审批被 `E_APPROVAL` 拒）

实测：`speak` 经 robotd 出声 2.8s（Tingting）；`listen` 在麦克风未授权时**显式失败**而不是"录到空音频假装听到了"。
两个坑与相机同源：① **未授权时录音不报错、只是录到空音频**（TTS 能响、ASR 拿不到字，就是这个原因）；
② TTS 的完成**必须等委托回调**——`speak()` 之后 `isSpeaking` 可能还是 false，用轮询会立刻返回（实测 19 字只花 26ms，
话根本没说完）。

### 2026-10-10：听改流式——一次性的"录满 N 秒再转写"处理不了长内容

用户要求"一边听一边分析一边处理"，并指出长内容会超时。根因在设计本身：`audio.listen` 是
**先录满固定 N 秒、再整段转写**，所以 ① 说完了还得等满时长，② 内容一长就只能靠加大 N，
而 N 同时是"等待时间"和"上限"，本质上没解。

改成流式（系统 ASR 本来就支持）：

- 桥新增 **`stream`**：`SpeechTranscriber(preset: .progressiveTranscription)` 才会吐 volatile 中间结果
  （`.transcription` 只在结束时给最终稿）；用 `analyzer.start(inputSequence:)` + `AnalyzerInput`
  喂麦克风（经 `bestAvailableAudioFormat` 转成 ASR 要的格式，实测 1ch/16kHz/Int16）。
- **桥的契约出现第一个例外**：stream 模式 stdout 是 **NDJSON**（`ready` → 反复 `partial` → `final`）。
  停止＝**stdin 收 `stop` 或 EOF** ⇒ robotd 必须保持子进程 stdin 打开（用 `ignore` 会喂 /dev/null，
  桥刚开始就收尾——实测踩到）；这类桥**不套超时**。
- robotd 新增能力 **`audio.stream`**（`returns: task`）：中间结果以 `audio.partial` 事件推给面板，
  最终稿在任务 data 里；停止＝面板 STOP / `POST /api/stop`（同一个抢占语义，桥会收尾并给最终稿）。
- 面板「语音」页改成**流式为主**（开始听 / 停止 / 实时文本），一次性那条降为"适合一句指令"。

实测：起流 8.3s 后 `/api/stop` → 任务 `cancelled`、桥交出最终稿、`aborted: true`。
**未解**：没有 VAD/静音检测，所以"说完了"还得手动停（或等 `max_seconds`，默认 300s、上限 1800s）——
原设计链路 B 的触发本来就是唤醒/按键，自动断句要另做。

### 2026-10-10（续）：流式**其实一直是假的**，以及端点检测的第一个坑

**发现一：中间结果从来没有实时到达。** 实测（扬声器说话、麦克风听）发现所有 partial 都挤在
结束那一刻：`t_ms≈10700` 才一次性吐 15 条。逐步排除：

1. 喂数据打点证明**麦克风一直在实时喂**（每 25 块一条：#25@2.75s、#100@10.25s）；
2. `volatileRangeChangedHandler` 打了 118 条回调，**区间在 0.085→0.19→0.29… 正常推进**，
   但全部在 `t_ms≈10703` 到达 ⇒ **analyzer 在实时处理，是"消费端"没在跑**；
3. 根因：**Swift 脚本的顶层代码是 `@MainActor` 隔离的**，我那些 `Task { }` 继承了 main actor，
   而主流程阻塞在 `stopSignal.wait()` 上 ⇒ 消费任务被饿死，直到结束才一起跑。
4. 修法：消费任务改 **`Task.detached`**，阻塞等待改 **异步等待**（`withCheckedContinuation`
   里挂 `DispatchQueue.global`）。修后 partial 在 1.2s / 2.8s / 3.6s… 正常实时出现。

顺带排除掉的（都不是原因）：`preset` 用 `.progressiveTranscription`、`prepareToAnalyze(in:)`、
给 `AnalyzerInput(buffer:bufferStartTime:)` 带时间轴、周期性 `finalize(through:)`、
显式 `reportingOptions: [.volatileResults, .fastResults]`。

**发现二：系统 `SpeechDetector` 和 `SpeechTranscriber` 放同一条 analyzer，两边都收不到结果。**
直接对照实验：`--no-auto-endpoint` 时 24 条 partial + 有转写；加上 detector 后**一个事件都没有**
（连转写也哑了）。已经把 `audio.stream` 的 `auto_endpoint` **默认关掉**（`--auto-endpoint` 显式开），
桥里也注明"要先把 detector 单独调通"。下一步要么把 detector 单独调通（可能要独立 analyzer 或
`setModules` 分步），要么退回"能量门限 + ASR 文本变化"的启发式，或引 Silero VAD（MIT/ONNX/~1MB）。

**另一个教训**：桥是 Swift **脚本**（每次调用现编译），一次重名（`trace`）就让桥编译失败、
进程秒退——而 robotd 只看到"退出码非 0、没有任何输出"，表现成"流式 0 结果"。现在流式返回里带
`stop_reason`、robotd 会把桥的 stderr 记进日志，就是为了下次能一眼看出来。
> 详见 [[poc-readme|使用说明]] §1.1 / §2。

## 2. 分层与文件职责

```text
Codex Harness(LLM) ──MCP stdio──▶ robot-mcp.ts ──HTTP──▶ robotd.ts ──串口 v2──▶ ESP32(固件)
        │                                                     ▲
        └── 人控入口 ── HTTP/WebSocket ── panel.html ──────────┘
                                         modeld.py（模型）
```

| 文件 | 层 | 职责 |
| --- | --- | --- |
| `robotd.ts` | Runtime（身体） | 能力注册表 + JSON Schema 校验 + Task/Event + HTTP + 最小 WebSocket；**真相归属**的落点（步数=板子、位姿=Runtime） |
| `lib/schema.ts` | Runtime | JSON Schema 子集校验器（产品里换 Zod，同一份 schema 导出成 MCP `inputSchema`） |
| `lib/miniws.ts` | Runtime | 极简 WebSocket 服务端（推送 + close/ping），robotd 与 agentd 共用 |
| `robot-mcp.ts` | Agent 接口 | 把 capability 映射成 MCP tool（stdio JSON-RPC）；**MCP 只是接口，不是内部架构** |
| `panel.html` | 应用层（人） | 调试面板，三个子页：`ESP32`（板侧协议 / 调试旁路）、`robotd`（Runtime 接口）、`模型`（模型服务状态 + `vision.describe` 能力表单 + 原始 OpenAI 调试旁路 `POST /api/debug/model`） |
| `agentd.ts` | 应用层（Agent） | 可选：常驻 `codex exec` 并把 robot-mcp 注册成 MCP server（`--once` 保留一次性用法） |
| `modeld.py` | 模型 | Python（按语言分工）：OpenAI 兼容 `/v1/chat/completions`。**真模型不经它**——`run.sh` 直接起 MLX 的 `mlx_vlm.server`（`modeld.py` 现为 stub 专用） |
| `serial-bridge.py` | 原生桥 | Python 持有串口（Node 无法 ioctl 清 DTR/RTS），stdio 中继行 |
| `firmware/robot_server_v2.py` | 固件 | MicroPython 协议 v2：非阻塞运动状态机 + 心跳看门狗 + 两态制 ENA 时序 |
| `firmware/upload_v2.py`、`tools/board_*.py` | 工具 | base64 分块上传固件、读回板子源码备份 |
| `tools/smoke.ts` 等 | 验收 | 契约级验收与台面探针（见 [[poc-readme|使用说明]]） |

## 3. 关键设计决策（附「为什么」）

1. **MCP 只是接口，不是内部架构**。工具面是 Agent 唯一能碰的东西；Agent 看得见源码就会绕过
   工具面改用 shell/`curl`（POC 实测：指向 POC 目录时 16 次 shell 调用 / 0 次 MCP；换成空工作目录
   并明确"只用工具"后是 4 次纯 MCP 调用）。把实现藏在工具面之后首先是**可观测性**问题。
2. **串口必须由原生辅助进程持有**。串口一开就把这块板复位（DTR/RTS 经三极管接 EN/IO0），
   而 Node 没有 ioctl 清不掉；所以串口归 `serial-bridge.py`，Runtime 只跟它的 stdio 说话——
   正好落在设计里"只有原生才能做的事"那类桥（见 [[architecture|架构设计]] §8.4）。
3. **固件 v2 必须是"分片状态机"**。v1 的 `move` 用 `bitstream` 一次把脉冲发完，期间读不到串口 ⇒
   中途 `stop` 与心跳看门狗**根本不成立**。v2 改成主循环每 20ms 推进一小片（`uselect.poll` 已验证），
   抢占与看门狗才成立——这是"板侧要有状态机"这条设计判断的硬证据。
4. **物理动作超时禁止自动重试**。真机上 `move` 超时无法区分"没执行"和"执行了但没回包"，
   重发就会多走一段。POC 里超时统一走"**先查状态**"（任务看门狗 >5s 无进度 → 发 `status`；
   还在动就续期，否则判失败；全程不重发运动命令）。
5. **能力面与调试旁路分开**。`/api/debug/serial`（钉电平、发脉冲、切 ENA、看串口原始行）
   **必须 `--debug` 才开**，不映射成 MCP tool、Agent 看不到（判据 P5 旁路：显式命名、不进工具面、
   不成常路，见 [[architecture|架构设计]] §1）。
6. **State 是合取、Event 是增量**。POC 真的踩到过：链路巡检早于握手启动，把复位窗口的 `status`
   超时误判成失联，`mode` 永久卡在 `degraded` 而 `esp32` 已 `ready`——State 自相矛盾。
   验收脚本已加断言 `!(esp32==='ready' && mode==='degraded')` 把它钉住。
7. **宁缺勿造**。没接 BMS 就报 `battery: { source: 'unimplemented' }`，而不是写死 `12.4V / 72%`
   ——假数据比没有更危险（P2 真相归属）。

## 4. 四类契约的落地

| 契约 | 端点 / 载体 | 关键字段 |
| --- | --- | --- |
| **Capability** | `GET /api/capabilities`、MCP `tools/list` | 名称、`inputSchema`（量程）、`units`、`requires_approval` |
| **State** | `GET /api/state`、WS `state` | `pose`（`valid` 可失效）、`mode`、`battery`、`devices`、当前任务 |
| **Task** | `POST /api/call`、`GET /api/tasks/:id`、WS `task.*` | `task_id`、`state`、`progress`、`error`（内部句柄经 `pubTask()` 剔除） |
| **Event** | WS 推送 | `motion.progress/done/aborted`、`task.failed`、`device.lost/recovered/reset`、`approval.*` |

串口协议 v2（Runtime ↔ ESP32）：命令 / 应答 / 推送三类文本行 JSON，带 `id`、错误码、
`hello` 版本协商；`velocity` 兼心跳（板侧 300ms 收不到即自主停机）。

## 5. 与设计文档的符合性评审（2026-10-05）

逐条对照 [[communication-protocol|communication-protocol]]（§2 边界 A、§3 串口协议、§6 四类契约、
§7 超时/重试）与 [[architecture|架构设计]] §9 分层纪律，共评 10 项：**修 8、记 1、基本符合 1**。

| # | 设计条目 | 评审前 | 处置 |
| --- | --- | --- | --- |
| 1 | §3.4/§3.5 板子失联 → **降级** | 无任何链路监督，`mode` 只有 `idle/moving` | 补 2s 链路巡检：连续 2 次 `status` 失败 → `esp32=lost` + `mode=degraded` + `device.lost`；恢复推 `device.recovered`；降级中 `motion.*` 拒 `E_STATE` |
| 2 | §2.3 物理动作超时**禁止自动重试** | 收不到 `motion.done` 会永久卡在 `moving` | 任务看门狗：>5s 无进度 → 先 `status`；还在动就续期，否则判失败（不重发） |
| 3 | §5 面板不裸奔 | CORS 写成 `*`（任意网页都能开车） | 改来源白名单，其余回 `null` |
| 4 | §2.1 能力面要有**单位与量程** | 单位散在描述文字里 | `capabilities` 加 `units` + 逐参数单位；量程仍由 `inputSchema` 承担 |
| 5 | §6 State 不得凭空造事实 | `battery` 写死 `12.4V / 72%` | 改 `source: 'unimplemented'`，面板显示"未接入" |
| 6 | §6 Task 字段 | `/api/call` 漏出 `AbortController` | `pubTask()` 统一剔除内部句柄 |
| 7 | §3.2 `hello` 版本协商 | 调试旁路转裸 `hello` → 固件回 `E_FW`（行为正确、用起来别扭） | 面板改发 `{proto:2}`；固件不动。记一笔：**旁路也得守协议** |
| 8 | §4.2 配置中心 | 完全没有配置接口 | ⏭ 记为下一步（`GET/PUT /api/config` + schema 驱动表单） |
| 9 | §6 Task 可取消 | 无按 `task_id` 取消 | ➖ 基本符合：`motion.stop` 幂等、可抢占、免审批，已覆盖取消语义 |
| 10 | §6 板侧 `boot` 是对账事件 | 板子复位后任务**永远停在 running**、`pose` 还照旧当真 | 处理 `boot`：作废在跑任务（`task.failed(reason=board_reset)`）、推 `device.reset`、`pose.valid=false`、重新握手 |

### 两条真机教训

1. **巡检必须等握手完成**（见上文决策 6，State 自相矛盾）。
2. **调试旁路也得守协议**：裸 `hello` 被固件以 `E_FW: host=None` 拒掉不是 bug，协议校验就该拦；
   错的是维护通道以为"旁路 = 可以不守协议"。

### 顺带发现的硬件/固件配置问题

板子每次启动都报 `quad_psram: PSRAM chip is not connected, or wrong PSRAM line mode` →
`Failed to init external RAM`。这块是 **ESP32-S3-N16R8（Octal PSRAM）**，而烧的镜像按 **quad**
模式初始化 ⇒ **固件/烧录的 PSRAM 模式不对**。当前只用内部 SRAM，不影响协议与电机；
**做相机 / VLM 缓冲前要换 Octal 模式的 MicroPython 构建再验**。接线纪律不变：GPIO26–37 仍必须留空
（见 [[electrical-architecture|电气系统架构]] §5.2）。

## 6. 实测结果

| 验证项 | 结果 |
| --- | --- |
| 契约验收（仿真） | **35 / 35 PASS**：能力清单、inputSchema、审批门、越界拒绝、Task 生命周期、`E_BUSY` 互斥、`stop` 抢占 <300ms、WS 推送、单位/量程、`healthz` 链路字段、State 自洽、失联降级与恢复、降级中急停仍可用、**中途复位任务作废 + `pose` 失效** |
| 契约验收（真机 ESP32-S3） | 15 PASS / 1 FAIL → FAIL 是**脚本竞态**（事件已推、断言读早了），修断言后通过 |
| 心跳看门狗（真机） | 故意停心跳 → **420ms 内**板子自主停机并上报 `motion.aborted reason=watchdog` |
| 应用层（Codex Harness） | 4 次 MCP 调用（能力 → 状态 → `motion_move 0.2m` → 状态），位姿 (0,0,0) → (0.2,0,0) |
| 调试面板 | 两个子页真机实测可用（ESP32 子页拿到真板 `hello`/`status`/串口原始行；robotd 子页 healthz/State/任务/能力表单/事件流） |
| CORS 白名单 | `Origin: evil.example` → `access-control-allow-origin: null` |

## 7. 已知缺口与下一步

1. **真机完整验收未跑**：含 0.2m/0.5m 真实位移的 `smoke.ts --label hardware` 需确认台架安全后执行。
2. **标定 `steps_per_m` / `wheelbase_mm`**：固件里 8000 / 120 是占位值，位姿目前只是相对量。
3. **两驱差速行驶**：2026-10-09 已完成 `DRIVERS_PRESENT=("L","R")` 重烧，并验证两驱 ENA 一起
   自动脱机；**剩余：差速前进 / 转向上台架实测**（`steps_per_m` / `wheelbase_mm` 仍是占位值，
   转向要先标定）。台面探针 `pins` op 目前只覆盖左驱三脚，要量右驱引脚得先扩展它。
4. **配置接口**（§4.2）：`GET/PUT /api/config` + schema 驱动面板表单。
5. **产品化**：目标机无 Node/pyserial（要装运行时）；POC 靠 Node 类型擦除跑 `.ts`，
   产品要把 Zod / `tsc` 纳入构建；`lib/miniws.ts` 换 `ws` 库并补客户端上行。
6. **面板增强**：任务进度条、审批弹窗（替代勾选框）、串口日志过滤/暂停。

## 8. 未入库的中间产物（工作区 `work/`）

按本项目 [AGENTS.md](../../AGENTS.md)，**产出进本目录、临时材料进项目内 `work/`**。以下这批是 POC 期间
产生的，当时写在**仓库根 `work/`**，未迁移；新产物写项目内 `work/`。

- 仓库根 `work/poc/artifacts/panel-esp32.png`、`panel-robotd.png`、`poc-panel.png`：面板真机截图（二进制）。
- 仓库根 `work/poc/artifacts/agentd-*.jsonl`：`agentd` 每次运行的原始事件流（运行日志）。
- 仓库根 `work/poc/firmware/board_main_backup.py`：**上传 POC 固件前备份的原厂 `main.py`**（还原用）。

复现资料另见仓库根 `work/refs/`（上游第三方源码）与 `work/scripts/`（探针脚本）。

## 相关页面

- [[poc-readme|POC 使用说明]]（怎么跑：仿真 / 真机 / 面板 / 验收 / 排错）
- [[communication-protocol|分层通信与接口设计]]
- [[architecture|架构设计（C4）]]
- [[architecture|架构设计文档]]（§1 职责边界判据）
- [[stepper-wiring|步进驱动接线与供电]]（两态制与 TB6600）
