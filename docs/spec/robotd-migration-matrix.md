---
title: robotd TS→Python 迁移差异矩阵（R01 产出）
type: project
description: 逐项登记 v1 operationId、公开事件、内部旁路与设备依赖在现有 TS POC 中的实现位置、目标行为、差异与承接任务，作为契约补齐（R03）与内核实现（R05+）的输入。
tags: [project, robot, plan, robotd, migration]
domain: robot
project: macmini-robot
status: draft
generated: { by: process:workbuddy-agent, at: 2026-10-23T07:40:00+08:00 }
relations:
  - predicate: part-of
    target: /README.md
  - predicate: depends-on
    target: /docs/spec/robotd-development-plan.md
  - predicate: depends-on
    target: /docs/spec/robotd-interface-contract.md
  - predicate: relates-to
    target: /contracts/openapi.yaml
---

# robotd TS→Python 迁移差异矩阵（R01 产出）

> 本页是[开发计划](robotd-development-plan.md) R01 的产出物：把「现状」登记成可核对的行，
> 每一行绑定一个后续任务。**本页只登记，不代表任何条目已经迁移。**
>
> 证据基线：`src/runtime/robot-runtime.ts`（1918 行）、`src/transport/http-server.ts`（511 行）、
> `contracts/openapi.yaml`、`firmware/robot_server_v2.py`，读取日期 2026-10-23。

## 0. 判定口径

| 标记 | 含义 |
| --- | --- |
| **可复用** | 语义与目标一致，Python 侧照搬逻辑即可（不含代码翻译成本） |
| **需迁移** | 语义要保留，但当前实现依赖 TS/Node 或写在了错误位置（HTTP handler 里改状态等） |
| **需修正** | 当前实现与契约目标**不一致**，迁移时要按契约改，不是照抄 |
| **未实现** | 契约/计划要求，现 POC 里没有 |

**一条重点**：R01 checklist 要求「不将旧行为未经验证直接迁移」。本页把这类条目在
「差异 / 风险」列里显式标 `复制即错误`。

## 1. 公开 HTTP 操作（operationId）

契约是唯一事实源；下表「现状」列指 TS 实现在 `http-server.ts` 里注册的 handler。

| operationId | 路由 | 审批 | 现状 | 判定 | 差异 / 风险 | 承接 |
| --- | --- | --- | --- | --- | --- | --- |
| `robot_health` | `GET /v1/health` | 否 | 内联 handler，返回 `protocol/transport/esp32/mode/pid` | 需迁移 | 无 `instance_id`；WS `hello` 也没有，客户端无法识别进程重启 | R03 R05 R09 |
| `robot_state` | `GET /v1/robot/state` | 否 | `runtime.v1State()` | 需修正 | **无 `event_seq`**，无法做 WS 游标；`devices` 是自由 object，未 enum | R03 R05 R10 |
| `robot_calibration_get` | `GET /v1/robot/odometry/calibration` | 否 | `calibrationGet()` | 可复用 | 缺 `applied_at`（schema 里有，实现不返回） | R11 |
| `robot_calibration_set` | `PUT` 同路由 | **是** | `calibrationSet()` | 需修正 | ① 运动中被拒依赖 `state.mode === 'moving'`，而 `mode` 本身是派生态；② 部分成功时（板侧只接受一个字段）没有报「不一致值」；③ handler 自己 catch 后一律映射 400 | R09 R11 |
| `robot_speak` | `POST /v1/robot/speak` | **是** | `speakV1()` → 软任务槽 | 需迁移 | 依赖常驻 Swift 语音桥；`interruptible` 默认值在契约里是 `true`，实现里 `!== false`，语义一致但需在 Python 侧显式化 | R14 |
| `speech_listen` | `POST /v1/speech/listen` | 否 | `listenV1()` → 软任务槽 | 需迁移 | 与 `robot_speak` 走不同槽位（听/说可并存），此语义必须在任务表里保留，不能简化为「全局单任务」 | R06 R14 |
| `audio_state` | `GET /v1/audio/state` | 否 | `audioStateV1()` | 需修正 | 契约 schema 是裸 `object`，字段完全未声明（`muted/speaking/calibrated/partial/last_final/ambient_db/...`） | R03 R14 |
| `audio_mute` / `audio_unmute` | `POST` | 否 | `setAudioMutedV1()` | 需迁移 | 乐观更新后等桥回调对齐；Python 侧要保留「先回执后对齐」还是改成就地确认，需 R14 定 | R14 |
| `robot_follow` | `POST /v1/robot/follow` | **是** | `followV1()` → 转发给 `approach()` | **复制即错误** | 见 §4：`target_track_id` 被丢弃，实现是「走走看看」逼近，**不是**跟踪；响应用 `warnings` 说明但状态仍是 `accepted` | R15 R16 R17 |
| `robot_stop` | `POST /v1/robot/stop` | 否 | `runtime.stop()` | 需迁移 | 实现把**语音软任务也一起取消**；契约只承诺「运动任务被抢占」。是否保留这条扩展语义须回填契约 | R03 R06 R08 |
| `task_get` | `GET /v1/tasks/{task_id}` | 否 | `taskGet()` | 需修正 | `Task.state` enum 缺 **`accepted`**（契约 §5 生命周期含它）；`error` 是自由 `string`，契约要求稳定错误码 | R03 R06 |
| `task_cancel` | `DELETE /v1/tasks/{task_id}` | 否 | `taskCancel()` | 需修正 | 运动任务取消走 `stop()`——**会顺带停掉语音任务**；重复取消已终态任务返回原对象（幂等，可接受） | R06 |
| `events_subscribe` | `GET /v1/events`（WS） | — | `handleV1Upgrade()` | 需修正 | 见 §3 | R03 R10 |

