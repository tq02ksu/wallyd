---
type: project
title: Mac mini 移动机器人 — 语音输入输出改造方案（流式优先）
description: 把语音链路从「录完一句 → 识别 → LLM → 播放」的 request/response 形态改成持续在线的 stream 形态：常驻 audio-bridge（AEC 采集/播放同图）+ 独立 VAD 端点检测 + 增量 ASR + 并行说话人分段 + 分句流式 TTS 与打断；保留 Application / Robot Runtime / Device Runtime 三层，只在第二层内重划 Audio Runtime。
aliases: [语音架构改造, voice-architecture, 流式语音改造, 语音输入输出改造]
tags: [project, robot, architecture, audio]
domain: robot
project: macmini-robot
sources:
  - id: ref-voice-redesign
    resource: https://github.com/k2-fsa/sherpa-onnx
    title: sherpa-onnx（本地流式 ASR / VAD / 说话人分段与识别 / TTS，macOS 支持）
  - id: ref-xiaozhi-server
    resource: https://github.com/xinnan-tech/xiaozhi-esp32-server
    title: xiaozhi-esp32-server（WebSocket 音频帧 + JSON 控制事件分离、ASR/LLM/TTS 流水线、声纹注册）
  - id: ref-xiaozhi-esp32
    resource: https://github.com/78/xiaozhi-esp32
    title: xiaozhi-esp32（设备端固件与服务端协作模式）
  - id: apple-speech-docs
    resource: https://developer.apple.com/documentation/speech/speechanalyzer
    title: Apple Speech framework — SpeechAnalyzer / SpeechTranscriber（含结果时间范围）
  - id: apple-avspeechsynth
    resource: https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer
    title: Apple AVSpeechSynthesizer（AVFAudio，支持中途停止）
generated: { by: codex/gpt-5, at: 2026-10-13T15:30:00+08:00 }
status: draft
relations:
  - predicate: part-of
    target: /README.md
  - predicate: depends-on
    target: /docs/architecture.md
  - predicate: depends-on
    target: /docs/communication-protocol.md
  - predicate: depends-on
    target: /docs/model-selection.md
  - predicate: depends-on
    target: /docs/archive/poc-design.md
  - predicate: depends-on
    target: /contracts/openapi.yaml
---

# Mac mini 移动机器人 — 语音输入输出改造方案（流式优先）

> 定位：本文回答「**语音输入输出怎么改**」。核心不是换一个更聪明的模型，而是把语音从
> **request/response** 形态改成 **stream** 形态——输入是「一直在听、边说边出字、说完自动收尾」，
> 输出是「边生成边分句、边播边说、随时被打断」。

> 与既有文档的分工：[[model-selection|模型选型]] 定「用哪个 ASR/TTS」，本文定「链路怎么流起来」；
> [[architecture|架构设计]] 的三容器边界与 [[communication-protocol|分层通信与接口设计]] 的
> Capability / State / Task / Event 四类契约**不变**，本文只在 Robot Runtime 内部**重划语音相关模块**并扩充事件面。

> 依据：用户 2026-10-13 提供的语音改造参考分析（附件，借鉴 xiaozhi 的音频流水线/会话状态机/能力解耦）
> ＋ 本项目 POC 的语音实测记录（[[archive/poc-design]] 的 2026-10-09 / 2026-10-10 两条）。
> ⚠️ 本文引用的外部仓库与文档**未联网核验**（2026-10-13 运行环境无网络），细节以官方仓库为准；
> 所有「待核实」标记的结论必须实测后再定。

> **2026-10-13 结构调整**：项目已从 POC 进入正式工程化开发——代码在 `wallyd/src/`
> （`runtime/` + `transport/` 拆分），文档在 `docs/`，接口契约单一来源为
> `wallyd/contracts/openapi.yaml`（生成 `contracts/generated/` 的 JSON 与 TS 类型）。
> 本文讨论的**接口/事件**落地时以该契约为准（§6）。

## 0. 结论先行

1. **三层模型不推翻。** 应用层 / Robot Runtime / Device Runtime 三层保持，ESP32 继续只管实时硬件控制。
   改动全部发生在**第二层内部**：把语音相关的采集、端点、识别、说话人、合成、播放收敛成一个明确的
   **Audio Runtime** 模块，加上与语音并列的 **People Perception**（人物感知）。
2. **现在「弱」的根因是形态问题，不是模型问题。** 现有链路本质上还是「起一个进程 → 录/生成 →
   拿一个结果」：`audio.listen` 是录满 N 秒再说；`audio.stream` 虽然吐 partial，但仍是一次性
   spawn 的原生脚本、**没有 VAD 端点**（说完要手动停）、**没有说话人**、**采集与播放是两个各自独立的
   进程所以没有回声消除**；TTS 是整句一次性合成、不能被打断。
3. **流式改造 = 五个结构性变化**（详见 §3~§5）：
   ① 一次性语音桥 → **常驻 `audio-bridge`**（AEC 采集/播放同一音频图）；
   ② 「录一段再传」→ **持续 PCM 帧流 + 统一单调时间轴**；
   ③ 端点检测从系统 `SpeechDetector`（与 Transcriber 冲突、已实测不可用）→ **独立 VAD**（Silero / sherpa-onnx）；
   ④ ASR 与说话人分析 **并行**，输出带时间范围的 speaker-aware transcript；
   ⑤ TTS 从整句阻塞 → **分句流式 + 有界播放队列 + barge-in 打断**。
4. **不照搬 xiaozhi 的设备架构。** 本项目是单机（Mac mini 主力 + ESP32 控制），只借鉴它的
   「音频帧与控制事件分离、ASR/LLM/TTS 独立流水线、能力与对话解耦」，不引入它的设备-服务端模式。
5. **推荐 V1 路线**：常驻音频桥 + 独立 VAD + **保留系统 ASR 做增量文本**（中文资产已装、已实测），
   说话人分析用 sherpa-onnx 并行补上；TTS 先用系统合成做分句流水，首包/自然度不达标再换
   sherpa-onnx 流式 TTS。这样只新增真正缺的能力，把已验证的能力留下。

## 1. 现状盘点：为什么现在「不流式」

> 事实来源：[[archive/poc-design]] 2026-10-09 / 2026-10-10 两次实测；[[archive/poc-readme]] §3 面板说明。

| 环节 | 现状（POC） | 为什么不是流式 |
| --- | --- | --- |
| 采集 | `mac_speech.swift` 被 robotd **每次调用 spawn 一次**，进程内部开 `AVAudioEngine` tap | 进程一次性退出；每次调用重启音频栈，无法「一直在听」 |
| 端点 | `auto_endpoint` 默认关；开了也不可用 | 系统 `SpeechDetector` 与 `SpeechTranscriber` 放同一条 analyzer **两边都收不到结果**（对照实验实测）；只能手动停或等 `--max-seconds` |
| ASR | `SpeechAnalyzer + SpeechTranscriber(.progressiveTranscription)`，会吐 partial | 文本是流式的，但**只有文本、没有说话人、没有可消费的时间轴**；partial 与 final 语义未在契约里区分 |
| 说话人 | 无 | 系统 ASR 不提供说话人分段/声纹；现在连「这是不是同一个人」都答不了 |
| TTS | `audio.speak` = `AVSpeechSynthesizer` 读整段，必须等 delegate 回调才返回 | 整段一次性合成、阻塞式；没有分句流水、没有播放队列 |
| 打断 | 无 | 播放与采集是**两个独立进程**，没有回声消除；机器人会把自己的声音当用户输入，barge-in 无从谈起 |
| 时间轴 | 无统一基准 | 音频、文本、说话人、视觉帧各自为政，无法对齐 |

