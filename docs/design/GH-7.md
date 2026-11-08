# GH-7：把语音 final 接成一次 run（V04）

状态：实现完成，待评审（真机音频链路未在本环境执行）。对应 issue：`[V04] 把 onUtteranceHeard 接上：语音 final 要能变成一次 run`。
本轮范围以维护者 2026-11-08 评论为准（正文中「钩子没人调用」的现状已作废）。

## 1. 现状与边界

`RobotdEventBridge.onUtteranceHeard` 已由装配层接到
`RunService.dispatchUtterance`，顺序固定为：

```
空文本 / 回声 → 审批 settle → 忙 → submitUtterance
```

`submitUtterance` 再走 `submitRunRequest(...)`，与 `POST /api/run` 共用同一份路由、
审批门与幂等实现。因此本轮**不重写分发器顺序**、不移动钩子、不放宽审批门。

本轮只补四件事：

1. 判据 1 的**因果**断言：run 的 `source/route/fast_rule/idempotency_key` 与
   robotd 真正收到的 `POST /v1/robot/stop`；
2. 判据 5 区分**审批层**与**执行层**，并把「确认后才执行」串成一条；
3. 被中断的 final（`barge_in` / `cancelled` / `muted`）不变成 run 的反向断言；
4. 新增窄事件 `speech.ignored`，让 robotd 侧丢弃的轮次在时间线上有分母。

## 2. `speech.ignored` 契约

```
speech.ignored
payload:
  utterance_id: string (required)
  reason: enum [busy, echo, empty, speaking] (required)
  run_id: string (optional)
```

- `busy` / `empty` 的判定在 agentd（活动 run 在它那儿）；`speaking` 留给 V06，
  本轮只声明枚举、不实现；`echo` 由 AEC 事实在 agentd 判定。
- robotd 在 `new_utterance()` / `_adopt_auto_utterance()` **拒绝一轮**时发 `busy`：
  新请求的 `utterance_id` 作为被丢弃轮次的身份，不指向已在听的那一轮。
- agentd `RobotdEventBridge` 收到后只写日志 + 现有的
  `observation.speech_ignored`，不新增第二个 agentd 事件类型。分发器自己写的那条
  与这条同型，时间线不会出现两种「被忽略」。
- 契约顺序：`contracts/events.json` → `contracts/generated/robotd-events.json`
  → robotd 发 → agentd 收 → 测试。`_emit_locked` 对未登记事件直接抛，
  所以不能先写实现。

## 3. 判据映射

| 判据 | 单测（`agentd/tests/unit/utterance-dispatch.mjs`） | 反向验证 |
| --- | --- | --- |
| 1 停止 → `source:asr` / `fast` / `stop_robot@1` / robotd 收到 stop | 真实 `RunService` + `submitRunRequest`；CI 回环下用 `createRuntime` + 假 robotd HTTP | 去掉 `fast_rule` 或把 route 固定成 harness，断言红 |
| 2 同一 `utterance_id` 重放只建一条 run | 第二次 final 命中 `asr:<id>` 幂等键（`duplicate:true`），不重复执行 | 去掉 `idempotency_key`，run 数变 2 |
| 3 `no_speech` → 0 run | 事件库只有 `speech.no_speech`，无 run、无 `speech_ignored` | 把 `no_speech` 分支删掉，run 出现 |
| 4 忙 → `observation.speech_ignored {busy}`，不建 run | 活动 run 存在时的 final 被吞掉并记账 | 删除忙分支，run 数 +1 |
| 5 需审批 → `waiting_confirmation`，不执行；确认后才执行 | 审批层（run/approval 状态）+ 执行层（`robot_follow` 计数为 0）分别断言 | 把审批门当无审批执行，`robot_follow` 提前出现 |
| 中断 final 不建 run | `barge_in` 的 final 只落 `speech.no_speech` | 去掉 `isInterrupted` 分流，run 出现 |

`speech.ignored` 的整条链路由 `agentd/tests/unit/speech-ignored-chain.mjs` 一条测试串通：
读契约与生成物 → 真跑 robotd `AudioRuntime` 的忙拒绝 → 把产出的 payload 原样喂给
`RobotdEventBridge` → 断言 `observation.speech_ignored`。

「robotd 真的收到」只在能绑定回环时由真实 HTTP 假服务断言；受限沙箱 `listen`
被拒时如实 SKIP，并用同一份文件在 `agentd/tests/manual/in-memory-http.mjs`
内存传输下本地复核。真实硬件链路（`scripts/speech_fixture.swift`）不进 CI，
在 handoff 中如实写 SKIP 与原因。

## 4. 不做

- 不改分发器顺序、不改审批门、不为 `robot_speak` 开免审批口；
- 不做 V09 会话上下文、V07 Harness 执行、V06 的 `speaking` 闸；
- 不把 `onUtteranceHeard` 挪到别的模块——它已在装配层接好，#11/#13 依赖它。