**debug 旁路（不进 MCP 工具面，不属 v1 公开面）**：`/v1/debug/{serial,state,capabilities,tasks,tasks/{id},call,stop,model,frame}`。
`generate.mjs` 已按 `tags: [debug]` 与 `x-websocket` 排除，**这一条当前是正确的**，
Python 侧只需保证「默认关闭、非 `--debug` 一律 403/E_DEBUG_OFF」。

**未进入公开契约的内部能力（不得因内部有实现就算已发布）**：
`system.capabilities`、`robot.status`、`motion.move`、`motion.rotate`、`motion.stop`、`pump.set`、
`camera.capture`、`vision.describe`、`vision.find`、`nav.approach`、`audio.list`、`audio.listen`、
`audio.stream`、`audio.speak`、`audio.state`、`audio.mute`、`audio.unmute`（共 17 项，来自
`registerCapabilities()`）。它们只经 `/v1/debug/capabilities` 与 `/v1/debug/call` 可达。

## 2. 公开事件

现有实现产生的事件（`grep "this.event('"`，加上模板拼接的 `task.${st}` / `device.${...}`）。
契约要求「内部字段不得出现在 Agent 可见事件中」，下表「差异」列重点看 `ts_mono_ns`。

| 事件 | 现状产生点 | 是否在契约 §6.2 类别内 | 差异 | 判定 |
| --- | --- | --- | --- | --- |
| `task.started` / `.progress` / `.completed` / `.failed` / `.cancelled` | `newTask` / `onBoardEvent` / `finishTask` | 是 | 缺 `accepted` 阶段事件；`task.failed` 的 `error` 是拼装字符串 | 需修正 |
| `motion.plan` | `motion.move` 的 run | 是 | 只有 `left_steps/right_steps/eta_ms`，缺契约要求的「计划摘要」边界 | 需迁移 |
| `safety.stopped` | `onBoardEvent('motion.aborted')` | 是 | `reason` 直接透传板侧字符串（`watchdog`/`stop`），无枚举 | 需修正 |
| `device.ready` / `.lost` / `.recovered` / `.reset` / `.changed` | `connect` / `setEsp32` / `onBoardReset` / `pump.set` | 是 | `pump.set` 在能力 `run()` 里直接改 `state.devices.pump` 并 emit（ADR-0006 已点名这是违规） | 需修正 |
| `audio.state` | 语音桥事件分发 | 是 | payload 是裸 object | 需修正 |
| `speech.started` / `.speech_ended` / `.partial` / `.endpoint` / `.final` / `.vad_calibrated` / `.ready` | `onAudioBridgeEvent` / `streamListen*` | 是 | **全部带 `ts_mono_ns`**，直接违反「内部时间戳不外泄」 | 需修正 |
| `speech.interrupted` | `maybeBargeIn` | 是（归 `speech.*`） | — | 可复用 |
| `speech.tts_started` / `.tts_chunk_started` / `.tts_chunk_finished` / `.tts_finished` / `.tts_cancelled` | `speakV1` | partial（契约只列 `speech.*`） | 需在契约的事件登记表里逐条声明，否则不算公开 | 需修正 |
| `board.log` / `board.tx` / `board.rx` | `BoardLink` 的 `raw`/`tx`/`rx` | **否** | 原始串口行，**属调试旁路**，不得进公开事件流 | 需修正（移出公开面） |
| `vision.*` / `camera.*` / `people.*` / `person.*` | — | 契约要求覆盖 | **完全未实现**（无检测、无 track） | 未实现 |

