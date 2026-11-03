# R14 语音链路实测记录（2026-10-24）

本文件记录 R14 落地阶段的**原始实测**，供 ADR-0011 与 `voice-architecture.md` 引用。
复现命令都在文内，数据本身不进设计文档。

环境：Mac16,10（M4）/ macOS 27.0.1 / Xcode Swift 6.4 / 麦克风 = HDI Webcam USB。

---

## 1. TCC 权限：责任进程判据（本阶段最大的坑）

| 启动方式 | 结果 |
| --- | --- |
| 终端直接执行 `AudioBridge.app/Contents/MacOS/AudioBridge` | ❌ 查询为 `notDetermined`；调用 `requestAccess` 直接 SIGABRT |
| `open -a AudioBridge.app --args ...` | ✅ `speech_auth_raw=3`、`mic_access=true` |

崩溃报告里的关键两行（此前被误读为「plist 缺 key」）：

```text
Termination Reason: Namespace TCC, Code 0
Responsible Process: OpenCode [1062]
```

推论与决策见 [ADR-0011](../decisions/0011-audio-bridge-app-bundle-tcc.md)。

### 1.1 adhoc 签名 → 重新编译即失去授权

本机无代码签名证书：

```console
$ security find-identity -v -p codesigning
     0 valid identities found
```

adhoc 签名的 TCC 标识是 **CDHash**，改一行 Swift 再 `codesign --force`，哈希就变，
授权记录随之失效（实测：重签后 `麦克风授权=notDetermined`）。
**因此桥的 Swift 代码应当尽量冻结**，可变逻辑放 Python 侧。

---

## 2. 分句播报（已验证）

请求：

```console
curl -s -X POST http://127.0.0.1:8787/v1/robot/speak \
  -H 'content-type: application/json' \
  -d '{"text":"第一句在这里。第二句也说完了。第三句是最后一句。"}'
```

事件序列（实测）：

```text
speech.tts_started        {response_id, task_id, voice, chunks: 3}
speech.tts_chunk_started  {index: 0} → speech.tts_chunk_finished {index: 0}
speech.tts_chunk_started  {index: 1} → speech.tts_chunk_finished {index: 1}
speech.tts_chunk_started  {index: 2} → speech.tts_chunk_finished {index: 2}
speech.tts_finished       {chunks: 3, played: 3}
```

任务 `robot.speak` 正常 `completed`。

### 2.1 分句规则自测（离线，不需麦克风）

```console
$ swift scripts/mac_speech.swift split-selftest
```

| 输入 | 切分结果 |
| --- | --- |
| 你好，我是机器人。语音功能已经接通了。 | `['你好，我是机器人。', '语音功能已经接通了。']` |
| 海拔 3.5 米，温度 25.6 度。 | 不切（小数不误判） |
| 他说：“走吧！”然后就离开了。 | `['他说：“走吧！”', '然后就离开了。']`（收尾引号被吃掉） |
| 短句！问题？感叹；还有省略号……结束。 | `['短句！','问题？','感叹；','还有省略号……','结束。']` |
| Line one. Line two ends here. | `['Line one.', 'Line two ends here.']` |

---

## 3. AEC 实测：开启后采集全静音（**V1 不可用**）

`voice-architecture.md` §9 把 AEC 列为 barge-in 的前提，代码注释也写着「会改输入格式，需真机验证」。
实测结果：

| 配置 | `vad_calibrated.ambient_db` | 判定 |
| --- | --- | --- |
| `serve --aec` | **-120**（代码里表示「无声」的哨兵值） | ❌ 采集链路被破坏 |
| `serve`（默认，无 AEC） | **-45.3**（真实房间噪声） | ✅ 正常 |

复现：

```console
mkfifo /tmp/ab.in && touch /tmp/ab.out
( exec 3>/tmp/ab.in; sleep 10 ) &
open -n -a work/bin/AudioBridge.app --stdin /tmp/ab.in --stdout /tmp/ab.out --args serve --aec
sleep 6 && tail -2 /tmp/ab.out
```