**一句话**：现在的语音系统是「**一个函数调用**」，不是「**一条一直在跑的流水线**」。
要解决流式处理，改的是这条流水线的形态与边界，不是换一个 ASR 模型。

## 2. 「真正流式」的定义（先立验收口径）

不先说清「流式指什么」，验收就会退化成「听着还行」。本文采用以下可测量定义：

| 维度 | 非流式（现状） | 真正流式（目标） |
| --- | --- | --- |
| 首字延迟 | 与发言长度绑死（等录满 / 等结束） | 首个有效 partial 延迟**与发言长度无关**（5s 与 60s 发言应基本一致） |
| 最终延迟 | = 发言时长 + 整段识别 | 从「说完」到 final 只取决于**端点检测 + 尾段识别**，不随时长线性增长 |
| 端点 | 手动停 / 固定时长 | **说完自动收尾**（VAD 静音 + ASR 稳定 + 最短话长） |
| 输出 | 整段合成完再播 | **分句合成、边生成边播**，首包延迟与回答总长无关 |
| 打断 | 做不到 | 播放中用户开口 → 停止播放、清空队列、取消或标记当前回答（barge-in） |
| 说话人 | 无 | 句子级说话人标签，**允许先给、后修订**（标签可滞后但可收敛） |

> 判据提醒：把 5 秒音频切块反复喂给非流式模型，**不是**流式识别——它会造成重复文本与断句抖动。
> 验收必须用**真实连续音频**测首字/最终延迟，见 §11。

## 3. 目标架构：三层不变，第二层内部重划

### 3.1 分层与职责（对 [[architecture]] §1「职责边界判据」的推论，不新增规则）

```text
┌─ 第一层 Application ─────────────────────────────────────────────────────┐
│  Agent / Skill / Memory / Behavior（agentd；快速路由 + 可选 Codex Harness）│
│  · 只消费结构化事件（speech.*，含 speaker / tts），只调用能力              │
│  · 明确短指令先快速映射；复杂、多步、定时任务才交给 Harness 规划             │
│  · 不碰麦克风、不碰播放设备、不碰采样率（P4 粒度判据）                     │
└───────────────▲──────────────────────────────────────┬──────────────────┘
                 │ 事件（增量）                  │ 能力（robot_speak / motion.*）
┌───────────────┴──────────────────────────────────────▼──────────────────┐
│  第二层 Robot Runtime（robotd）                                           │
│  ┌ Runtime Core ─ 事件总线 · 会话/回合状态机 · 单调时间轴 · 仲裁 · 取消   │
│  ├ Audio Runtime        ← 本文主角（采集/端点/ASR/说话人/TTS/播放/打断）  │
│  ├ People Perception    ← 人物检测/跟踪/身份关联（与语音并行，§8）         │
│  ├ Motion & Navigation  ← 跟随/路径/速度/避障（已有）                      │
│  └ Device Runtime 适配  ← 串口 → ESP32（已有）                            │
└───────────────┬──────────────────────────────────────┬──────────────────┘
                │ 帧通道（二进制 PCM）                  │ 事件通道（NDJSON）
                ▼                                      ▼
   ┌────────────────────────┐        ┌───────────────────────────────────┐
   │ audio-bridge（Swift 常驻）│        │ speech 服务（modeld 内 / 独立 worker）│
   │ AVAudioEngine + 语音处理  │        │ VAD · 流式 ASR · 声纹分段 · TTS     │
   │ 采集↔播放同一音频图（AEC）│        │ （sherpa-onnx / 系统 ASR）           │
   └────────────────────────┘        └───────────────────────────────────┘
```

### 3.2 模块改动点

| 模块 | 现状 | 改造后 | 归属层 |
| --- | --- | --- | --- |
| 音频 I/O | 每次 spawn 的 `mac_speech.swift`（采集与播放分离） | **常驻 `audio-bridge`**：同一 `AVAudioEngine` 管采集+播放，开启语音处理（AEC/NS/AGC） | robotd 持有的原生常驻桥 |
| 语音会话 | 无（每次调用独立） | **Audio Runtime 会话/回合状态机**（utterance 生命周期、端点、打断仲裁） | robotd |
| 端点检测 | 系统 `SpeechDetector`（实测不可用） | **独立 VAD**（Silero / sherpa-onnx），输出 `speech_started/ended` | speech 服务 |
| ASR | 系统 `SpeechAnalyzer`（仅文本） | 增量文本 + **结果时间范围**；partial/final 契约化 | speech 服务 |
| 说话人 | 无 | 声纹嵌入 + 说话人分段/聚类，**与 ASR 并行** | speech 服务 |
| TTS | 整段阻塞合成 | **分句流式**合成 + 有界播放队列 + 可取消 | speech 服务 + audio-bridge |
| 事件面 | `speech.partial` / `speech.final`（由 `audio.*` 别名映射） | `speech.*` 事件族（含 speaker / tts / interrupted）+ 单调时间戳 | robotd Runtime Core |
| Agent 接口 | `speech_listen`（流式听，手动停）/ `robot_speak`（整段说） | `speech_listen` + `robot_speak` + `task_cancel`；**语义升级、不新增冗余能力** | 第一层 |

> **进程边界纪律（沿用 [[architecture]] §6.5）**：不因为本文新增一个顶层 daemon。
> `audio-bridge` 是 robotd 持有的**常驻原生桥**（类比 `serial-bridge.py`：只有原生才能做，所以独立进程、
> 由 robotd spawn、崩溃自动重启）；语音模型推理放进 `modeld`（它本来就是模型 daemon），
> 若实测发现 onnxruntime 与 MLX 共存不稳，再考虑拆出独立 `speechd`（列为待确认项，见 §12）。

## 4. 流式输入管线（本文重点）

### 4.1 数据流

```text
麦克风(USB/UAC)
  │  AVAudioEngine tap（硬件原生采样率，如 48kHz）
  ▼
音频前端：AEC 回声消除 · NS 降噪 · AGC 增益        ← 在 audio-bridge 内，与播放同图
  ▼
重采样 → 16kHz / mono / Int16                        ← ASR 与 VAD 要的格式
  ▼
环形缓冲（带单调时间戳 ring buffer，保留最近 N 秒）
  ├──────────────► VAD（Silero）──► speech_started / speech_ended（端点）
  │                                        │
  │                                        ▼
  └──────────────► 流式 ASR（增量）──► speech.partial(revision) / speech.final
                          ∥（并行，不等 ASR 结束）
                  说话人分析（声纹嵌入 / 分段聚类）──► speech.speaker_segment / speech.speaker_resolved
  ▼
Speaker-aware Transcript（文本 + 时间范围 + 说话人标签 + 置信度）
  ▼
Robot Runtime 事件总线 ──► Agent / 面板
```

