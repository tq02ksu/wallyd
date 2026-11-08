---
title: GH-36 macOS CI 门禁分档：哪些判据能进 GitHub 的 mac runner
type: design
description: 新增 apple lane（Swift 编译 + 纯逻辑 XCTest + AEC3 离线链路），并把判据按「能否在 GitHub macOS runner 上跑」分成可跑 / 可能可跑 / 不可跑三档。
tags: [design, ci, swift, macos, aec3]
domain: robot
project: wallyd
status: draft
---

# GH-36 macOS CI 门禁分档

## 1. 为什么加这条 lane

`quality.yml` 原有的四条 lane 全部在 `ubuntu-latest`，没有一行能编译 Swift：
`.swift` 改动只能靠 `test_voice_bridge_architecture.py` 那类源码文本断言把关。
写完却不可验证的代码会把「编译 + 逐样本比对 + 真机时序」全部推给人（#6 已经吃过一次）。

新增的 `apple` job：

- `runs-on: macos-latest`（GitHub 官方镜像，arm64；不用 `macos-13`，不引自托管）；
- `timeout-minutes: 15`；
- 只做**编译**与**不依赖音频/相机设备的测试**；
- 由 `scripts/ci/check-apple.sh` 一条命令跑完，便于本地复现。

`apple` 与另外四条 lane 是**加法关系**：Linux lane 的触发条件、超时、跳过项一个字没改。

## 2. 每个 Swift / C++ 源在 lane 里做什么

> issue 正文写「7 个 `.swift`」；本 issue 涉及的桥/工具脚本实核是 **6 个**（少了 1 个，
> 不是漏扫）。本 lane 自己又新增 3 个 Swift 文件（测试包），所以 `git ls-files '*.swift'`
> 现在是 **9 个**。lane 用 `git ls-files` 动态枚举，多一个少一个都不需要改脚本；
> 数量不符不算门禁失败，但记录在此，避免下次又按「7」去找。

| 文件 | lane 里的动作 | 说明 |
| --- | --- | --- |
| `scripts/mac_speech.swift` | `swiftc -parse` + 抽纯逻辑跑 XCTest | `EnergyVAD` / `splitSentences` 与设备无关，被抽进测试包 |
| `scripts/mac_speech_pipeline.swift` | `swiftc -parse` | 单文件脚本，依赖 `mac_speech.swift` 的顶层代码，不能单独编译；真编译仍走 `scripts/build_audio_bridge.sh` |
| `scripts/speech_fixture.swift` | `-parse` + `swiftc -O` 真编译 | 只用 AVFAudio 的合成 API；CI 只编译，不合成（不占喇叭） |
| `scripts/uvc_capture.swift` | `swiftc -parse` | 相机抓帧，运行需要设备与 TCC 授权，CI 不运行 |
| `src/tools/cam_list.swift` | `-parse` + `swiftc -O` 真编译 | 只枚举设备，编译不需要设备 |
| `eval/vision_bench.swift` | `-parse` + `swiftc -O` 真编译 | Vision 框架编译，不跑基准（无图片、无真机时延结论） |
| `eval/aec3/aec3_eval.cc` | `bash eval/aec3/build_aec3.sh` 后 `clang++` 链接 | 源码未入库时 fail-closed 变红（见 §6） |
| `scripts/apple/**/*.swift` | `swiftc -parse` | 本 lane 的测试包（`Package.swift`、占位文件、XCTest 用例） |

## 3. 三档判据