**结论**：`setVoiceProcessingEnabled(true)` 在本机让输入变为全零。V1 **默认不开 AEC**
（robotd 侧 `--audio-aec` 为 opt-in，默认关闭）。

---

## 4. barge-in 的当前限制（**未解决，需要决策**）

桥里有两处相互矛盾的行为：

1. 播报期间置 `suppressAuto = true`（`mac_speech.swift` 的 `handleTap`），
   目的是**不让机器人把自己的话当成用户开口**（没有 AEC 时必须这样，否则自激）；
2. 同一标志也使得**真正的用户打断无法在播报期间触发**。

而契约 `SpeakRequest.interruptible` 的设计意图是「由 barge-in 自动打断」，没有任何
「停止播报」端点。于是当前状态是：

- ✅ 播报期间机器人不会自激（不会听到自己然后无限自问自答）
- ❌ 用户说话**不能**打断正在进行的播报
- ❌ 没有 API 可以显式停止一次播报（`DELETE /v1/tasks/{id}` 只改任务表，不会让声音停下来）

AEC 不可用（§3）意味着「区分自己与他人」这件事目前没有技术手段。**这是 R14 的已知缺口**，
处置选项记录在设计文档里，不在本文件擅自决定。

**2026-10-24 追查：根因已定位到代码，不是硬件限制。**

`grep -n "engine.attach\|engine.connect\|engine.outputNode" scripts/mac_speech.swift` → **无匹配**。
`buildEngine()` 只做了 `engine.inputNode.installTap(...)`，从未连接输出节点。而 VPIO
（`setVoiceProcessingEnabled(true)`）的 AEC 依赖**渲染链路里的播放参考信号**：没有输出链路，
就消不了回声；同时 `try?` 把失败的 `setVoiceProcessingEnabled` 吞掉，表面上「开着 AEC」，
实际上采集到的全是静音（`bufferDb` 对空帧返回哨兵 -120）。

> 对照：§13.1 里 Node 版 AEC 实测有效，那次的采集与播放共用同一个音频图 —— 与这里只有输入
> tap 的形态不同，所以不能拿「Node 能跑通」直接推出「Swift 桥也能」。

修法方向（需改 Swift 并重签，见决策项）：给引擎接一条输出链路（哪怕只喂静音参考），
再开 VPIO；并把 `try?` 改成显式报错，避免「AEC 开着但实际是静音」这种沉默失败。

### 5.1 已修复：VPIO 下采集全静音（真正的根因是多声道 downmix）

> **2026-10-24 当天修复。** 上一段的「没有渲染链路」只对了一半；真正的根因见下。

加诊断事件 `aec_format` / `aec_convert` 后一次就看清了：

```json
{"ev":"aec_format","format_after_vpio":"4 ch, 48000 Hz, Float32, deinterleaved"}
{"ev":"aec_convert","src_ch":4,"src_peak":0.0214,"out_peak":0,"out_frames":1360,"err":""}
```

- `setVoiceProcessingEnabled(true)` **成功**（没有抛错），但把输入格式从单声道切成了
  **`4 ch / 48kHz / Float32 / deinterleaved`**；
- `AVAudioConverter` 的默认 downmix **只取第 0 声道**，而 VPIO 的 4 声道排布里音频不在第 0 声道
  ⇒ 源数据明明有 `src_peak=0.021`，转换结果 `out_peak` 恒为 `0`；
- 于是引擎在跑、tap 回调在进、VAD 拿到的却是全零帧 ⇒ `ambient_db` 恒为哨兵 `-120`。

**修法**（`scripts/mac_speech.swift`）：
1. 多声道来源先**手动等权混成单声道**（`downmixIfNeeded`），再按单声道格式建 `AVAudioConverter`；
2. 同时接一条 `mainMixer → outputNode` 渲染链路（VPIO 的常规要求）；
3. `try?` 改为显式上报 `aec_unavailable`，不再沉默失败。

