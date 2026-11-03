---
title: Mac mini 移动机器人 — LLM / TTS / ASR 模型选型（苹果生态优先）
type: project
description: 以 macOS 系统自带能力为主的 LLM/TTS/ASR 选型定案：ASR 用 SpeechAnalyzer（zh_CN 资产已装并端到端实测）、TTS 用 AVSpeechSynthesizer，系统 LLM 本机不可用，视觉与主脑走 MLX。
tags: [project, robot, model-selection]
aliases: [模型选型, LLM TTS ASR 选型, macmini 模型选型]
domain: robot
project: macmini-robot
sources:
  - id: apple-model-research
    resource: /wiki/sources/apple-llm-tts-asr-model-selection.md
    title: Apple 生态 LLM / TTS / ASR 本地能力与选型调研
  - id: apple-speech-docs
    resource: https://developer.apple.com/documentation/speech/speechanalyzer
    title: Apple Speech framework — SpeechAnalyzer / SpeechTranscriber / AssetInventory
  - id: apple-avspeechsynth
    resource: https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer
    title: Apple AVSpeechSynthesizer（AVFAudio）
  - id: apple-wwdc25-277
    resource: https://developer.apple.com/videos/play/wwdc2025/277/
    title: WWDC25 · Bring advanced speech-to-text to your app with SpeechAnalyzer
generated: { by: codex/gpt-5, at: 2026-10-03T20:50:00+08:00 }
status: draft
relations:
  - predicate: documented-in
    target: /wiki/sources/apple-llm-tts-asr-model-selection.md
  - predicate: part-of
    target: /projects/robot/README.md
---

# LLM / TTS / ASR 模型选型（苹果生态优先）

> 配套：[[architecture|架构设计]] §10.3、§6.4。
> 本文是 2026-09-17 的新一轮选型，优先级高于架构文档里较早的模型表：
> **系统自带能力优先，不能满足的再用本地开源模型补齐。**

## 0. 当前机器实测（2026-09-17）

目标机器实测环境：

- macOS 26.6.2（25G83），Apple M4 Mac mini，**16GB 统一内存**。
- 根卷可用空间约 **3.8GB**，因此「4GB 以内模型」也只能选更小的 1–2GB 模型，不能贴着 4GB 部署。
- 当前网络环境无法访问 PyPI / Hugging Face；内部 PyPI 镜像拉取 `mlx-metal` 超时，所以本次未能完成开源模型下载。

实测结论：

> ⚠️ 下表是 2026-09-17 的原始记录，**其中 ASR 两行是沙箱内结果，已被 §0.1 推翻**（保留原文以示记录）。

| 能力 | 实测结果 | 选型影响 |
| --- | --- | --- |
| TTS | ✅ 系统 `AVSpeechSynthesizer` / `say` 可用；有 `zh-CN` Tingting、`zh-TW` Meijia、`zh-HK` Sinji；成功生成 5.59 秒中文音频 | **继续用系统 TTS，优先落地** |
| LLM 系统模型 | ❌ `SystemLanguageModel().isAvailable == false`，reason 为 `deviceNotEligible`；`contextSize` 为 4096 | 当前这台机器不能直接使用系统 LLM；需先确认 Apple Intelligence 是否可启用，否则用 MLX 小模型 |
| ASR 新 API | ❌ `SpeechTranscriber.supportedLocales` 与 `DictationTranscriber.supportedLocales` 均为空 | 系统新 ASR 当前不可用 |
| ASR 旧 API | 🟡 `SFSpeechRecognizer(locale: zh-CN)` 可用，但 `supportsOnDeviceRecognition == false`；实际识别未返回结果（日志提示缺 Assistant asset） | 系统 ASR 尚不能当作全本地能力 |
| LLM 开源模型 | ❌ 受网络与磁盘空间限制，本次未部署成功 | 下一步需先清理磁盘/配置可用的模型下载通道，再部署 1–2GB MLX 4bit 模型 |

因此，原「系统 LLM / ASR 优先」的结论在当前机器上需要修正为（**2026-10-03 已复测，见 §0.1**）：

- **TTS：系统自带，立即可用**（复测确认：187 个音色、19 个中文音色）。
- **ASR：系统自带可用且支持中文**——上面的「新 API 为空 / 旧 API 不支持离线」是**沙箱造成的假象**，
  复测已推翻；投产前先用 `AssetInventory` 装好中文资产，之后全离线。
