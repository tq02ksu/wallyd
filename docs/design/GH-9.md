---
title: GH-9 AudioRuntime 常听会话状态机与自动续听
type: design
description: 在 AudioRuntime 内实现 idle/listening/thinking/speaking 会话状态机、runtime 驱动的自动续听、inter_utterance_ms 防抖、trigger 字段，以及只拦非打断自动轮的 speaking 闸。
tags: [design, voice, audio, always_on, state-machine, contract]
domain: robot
project: wallyd
status: draft
---

# GH-9 AudioRuntime 常听会话状态机与自动续听

落实 issue #9（V06）。本轮范围以维护者 2026-11-08 评论为准：正文中「`_adopt_auto_utterance()`
只挡 muted 和已有当前轮」等现状描述已部分作废，且**不能把 `speaking` 闸加在 `speech.gate` 之前**。

## 1. 目标与边界

把 `audio.state.mode` 从常量 `"always_on"` 变成由 AudioRuntime 真正维持的状态，并补齐：

1. 显式会话状态机 `idle / listening / thinking / speaking`；
2. runtime 收尾事件驱动的自动续听（不是外部轮询）；
3. 机器人侧 `inter_utterance_ms` 防抖（默认 300 ms）；
4. `Utterance.trigger: "api" | "auto"` 显式字段，进入 `speech.ready` / `speech.started`；
5. `speaking` 闸：播报期间**不认领非打断的自动轮**并记 `speech.ignored{speaking}`。

明确不做：

- 不做唤醒词；不做「播报中也能听」（V02/V03 的 barge-in 保持原样）；
- 不改 agentd 任何逻辑；
- 不重做 PR #16 的桥侧自动开轮、认领、`_utterance_for()` 迟到隔离；
- 不把桥的 `idle_timeout_ms` 当作本 issue 的防抖：桥空闲超时与轮次间防抖是两件事。

## 2. 两个状态字段，别混成一个

| 字段 | 取值 | 含义 |
| --- | --- | --- |
| `AudioState.mode` | `always_on` / `idle` | 常听是否由 runtime 维持：桥就绪、未静音、未停止 → `always_on`；静音 / 桥丢失 / 停止 → `idle` |
| `AudioState.phase` | `idle` / `listening` / `thinking` / `speaking` | 显式会话状态机 |

判据 2 要求「说话 → final → 续听，`mode == always_on` 全程为真」，所以 `mode` 不能直接等于
`phase`；反过来「把续听关掉，mode 掉回 idle」由静音 / 停止 / 桥丢失实现。`phase` 是本轮新增的
可观测面，用来证明 `speaking → idle → listening` 没有跳步。

## 3. 状态机

```
                 bridge_ready && !muted && !halted
        idle ─────────────────────────────────────► listening
          ▲                                            │  endpoint / 无人说话
          │                                            ▼
          │                                        (final 无文本)
          │                                            │
          │◄────────────── inter_utterance_ms ─────────┘
          │
          │  final 有文本
          ▼
      thinking ──(agentd speak: new_response)──► speaking
          ▲                                        │
          └────────── tts_finished / tts_cancelled ─┘
                     （先回 idle，再按防抖回 listening）

任意状态 ──(mute / bridge_exit / stop_listening)──► idle
```

- `listening → thinking` 只在 final **有文本**时发生；`no_speech` final 回 `idle` 并续听。
- `speaking → idle → listening` **不允许跳过 idle**：`inter_utterance_ms` 就落在 idle 窗口。
- `mode` 始终由「桥就绪 + 未静音 + 未停止」计算；`phase` 由事件推进。

**播报前必须停掉在听的那一轮**：常听会一直持有 `listen`，而桥只在 `activeId == nil` 时跑
probe VAD。`new_response()` 因此在进入 `speaking` 前发 `stop{reason:"speaking"}` 并清空
当前轮（不产 final，桥稍后的 final 因无当前轮被丢弃）；否则播报期间看不到 VAD 上升，
V03 的 barge-in 会整体失效。

## 4. 自动续听：runtime 驱动，事件收尾 + 一次性定时

桥在 `activeId == nil` 时才跑 probe VAD 自动开轮；只要 runtime 持续持有一轮，桥就不会再开第二轮。
因此「一直在听」的续听必须由 runtime 负责：

1. 收到桥的 `bridge_ready` 后，若 `mode == always_on` 且没有当前轮/播报 → 开一轮
   `listen`（`utterance_id = utt-auto-*`，`auto_endpoint=true`，`max_seconds=1800`，
   `idle_timeout_ms` 显式给出，沿用桥默认的 20 s）；
2. `_finish_utterance` / `tts_finished` / `tts_cancelled` 收尾时记录 `last_end_ms`，
   `phase = idle`，然后按 `inter_utterance_ms` 排一个**一次性**恢复定时（不是轮询）；
