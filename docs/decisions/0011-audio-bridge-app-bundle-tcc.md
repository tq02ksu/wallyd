---
title: ADR-0011 音频桥做成 .app bundle 并由 open 拉起：绕过 TCC 的责任进程判定
type: project
description: 语音采集与 ASR 受 macOS TCC 保护；从终端 spawn 的二进制会被按「责任进程」授权并直接 SIGABRT → 改为常驻 audio-bridge.app，由 robotd 用 open 启动，权限归桥自己。
tags: [adr, robot, voice]
domain: robot
project: macmini-robot
adr_status: accepted
date: 2026-10-24
sources:
  - https://developer.apple.com/documentation/bundleresources/information-property-list/nsspeechrecognitionusagedescription
  - https://developer.apple.com/documentation/bundleresources/information-property-list/nsmicrophoneusagedescription
  - https://developer.apple.com/documentation/security/protecting-the-user-s-privacy
generated: { by: { actor: agent, at: 2026-10-24T20:00:00+08:00 } }
relations:
  - predicate: part-of
    target: /README.md
  - predicate: implements
    target: /docs/voice-architecture.md
---

# ADR-0011 音频桥做成 .app bundle 并由 open 拉起

## 背景

R14 要求语音常驻（`docs/voice-architecture.md` §3「常驻 audio-bridge」）。落地第一步就撞墙：
调用 `SFSpeechRecognizer.requestAuthorization` / `AVCaptureDevice.requestAccess` 的进程被系统
以 `SIGABRT` 终止，崩溃报告写：

```text
Termination Reason: Namespace TCC, Code 0
This app has crashed because it attempted to access privacy-sensitive data without a usage
description. The app's Info.plist must contain an NSSpeechRecognitionUsageDescription key...
```

但 `Info.plist` 里**确实有**这个 key（已 `plutil -p` 核对）。报错信息误导了排查方向：
一度以为是中文值、或 plist 未嵌入二进制（试过 `-sectcreate __TEXT __info_plist`），
两者都不是原因。

真正的判据在崩溃报告的另一行：

```text
Coalition:  ai.opencode.desktop
Responsible Process: OpenCode [1062]
```

**TCC 按「责任进程」（responsible process）判定权限，不按发起调用的进程。** 从终端 / 编辑器
spawn 出来的二进制，其责任进程是那个终端 App；TCC 去查那个 App 的授权记录，而不是被 spawn
的二进制自己的 bundle id。所以：

- 在临时目录里做一个带 plist、带 adhoc 签名的 `.app`、但**从终端直接执行 `Contents/MacOS/xxx`** → 仍然崩；
- 换 bundle id、换 plist 语言、往二进制里嵌 plist → 全部无效（都试过，每次都是同一份 TCC 崩溃报告）；
- 改用 `open -a xxx.app`（经 LaunchServices 启动）→ **立即通过**。

## 决策驱动

1. **TCC 是平台硬约束，不能靠代码绕过。** 没有第二套采集路径：`AVAudioEngine` 与
   `SFSpeechRecognizer` 都要过 TCC。
2. **权限要稳定可复现。** 每次调试都改 bundle id，会导致授权记录不断累积、用户每次都要重新点同意。
3. **robotd 必须能自己拉起语音**，不能要求用户手动双击 App（机器重启后要自恢复）。
4. 项目已有的同类先例：串口必须由原生辅助进程持有（见 `docs/decisions/README.md` 待回填清单）；
   本次是同一形状的问题——「有些能力只能在特定进程形态里成立」。

## 考虑的选项

| 选项 | 结果 |
| --- | --- |
| A. robotd 直接 spawn 原生二进制 | ❌ TCC 按 robotd/终端 的责任进程判定，必然崩 |
| B. 把 robotd 自己也打成 `.app` | 代价过大：robotd 是 Python 服务 + 命令行工具，改形态会牵连部署与调试链路；且每次 `python -m robotd` 调试仍会回到问题原点 |
| C. 独立 `audio-bridge.app` + `open -a` 启动 + 本机 IPC | ✅ 权限归桥自己，robotd 仍是命令行进程 |
| D. 授权后用 `launchd` 常驻 | 可选，但引入开机自启与用户级服务管理，超出 R14 范围；IPC 形状与 C 相同，日后可平滑切换 |