- **LLM：系统设备端模型 `deviceNotEligible`**（复测在沙箱外仍成立，属真实结论）。主 Agent 用 MLX 小模型，
  目标内存预算从 24GB 下调到 16GB，模型更倾向 3–4B 4bit（约 1–2GB），而不是 7–8B。

## 0.1 复核（2026-10-03，macOS 27.0.1）

> 结论先行：**上一轮「系统 ASR 不可用」是受限沙箱造成的误判**——在沙箱内查询系统语音 API 返回空，
> 跳出沙箱后立即正常。这与此仓库 [[spec/camera-detection]] §3 记录的「沙箱里摄像头枚举为空、跳出后立刻出现」
> 是同一类现象。**以后再测这类系统 API，一律在非沙箱环境跑。**
> 探测脚本：`work/scripts/sys_speech_probe.swift`（系统框架 AVFAudio / Speech / FoundationModels，非沙箱运行）。

- 机器：Mac mini（Apple Silicon，arm64），**macOS 27.0.1（Build 26A434）**。
- 依据：Apple 官方文档（Speech / AVFAudio）[^apple-speech-docs][^apple-avspeechsynth] 与 WWDC25 session 277[^apple-wwdc25-277]。

| 能力 | 本次实测（**非沙箱**） | 结论 |
| --- | --- | --- |
| TTS | `AVSpeechSynthesisVoice.speechVoices()` 共 **187** 个音色，中文（`zh*`）**19** 个：`zh-CN Tingting`、`zh-TW Meijia` 及一批 eloquence 音色 | ✅ 系统自带、可用、on-device，无需下载 |
| ASR 新 API | `SpeechTranscriber.isAvailable == true`；`supportedLocales` **45** 个，含 **`zh_CN` / `zh_HK` / `zh_TW`**；`installedLocales` 9 个（**全为英文，中文资产尚未安装**） | ✅ API 与中文均受支持；用前需装中文资产 |
| ASR 旧 API | `SFSpeechRecognizer(locale: zh-CN).supportsOnDeviceRecognition == true`；`supportedLocales` 62 个，含 zh-CN/HK/TW | ✅ 同样可离线（**仅记录，本期不用**） |
| 系统 LLM | `SystemLanguageModel.isAvailable == false`，`reason = deviceNotEligible` | ❌ 本机不可用（沙箱内外一致，非假象） |
| **沙箱内的假象** | 新 API 的 `supportedLocales` / `installedLocales` 均返回 **0**，旧 API `supportsOnDeviceRecognition` 为 `false` | ⚠️ 沙箱假象，**勿据此判断能力** |

**平台版本门槛与资产机制**（Apple 官方文档）[^apple-speech-docs]：

- `SpeechAnalyzer` / `SpeechTranscriber` / `DictationTranscriber` / `AssetInventory` 均为 **macOS 26.0+** 起；
  系统 TTS `AVSpeechSynthesizer` 自 **macOS 10.14** 起可用[^apple-avspeechsynth]。
- ASR 的语音模型是**系统托管的机器学习资产**（Apple 服务器下载、跨 App 共享、自动更新），不是 App 内嵌；
  官方原话：`supportedLocales` 包含「尚未安装但可下载」的 locale。
- **装中文资产**：调 `AssetInventory.assetInstallationRequest(...)` → `downloadAndInstall()` 下载 `zh_CN`，
  首次需联网，装好后推理全离线。这对「数据全本地」是合规的（只有模型资产下载触网，音频不出本机）。

### 0.2 已装中文资产 + 端到端验证（2026-10-03）

**"ASR 没有中文可装"已被推翻**——中文资产确实存在，且已装好并跑通：

- **安装**：`AssetInventory.assetInstallationRequest(supporting:) → downloadAndInstall()` 下载 `zh_CN`：
  `status` 由 `supported` → 进度 100%（**103s**）→ **`installed`**；`installedLocales` 现在含 **`zh_CN`、`zh_TW`**。
  （`maximumReservedLocales = 5`；`reserve(locale: zh_CN)` 返回 `true`。）