3. 定时到点再次满足 `mode == always_on && !muted && !speaking && utt is None` 才开新轮。

runtime 主动 `listen` 的轮次在收到桥 `ready` 前标记为未确认；若桥报 `E_BUSY`
（撞上桥自己的自动开轮），runtime 释放这一轮并在防抖后重试，避免幽灵轮次卡住常听。

`inter_utterance_ms` 是 robotd 侧两轮之间的最小间隔。桥的 `idle_timeout_ms` 仍是
「桥自己的空闲超时」：静音房间里的自动轮由它收尾，runtime 把桥的 `final{stop_reason:"idle"}` /
`max_seconds` 且 `no_speech` 的自动轮翻译成 `speech.endpoint{reason:"idle_timeout"}`，**不发 final**。

## 5. `trigger` 与任务表

`Utterance.trigger` 是显式字段（`auto` 由桥 VAD 或 runtime 续听开启，`api` 由
`POST /v1/speech/listen` 开启）。`task_id is None` 继续保留，但下游不再靠它猜。

- `speech.ready` / `speech.started` payload 新增 `trigger`（required，enum `auto` / `api`）；
- `speech.listen` 任务表只在 `trigger == "api"` 时登记（HTTP 路由已创建 task；自动轮从不建 task）。

## 6. `speaking` 闸：只拦非打断的自动轮

维护者评论的边界：**不能**用「`self.response is not None` 就拒绝认领」，那会掐断 V03 的 barge-in。

- 播报期间桥先发 `speech_state`（probe 事实）。runtime 先跑 `speech.gate`：
  - `decision == "pass"`（真打断）：**照常认领**该轮、发 `speech.started`、`abort_response("barge_in")`；
  - `decision == "suppressed"`（回声/缺证据）：**不认领**、发 `speech.started` 事实、
    记 `speech.ignored{reason:"speaking"}`；
- 若桥只送来一个裸 `ready`（没有 gate 事实），播报期间同样不认领并记 `speech.ignored{speaking}`；
- 同一 utterance_id 只记一次 ignored；`speaking` 结束时清空本轮 pass/rejected 集合。

V02 的 `speech.gate{suppressed}` 是**桥侧声学事实的判定**；本条的 `speech.ignored{speaking}` 是
**runtime 的状态判定**。两者都保留，不合并。

## 7. 防抖与迟到隔离

- 桥自动轮（`ready` / `speech_state`）若落在上一轮结束后的 `inter_utterance_ms` 内 →
  不认领（不产生第二轮；没有对应 `speech.ignored` 原因，契约枚举不为本场景扩张）。
- `inter_utterance_ms = 0` 时两轮都认领，用来反向证明防抖确实生效。
- `_utterance_for()` 的迟到隔离保持不变：旧轮 `utterance_id` 的 `partial` / `final`
  不写当前轮；补测试守住 `last_final` 也不被旧轮 final 覆盖。

## 8. 判据映射

| 判据 | 测试 | 反向验证 |
| --- | --- | --- |
| 1 静音 30 min 无 final | 注入虚拟时钟 + 假调度器推进 30 min；0 条 `speech.final`，只有 `speech.endpoint{idle_timeout}` | 把自动轮 no_speech 抑制删掉 → final 出现 |
| 2 final → 续听，mode 全程 always_on | 逐阶段快照 `state()["mode"]`；tts 后先 `idle` 再 `listening` | 静音 → mode 变 `idle` |
| 3 间隔 < 300 ms 只一轮 | 两轮 ready 间隔 100 ms；第二次不认领 | `inter_utterance_ms=0` → 两次都认领 |
| 4 播报中不认领新自动轮 | `speech.ignored{speaking}`，认领 0 | 去掉闸 → 认领 1 |
| 4b 播报中 gate=pass 仍认领 | barge-in 轮被认领且 `tts_cancelled{barge_in}` | 闸加在 gate 之前 → 该判据红 |
| 5 静音后 listen 409 E_STATE | HTTP 处理函数返回 `E_STATE`；不再开新轮 | 放宽静音守门 → 200 |
| 6 自动轮不入 task 表 | 多轮自动续听后 `GET /v1/tasks` 仍空 | 自动轮建 task → 计数 +1 |
| 7 迟到事件隔离 | 旧轮 partial/final 不写当前轮 / `last_final` | 删 `_utterance_for` → 写进新轮 |

30 分钟必须用虚拟时钟（注入 `now` + `schedule`），不真 sleep，避免拖死 CI。

## 9. 契约与实现顺序

1. `contracts/openapi.yaml`：`AudioState.mode` enum 增 `idle`、新增 required `phase`；
2. `contracts/events.json`：`speech.ready` / `speech.started` 增 required `trigger`；
3. `npm run contract:generate` 生成物；
4. 测试（本文件的判据映射）；
5. `AudioRuntime` 实现与 app 装配（`inter_utterance_ms` 来自 Config）。