## 3. WebSocket 同步差异（R10 的主要输入）

| 项 | 契约要求 | 现状（`http-server.ts`） | 判定 |
| --- | --- | --- | --- |
| `hello` 消息 | 含 `version` / `server` / `instance_id` / 最新 seq / 支持的事件类型 | 有 `version/server/last_seq/supported_event_types`，**无 `instance_id`** | 需修正 |
| 初始快照 | `{"type":"state.snapshot","event_seq":N,"state":{...}}` | **不发**；客户端自己 `GET /v1/robot/state`，两者之间无游标关联 | 需修正 |
| 订阅确认 | `subscription.accepted` | 有 | 可复用 |
| 订阅竞态 | 捕获游标时开始缓冲，先快照后增量 | `v1Replay` 在 `accepted` 之后才读 `v1EventLog`，期间新事件已推给该 client → **可能乱序/重复** | 需修正 |
| `resume_from_seq` | 仅同 `instance_id` 且日志覆盖时有效，否则 `resync_required` | 只按 `seq >` 过滤，**没有实例校验、没有日志过期判定** | 需修正 |
| 过滤 | 精确 + `prefix.*` | `v1Matches` 支持 `*`/精确/`prefix.*` | 可复用 |
| 背压 | 慢订阅者要有界缓冲 + 明确断开/重同步 | `sock.write` 无背压判断，慢客户端只会堆内核缓冲 | 需修正 |
| `ts_mono_ns` | 不得外泄 | **每一帧都塞了 `ts_mono_ns`** | 需修正 |
| `event_id` | 跨实例唯一，建议 `instance_id + seq` | `evt_${seq}`，**跨实例不唯一** | 需修正 |
| `ping`/`pong` | 契约要求 | 应用层 `ping`→`pong` 有；RFC 层 ping 只回空 payload | 可复用（够用） |

## 4. 旧实现里必须显式记录的三处「复制即错误」

### 4.1 `robot_follow` 不是人物跟踪

`followV1()` 把参数改写成 `approach()` 的入参：`target_track_id` **被完全忽略**，
`target` 缺省填 `'人'`。`approach()` 每轮 `captureFrame → findTarget（VLM grounding + 自检）→ 按框中心偏移转、按框宽前进`。

风险：
- 依赖 VLM 单帧 1–2 s（[视觉延迟实测](../../eval/vision-latency.md)），不是快速检测器；
- 框宽当距离用，**单目框大小不等于米制距离**（计划 R16 已点明）；
- 丢失两轮即停，没有重新绑定；
- 每步之间车是停的，不是连续跟随。

**判定：未实现「人物跟随」**。R15 要接 macOS Vision 快速检测 + track，R16 定距离依据，R17 才做闭环。
Python 迁移**不得**把 `followV1 → approach` 这段原样搬过去冒充同一能力。

### 4.2 `mode` 是多点推导的派生态，不是状态字段

`mode` 在 `setEsp32` / `onBoardEvent` / `newTask` / `finishTask` / `stop` 五处被写，
每处都重新推导 `esp32 === 'ready' ? 'idle' : 'degraded'`（ADR-0006 已点名）。
Python 侧必须收敛为单一 `derive_mode()`，且 `mode` 不进「可被外部写入」的字段集合。