### 4.2 关键设计点

1. **采集不能被推理阻塞。** 音频帧走独立的**二进制帧通道**（长度前缀 + 序号，不用 Base64 塞 JSON），
   控制事件走 NDJSON。音频丢一下不能卡住整条链路：ring buffer 满时**丢最旧**，并记 `audio.frame_drop`。
2. **统一单调时间轴。** 全部事件带 `ts_mono_ns`（`mach_absolute_time` 派生，同一时间域）；
   墙钟只用于日志展示。跨进程比较与说话人/视觉对齐**只用单调时间**。
3. **VAD 与 ASR 解耦。** VAD 负责「什么时候有人说话、说到哪结束」；ASR 只负责「说了什么」。
   二者独立，才能把端点检测换成可用的模型，而不受系统 `SpeechDetector` 冲突拖累。
4. **端点检测（说完自动收尾）策略**：`VAD 静音 ≥ 600~800ms` **且** `ASR 文本在静音期内无新增`
   **且** `utterance 已 ≥ 最短话长` → 判 final。纯静音永不触发；用户插话（新的 speech_started）立即结束当前回合。
   这些阈值要可配置并实测（短句、长句、停顿、口头语各测一遍）。
5. **partial / final 语义分开。** `speech.partial` 明确可修订（带 `revision`），`speech.final` 默认冻结；
   若后续模型确实要改 final，必须发**显式修订事件**，不允许悄悄覆盖已有文本。
6. **说话人标签允许后到。** 说话人分段通常比 ASR 结果慢，允许先给 `speaker_id:"unknown"`，
   随后补 `speech.speaker_segment` / `speech.speaker_resolved` **修订**同一 `utterance_id`。
   系统 ASR 的识别结果自带**时间范围**，用它把「文本片段」与「说话人片段」按时间对齐。
7. **长会话可用。** 不允许「一条识别任务永远挂在一次 spawn 里」——常听意味着会话可以持续数小时；
   桥与 speech 服务都要有**周期性提交/回收**与健康检查（避免某个已实测的「攒到结束才吐」类问题复发）。

## 5. 流式输出管线与打断（输入的另一半）

### 5.1 数据流

```text
Agent / LLM（流式 token）
  ▼
文本缓冲 & 分句（标点优先 + 最长字符数上限 + 最短可播长度）
  ▼
TTS 合成（先按句合成；进一步可换流式 chunk 合成）
  ▼
有界播放队列（满则按策略丢 oldest；保证「说话尽量完整」与「不无限积压」平衡）
  ▼
audio-bridge 播放（与采集同一音频图 → AEC 生效）
  ▼
speech.tts_started / speech.tts_chunk / speech.tts_finished 事件
```

### 5.2 关键设计点

1. **TTS 与输入共享一个 AEC 音频图**。这是 barge-in 的前提——否则麦克风会把机器人自己的声音
   判成「用户在说话」，一开口就把自己打断。**这一条决定了 `audio-bridge` 必须常驻且采集/播放同进程。**
2. **分句不要太晚也不要太碎。** 太晚会退化成「整段生成完才播」；太碎会破坏韵律。
   规则：遇到句末标点即切；无标点时达到「最长字符数」强制切；同时设「最短可播长度」避免单字碎句。
3. **打断是一个仲裁动作，只能有一个仲裁点。** 由 Audio Runtime 统一决定：
   `VAD speech_started`（AEC 后残留能量真属用户）且 `tts 正在播放` → 立刻
   ① `speech.tts_cancelled`、② 清空未播队列、③ 发 `speech.interrupted`、④ 当前回答标记为「被中断」。
   决策放一处，避免 ASR/TTS/Agent 各自抢着停。
4. **回声门控（在 AEC 之上的兜底）**：播放期间提高 VAD 阈值 / 用 AEC 后的残余能量判断，
   并把「播放期自听误触发率」纳入验收（见 §11）。
5. **播放侧也不阻塞 Agent**。`robot_speak` 返回的是**任务句柄**（`accepted` + `task_id`），
   Agent 不等待播音结束；结束时由 `speech.tts_finished` 事件通知（待新增）。

## 6. 事件与接口契约（在现有四类契约上扩充）

契约仍是 Capability / State / Task / Event 四类（[[communication-protocol]] §6），只**新增语音事件族**。

**现有信封（已落地；当前实现见 `robotd/src/robotd/core/types.py`，最初取自已删除的 TS POC
`src/transport/http-server.ts`）**——本方案**沿用**它，不另造：

```jsonc
{ "version": 1,
  "type": "speech.partial",                    // 内部事件名经别名映射（audio.partial → speech.partial）
  "event_id": "evt_128",
  "seq": 128,                                  // 单调序号；WS 支持 subscribe / resume_from_seq 补发
  "timestamp": "2026-10-13T07:30:00.000Z",     // 墙钟（ISO）
  "payload": { "task_id": "t-...", "text": "向前走", "t_ms": 1200 } }
```

> **契约单一来源（2026-10-13 起）**：runtime 已拆为 `runtime/`（能力与状态真相）+ `transport/`
> （HTTP/WS 收口），对外能力与事件由 `contracts/openapi.yaml` 定义并生成 MCP 工具面与 TS 类型。
> 本方案新增的 **Capability（`speech.*`）与事件族必须先改 `contracts/openapi.yaml`**
> （含 `x-requires-approval` 等扩展字段），再改 runtime 与面板——**不允许任何一方各自定义**，
> 否则就回到契约漂移（[[communication-protocol]] R7）。现有对应项：`/v1/speech/listen`
> （流式听，结果经 `/v1/events` 推）与 `/v1/robot/speak`（TTS，受理为可取消任务）。

**要在这个信封上补的字段**（流式 + 多人所需）：

- 顶层 `ts_mono_ns`：音频、说话人、视觉对齐**只用单调时钟**，`timestamp` 只做展示；
- payload 里 `utterance_id` + `revision`（partial 可修订、final 冻结）+ `time_range`。

**事件命名对齐**（`V1_SUPPORTED_TYPES` 已预留 `speech.* / people.* / person.*`，**没有** `audio.*` / `speaker.*`）：