- **端到端转写**：用系统 TTS 生成 5.01s 中文音频（`say -v Tingting`），再用
  `SpeechAnalyzer + SpeechTranscriber(locale: zh_CN, preset: .transcription)` 转写：

  | | 内容 |
  | --- | --- |
  | 原文（TTS 输入） | `你好，我是移动机器人。现在开始测试语音识别。` |
  | 转写输出 | `你好，我是移动机器人，现在开始测试语音识别。` ✅ |
  | 耗时 | **0.15s**（5s 音频，快于实时） |

- 脚本：`work/scripts/speech_asset_install.swift`、`work/scripts/asr_transcribe.swift`（均须**非沙箱**运行）。

## 1. 一句话结论（定案：只选一种，先做通）

| 能力 | 唯一选择（先把这条做通） |
| --- | --- |
| **ASR** | macOS 26+ **`SpeechAnalyzer` + `SpeechTranscriber`**（`zh_CN` 资产已装，已实测转写） |
| **TTS** | **`AVSpeechSynthesizer`**（系统自带、19 个中文音色，已实测出声） |
| **LLM（视觉）** | 本地 **MLX + MiniCPM-V 4.6**（见 [[architecture]] §10.3） |
| **LLM（主脑）** | 系统 `SystemLanguageModel` 本机不可用（`deviceNotEligible`）→ **MLX 小模型 / Codex Harness**（见 [[architecture]] §10.6、§10.3） |

> **取舍原则（2026-10-03 用户明确）**：**不需要做 failover**——先选定一种、把它确认跑通、确保可用，
> 再考虑兼容更多环境。因此上表不给「回退」列；`SFSpeechRecognizer` / whisper.cpp / Kokoro 等只作为
> **将来**若确有需要时的候选，不进第一版设计。

## 2. 选型原则

- **全本地硬约束**：机器人数据不能上云。因此 ASR/TTS/主 LLM 都必须默认离线；任何需要
  网络的方案只能作为可选增强，不能是唯一路径。[^apple-model-research]
- **系统自带优先**：系统能力意味着模型资产由系统管理、无需额外下载、集成和内存开销更小。
- **中文必须可用**：机器人面向中文语音交互，选型必须验证 `zh-CN`。
- **Agent 友好**：主 LLM 需要稳定的 tool calling / function calling，否则无法编排运动、
  视觉、音频等 MCP 工具。
- **内存预算已修正为 16GB**：不再按 24GB 估算；主模型优先 1–2GB 级 4bit 模型。

## 3. ASR：SpeechAnalyzer 优先

**推荐：先排查系统语音资产，可用时用 macOS 26+ 的 `SpeechAnalyzer` + `SpeechTranscriber`。**

理由：
- 系统自带、全本地，支持中文；新模型面向长音频和远场对话，正好匹配机器人场景。[^apple-model-research]
- 模型资产通过 `AssetInventory` 下载到系统存储，不占 App 包体和运行时内存。
- （历史写法）若目标机仍是 macOS 15/25 才需要 `SFSpeechRecognizer`；**目标机已是 macOS 27，此路不需要**。

（**2026-10-03 复核更正**）上面这句**已作废**：`SpeechTranscriber.supportedLocales` 为空是**沙箱假象**，
非沙箱下为 **45** 个 locale（含 `zh_CN`/`zh_HK`/`zh_TW`），旧 `SFSpeechRecognizer` 的
`supportsOnDeviceRecognition` 也为 `true`。因此**本机可以把系统新 ASR 直接当作全本地能力使用**，
前提是先经 `AssetInventory` 装好中文资产（见 §0.1）。

**回退（本期不做）**：定案只用系统新 ASR。`whisper.cpp` / `sherpa-onnx` 等只在**将来**需要跨 macOS
版本或更细粒度流式控制时再评估，不进第一版设计。[^apple-model-research]

## 4. TTS：AVSpeechSynthesizer 优先

**推荐：系统 `AVSpeechSynthesizer`。**

理由：
- 零依赖、本地、稳定，直接支持 `zh-CN`（Tingting）、`zh-TW`（Meijia）、`zh-HK`（Sinji）。[^apple-model-research]
- 对 MVP 的「收到指令 → 回话」已经足够，先跑通，不提前引入模型管理复杂度。

**回退（本期不做）**：若将来实测发现系统中文音色机械感过强，再评估
`mlx-community/Kokoro-82M-bf16`；第一版不做多 TTS provider。[^apple-model-research]