### 4.3 停止的爆炸半径比契约声明的大

`stop()` 同时取消：独占运动任务 + 全部语音软任务（听/说）。契约 §5 只承诺
「stop 是独立有序停止、可抢占普通任务」。**这是一条契约缺口，不是实现 bug**——
迁移前要在 R03 里明确写出「`robot_stop` 是否连带取消语音任务」，否则 R06 的任务表设计没有依据。

## 5. 原生桥与外部设备依赖

| 依赖 | 现状 | Python 侧要点 | 判定 | 承接 |
| --- | --- | --- | --- | --- |
| `serial-bridge.py` | Node 无 ioctl ⇒ 由 Python 子进程持串口、清 DTR/RTS，robotd 通过 stdio 收发文本行 | **Python 可直接用 `pyserial` 持串口**，这条桥在迁移后应消失，但要保留「抑制 DTR/RTS 复位」的既有行为 | 需修正 | R11 |
| `SimBoard` | 在 `robot-runtime.ts` 内用 `setInterval(20ms)` 复刻固件 | 是固件行为的**可执行规格**，含 300 ms 看门狗、`link.fault`、`sim.reboot` 两个只仿真有的故障注入 | 需迁移（可复用语义） | R07 |
| `mac_speech.swift` | 一次性 CLI（stdout 一行 JSON）+ `serve` 常驻（stdin 命令 / stdout NDJSON）；`stream` 为 NDJSON 流式 | stdin 必须保持打开；流式桥不能套超时；AEC 默认开（打断前提） | 需迁移 | R14 |
| `uvc_capture.swift` | `capture` 一次性，stdout 一行 JSON，错误码 `E_CAM_*` | 授权非 authorized 时**静默不出帧**（不是报错），超时信息须带 `camera_authorization` | 需迁移 | R12 |
| macOS Vision（`VNGeneratePersonRectanglesRequest`） | **未使用** | R15 唯一允许的检测后端；可能需要扩展现有 Swift 桥 | 未实现 | R15 |
| `modeld`（OpenAI 兼容 `/v1/chat/completions`） | `postModeld()`：10 s 超时、单飞链式排队、`grounded` 标记 | 单飞、超时、`E_MODEL_TIMEOUT`/`E_MODEL_DOWN` 语义保留；晚到结果不得污染已结束任务 | 需迁移 | R13 |
| ESP32 线协议 v2（`firmware/robot_server_v2.py`） | `PROTO=2`、`FW=poc-2.1`；命令带 `id`，无 `id` = 最高优先级；`velocity` 心跳 5 Hz，板侧 `HEARTBEAT_TIMEOUT_MS=300`；`stop` 幂等无 id 也执行；`hello` 带 `steps_per_m/wheelbase_mm/calib_source/caps`；启动发 `boot` 事件；错误码 `E_BUSY/E_RANGE/E_FW/E_STATE/E_HW` | **不另造协议**；`hello` 的字段才是单位事实源 | 可复用 | R07 R11 |

## 6. 旧 POC 的可复现仿真基线

> ⚠️ **本节记录的是 2026-10-23 删除前的 POC 基线**，命令已不可用：`src/robotd.ts` 与
> `npm run smoke` 都已随 POC 移除。当前的仿真方式是 `npm run robotd:sim`（Python robotd），
> 验证用 `npm run test:robotd` / `npm --prefix agentd test`。

```bash
cd <wallyd-root>
npm ci                      # 需要 node_modules 才能跑 contract:check（现状缺失）
npm run robotd:sim          # node --experimental-strip-types src/robotd.ts --sim --http 8787 --debug
npm run smoke               # 冒烟：对 127.0.0.1:8787 跑一份用例
```

环境要求：Node 22+（`--experimental-strip-types`）、macOS。仿真不需要串口/相机/麦克风。
**不得在此基线上启动真机运动**：`npm run robotd` 会打开真串口（`/dev/cu.usbserial-A5069RR4`），
且**同一串口只能有一个实际持有者**——Python 版本与 TS 版本不能同时连真机。

### 6.1 契约变更对旧实现的回归结果（2026-10-23）