**修复后实测**：`out_peak: 0.0324`、`ambient_db: -40`（不再是 -120），自动听音正常触发。

### 5.2 AEC 实测：有效但不足以支撑 barge-in

修好采集后做了对照实验（同一段中文播报，播报期间每 500ms 采一次麦克风电平，
探针事件 `aec_echo_probe`）：

| 时刻（相对播报开始） | 无 AEC | 有 AEC |
| --- | --- | --- |
| 本底（校准） | -45.2 dB | -43.0 dB |
| +0.5s | -45.7（+0） | -43.0（+0） |
| +1.0s | **-11.9（+33）** | **-51.3（-8）** |
| +1.5s | -17.3（+28） | -48.3（-5） |
| +2.0s | -14.7（+31） | **-15.2（+28）** |
| +2.5s | -15.5（+30） | **-25.8（+17）** |

括号内是相对本底的差值。

**结论：AEC 在前 ~1.5s 把回声压掉约 30dB，之后退化成只比无 AEC 好 3~13dB。**
后段电平（-15 ~ -26 dB）仍明显高于说话门限（`speech_db: -32`），**足以误触发 VAD**。

根因：`AVSpeechSynthesizer` 走的是**另一套音频图**，VPIO 的 AEC 拿不到它的播放参考信号，
自适应滤波器没有正确参考就会发散。这与「有参考信号时 AEC 工作良好」的预期一致。

### 5.3 AEC 复测（2026-10-25）：旧结论站不住，改判「有 AEC 但参考不完整」

§5.2 有两个问题：① 当时 `ambient_db` 用的是哨兵值 -120（校准没完成就播报了），
表里的「本底」是事后另取的，两组实验不同时；② 「前 1.5s 有效、之后发散」这个说法
是**只按时刻排**排出来的，看起来像时间相关，其实同一句话内部就忽好忽坏。

**复测方法**（脚本 `work/verify/aec_ab.sh`，不入库）：同一句话，`--aec` / `--no-aec` 各跑一遍，
**等 `vad_calibrated` 再播报**，避免哨兵值；每 500ms 采一次麦克风电平（`aec_echo_probe`）。

| 指标（相对本底 dB） | 无 AEC | 有 AEC |
| --- | --- | --- |
| 本底（校准 ambient_db） | -39.8 dB | -33.9 dB |
| 中位数 | **+21.7** | **+1.4** |
| 最大残留 | +31.6 | **+18.6**（-15.3 dBFS） |
| 最小（消得最狠处） | +0.3 | **-20.2** |

**改判**：VPIO 的 AEC **确实在工作**，平均压 20dB、最好处压 55dB；
但**最坏处仍残留 +18.6dB**，高于说话门限 `speech_db=-32`，**足以误触发 VAD**。

**另一条决定性证据**：VPIO 给的 4 声道是**逐样本完全相同**的同一信号
（`ch0_vs_others_max_diff = 0`，`per_ch_rms` 四个值恒等）。
所以 §5.1 那个「4 声道里含参考通道、等权混音破坏了 AEC」的推断**不成立**——
这不是「硬件 Mic + Reference 两路」，而是同一路被复制 4 份。

> 对照小智（xiaozhi-esp32）：它的 `input_format = "MR"` 是**硬件回采**——编解码器直接回读一路
> 播放信号（`codec_->input_reference()`），配 `AEC_MODE_FD_LOW_COST` +
> `AEC_NLP_LEVEL_VERYAGGR`。Mac mini 没有这种硬件回采，只有 Apple 的软 AEC（VPIO），
> 其参考信号**只能来自同一个 `AVAudioEngine` 的渲染链路**。


要真正可靠地做 barge-in，需要把 **TTS 播放也放进同一个 `AVAudioEngine`**
（`AVSpeechSynthesizer.write(_:toBufferCallback:)` 拿 PCM → `AVAudioPlayerNode` 播），
让 AEC 与播放共享同一条渲染链路。这是结构性改动，记录为待办，不在本轮实施。