## 决定

采用 **C**：

1. `audio-bridge` 打成一个**固定路径、固定 bundle id** 的 `.app`（`com.macmini.robot.audiobridge`），
   内含 `NSMicrophoneUsageDescription` 与 `NSSpeechRecognitionUsageDescription`。
2. robotd **只通过 `open -a <AudioBridge.app>` 启动它**，绝不直接 spawn
   `Contents/MacOS/...`——那会回到选项 A 的失败路径。
3. 桥与 robotd 之间走**本机 IPC**（unix domain socket，路径由 robotd 生成后作为参数传入）：
   帧数据与控制消息分离，符合 `voice-architecture.md` §3.1「帧通道 / 事件通道」。
4. robotd 不把「桥已拉起」等同于「桥可用」：桥必须回报 `ready`（含采集格式）才算就绪；
   拉不起来、权限缺失、桥退出，一律在 `audio.state` 里显式体现，不伪装成「在听但没说话」。
5. 桥的 `.app` **不进版本库**（二进制），源码在 `scripts/`，构建脚本产出到 `work/`；
   文档写清构建与首次授权步骤。
6. **改了桥的 Swift 代码就要重新授权一次**：本机没有代码签名证书（
   `security find-identity -v -p codesigning` → 0 个），只能用 adhoc 签名；adhoc 没有 Team ID，
   TCC 以**代码哈希（CDHash）**标识程序，重新编译即失配。因此**开发期只在两个时点重新授权**：
   首次部署、或确实必须改桥的采集/权限相关代码时。改 Python 侧（robotd 的翻译层、契约行为）
   **不需要**重签桥——这一点把日常迭代与权限重置隔开了。

   > 若将来要消除这个反复，只有两条路：拿到开发者证书（TCC 改按 Team+BundleID 记），
   > 或把桥的代码冻住、所有可变逻辑放到 Python 侧。R14 阶段选后者：桥只做"听得见/说得清"。

## 后果

**好**

- 权限一次授权、长期有效：bundle id 固定，不随调试反复弹窗。
- robotd 保持命令行形态，`--sim` 与测试路径不受影响（无桥时语音能力如实报 unavailable）。
- 与 `voice-architecture.md` 的「常驻桥」设计一致，AEC / barge-in 有了落地前提。

**坏**

- 多一个常驻进程，且它的生命周期不完全由 robotd 掌控（`open` 启动后 robotd 只是父级之外的关系）；
  需要用 IPC 心跳 + 退出通知来收拾残留实例。
- 首次运行仍需用户在系统设置里点一次同意（无法自动化，这是 TCC 的设计）。
- **adhoc 签名下改桥代码就要重新授权**（见「决定」第 6 条）：这是本机没有签名证书的直接代价。
- 构建链多一步（`swiftc` → 组 bundle → `codesign -s -`），未签名 App 在换机器时可能要重新授权。

**中性**

- 桥的实现语言固定在 Swift（`AVAudioEngine` / `Speech` / `AVSpeechSynthesizer` 只在 Apple 平台有）；
  这与 `voice-architecture.md` §9 选型一致，换 ASR 后端不影响这条决策。

## 怎么验证

```bash
# 1. 直接执行会崩（基线，证明问题真实存在）
work/voice/AudioBridge.app/Contents/MacOS/AudioBridge   # 期望 SIGABRT / exit 134

# 2. 经 LaunchServices 启动可授权
open -a work/voice/AudioBridge.app                      # 期望弹出权限请求

# 3. robotd 从 Python 子进程 open 拉起后，桥仍保有权限
#    实测记录：work/voice/probe_result.txt 中 speech_auth_raw=3、mic_access=true
```

验收断言：`GET /v1/audio/state` 的 `bridge` 为 `ready` 且 `mic_format` 非空；
杀掉桥之后该字段变为 `lost` 并给出原因，而不是继续显示 `ready`。

## 相关资料

- `docs/voice-architecture.md` §3 常驻桥、§12 风险表
- `docs/spec/robotd-development-plan.md` R14
- 实测记录：本 ADR 的背景一节即为 2026-10-24 的排查过程（`work/voice/` 下的探针与崩溃报告）