R03 修改 `contracts/openapi.yaml` 后必须回归旧 TS 实现，因为它用 `openapi-backend` 在启动时
**校验整份文档**，文档非法会让所有路由退化成 404（服务看起来在跑，接口全不可用）。

| 轮次 | 现象 | 原因 | 处置 |
| --- | --- | --- | --- |
| 1 | `/v1/health` 等全部返回 `E_NOT_FOUND` | `Task.error` 上 `$ref` 与 `nullable` 并列 | 改 `oneOf` + `type: null` |
| 2 | 同上 | `nullable` 缺 `type` 同样判无效 | 同上修正 |
| 3 | — | — | **通过**：health/state/calibration/stop/404 全部正常 |

最终实测（`--sim`，端口 18794）：

```text
GET  /v1/health                        → 200 {"ok":true,"transport":"sim","esp32":"ready",...}
GET  /v1/robot/state                   → 200（注意：仍无 event_seq，符合「Python 才实现」的预期）
GET  /v1/robot/odometry/calibration    → 200 {"steps_per_m":8000,"wheelbase_mm":120,"source":"default"}
POST /v1/robot/stop                    → 200 {"stopped":true,"at":...}   ← 尚未按新契约补 board_ack
GET  /v1/tasks/nope                    → 404
```

**结论**：契约收紧是**向后兼容的追加**，旧实现仍可运行；但新契约里 `robot_stop` 的
`board_ack`、`RobotState.event_seq` 等字段旧实现**不产出**——这是「契约先行、实现跟上」的
正常状态，不是回归缺陷。为避免这两个 OpenAPI 3.0 陷阱再次发生，`contracts/tools/check.mjs`
已加入：① `$ref` sibling 检查；② 用 `openapi-backend` 实跑 `init()` 校验整份文档。

## 7. 差异 → 任务绑定汇总

| 差异类别 | 差异条数 | 承接任务 |
| --- | --- | --- |
| 契约 schema 缺口（裸 object、缺 `event_seq`/`instance_id`、`Task.state` 缺 `accepted`、错误码自由字符串） | 9 | R03 |
| WS 同步（快照、竞态、补发窗口、背压、跨实例 id） | 8 | R03 R10 |
| 事件 payload（`ts_mono_ns` 外泄、`board.*` 进公开面、`reason` 无枚举） | 4 | R03 R05 |
| 状态写入散落（`mode` 五处、`pump.set` 就地改） | 2 | R05 |
| 控制与停止（心跳、意图时效、stop 优先级、隔离机制未定） | — | R02 R08 |
| 任务语义（`accepted` 阶段、软任务槽、stop 爆炸半径） | 3 | R03 R06 |
| 人物跟踪未实现（`follow` 实为 `approach`） | 1 | R15 R16 R17 |
| 快速检测 / Vision 后端 | 1 | R15 |
| 设备适配（串口直连、桥生命周期、帧策略） | 4 | R07 R11 R12 R13 R14 |

## 8. 待人工确认

1. `robot_stop` 是否应连带取消语音任务（§4.3）——影响 R06 任务表。
2. `Task.state` 是否正式加入 `accepted`（契约 §5 的图已含，OpenAPI enum 没有）。
3. `board.*` 原始串口行是否只留在 debug 旁路（当前无 `--debug` 时 `CFG.debug` 为假，
   `rx/tx` 事件本来就不产生，但 `board.log` 无条件产生）。
4. `speech.tts_*` 五个事件是否正式登记为公开事件。

## 相关

- [robotd Python 模块开发计划](robotd-development-plan.md) —— 任务与验收门槛
- [robotd 对外接口契约 v1](robotd-interface-contract.md) —— 目标行为
- [`contracts/openapi.yaml`](../../contracts/openapi.yaml) —— 机器可读事实源
- [ADR-0006](../decisions/0006-robotd-event-driven-core.md) —— 状态单点与事件归并（proposed）
- [ADR-0009](../decisions/0009-robotd-python-runtime.md) —— Python 方向与控制隔离待设计项
- [分层通信与接口设计](../communication-protocol.md) —— B1/B2 边界、超时与背压