| 档 | 判据 | 结论 |
| --- | --- | --- |
| ✅ 可跑 | 全部 Swift 的语法/类型解析（`swiftc -parse`） | 进 `apple` lane |
| ✅ 可跑 | 三个自包含目标 `swiftc -O` 真编译（`speech_fixture` / `cam_list` / `vision_bench`） | 进 `apple` lane |
| ✅ 可跑 | 纯逻辑单测：能量 VAD 去抖/迟滞/端点、TTS 分句与限长（XCTest） | 进 `apple` lane |
| ✅ 可跑 | AEC3 离线链路的**编译**（`build_aec3.sh` + 链接 `aec3_eval`） | 进 `apple` lane；源码入库前 fail-closed |
| ✅ 可跑 | 契约检查、文档链接检查、源码 lint | 仍由 Linux `static` / `robotd` lane 跑，不在 mac 上重复 |
| ⚠️ 可能可跑 | 虚拟音频设备（BlackHole 等）上的闭环：TTS 出到虚拟设备，再回灌给桥 | **本轮只调研，不改代码**；问题清单与验证方案见 §4 |
| ⚠️ 可能可跑 | AEC3 逐样本比对（喂固定 PCM，比较包装层输出与 `aec3_eval`） | 需要先有实时包装层（#6）；本轮未实现，不进 lane |
| ❌ 不可跑 | 真实麦克风灵敏度 / 本底校准 | **不由 CI 保证**；维护者在 Mac mini 真机 + 实际房间测 |
| ❌ 不可跑 | 播报中静默 30 分钟 0 误触发 | **不由 CI 保证**；维护者在 Mac mini 真机做 30 分钟实验（`speech.gate` 时间线 + `aec_echo_probe`） |
| ❌ 不可跑 | 真实房间的 ERLE | **不由 CI 保证**；维护者在 Mac mini 真机用 `eval/aec3/collect_pair.sh` + `aec3_eval` 测 |
| ❌ 不可跑 | 实时 AEC3 的 CPU 占用 | **不由 CI 保证**；维护者在 Mac mini 真机 `top -pid` 采样 |
| ❌ 不可跑 | P95 打断时延、首字/首包/最终时延 | **不由 CI 保证**；执行轮 + 维护者在 Mac mini 真机按 `eval/r14-voice-bringup-2026-10-24.md` 的方法测（#14 承接） |

**❌ 档的判据不由 CI 保证**：GitHub 的 macOS runner 没有真实麦克风、扬声器、
摄像头，也没有 TCC 音频授权；`AVCaptureDevice` 拿不到设备。这些数值只能在真机上量，
CI 绿了也不代表它们成立。

## 4. ⚠️ 档调研：虚拟声卡在 GitHub macOS runner 上（未验证）

本轮**没有**安装或试验任何虚拟声卡。下面是下一轮要回答的问题，不是结论。

| 问题 | 目前掌握的情况 | 验证方式 |
| --- | --- | --- |
| 装不装得上 | BlackHole 是 AudioServerPlugin（HAL 插件），装到 `/Library/Audio/Plug-Ins/HAL`；Homebrew cask `blackhole-2ch` 存在 | 在一个**非门禁**的 `workflow_dispatch` 试验 job 里 `brew install --cask blackhole-2ch`，看安装与 `system_profiler SPAudioDataType` |
| 要不要 root | HAL 插件目录写入与 `killall coreaudiod` 需要 root；GitHub-hosted macOS runner 的 `runner` 用户通常在 admin 组、`sudo` 无密码——**未验证** | 试验 job 里 `sudo -n true` 与 `sudo killall coreaudiod` |
| arm64 有无现成包 | BlackHole 安装器为 universal2（Intel + Apple Silicon）；Homebrew 在 runner 上是 arm64 前缀——**未验证** | 试验 job 里 `file /Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver/Contents/MacOS/BlackHole2ch` |
| 每次跑多久 | 估算：brew 安装 1–3 分钟（含网络），重启 `coreaudiod` 数秒，回灌测试 10–30 秒——**未验证** | 试验 job 打印各段 `$SECONDS` |
| 闭环是否可行 | BlackHole 2ch 同时是输出与输入设备，理论上可「TTS 输出 → 采集回灌」；但 runner 的默认设备、采样率、时钟漂移都未知 | 试验脚本：`say`/`AVSpeechSynthesizer` 输出到 BlackHole，再用 `AVAudioEngine` 从 BlackHole 采集，比较首尾与丢帧 |

进入 `apple` 门禁前的门槛：上述五项全部有实测数据，且单次增加耗时不超过 15 分钟预算。
在那之前，「虚拟声卡闭环」不属于可跑档。

## 5. 耗时与工具链（首次 `apple` run 后回填）

