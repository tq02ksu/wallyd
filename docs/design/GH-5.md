---
title: GH-5 播报期间的 VAD 门控：桥只报事实，AudioRuntime 单点判定
type: design
description: 删除桥侧 suppressAuto 一刀切，播报期间照常跑 VAD 并上报事实；由 robotd 的 AudioRuntime 用可调门限决定是否 barge-in，并产出可观测的 speech.gate。
tags: [design, voice, audio, barge-in, vad, aec]
domain: robot
project: wallyd
status: draft
---

# GH-5 播报期间的 VAD 门控：桥只报事实，AudioRuntime 单点判定

## 1. 目标与边界

本设计落实 issue #5（V02）。要解决的问题只有一个：**播报期间 VAD 判出有人说话时，
该不该真的停掉正在播的话。**

不做的事（与 issue 的「明确不做」一致）：

- 不接 AEC3（V03）；不换参考信号、不改两条管道的结构；
- 不放宽或删除 `agentd/src/agentd/robotd-event-bridge.ts` 的 `echo` 判定（V08 的审批
  settle 证据链），只记录它与本设计门限的重复关系（见 §7）；
- 不裁定语义。「这句话算不算审批」仍归 agentd 的 settle 链（`runs.ts`）。

`speech.gate` 只回答「这一帧 VAD 上升要不要放行打断」，不产出任何业务语义。

## 2. 判定归属：单一仲裁点

| 层 | 做什么 | 不做什么 |
| --- | --- | --- |
| 桥（Swift） | 播报期间照常跑 VAD；如实上报 `rms_db`/`db`/`render_db`/`aec_erle_db` 事实；照常开启自动轮次 | 不判定、不丢弃帧、不以「被压掉」为由短路 `speech_state` |
| robotd `AudioRuntime` | 唯一决定 break / 不 break；产 `speech.gate` 与 `speech.started`；执行 `stop_speak` | 不把判定下放给桥或 agentd |
| agentd | 只消费 `speech.*` 推进会话/审批 | 不读 `aec_erle_db` 重算「要不要打断」 |

依据：`docs/voice-architecture.md:231`（打断只能有一个仲裁点，由 Audio Runtime 决定）、
`:150`（utterance 生命周期、端点、打断仲裁归 Audio Runtime）、ADR-0007 的模块归属表
（`Audio` 属 robotd）。物理上也只有持有播放队列的一层能执行「停播 + 清队列」。

**门禁化**：`robotd/tests/unit/test_barge_in_gate_location.py` 枚举扫描源码，而不是抽查。
`robotd/src/` 里出现打断判定标记（`"barge_in"` / `speech_db_barge_in` / `_barge_in_verdict`）
的文件只允许是 `core/audio_runtime.py`（配置项与转发参数不算判定）；
`agentd/src/` 里读 `aec_erle_db` 的位置只允许 `robotd-event-bridge.ts` 的那一条 settle 证据判定，
断言行内必须同时出现 `during_tts`（即「这句话是不是回声」），并在断言里注明理由。

## 3. 桥侧：删掉 suppressAuto，播报期间照常跑 VAD

`scripts/mac_speech_pipeline.swift` 的改动保持在 VAD worker 的一个条件上：

```swift
// before: if activeId == nil && !m && !s && !busy {
if activeId == nil && !m && !busy {
    runProbeVAD(frame)
}
```

同时删除 `suppressAuto` 的声明、读取与两处置位，`aec_echo_probe` 的触发条件从
`if s || speaking` 改为 `if speaking`（ERLE 只在有渲染参考时有意义）。

`runProbeVAD` 在 probe VAD 上升时**先发事实、再开轮**：

1. 发一条 `speech_state{state:"speech"}`，带 `utterance_id`（即将开启的 `utt-auto-N`）、
   `rms_db`/`db`，以及可得的 `render_db` 与 `aec_erle_db`；
2. 再走原有的 `beginUtt(auto: true)` 自动开轮路径。

桥侧事件名保持**裸名**（`ready` / `final` / `speech_state`），不新增 `speech.gate`，
也不写任何「判为回声就不发事实」的分支。

这样有两个直接后果，都是设计的一部分：