| 事件（对齐后的公共名） | 关键字段 | 用途 | 现状 |
| --- | --- | --- | --- |
| `speech.ready` | `locale, source, auto_endpoint, trigger` | 会话就绪；`trigger=api/auto` 区分显式 listen 与自动开轮 | ✅ 已落地（GH-9 加 `trigger`） |
| `speech.started` / `speech.speech_ended` | `utterance_id, trigger, rms_db, audio_ms` | VAD 判「开始说 / 说完了」 | ✅ 已落地（能量 VAD） |
| `speech.gate` | `utterance_id, decision, reason, db, aec_erle_db, threshold_db` | 播报期间 VAD 上升是否放行打断（robotd 的 AudioRuntime 单点判定；pass 与 suppressed 都发） | ✅ 已落地（GH-5 / V02） |
| `speech.partial` | `task_id, utterance_id, revision, text, audio_start_ms/end_ms` | 增量文本（可修订） | ✅ 已落地 |
| `speech.final` | `task_id, utterance_id, text, stop_reason` | 最终文本（默认冻结） | ✅ 已落地 |
| `speech.ignored` | `utterance_id, reason, run_id?` | 这一轮被丢弃（`busy` / `echo` / `empty` / `speaking`），让时间线有分母 | ✅ 已落地（GH-7；`speaking` 由 GH-9 真正产生） |
| `speech.speaker_segment` / `speech.speaker_resolved` | `segment_id, utterance_id, speaker_id, start_ms, end_ms, confidence` | 说话人分段 / 身份后置解析 | 待新增（或走 `people.*`） |
| `speech.tts_started` / `speech.tts_chunk_started` / `speech.tts_chunk_finished` / `speech.tts_finished` / `speech.tts_cancelled` | `response_id, index, reason` | 播放进度与控制 | ✅ 已落地（`speak-stream`） |
| `speech.interrupted` | `response_id, task_id, reason` | 用户打断机器人（barge-in） | ✅ 已落地（单点仲裁） |
| `speech.endpoint` | `utterance_id, speech_ms, silence_ms, reason` | 端点判定结果 | ✅ 已落地 |
| `audio.frame` / `audio.frame_drop` | `stream_id, seq, sample_rate, channels, samples` | 二进制帧通道（不进事件总线） | 待新增（常驻桥时再做） |

> 命名冲突**已解决**：此前 `speech.started` 被当成「流已就绪」（`audio.stream_ready` 的别名），
> 与「检测到有人开始说话」混为一谈；现在拆成 `speech.ready`（麦克风/会话就绪）与 `speech.started`
> （VAD 判到有人开口）。订阅方可以只看 `speech.ready` 判断链路，只看 `speech.started` 判断有人说话。

**Capability 面对齐**：契约生成的 MCP 工具今天只有 **8 个**——`robot_health` / `robot_state` /
`robot_speak` / `robot_follow` / `robot_stop` / `speech_listen` / `task_get` / `task_cancel`。
`audio.list` / `audio.listen` / `audio.stream` / `vision.*` / `nav.*` 等旧能力已退到 `/v1/debug/*`
旁路（面板用，不进 Agent 面）。本方案落地的映射：

| 本方案原拟能力 | 重构后的落点 | 说明 |
| --- | --- | --- |
| `audio.session`（会话化听） | `POST /v1/speech/listen` | 返回 task + `speech.*` 事件；端点自动收尾待补 |
| `audio.listen`（一次性听） | `/v1/debug/call`（旁路） | 面板 / 脚本用，不进 Agent 面 |
| `audio.speak` 升级 | `POST /v1/robot/speak` | 已返回 task（可查询 / 取消）；`interruptible` 已生效（barge-in 依赖它） |
| `audio.cancel` / 打断 | `DELETE /v1/tasks/{task_id}` + `POST /v1/robot/stop` | 已有；缺「VAD 触发」这一路 |

> 边界不变：Agent 只能看到「听/说/打断」这类**语义能力**，看不到采样率、设备、VAD 阈值
> （P4 粒度判据）；设备级调试仍走面板的**调试旁路**（P5）。

## 7. 多人说话：在流式基础上并行补上

用户需求「识别周围不同的人、按音色区分是谁在说」对应**两个不同能力**，不能混为一谈：

| 能力 | 解决什么 | 本方案 |
| --- | --- | --- |
| VAD | 什么时候有人在说 | 必需，§4 |
| Speaker Diarization（说话人分段） | 一段对话里谁在什么时候说（A→B→A） | M2，与 ASR 并行 |
| Speaker Identification（声纹身份） | 这个人是不是已登记的某个人 | **V1 不做持久库**；只做会话内临时 ID |
| 语音分离（重叠说话） | 两句话叠在一起分别听清 | **非目标**（单麦做不到；需多通道/声源定位） |

目标结构化结果（说话人标签可后置修订，未定则 `unknown`）：

```jsonc
{ "utterance_id": "utt-007",
  "segments": [
    { "start_ms": 0,    "end_ms": 1800, "speaker_id": "spk_1", "text": "你好。",       "confidence": 0.86 },
    { "start_ms": 1800, "end_ms": 3000, "speaker_id": "spk_2", "text": "你在干什么？", "confidence": 0.81 },
    { "start_ms": 3000, "end_ms": 4000, "speaker_id": "spk_1", "text": "我在测试机器人。","confidence": 0.88 }
  ] }
```

**硬约束（先说清上限）**：单个普通 USB 麦克风**不应被假设**能完美处理多人重叠说话。
第一版把目标限定为「**轮流发言场景下稳定区分不同的人**」；重叠语音、鸡尾酒会场景列为已知局限。

## 8. 人物感知与「声音↔人脸」关联（接口预留，V1 从简）

人物识别和说话人识别是**两个独立子系统**，由 Runtime 做关联，不合并成一次大模型调用：

- **阶段 A（同场景区分，M3）**：摄像头检测人 → 跨帧分配稳定 `track_id`；音频给出 `speaker_id`；
  两者各自带时间戳，先保证机器人能稳定地把「画面里两个人」「声音里两个人」分开。
- **阶段 B（跨模态关联，后续）**：在人物**轮流说话**的时间窗内，结合「谁在场 / 谁在动 / 可选口型线索」
  推断 `speaker_id ↔ track_id`；证据不足时**保持 unknown**，不强行绑定。

> 明确区分：人物跟踪 ≠ 人脸识别；人脸识别 ≠ 说话人识别。用户当前目标只是「区分不同的人、不认姓名」，
> 因此**不建人脸特征库与声纹注册库**；`spk_1` 只是**当前会话**的临时标签，会话结束可清理。

## 9. 模型 / 服务选型（只列与「流式」相关的取舍）

| 子系统 | V1 推荐 | 备选 / 后续 | 选型理由（与流式相关） |
| --- | --- | --- | --- |
| 音频 I/O | **AVAudioEngine + 语音处理**（AEC/NS/AGC） | — | 采集与播放同一音频图，是 barge-in 的前提 |
| VAD / 端点 | **sherpa-onnx 的 Silero VAD**（ONNX，~1MB，MIT） | 能量+文本变化启发式（兜底） | 系统 `SpeechDetector` 同 analyzer 冲突（已实测）；独立 VAD 才能自动断句 |
| 流式 ASR | **方案 A：保留系统 `SpeechAnalyzer`**（有 partial、有结果时间范围；`zh_CN` 资产已装、已实测） | 方案 B：sherpa-onnx 流式 ASR（完全可控、与 VAD/声纹同栈） | A 复用已验证能力、风险最低；接口留好以便随时切 B |
| 说话人分段 | **sherpa-onnx**（pyannote 分段 + 声纹嵌入，如 3D-Speaker/WeSpeaker） | — | 与 ASR 并行，输出 `speaker_id`；离线整段模型需处理器改成**滚动/分段**使用（待核实） |
| TTS | **系统 `AVSpeechSynthesizer` 分句流水**（19 个中文音色，已验证） | sherpa-onnx 流式 TTS（VITS / Kokoro / Matcha） | 先把「分句 + 队列 + 打断」跑通；首包/自然度不达标再换流式 TTS |
| 语音分离 | 不做 | 多通道麦 / 声源定位 | 超范围，见 §7 |

