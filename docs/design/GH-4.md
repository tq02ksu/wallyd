---
title: GH-4 语音桥内部拆分：拾音管道与出话管道
type: design
description: 把 mac_speech serve 的单体 ServeBridge 拆成「采集→AEC→VAD→ASR」与「分句→合成→有界队列→渲染」两条独立管道，并固定可替换的 engine 边界。
tags: [design, voice, audio, bridge]
domain: robot
project: wallyd
status: draft
---

# GH-4 语音桥内部拆分：拾音管道与出话管道

## 1. 目标与边界

本设计落实 issue #4：`scripts/mac_speech.swift` 的 `serve` 模式仍是 POC 时代的单体
`ServeBridge`。本轮的验收对象是**桥内部的边界与可观测性**，不是换模型，也不是 barge-in 策略：

- 拾音与出话各有独立 worker：音频 tap 只做「拷贝 + 分发」；
- VAD 与 ASR 都订阅同一份已转换帧，VAD 是旁路，不是 ASR 的前置门；
- 同一二进制通过 `--asr system|sherpa`、`--tts system|sherpa` 选择引擎；
  sherpa 分支返回明确的 not implemented，不伪造成功；
- 命令面收敛为 `listen` / `stop` / `speak` / `stop_speak`，保留 `mute` / `unmute` /
  `status` / `quit`；
- 不新增 `speech.interrupted` 等判断类事件；桥只多报 `aec_erle_db`、`tts_queued`、
  `tts_played`，以及验收明确要求的 `tts_chunk_dropped`。

> 说明：issue 引用的 `docs/decisions/0012-voice-session-control-layer.md` 不在当前基线
> 工作树中（`docs/decisions/` 只到 0011）。本设计严格采用 issue 正文转述的规则 5：
> 引擎可替换、管道之间只走纯数据、判断留给上层。

## 2. 数据流

```text
AVAudioEngine tap
  └─ handleTap：深拷贝原始帧 + 入 raw queue + 记录 tap 耗时（不做转换/ASR/TTS）
       └─ capture worker：多声道 downmix → ASR 格式；发布 AudioFrame
            ├─ VAD worker：校准 / probe VAD / utterance VAD / endpoint / echo probe
            └─ ASR worker：ASREngine.feed(frame)

speak(text)
  └─ Split（splitSentences）
       └─ synth worker → TTSEngine.synthesize(chunk)
            └─ BoundedQueue<TTSClip>（满则丢 oldest，并报 tts_chunk_dropped）
                 └─ render worker → playerNode → tts_played
```

`AudioFrame` 是不可变的纯数据：ASR 格式的 `AVAudioPCMBuffer`、`startFrame`、采样率、
采集时刻。`FrameBus` 只负责把同一帧投给订阅者各自的 serial queue；订阅者的处理速度
不会阻塞采集线程。

## 3. Engine 边界

```swift
protocol ASREngine {
    var name: String { get }
    func begin(utteranceId: String, format: AVAudioFormat,
               window: SpeechWindow, emit: @escaping ([String: Any]) -> Void) async throws
    func feed(_ frame: AudioFrame)
    func finish() async -> ASRFinal
}

protocol TTSEngine {
    var name: String { get }
    func synthesize(_ text: String, voice: String?, rate: Float) throws -> TTSAudio
}
```

- `SystemASREngine` 包装 `SpeechAnalyzer + SpeechTranscriber`；`SherpaASREngine` 只返回
  `E_ASR_NOT_IMPLEMENTED`。
- `SystemTTSEngine` 包装 `AVSpeechSynthesizer.write(_:toBufferCallback:)`；
  `SherpaTTSEngine` 只返回 `E_TTS_NOT_IMPLEMENTED`。
- `SpeechWindow` 是 VAD 写给 ASR 的**纯数据**（speech start/end 音频毫秒），不是判断：
  ASR 用它做 partial 门控，端点仍由 VAD 决定。
- 每轮 utterance 有自己的 `SpeechWindow` 与 ASR engine；上一轮的 final/batch 收尾在后台
  继续时，VAD 可以开始下一轮，不需要等上一轮跑完。
- 引擎选择不改变上层事件；`bridge_ready` 额外报告 `asr_engine` / `tts_engine` 以便核对。

## 4. 命令面

| 命令 | 语义 |
| --- | --- |
| `listen` | 显式开启一轮听（已由 VAD 自动开启时可复用） |
| `stop` | 结束当前一轮听 |
| `speak` | 一整段文本进入分句/合成/渲染管道 |
| `stop_speak` | 取消当前播报并清空未播队列 |
| `mute` / `unmute` | 常听开关，保持原语义 |
| `status` / `quit` | 状态快照 / 退出 |

`play` / `record` 诊断命令不再属于桥的命令面；AEC 离线实验脚本需要另走独立工具，
避免把实验入口混进生产协议。

## 5. 新增可观测字段与事件

| 事件 | 新字段 / 语义 |
| --- | --- |
| `aec_echo_probe` | `aec_erle_db`：以最近一次送入 playerNode 的参考电平减当前麦克风电平估计；同时带 `fed_frames` |
| `tts_queued` | `depth`、`peak`、`index`、`chunks`、`response_id` |
| `tts_played` | `played`、`depth`、`peak`、`index`、`response_id` |
| `tts_chunk_dropped` | `reason: "queue_full"`、`index`、`text`、`response_id`、`depth`、`peak` |
| `capture_timing` | 每 250 帧一次：tap 的 `p50_ms`/`p99_ms`/`max_ms`/`p99_ok`，以及转换 worker 的 `capture_work_p99_ms` |
| 所有语音事件 | 尽量携带 `fed_frames` 与 `audio_ms`，便于与 `t_ms` 对账 |

`status` 额外暴露 `capture_frames`、`fed_frames`、`vad_frames`、`asr_frames`、`tap_p99_ms`、`capture_work_p99_ms`、`tts_queue_depth`、
`tts_queue_peak`、`tts_dropped`，让 30 分钟常听可以用一个查询对账。

## 6. 验收映射

| 验收判据 | 实现 | 验证 |
| --- | --- | --- |
| 1. 同二进制切换 ASR/TTS | `--asr` / `--tts` + 两个 stub engine | `bridge_ready` 的 `asr_engine` / `tts_engine`；sherpa 命令返回 `E_*_NOT_IMPLEMENTED` |
| 2. `tts_queued` 峰值与 `tts_chunk_dropped` | `BoundedQueue<TTSClip>` + `tts_queued` / `tts_played` | 小队列 + 长文本，观察峰值与 drop 事件 |
| 3. 30 分钟常听不丢帧 | tap → raw queue → capture → FrameBus；`fed_frames` 入所有事件 | 用 `capture_timing` 与 `aec_echo_probe.t_ms/fed_frames` 对账 |
| 4. 单帧 p99 < 5ms | `TapTiming` 只统计 `handleTap` 的拷贝/入队 | `capture_timing.p99_ms` 与 `status.tap_p99_ms` |

真实麦克风、30 分钟长跑与 p99 必须在 macOS 目标机执行；本轮在 Linux 沙箱内只能运行
Python/契约门禁和静态边界检查，不能把静态检查冒充真机结果。