本设计的实现环境是 Linux 沙箱，没有 `swiftc`，无法预填实测值。`check-apple.sh`
会打印每一段的秒数，PR 第一次 `apple` run 后把数字填进下表（issue handoff 要求项 2/3）。

| 段 | 实测值 | 备注 |
| --- | --- | --- |
| runner 镜像 | 待填 | `macos-latest` 当次解析成的具体镜像名 |
| `swiftc` 版本 | 待填 | `swift --version` |
| SDK 版本 | 待填 | `xcrun --show-sdk-version` |
| macOS 版本 | 待填 | `sw_vers -productVersion` |
| Xcode 版本 | 待填 | `xcodebuild -version` |
| 工具链探测 | 待填 | 四条版本命令本身 |
| `swiftc -parse`（全部文件） | 待填 | 逐文件解析 |
| `swiftc -O`（3 个自包含目标） | 待填 | 真编译 + 链接 |
| XCTest | 待填 | 抽取纯逻辑 + `swift test` |
| AEC3 构建 | 待填 | 源码未入库时是「立即失败」，不是耗时 |

这些数字决定以后要不要加 SwiftPM/Xcode 缓存，以及 AEC3 构建是否需要并行化（`build_aec3.sh` 归 #6）。

## 6. 门禁接线与 fail-closed

三处必须同时成立，漏一处就是假绿（`quality` 绿而 lane 红/没跑）：

| 位置 | 作用 |
| --- | --- |
| `quality.needs` 含 `apple` | 汇总结论等待 `apple` |
| `quality` 汇总步骤 `env` 含 `APPLE: ${{ needs.apple.result }}` | 把结果真的传给判定脚本 |
| `scripts/ci/verify-lanes.mjs` 的 `LANES` 含 `apple` | 判定脚本真的读它 |

`scripts/ci/ci-config.test.mjs` 新增断言专门守这三者一致（并检查 `quality.needs`/`env`
没有 `LANES` 之外的多余项），同时钉住 `runs-on: macos-latest`、15 分钟超时、
「workflow 没有 `paths:` 过滤」、「`check-apple.sh` 没有 `|| true`」。

**AEC3 fail-closed**：`third_party/webrtc-aec3/` 为空时 `build_aec3.sh` 非零退出并提示
`scripts/vendor-aec3.sh`，`check-apple.sh` 据此让 `apple` **变红**（不是 SKIP、不是
`continue-on-error`）。因此在本分支当前树（源码未入库）上 `apple` 预期是红的；
等 #6 把源码入库后同一条 lane 才可能变绿。这是与 #6 对齐的口径，不是回归。
lane 解析 AEC3 源码目录的方式与 `build_aec3.sh` 一致：只认 `third_party/webrtc-aec3`
或显式 `AEC3_SRC`，**不读 `work/` 回退目录**（#6 已取消该回退）。

## 7. 本地复现

```sh
# 仅 macOS（需要 Xcode / swiftc / XCTest）
bash scripts/ci/check-apple.sh

# 只跑 XCTest（先抽取纯逻辑）
python3 scripts/apple/extract_bridge_core.py \
  --source scripts/mac_speech.swift \
  --out scripts/apple/Sources/BridgeCore/Generated.swift
swift test --package-path scripts/apple
```

`npm run gates`（`scripts/ci/run-gates.sh`）仍只跑四条 Linux lane：`apple` 需要 Xcode，
在 Linux 上跑不了，也不该在 Linux 上伪装通过。

## 8. 明确不做

- 不把 `static` / `robotd` / `agentd` / `integration` 挪到 macOS，不放宽它们的超时或跳过项；
- 不在 CI 里占麦克风/喇叭/摄像头，不写任何「真实音频 I/O 已验证」的结论；
- 不引第三方（自托管）macOS runner，只用 GitHub 官方镜像；
- 不给 `apple` 加 `paths:` 过滤：先全量跑，等耗时数据出来再谈；
- 不做 iOS 构建、公证或签名，不塞 CI secret；
- 不重构 `scripts/mac_speech_pipeline.swift`：它整体依赖 AVFoundation，本轮目标是「编译得起来」。