## 5. LLM：系统模型 + 开源主 Agent 双轨

**首选系统能力：`FoundationModels.SystemLanguageModel()`。**

系统设备端模型全本地、支持工具调用和 guided generation，适合作为「轻量本地智能层」：
短指令解析、摘要、状态描述、简单 Q&A。但有两个现实约束：

1. 它在 macOS 26.0 上上下文窗口为 4096，27.0 新设备为 8192，对复杂 Agent 编排偏紧。[^apple-model-research]
2. 框架当前以 Swift API 为主，官方 Python SDK / `fm` CLI 属于 macOS 27 方向；本项目主
   Agent 是 Python 栈，直接接入仍需验证。[^apple-model-research]

当前机器实测 `SystemLanguageModel().isAvailable == false`，原因是 `deviceNotEligible`。
需要先在系统设置确认这台 Mac 是否满足并已启用 Apple Intelligence；若不能启用，则系统
LLM 不能作为本机主模型。

**主 Agent 大脑：MLX + 小参数 Qwen。**

在系统设备端 LLM 与 Python Agent 稳定打通前，主 Agent 继续用本地 MLX 模型。考虑到 16GB
内存与 3.8GB 磁盘，首选顺序调整为：

1. `mlx-community/Qwen3-4B-4bit`（约 1–2GB）——比 8B 更适合 16GB 与当前磁盘。
2. `mlx-community/Qwen2.5-3B-Instruct-4bit`（约 2GB）——中文与工具调用成熟。
3. 旧文档中的 7–8B 模型暂不作为本机首选；其它本地开源模型（如 Qwen / Hermes 系列）仍可作为生态备选。

这样可给 ASR/TTS/VLM 和系统进程留出余量。若后续目标机器升级到 24GB 或更大磁盘，再考虑
7–8B 4bit。

**Private Cloud Compute 不作为默认**：`PrivateCloudComputeLanguageModel()` 有 32K 上下文
和 reasoning，但需要网络，违反「全本地」硬约束；只在未来明确允许云端增强时再评估。[^apple-model-research]

## 6. 落地建议（PoC 顺序）

1. ~~先确认目标 Mac mini 的 macOS 版本，并在本机枚举 `SpeechTranscriber.supportedLocales` /
   `AVSpeechSynthesisVoice.speechVoices()`~~ —— **已完成（2026-10-03，见 §0.1）**：macOS 27.0.1；
   ASR 支持 zh_CN、TTS 有 19 个中文音色。
2. ~~用 `AssetInventory` 装 `zh_CN` 资产~~ —— **已完成（2026-10-03，见 §0.2）**：`status=installed`；
   并已做端到端转写验证（0.15s）。
3. ~~用系统 TTS / ASR 各自跑通~~ —— **已完成**：TTS 生成 5s 中文音频、ASR 正确转写；下一步接主 Agent 工具调用。
4. 主 Agent LLM 先按 MLX 小参数 Qwen 验证 MCP 工具调用；同时单独评估
   `SystemLanguageModel()` 是否能从 Codex Harness 侧稳定调用。
5. （可选，之后）把系统 TTS 的自然度与 Kokoro 做 A/B，再决定是否替换——本期不做。

## 7. 待核实

- [x] 目标 Mac mini 实际 macOS 版本，以及 `SpeechAnalyzer`/`SpeechTranscriber` 可用中文 locale。
  —— 2026-10-03：macOS 27.0.1；支持 zh_CN/zh_HK/zh_TW（§0.1）。
- [x] `SystemLanguageModel()` 在目标设备上是否可用。—— 2026-10-03：`deviceNotEligible`（不可用）。
- [ ] `FoundationModels` 官方 Python SDK 在目标 macOS 版本是否可用。
- [ ] `AVSpeechSynthesizer` 中文自然度是否达标。
- [ ] `mlx-community/Qwen3-8B` 是否有稳定 4bit MLX 版本，并兼容 Codex 工具调用。

## 8. 相关页面

- [[architecture|架构设计文档]]
- [[architecture|架构设计（C4）]]
- [[risk-assessment|风险清单]]（R4 本地模型实时性）

[^apple-model-research]: Apple 生态 LLM / TTS / ASR 本地能力与选型调研