- 播报期间的自听回声也会开启自动轮次（桥不知道也不该知道那是回声）；robotd 用
  `speech.gate{suppressed, echo}` 把它记在时间线上，agentd 的 `during_tts` 仍然把它当回声；
- 事实先于 `ready` 到达。`AudioRuntime` 必须能以 `speech_state` 的 `utterance_id`
  认领尚未 `ready` 的自动轮次（复用 `_adopt_auto_utterance`），否则播报期的第一帧事实会被丢掉。

## 4. 门限与判定规则（唯一一份，在 AudioRuntime）

### 4.1 符号

- `T = speech_db_barge_in = max(ambient_db + erle_margin, speech_db)`
  —— 判定「VAD 上升是否属于用户」的电平门限（dBFS）；
- `db` —— 该 VAD 上升帧的麦克风电平（桥 `speech_state.rms_db`/`db`）；
- `aec_erle_db` —— 最近一次 `aec_echo_probe` 的 AEC 回声抑制量（`render_db - mic_db`）；
- `erle_margin` —— **AEC 实测回声残余相对本底的最大值 + 安全余量**（dB），可配置。

`erle_margin` 的来源是 `eval/r14-voice-bringup-2026-10-24.md` §5.6 的 VPIO 实测：
回声残余本底之上中位 +19.2 dB、最坏 +26.9 dB。默认取 **30 dB**（最坏值 + 约 3 dB 余量）。
这不是随意抬高门限：V03 把参考信号换成 AEC3 后，离线中位 ERLE +45.2 dB，残余落到本底以下，
`erle_margin` 应随之收窄到小值，门限自然回落到 `speech_db`。

`AudioRuntime` 同时记下 probe 的 `render_db`（事实），供 V03 收窄 `erle_margin` 时核对；
它不参与本轮的判定。

### 4.2 判定

按顺序，第一命中即为结果：

| 条件 | `decision` | `reason` |
| --- | --- | --- |
| 没有正在播报的 response | `pass` | `not_speaking` |
| `ambient_db` 与 `speech_db` 都缺失（未标定） | `suppressed` | `no_threshold` |
| 无 `aec_erle_db`、上次探测 >1000ms、或 `aec_erle_db < 6 dB` | `suppressed` | `no_erle` |
| 该帧没有可用的 `db` | `suppressed` | `no_db` |
| `db >= T` | `pass` | `barge_in` |
| 其余（`db < T`） | `suppressed` | `echo` |

三条纪律：

1. **缺证据 ≠ 有证据**：`no_erle` 落在 suppressed 一侧。ERLE 缺失、过期、明确为 0、
   或低于 6 dB 底线都走这一条（`_num` 保留 0 这个值，不把 0 当缺失；0 与「没探测到」
   都判 `no_erle`）。
2. **6 dB 的 ERLE 底线**表示「AEC 确实在压回声」。它与 agentd settle 的
   `ECHO_ERLE_MAX_DB = 6` 共用同一物理量与同一数值，属已知重复，见 §7。
3. **每个 utterance 只判一次**：沿用 `Utterance.saw_speech`。probe VAD 上升与随后
   utterance VAD 的上升是同一轮的两个事实，第二次不再产 `speech.gate`、不再重复打断。

### 4.3 执行

- `pass` 且正在播报：发 `speech.gate` → 发 `speech.started` → `abort_response("barge_in")`
  （本地立即发 `speech.tts_cancelled{reason:"barge_in"}`，并让桥 `stop_speak` 清空未播队列）。
  立即本地中止是有意的：打断是仲裁动作，不能等桥回报；桥随后回报的 `tts_cancelled`
  因 `self.response` 已清空而被忽略，不会重复。
- `pass` 但未播报（B2/B3）：只发 `speech.gate` + `speech.started`，不动任何播报状态。
- `suppressed`：只发 `speech.gate` + `speech.started`。**仍然发 `speech.started`**：
  桥确实开启了一轮 utterance，robotd 只是决定不打断；不发 started 才是第二个判定点。
  而且 agentd 的回声证据（`during_tts` / `aec_erle_db`）挂在 `speech.started` 上：
  少发它会让回声轮次失去 `echo=true`，反而可能被当成审批证据。