> 选型原则（延续 [[model-selection]] §1「只选一种、先做通」）：**先不绑定**，把事件接口定死，
> 让「换 ASR / 换 TTS」只是换 speech 服务里的一个实现，不动 Runtime 与 Agent。

## 10. 里程碑（以流式为主线）

- **M1 — 流式闭环（不接 Agent、不接摄像头）**
  - 常驻 `audio-bridge`：采集+播放同图、AEC、16k 帧流、单调时间戳；
  - 独立 VAD 端点检测：说完自动收尾（替代不可用的 `SpeechDetector`）；
  - 流式 ASR partial/final 契约化（先保留系统 ASR）；
  - TTS 分句流式 + 有界队列 + `speech.tts_cancelled` + **barge-in**；
  - 统一事件族 + 会话状态机；面板「语音」页显示实时 partial / 端点 / 播放 / 打断。
- **M2 — 多人说话**
  - 说话人分段/声纹嵌入与 ASR **并行**；`speech.speaker_segment` / `speech.speaker_resolved`；
  - 说话人标签后置修订；两人轮流 / 相近音色 / 插话三组数据验证。
- **M3 — 接入 Agent 与人物**
  - 语音事件接入 Application：明确短指令走 agentd 快速路由，复杂/多步/定时请求再交 Harness；
  - 快速路由不得猜测缺失参数或绕过工具审批；Agent 只消费事件、调用能力；
  - 摄像头人物跟踪 `track_id`，与 `speaker_id` 做阶段 A 关联（可选阶段 B）。

> 与既有里程碑的关系：本方案落在 [[architecture]] §12 的 **S5（音频）** 之前/并行，
> 是 S5 的**升级版**（把「接系统 ASR/TTS 桥」扩成「流式语音 Runtime」）。

## 11. 验收指标（含「是否真流式」的判据）

> 门槛值为**建议初始值**，不是当前已达成；所有指标以真实连续音频、带人工标注的测试集为准。

| 指标 | 建议门槛 | 怎么测 |
| --- | --- | --- |
| 采集连续性 | 30 分钟无非预期断流 | 检查帧序号、丢帧、设备错误 |
| 中文 ASR 质量 | CER ≤ 10%（安静场景） | 人工标注语料 |
| **首字延迟（与句长无关）** | P95 ≤ 800ms | 5s 与 60s 发言各测，验证延迟不随时长增长 |
| ASR 最终延迟 | 说完 → final P95 ≤ 1.5s | 端点检测 + 尾段识别 |
| **端点检测** | 说完自动收尾，误切/漏切率低 | 短句/长句/停顿/口头语各 20–30 条 |
| TTS 首包 | P95 ≤ 800ms | 提交文本 → 播放首帧（分句生效后与回答总长无关） |
| **打断响应（barge-in）** | P95 ≤ 300ms | 播放中开口 → 停止播放的时延 |
| 自听误触发率 | 连续播放 30 分钟，`speech.gate{decision:"pass"}` = 0 | 统计 `speech.gate` 的 pass/suppressed（B1 即其测试载体） |
| 说话人归属 | 两人轮流 ≥ 95% | 人工标注片段；单独统计 unknown（防刷分） |
| 人物跟踪 | 30 分钟无严重 ID 抖动 | 人工标注轨迹、统计 ID switch |
| 运动安全 | 通信丢失后按超时停机 | 已有看门狗，改造不应回归 |

**测试数据集（先各备 20–30 分钟带标注）**：
A 单人中文（远近/长短/停顿）；B 两人轮流（不同性别、相近音色、插话）；
C 重叠语音 + 机器人自身播放（验 AEC/打断）；D 人物移动（交叉、离开、重入）。

## 12. 风险与待确认

| # | 风险 / 未知 | 影响 | 处置 |
| --- | --- | --- | --- |
| R1 | 系统 ASR 结果的**时间范围**是否稳定可用于与说话人分段对齐 | 直接决定「文本×说话人」能否合并 | M1 先实测；不行则只能按回合近似对齐，或切方案 B |
| R2 | `AVAudioEngine` 语音处理（AEC）与 ASR 采样率不一致（如 48k vs 16k） | 需要重采样，处理不好有延迟/失真 | 桥内做高质量重采样；实测端到端时延 |
| R3 | sherpa-onnx 的**在线**说话人分段能力（很多 diarization 是离线整段） | 决定 M2 能否真「流式」 | 需实测其在线/滚动模式；不行则退回「按 utterance 分段后再嵌入聚类」 |
| R4 | 单麦多人重叠语音 | 上限受限 | 已列为已知局限，不做语音分离 |
| R5 | 长会话稳定性（数小时连续采集/识别） | 影响「一直在听」 | 周期提交/回收 + 健康检查；压测 |
| R6 | onnxruntime 与 MLX 同在 modeld 是否互相拖累（内存/延迟） | 影响是否要拆 `speechd` | 先合后分：实测不稳再拆独立进程 |
| R7 | 系统 ASR 在长时间任务上的行为（是否有隐藏时长限制） | 影响常听 | 长跑压测 |

**待用户确认的取舍**（未回复则按推荐默认推进）：

1. ASR 路线：**先 A（系统 ASR）** 还是直接 B（sherpa-onnx 流式）？默认 A（复用已验证能力）。
2. 是否接受为流式引入**常驻原生桥**（比现在多一个常驻进程）？默认接受——这是 AEC/打断的前提。
3. TTS 先用系统合成（分句流水）还是直接上神经流式 TTS？默认先用系统，按首包/自然度再定。

## 13. 实现记录（2026-10-13：听 / 说的流式已落地）

> 另一台机器上没装硬件、只做了工程化重构；本机把**流式部分补齐并用离线夹具跑通了回归**。

| 环节 | 实现 | 证据 |
| --- | --- | --- |
| 端点检测 | 桥内自带**能量 VAD**（RMS + 迟滞 + 最短话长），不再用与 transcriber 冲突的系统 `SpeechDetector`；`stream` 默认说完自动收尾（`--no-auto-endpoint` 可关） | ~~`swift scripts/mac_speech.swift vad-selftest`~~ → `ok:true`（⚠️ 脚本随 POC 删除；结论为当时实测） |
| 流式输入 | `speech.ready / speech.started / speech.partial(revision,audio_ms) / speech.speech_ended / speech.endpoint / speech.final(stop_reason)`，每条带 `ts_mono_ns`；新增 `--file` 让整条听链路可离线复现 | `src/tools/speech_test.ts` B1–B8 |
| 流式输出 | 新 `speak-stream`：stdin 收句子块 → 顺序播 → `speech.tts_started / tts_chunk_started / tts_chunk_finished / tts_finished`；`stop` 立即取消 → `tts_cancelled` | 同上 A1–A5 |
| 打断（barge-in） | 听/说拆成两个**软任务槽**（可并存），听检测到人开口 → 单点仲裁 `speech.interrupted` → 取消播报任务 | 同上 C1–C4 |
| 单调时间轴 | `monoNs()`（`process.hrtime.bigint()`；桥用 `mach_absolute_time`），事件带 `ts_mono_ns` | B8 |
| 测试夹具 | `scripts/speech_fixture.swift`：合成「静音 + 语音 + 静音」CAF，离线测端点（⚠️ 脚本随 POC 删除） | ~~`npm run speech:fixture`~~（已随 POC 删除） |