### 5.4 TTS 改走本 engine 的 playerNode（2026-10-25 实现）

按 §5.2 的方向落地：`buildEngine()` 里 attach 一个 `AVAudioPlayerNode` 并
`player → mainMixer → outputNode` 接上；播报时用
`AVSpeechSynthesizer.write(_:toBufferCallback:)` 把整句合成成 PCM（回调 buffer 会被复用，
必须深拷贝），再 `player.scheduleBuffer` 播放。

- `synth.speak()` 路保留作**回退**：`playerNode` 不可用（引擎重建中）时仍能说话，
  同时发 `tts_fallback_synth` 事件，避免「AEC 静默降级」看不出来。
- 回退路径下 AEC 退回盲式抑制，语义与 §5.3 的「无 AEC」相近。

**待测**：改后同一实验的残留是否从 +18.6dB 降到门限以下（见 `work/verify/aec_ab.sh`）。

> **踩坑记录：重签即掉麦克风授权。** 每次 `build_audio_bridge.sh`（adhoc 重签）后
> TCC 回到 `notDetermined`，`serve` 会直接报 `E_MIC_PERM` 退出。必须在
> 系统设置 → 隐私与安全性 → 麦克风 里重新打开 AudioBridge，再用 `open -n -a` 起桥。
> **不能直接 spawn 二进制**：那样 `AVCaptureDevice` 报 `authorized`（残留的旧记录），
> 但 CoreAudio 拿不到设备，进程会卡死在 `HALC_ProxyObject::SetPropertyData`。
>
> （2026-10-30 已改用稳定自签身份解决，见 §5.5。）

### 5.5 稳定签名：自签证书解决「重编译即掉授权」（2026-10-30）

§5.4 结尾那个坑的根因是**签名身份不稳定**：adhoc 签名按 CDHash 识别，每编译一次就换一个
身份，TCC 认为是另一个 App。改代码 → 重编译 → 授权失效 → 手动去系统设置点一次，
单次迭代成本 1–2 分钟。

**做法**：建一个本地自签代码签名证书，签名身份因此稳定。

```sh
# 一次性准备（产物在 work/cert/，已 gitignore）
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout audiobridge.key -out audiobridge.crt -config csr.cnf   # csr.cnf: EKU=codeSigning
openssl pkcs12 -export -out audiobridge.p12 -inkey audiobridge.key \
    -in audiobridge.crt -name "AudioBridge Dev" -passout pass:devpass -des3
security create-keychain -p devks work/cert/dev.keychain-db
security import audiobridge.p12 -k work/cert/dev.keychain-db -P devpass -T /usr/bin/codesign -A
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k devks work/cert/dev.keychain-db
security add-trusted-cert -d -r trustRoot -p codeSign -k ~/Library/Keychains/login.keychain-db audiobridge.crt
```

**验证**（本次实测闭环）：`Authority=AudioBridge Dev` → 重编译一次 → 再查 `mic_auth`，
仍为 `authorized`，**不需要重新授权**。

> **两个必须记的坑**：
> 1. **空密码的 p12 在 macOS 上导入失败**（`MAC verification failed`），必须设密码。
> 2. **私钥放登录钥匙串会卡死**：`codesign` 停在 `SecKeyCreateSignature` 超过 40 秒不返回
>    （在等一个没有出现的 GUI 授权框）。改进**独立钥匙串** + `set-key-partition-list` 后，
>    签名耗时降到 **2 秒**。
>
> `build_audio_bridge.sh` 已改为优先用该身份，找不到时回退 adhoc 并在输出里说明。

### 5.6 AEC 基线：ABAB 对照实测（2026-10-30）

§5.2/§5.3 的实验方法有缺陷，本轮重做。**方法**（脚本 `work/verify/aec_ab2.sh`，不入库）：