## 5. `speech.gate` 事件

由 robotd 发，登记在 `contracts/events.json`（`no_state: true`）：

| 字段 | 类型 | 必有 | 说明 |
| --- | --- | --- | --- |
| `utterance_id` | string | 是 | 这一次 VAD 上升所属的轮次 |
| `decision` | `pass` / `suppressed` | 是 | 是否放行打断 |
| `reason` | string | 是 | `barge_in` / `echo` / `no_erle` / `no_db` / `not_speaking` / `no_threshold` |
| `db` | number | 否 | 该帧电平 |
| `aec_erle_db` | number | 否 | 最近一次探测的原始 ERLE（可能是 0；从未探测到则不出现；是否可用于判定见 §4.2） |
| `threshold_db` | number | 否 | 本次判定使用的 `T`（未标定时不出现） |

**每次 VAD 上升都发一条，pass 与 suppressed 都发**。否则「被压掉的声音」没有分母。

## 6. 用例映射

| 用例 | 测试 |
| --- | --- |
| A1 播报中用户插入 | `robotd/tests/unit/test_audio_runtime.py::test_barge_in_passes_*` |
| A2 审批复述被打断 | `::test_approval_repeat_barge_in_*`（只发 tts_cancelled，不发 tts_finished） |
| A3 刚开播就打断 | `::test_barge_in_right_after_tts_started` |
| B1 自听回声 | `::test_barge_in_suppressed_for_self_echo` |
| B2 没在播报 | `::test_gate_passes_without_playback` |
| B3 播报尾巴 | `::test_gate_passes_after_tts_finished` |
| B4 缺 ERLE / 过期 / 明确 0 | `::test_gate_suppressed_without_erle_fact` 等 |
| B5 抖动去重 | `::test_repeated_vad_rise_emits_one_gate_per_utterance` |
| 判据 4 判定单点 | `robotd/tests/unit/test_barge_in_gate_location.py` |
| 判据 5 每次上升都有 gate | `::test_every_vad_rise_emits_a_gate` |
| 判据 6 suppressAuto 真删 | `robotd/tests/unit/test_voice_bridge_architecture.py::test_bridge_does_not_suppress_vad_during_playback` |

## 7. 已知重复门限（待收敛，本 issue 不改）

`agentd/src/agentd/robotd-event-bridge.ts:264` 的
`during_tts || (aec_erle_db !== null && aec_erle_db < ECHO_ERLE_MAX_DB)` 判的是
「这句话是不是回声」，作为审批 settle 的证据（`echo=true` 的 utterance 不能确认审批），
**不是**「要不要停播」，归 agentd 且必须保留。

它与 AudioRuntime 的 `no_erle` 底线共用 `aec_erle_db` 与 `6 dB`。两处含义不同
（agentd 用它排除审批证据；robotd 用它判断 AEC 是否在压回声），但数值耦合是真实的，
收敛需要同时改 V08 的 settle 用例，应另开 issue。本 issue 只在 handoff 记一笔。

另一个连带事实：真实的 barge-in 轮次在 `speech.started` 时 `during_tts` 仍为真，
agentd 会把它标成 `echo`（settle 证据）。这是 V08 的既有口径，本 issue 不改；
V06 消费 `speech.gate` 后应改用 gate 的 `pass` 作为「真的打断了」的证据。

## 8. 未在本环境验证的部分（不得当作已解决）

- **判据 1 的 30 分钟连续播报、pass=0**：需要 macOS + 真实麦克风/喇叭的整机运行，
  本沙箱没有硬件。单元测试只证明判定逻辑与事件面；硬件结论留给 V03 复跑。
- **判据 2 的「播报中/不播报人声 db 差 ≤ 3 dB」**：需要 `eval/aec3/` 的录音对，
  录音在 gitignore 的 `work/` 下，不在仓库内。
- 默认 `erle_margin = 30 dB` 在 VPIO 下高于常人声电平，因此**真机 A1 在 V03 收窄门限前
  可能仍不打断**；这是 issue 明确接受的现状（先搭判定与可观测性，V03 换参考信号后再收窄）。