**顺带修掉一个重构遗留 bug**：`src/runtime/robot-runtime.ts` 里的相对路径锚点还是 `poc/` 时代的——
`ROOT` / `CAMERA_TOOL` / `SPEECH_TOOL` / `serial-bridge.py` 全指向了不存在的 `src/scripts/...`，
等于重构后**相机、语音、串口三条链都起不来**（另一台机器没硬件，没暴露）。已按新目录修正，
并加了注释提醒「改目录结构时这几条要一起动」。

**怎么复现**（⚠️ 以下命令随 POC 于 2026-10-23 删除，`scripts/mac_speech.swift`、
`scripts/speech_fixture.swift`、`src/tools/speech_test.ts` 均已不在仓库；本节保留的是
**当时的取证方式**，不是当前可执行的命令。语音链路重新落地时以新实现为准）：

```bash
cd <wallyd-root>
npm run speech:vad       # 端点逻辑离线自测
npm run speech:fixture   # 生成测试音频 → work/eval/speech/zh_short.caf
npm run speech:test      # 17 项：说 5 + 听 8 + 打断 4
```

**还没做**（明确留白，别当成已完成）：

- **常驻 audio-bridge**：仍是「每次调用 spawn 桥」（已改用编译好的二进制，省掉每次重编译）。
  采集/播放仍不在同一个音频图里，AEC 靠系统语音处理（见下）。
- **说话人分段 / 声纹**（§7）：未实现；事件名与槽位按 `speech.*` 预留。
- `openapi.yaml` 里事件族的文字说明待补（本机没有 npm 依赖，`contract:generate` 跑不了；
  本次只把 `auto_endpoint` 默认值与 summary 按生成格式同步改到了三个生成物）。

### 13.1 真机实测（2026-10-13：Mac mini M4 + HDI Webcam 麦 + Mac mini 内置喇叭 + ESP32-S3）

> **2026-10-14 真机又抓出三个坑（都已修）**：
> 1. **面板显示几十个 `u`**：房间本底噪声峰值到 -31dB、高于默认说话门限 -36dB ⇒ VAD 认为"一直在说"、
>    **永不触发端点**（实测有个 listen 跑了 198s），低延迟流式 ASR 就在噪声上吐元音幻觉。
>    修：①开录先量 600ms 本底并把门限抬上去（`vad_calibrated` 事件会回传门限）；②**partial 只在 VAD 判出的
>    说话窗口内上报**（按音频时间轴比对，不是布尔标志——文件模式灌得快，布尔会把正常 partial 也挡掉）；
>    ③加 `--idle-timeout`（默认 20s：一直没人说话就收尾），不再有挂死的 listen。
> 2. **robotd 被一次重复 listen 打崩**：`openapi-backend` 不接 async handler 的 rejection，而 Node 24 把
>    未处理 rejection 当致命错误 ⇒ 进程直接退出（日志见 `code: 'E_BUSY' … at OpenAPIBackend.handleRequest`）。
>    修：所有 `/v1` handler 包一层 `guard()`（异常转 409/400 JSON），并加 `process.on('unhandledRejection'/'uncaughtException')`
>    只记日志不退出——常驻 Runtime 静默退出等于整机失控。
> 3. **面板「开始听」拿不到麦克风**：它走的是调试旁路 `audio.stream`（吃"独占任务"那把锁），被别的任务占住就
>    E_BUSY。修：面板改走公共 `/v1/speech/listen`（和 Agent 同一条路、用软任务槽），并且**开始前先 `stop`**
>    清掉上一条（听同一时刻只能有一个）。
>
> **顺带量到的硬事实**：这颗 HDI Webcam 麦上，人声 20ms 帧的 p50=-44dB、p95=-34dB、max=-26dB，
> 只有约 9% 的帧超过 -36dB —— **信噪比只有 5–10dB**。增益（+12/+20dB）不改善识别，因为 SNR 没变。
> 结论：**要识别得好，得先把麦克风端搞上去**（靠近说话 / 提高系统输入音量 / 换指向性更好的麦），
> 光靠软件调门限只能在"能触发"和"不误触发"之间挪。

目标机实测环境：麦克风授权 `authorized`、`zh_CN` 资产 `installed`、20 个中文音色、
默认输入 = `HDI Webcam USB`、默认输出 = `Mac mini Speakers`。板子是真板（`transport=serial`，`fw=poc-2.0`，L/R 驱动都报在）。

**真机不只验证，还抓出两个只有上硬件才暴露的问题：**

1. **`speak-stream` 的竞态（已修）**：第一轮真机测试里机器人**一个字都没播**——
   `tts_finished {chunks:0, played:0}` 却在 1ms 内"成功"结束。根因：读线程读到 `end` 时，
   前面几块的 `DispatchQueue.main.async` 还没跑，于是 `finishedCount(0) >= queued(0)` 成立、
   直接收尾退出。修法：加 `declared` 计数，**读线程一收到块就同步 +1**，收尾只看 `declared`。
   修后实测 `chunks:2, played:2`，两块真实播放 1.55s + 2.62s。
2. **VAD 起判去抖（已加）**：默认门限 `-36dB` 下，房间本底噪声（实测 `rms≈-34.6dB`）单帧就触发假起点。
   加「连续 3 个 20ms 子帧过门限才算开始」去抖后不再误判。

**AEC 是打断的前提（实测证据）**：

| 条件 | 结果 |
| --- | --- |
| **不开 AEC** | 机器人开播 0.7s 后，麦克风收到**自己的声音**（`rms_db=-11.5`，房间本底 `-34.6`）→ `speech.started` → `speech.interrupted` → 自己把自己打断（`task.cancelled`） |
| **开 AEC** | 同一段 8.4s 连续播报全程 `played:1`、**无 `speech.started`、无打断**；默认设置（AEC 默认开）再测一次同样通过 |

结论：**能量门限区分不了自听**（自己的播放比人声还响），只能靠 AEC。因此 `--speech-aec` 已改为**默认开**
（`--no-speech-aec` 可关）——不开的时候 barge-in 必然误触发，等于没用。

**其它真机数据**：真 TTS 11 字 → 2976ms 实际播放（不是早期那个 26ms 的假完成）；
真麦 partial 实时到达（1.26s / 2.84s / 4.44s…，`audio_start_ms` 随真实音频推进）；
说完自动收尾在真麦上同样成立（`endpoint {silence_ms≈710}`）。

⚠️ **一个消费侧注意**：真机上出现过「没有 `speech.started`、但 ASR 吐了 `speech.partial`（"o"/"ou"）」，
即 volatile 结果会对非语音瞎给字。**上层应以 `speech.final`（以及 `speech.started` 之后的片段）为准**，
不要把每条 partial 都当用户输入。

**编译桥（省掉每次重编译）**：~~`npm run speech:build`~~ → `work/bin/mac_speech`，
再把 `--speech-bin` 指向它即可（⚠️ 该 npm 命令与 `--speech-bin` 参数都已随 POC 删除，
语音桥尚未在 Python robotd 中重新落地）。
runtime 已自动区分「解释器（swift + .swift 路径）」与「编译好的二进制（直接可执行）」两种形态，两者都支持。