| 项目 | 旧版 | 本轮 |
| --- | --- | --- |
| 时间顺序 | AA BB（环境漂移单向污染） | **ABAB 交替**，3 轮 |
| 本底 | 一次性静态校准 | 每轮播报前后实时测 |
| 信号源 | TTS（合成不保证逐字节一致） | **固定 WAV**（带限噪声 300–3400Hz + 4Hz 音节包络） |
| 采样间隔 | 500ms（17 点/轮） | **100ms**（约 50 点/轮） |
| 播放路径 | `synth.speak()`（系统另一套音频图） | **同一 `playerNode`** |

**为什么不用 TTS 做对照**：合成结果不能保证逐字节相同，且走系统另一套音频图，
回声源不可控。用固定 WAV 才能做 ABAB。

**结果**（本底约 -41 dB，每组 34 个探针，3 轮）：

| 指标（相对本底） | 无 AEC | 有 AEC（VPIO） | 抑制量 |
| --- | --- | --- | --- |
| 中位 | +33.4 dB | +19.2 dB | **14.3 dB** |
| P90 | +38.5 dB | +25.4 dB | 13.1 dB |
| 最大 | +39.3 dB | +26.9 dB | 12.4 dB |

三轮之间差异 < 3 dB，结论稳定。**判据**：要支撑 barge-in，回声残留须低于人声门限
（安全余量约 +8~10 dB 相对本底）。**VPIO 的 +19.2 dB 中位、+26.9 dB 最坏，不达标**。

**与 §5.3 的差异说明**：§5.3 得出「平均压 20dB、最坏 +18.6dB」，本轮是「平均压 14.3dB、
最坏 +26.9dB」。差异来源是**方法**：§5.3 用 TTS + 500ms 采样，本轮用固定 WAV + 100ms 采样。
按 §5.3 自己的说明，它的「最坏处」是单点采样撞上的值。**以本轮为准**，§5.3 的数字保留作历史。

**根本原因**（对照小智）：小智的参考信号是**硬件回采**——功放输出直接回接 ADC
（`box_audio_codec.cc`：`input_reference_ = ...; input_channels_ = input_reference_ ? 2 : 1`），
AEC 面对的只有喇叭→麦克风这一段物理路径。Mac mini 没有这种回采，VPIO 的参考只能从
I/O 链路推断，中间隔着系统混音、音量、输出设备非线性。

### 5.7 WebRTC AEC3 离线对照：同一份录音，抑制量是 VPIO 的 3 倍（2026-10-30）

**为什么测**：WebRTC 官方集成文档明确指出 *「feed the render signal correctly, before any
mixing — #1 cause of echo is a broken or fed-back reference wire, not a weak algorithm」*。
软件层「分叉参考」是正统做法，且比硬件回采更可控。

**准备**：

- 源码：`work/refs/webrtc-aec3`（Enaium/webrtc-aec3，从 WebRTC 提取的独立 AEC3，MIT）。
- 构建：本机无 cmake/ninja，用 `work/verify/build_aec3.sh` 直接调 clang 复刻 CMakeLists 的
  规则（100 个源文件，排除 x86 SIMD，保留 NEON），产出 `libwebrtc_aec3.a`（1.1 MB）。
- 评估器：`work/verify/aec3_eval.cc`（10ms 帧，`AnalyzeRender` / `AnalyzeCapture` / `ProcessCapture`）。
- 录音：桥新增 `record` 命令，把**送进 playerNode 的 PCM** 与**同时录下的麦克风信号**
  各存一份 16k 单声道 WAV（脚本 `work/verify/collect_pair.sh`）。

**为什么必须用真实录音**：AEC 的表现取决于真实房间声学（混响、传播延迟、非线性）。
合成一个线性回声去测 AEC3 只会得到漂亮但无法迁移的结论。

**结果**（同一份 `pairs/r1/{ref,mic}.wav`，48 个 100ms 窗，回声期间 41 窗）：

| 指标 | VPIO（§5.6） | **AEC3** |
| --- | --- | --- |
| 回声期间中位 ERLE | +14.3 dB | **+45.2 dB** |
| P10（较差的一侧） | — | **+31.2 dB** |
| 最坏单窗 | +12.4 dB | **+28.5 dB** |
| 整体抑制（RMS 比） | — | 37.2 dB |
| 收敛时间 | — | **无**（第一个回声窗即 41.4 dB） |

**独立复测**（第二次采集 `pairs/r2`，不同时刻、不同本底）：

| 指标 | r1 | r2 |
| --- | --- | --- |
| 中位 ERLE | +45.2 dB | **+43.3 dB** |
| P10 | +31.2 dB | **+32.0 dB** |
| 最大 | +54.5 dB | +53.5 dB |
| 最坏单窗 | +28.5 dB | +9.7 dB |
| 整体抑制 | 37.2 dB | 28.7 dB |

中位与 P10 两次相差 < 2 dB，**结论可复现**。注意 r2 的「最坏单窗」降到 +9.7 dB——
单窗极值对个别窗敏感，判据应以 **P10** 为准（两次均在 +31 dB 以上）。

> **统计口径修正（踩过的坑）**：第一版统计把静音窗也算进 ERLE，导致 P10 = 0.1 dB，
> 得到「最差情况很糟」的假结论。静音窗里 mic 只有本底，AEC3 对它的 ERLE 天然是 0 dB，
> 不说明任何问题。现判据：**只统计 mic 电平高于全窗最小值 10 dB 以上的窗**。

**局限（未验证，不可当结论）**：

1. 这是**离线**处理同一份录音，**没有验证实时链路**。实时里 `analyzeRender` 与
   `analyzeCapture` 是两条异步流，时钟偏移与缓冲延迟都还没处理。
2. 实时里喂给 AEC3 的 render 是否真的是「将要播放的那份」，需在桥里显式分叉验证。
3. CPU 开销未测（每 10ms 一帧，跨 Swift/C++ 调用）。

**结论**：B 方案（AEC3 + 软件分叉参考）**离线验证成立**，具备进入实时集成的条件；
但「实时可用」尚无证据。

### 5.8 本轮踩坑记录：四个让实验静默失效的陷阱（2026-10-30）

这四个坑的共同特征是**实验「看起来跑完了」，实际没有数据**。都是靠追加断言才暴露的。

#### 坑 1：`scheduleBuffer` 通道数不匹配 → 直接杀进程

```
*** Terminating app ... 'required condition is false:
    _outputFormat.channelCount == buffer.format.channelCount'
```

`engine.connect(player, to: mixer, format: nil)` 时，各模式 mixer 通道数不同
（VPIO 开时 4ch、关时 2ch），而 WAV 是 1ch。**不相等时抛 NSException 直接终止进程，
不是返回错误，`try` 抓不到**。

后果：`aec_ab2.sh` 的第一版六组全部在 `play_started` 之后崩溃，脚本只检查「有没有产出文件」，
于是把崩溃当成「实验完成」，汇总出一批假数据。

**修法**：连接格式显式用 `mainMixerNode.outputFormat(forBus: 0)`，播放前把 1ch 转换成该格式。
**防复发**：实验脚本每轮断言 `play_finished` 存在且 `.err` 无 `Terminating app`。

#### 坑 2：`AVAudioConverter` 在 push 模式下卡死

`conv.convert(to:error:withInputFrom:)` 的闭包只提供一次输入后返回 `.noDataNow`，
转换器可能永不返回（实测卡在 `record_started` 之后，无任何后续事件）。

**修法**：测试音是窄带信号，直接用线性插值手写重采样，行为完全可预测。

#### 坑 3：`AVAudioFile.write(from:)` 阻塞到进程卡死

在命令线程里写 WAV，两个文件都永远停在 4096 字节（只有表头）。

**修法**：音频线程只往内存数组追加样本，结束时用 44 字节标准 WAV 头手写落盘
（`writeWav16`）。WAV 头格式固定，手写反而确定性最高。