## 14. 实现记录（2026-10-24：语音在 Python robotd 中重新落地）

> 2026-10-23 的 POC 清理删掉了 Node 时代的语音接线；本节记录**重新落进 Python robotd** 的部分。
> 实测原文与原始数据见 [`eval/r14-voice-bringup-2026-10-24.md`](../eval/r14-voice-bringup-2026-10-24.md)。

### 14.1 结构：桥 + 运行时 + 订阅桥

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 桥进程管理 | `robotd/src/robotd/devices/audio_bridge.py` | 构建/启动 `AudioBridge.app`、FIFO(stdin) 发命令、文件(stdout) 收事件、就绪判定 |
| 契约翻译 | `robotd/src/robotd/core/audio_runtime.py` | 桥的原始事件 → `speech.*` / `audio.state`；utterance 生命周期、单选仲裁、静音守门 |
| 上游订阅 | `agentd/src/agentd/robotd-events.ts` | agentd → robotd `WS /v1/events` 的常驻订阅（断线留痕、游标补发） |
| 语义翻译 | `agentd/src/agentd/robotd-event-bridge.ts` | robotd 事件 → agentd 事件库（只落节点性事件，不做意图解析） |

### 14.2 桥必须以 `.app` + LaunchServices 启动（不是工程偏好，是 TCC 硬约束）

macOS 按**责任进程**（responsible process）而不是「谁 spawn 了它」判麦克风权限。
终端直接 spawn 出的二进制，权限记在终端（这里是 OpenCode）名下，于是：

- 崩溃报告里 `Responsible Process: OpenCode [1062]`；
- 改 `Info.plist`、改语言、把 `NSMicrophoneUsageDescription` 嵌进 `__info_plist` 都无效。

改成固定 bundle id 的 `.app`、由 `open -a` 经 LaunchServices 启动后，`speech_auth_raw=3`、
`mic_access=true`、`zh_CN` onDevice=true，麦克风授权通过。

**代价**：adhoc 签名按 CDHash 识别，**改 Swift 代码并重签即失权**，必须重新
`open -a … --args request-permission` 并在系统弹窗点允许（本机无可用的 Developer ID）。
详见 [ADR-0011](decisions/0011-audio-bridge-app-bundle-tcc.md)。

### 14.3 已实测跑通

- **TTS 分句播报**：3 句 → 3 个 chunk → `speech.tts_finished {chunks:3, played:3}`，任务 `completed`。
- **ASR 全链路**：`speech.ready` → `speech.started`(rms -31.1) → 18 条 `speech.partial`(revision 1→18)
  → `speech.endpoint`(speech_ms 3966 / silence_ms 710) → `speech.final`。
- **上游订阅**：agentd 侧 `state: live`、19 个过滤器、`verdict: ok`；播报后事件库里出现
  `speech.spoken`「播报了 2 句（实际播出 2 句）」，来源 `robotd`。

### 14.4 修掉的两个缺陷（都是实测才暴露）

1. **订阅过滤字段名与契约不符**：契约 `WsClientMessage.subscribe` 要求 `event_types`
   （`contracts/openapi.yaml` 988/993 行），实现读的是 `types` ⇒ 按契约写的客户端过滤失效、
   退化成「订阅全部」。已改为以 `event_types` 为准，`types` 保留为兼容别名；缺字段明确报
   `E_VALIDATION` 而不是默默订阅全部。
2. **静音守门漏了显式 `speech/listen`**：静音只拦住了自动切句，`POST /v1/speech/listen`
   照常执行，实测静音后仍产生识别文本（"你喜欢气"），违反 R14「静音期间不产生新的识别结果」。
   守门已下移到 `AudioRuntime.new_utterance`（所有入口都经过它），HTTP 层对静音返回
   **409 `E_STATE`** 而不是「依赖不可用」——静音是用户的选择，不是故障。
   回归用例：`robotd/tests/unit/test_audio_runtime.py`。

### 14.5 已知限制（明确留白）

- **barge-in 的判定侧已落地（GH-5 / V02）**，整机可用性仍受 AEC 限制（详见 §14.6 与
  [`design/GH-5.md`](design/GH-5.md)）：
  - 已修：播报改走本 engine 的 `AVAudioPlayerNode`（§14.4），不再依赖 `synth.speak()`。
  - 已改：桥删除 `suppressAuto`，播报期间**照常跑 VAD** 并如实上报 `rms_db` / `render_db` /
    `aec_erle_db`；判定收口到 robotd 的 `AudioRuntime`，每次 VAD 上升都产 `speech.gate`。
  - 仍不够：VPIO 实测只有 **12–14 dB** 抑制，回声残留相对本底 **+19.2 dB（中位）/ +26.9 dB（最坏）**。
    V03（GH-6）已按 AEC3 离线证据把默认门限收窄为 `erle_margin = 15 dB`、ERLE 可用性底线
    20 dB，并允许配置文件 / 环境变量覆盖（`GET /v1/audio/state` 回显生效值）——
    **真实打断 P95、30 分钟误触发率与 AEC3 CPU 仍是 `pending-hardware`**；
    当前单元测试证明的是判定逻辑、门限来源与事件面。
  - 契约已有「停止播报」路径（`stop_speak`）；打断由 `AudioRuntime` 在 gate pass 时立即执行。
  - 实测数据见 [`eval/r14-voice-bringup-2026-10-24.md`](../eval/r14-voice-bringup-2026-10-24.md) §5.6。
- **说话人分段 / 声纹**（§7）未实现。
- 事件库只落**节点性**事件：`speech.partial`、`audio.state` 每秒十几条，故意不入库，
  否则时间线会被淹没；需要时按需拉 `/v1/audio/state`。

### 14.6 AEC 路线：VPIO 不达标，改用 AEC3 + 软件分叉参考（2026-10-30）

#### 问题定性

barge-in 的前提是「播报期间仍能听清人声」。这要求回声残留低于人声门限并有安全余量。
VPIO 在真实场景（USB 麦 + 内置喇叭 + 房间）只做到 12–14 dB 抑制，**不达标**。

#### 为什么 VPIO 不够：参考信号不由我们掌握

对照 xiaozhi-esp32 的实现（`work/refs/xz/afe.cc`、`box_audio_codec.cc`）：

```cpp
// 硬件回采：功放输出直接接回 ADC 通道
input_reference_ = input_reference;
input_channels_ = input_reference_ ? 2 : 1;      // 有参考 → 2 通道输入
afe_config->aec_mode    = AEC_MODE_FD_LOW_COST;
afe_config->aec_nlp_level = AEC_NLP_LEVEL_VERYAGGR;
```

小智的关键不是算法更强（ESP32 算力远不如 Mac mini），而是**参考信号是确定性的**：
AEC 面对的只有「喇叭 → 麦克风」这一段物理路径。Apple 的 VPIO 没有这种回采，
参考只能从 I/O 链路**推断**，中间隔着系统混音、音量控制、输出设备非线性。

WebRTC 官方集成文档的表述与此一致：