#### 坑 4：统计口径把静音窗算进去 → P10 假性为 0

AEC3 对「没有回声的窗」ERLE 天然是 0 dB。计入后 P10 = 0.1 dB，得出「最差情况很糟」的
假结论，掩盖了真实结果（+31.2 dB）。

**修法**：只统计 mic 电平高于全窗最小值 10 dB 以上的窗。

> **通用教训**：测量类实验必须**先能证伪**——脚本要断言「该发生的发生了」
> （`play_finished`、探针数量、进程无崩溃），而不是只断言「产出了文件」。
> 这次的假数据就是这样骗过三小时的。


---

## 5. 上游订阅：robotd 事件 → agentd 事件库（2026-10-24 补测）

R14 要求语音结果「只供 agentd 路由」，但在此之前 agentd 只走 REST（health/state/tasks/stop），
**一条 robotd 事件都收不到**——页面事件页只有自己启动时写的那条。

补上订阅后实测：

| 步骤 | 证据 |
| --- | --- |
| 连接 | `robotd 订阅已生效 {"filters":19,"resume_from_seq":null,"verdict":"ok","replayed":0}` |
| 播报触发 | `POST /v1/robot/speak {"text":"事件订阅已经通了。这是第二句。"}` → `t-0005 accepted` |
| 订阅侧收到 | `task.started / speech.tts_started / speech.tts_finished / task.completed`，`received=4, last_seq=37` |
| 事件库落库 | `speech.spoken`｜`播报了 2 句（实际播出 2 句）。`｜`source: robotd` |
| 页面 | `#/events` 显示「已播报 · 播报了 2 句（实际播出 2 句）」，页脚「显示 4 条」 |

**过程中修掉两个真缺陷：**

1. **事件被静默拒写**：运行时读的是生成物 `agentd/contracts/generated/events.json`，
   只改了源文件 `agentd/contracts/events.json` 却没重新生成 → `isRegistered` 判定未登记 →
   日志刷 `未登记的事件类型，拒绝写入 {"type":"speech.spoken"}`，而 `received` 增长正常，
   很容易误判成「订阅没连上」。教训：**改完登记表必须 `npm run contract:agentd`**。
2. **订阅过滤字段名与契约不符**：契约要 `event_types`（`openapi.yaml` 988/993 行），
   实现读 `types` ⇒ 按契约写的客户端过滤失效、退化成订阅全部。已以契约为准，`types` 作兼容别名。

另修一处前端渲染缺陷：`events-footer` 用 `replaceChildren(span, cond ? btn : null)`，
`replaceChildren` 不像项目里的 `el()` 那样过滤空值，`null` 被渲染成文本 ⇒ 页脚出现「显示 4 条null」。

## 6. 静音期间不得产生识别结果（2026-10-24 修复）

**缺陷**：`POST /v1/audio/mute` 后显式 `POST /v1/speech/listen` 仍会产生识别文本（实测出「你喜欢气」）。
根因：静音只拦了自动切句，`listen` 命令照常下发给桥。

**修复**：把守门下移到 `AudioRuntime.new_utterance`（HTTP 路由、自动续听、测试都经过这里），
HTTP 层对静音返回 **409 `E_STATE`**——静音是用户自己的选择，不是「依赖不可用」，UI 不该显示成错误。

**实测**：

```
POST /v1/audio/mute   → {"muted": true, ...}
POST /v1/speech/listen→ HTTP 409 {"ok":false,"error":{"code":"E_STATE",
                        "message":"当前处于静音状态，不会开始新的识别；先调用 POST /v1/audio/unmute",
                        "details":{"capability":"speech.listen","muted":true}}}
POST /v1/audio/unmute
POST /v1/speech/listen→ HTTP 200 {"task_id":"t-0001","status":"accepted"}
```

回归用例：`robotd/tests/unit/test_audio_runtime.py`（5 项，含「静音取消进行中的听音」与「桥不可用」）。