> *The reference / render signal the far-end audio **BEFORE any mixing** — feed it correctly.
> **#1 cause of WebRTC echo is a broken or fed-back reference wire, not a weak algorithm.***

#### 决策：软件分叉参考 + WebRTC AEC3

```
播放路径 ──┬──> 扬声器
           └──> AEC3.AnalyzeRender()   ← 同一份 PCM，不经过任何混音
                       ↓
麦克风 ──────────> AEC3.ProcessCapture() ──> 去回声后的人声 ──> VAD
```

与硬件回采在语义上等价，但**更可控**：参考是我们自己写的，不依赖设备内部实现。
这也天然符合「AEC 与 VAD 分开」的分层——AEC 是独立可替换层，VAD 只吃电平。

#### 离线验证结果（同一份真实录音）

| 指标（回声期间） | VPIO | **AEC3** |
| --- | --- | --- |
| 中位 ERLE | +14.3 dB | **+45.2 dB** |
| P10 | — | +31.2 dB |
| 最坏单窗 | +12.4 dB | **+28.5 dB** |
| 收敛时间 | — | 无 |

结论：**离线成立**。数据见 [`eval/r14-voice-bringup-2026-10-24.md`](../eval/r14-voice-bringup-2026-10-24.md) §5.7。

#### 尚未验证（不得当作已解决）

1. **实时链路**：离线是逐样本对齐的 WAV；实时里 `AnalyzeRender` 与 `AnalyzeCapture` 是两条
   异步流，时钟偏移与缓冲延迟都还没处理。
2. **渲染参考的真实性**：需在桥里显式分叉「即将播放的 PCM」并喂给 AEC3，而不是事后推导。
3. **CPU 开销**：每 10 ms 一帧、跨 Swift/C++ 调用，未测。

#### 集成步骤（每步都可验证）

| 步骤 | 内容 | 验证 |
| --- | --- | --- |
| 1 | AEC3 静态库（已完成）+ Swift 包装层 | 喂固定 PCM，输出与离线逐样本一致 |
| 2 | 桥加 `--aec3` 模式，playerNode PCM 作 render | 跑同一 ABAB 实验，与 VPIO 对照 |
| 3 | `suppressAuto` 已在 GH-5 删除；本步按 AEC3 残留水平收窄 `erle_margin`（`speech_db_barge_in`） | 实测：播报中说话能否打断、`speech.gate` 的 pass/suppressed 比例 |

#### 依赖与构建

- 源码入库到 `third_party/webrtc-aec3/`（Enaium/webrtc-aec3，MIT，从 WebRTC 提取），
  由维护者执行 `scripts/vendor-aec3.sh <commit-or-tag>` 后提交（见 `third_party/README.md`）。
- 本机无 cmake/ninja，`eval/aec3/build_aec3.sh` 用 clang 直接复刻 CMakeLists 规则；源码缺失时
  **fail-closed** 并指向 vendor 脚本，不退回 `work/` 副本、也不静默退回 VPIO。


## 附录 A · 与 2026-10-13 工程化重构的差异对照

> 目的：把本文（先写的方案）与另一台电脑落地的重构逐条对齐，标明「已一致 / 需改口径 / 仍缺」。

| # | 本文的方案 | 重构后的实际 | 结论 |
| --- | --- | --- | --- |
| 1 | 保留三层，第二层内重划 Audio Runtime / People Perception | 三层保留；但第二层内部未重划，语音仍是 robotd 里注册的一组 `audio.*` 能力 | 方向一致，**结构未动** |
| 2 | 常驻 `audio-bridge`（采集/播放同图 + AEC），barge-in 的前提 | 仍是每次调用 spawn `mac_speech.swift`；communication-protocol 明确「原生桥 = spawn + stdio，一次性命令」 | ⚠️ **最大结构性差异**：方案要改常驻，重构未改 |
| 3 | 独立 VAD 端点检测（Silero），说完自动收尾 | `auto_endpoint` 仍走系统 `SpeechDetector`、默认关（已实测与 Transcriber 冲突不可用） | **仍缺 → §13 已补**（改用自带能量 VAD，默认开） |
| 4 | 流式 ASR partial/final 契约化 + 事件推送 | ✅ `/v1/speech/listen` + `speech.partial` / `speech.final`，`/v1/events` 带 `seq` / 订阅 / 补发 | 一致（投递侧比方案写得更强） |
| 5 | ASR 与说话人分析并行 → speaker-aware transcript | 未实现；仅 `V1_SUPPORTED_TYPES` 预留 `people.*` / `person.*` | **仍缺** |
| 6 | 分句流式 TTS + 有界队列 + barge-in | 未实现；`SpeakRequest.interruptible` 已进契约但**代码未消费** | 部分 → **§13 已补**（`speak-stream` + 队列 + 取消 + 打断，`interruptible` 已生效） |
| 7 | 统一单调时间轴（`ts_mono_ns`） | 现状 = `seq` + 墙钟 ISO `timestamp`，无单调时间 | **仍缺 → §13 已补** |
| 8 | 打断仲裁单点（Audio Runtime） | 有 `robot_stop`（幂等抢占）/ `task_cancel`（abort），但缺 VAD 触发那一端 | 部分 → **§13 已补**（听/说软任务分槽 + 单点仲裁） |
| 9 | 契约单一来源、生成工具面 | ✅ `contracts/openapi.yaml` → `mcp-tools.json` / `robotd-types.ts`，runtime/transport 拆分 | 一致，比方案写得更完整 |
| 10 | 事件命名 `audio.*` / `speaker.*` / `asr.*` | 实际公共事件族是 `speech.*`（`audio.*`、`speaker.*` 不在 `V1_SUPPORTED_TYPES`） | **口径已改**（见 §6） |

**顺带发现的缺口（本次未改，供你确认）**：

- `SpeakRequest.interruptible` 声明了（默认 `true`）但 `speakV1` 没读它 → 契约/实现漂移；且它已进 MCP 工具 schema，Agent 传了也没效果。
- `audio.stream` 能力描述里写「停止＝面板 STOP / `audio.stop`」，但**没有** `audio.stop` 这个能力；实际取消路径是 STOP 或 `DELETE /v1/tasks/{id}`。
- MCP 工具面从「全部能力」收敛到 8 个契约操作，`vision.*` / `camera.*` / `system.capabilities` 不再进 Agent 面（是否有意？方案 §6 原假设能力面仍全量）。
- 归档中的 [`poc-design.md`](archive/poc-design.md) 接口示例仍写着 `/api/*` 旧路径（现已收敛到 `/v1/*`），不作为当前契约。
- `docs/architecture.md`、`docs/communication-protocol.md` 尚未描述 runtime/transport 拆分与契约驱动（只在 poc-readme 提了一句）。

## 相关页面

- [[architecture|架构设计（C4）]] · [[communication-protocol|分层通信与接口设计]]
- [[model-selection|LLM / TTS / ASR 模型选型]] · [[architecture|架构设计]]（§1 职责边界判据）
- [[archive/poc-design|机器人 POC — 分层通信链路设计与验证]] · [[archive/poc-readme|机器人 POC — 使用说明]]
- [[spec/camera-detection|摄像头自动检测与配置]] · [[eval/vision-latency|视觉延迟实测]] · [[risk-assessment|风险清单]]
