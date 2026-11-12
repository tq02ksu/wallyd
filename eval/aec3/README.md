# AEC 实验脚本（R14）

这里的脚本分两类：`smoke_voice.sh` 走默认生产桥，证明正式播报链路通、扬声器真的
播出去；其余脚本用来**量化**回声消除效果，不靠听感。结论见
[`../r14-voice-bringup-2026-10-24.md`](../r14-voice-bringup-2026-10-24.md) §5.6–§5.8。

## 依赖

- `smoke_voice.sh`：桥用**默认生产构建**（正式命令面 8 条）：
  `sh scripts/build_audio_bridge.sh` → `work/bin/AudioBridge.app`
- `aec_ab2.sh` / `collect_pair.sh`：桥用**测试专用 harness 构建**：
  `WALLY_AUDIO_TEST_HARNESS=1 sh scripts/build_audio_bridge.sh`
  → `work/bin/AudioBridge.app`
- 麦克风授权：稳定签名已生效时无需反复授权（见 eval §5.5）
- AEC3 源码（仅 `build_aec3.sh` 需要）：入库到 `third_party/webrtc-aec3/`，
  用固定 commit/tag 拉取（需要网络）：
  ```sh
  sh scripts/vendor-aec3.sh <commit-or-tag>
  ```
  该库为 MIT 许可；vendor 脚本会校验 `LICENSE` 与 `src/` 后才入库。
  `work/refs/webrtc-aec3` 仅作为本地离线实验的回退路径。

## 正式播报冒烟（GH-58）

`smoke_voice.sh` 走**默认生产桥**与正式 `speak` 命令，不依赖测试 harness 命令，
按 #41 的 B1–B7 判定。它证明「链路通 + 真的播出去（`tts_played > 0`）」，
**不证明 AEC 消得掉**；最终真机 PASS 证据由 #41 收集。

```sh
# 前置：默认生产构建（不要加 WALLY_AUDIO_TEST_HARNESS=1）
sh scripts/build_audio_bridge.sh

# 正式命令（Mac mini 真机，麦克风 + 扬声器）
bash eval/aec3/smoke_voice.sh
```

产出（`SMOKE_VOICE_OUT` 可改目录）：

- `work/verify/smoke_voice/events.ndjson`：完整 NDJSON 事件
- `work/verify/smoke_voice/stderr.log`：完整 stderr

脚本先打印事件计数（重点是 `tts_chunk_finished` 次数与 `tts_played` 的
`played` 数值，例如 `played: 1,2,3；最大值 3`），再逐条打印 PASS/FAIL：

| # | 断言 |
| --- | --- |
| B1 | 见过 `bridge_ready`（且 `engine_started=true`） |
| B2 | 见过 `tts_started` |
| B3 | `tts_chunk_finished` 计数 > 0 |
| B4 | 见过 `tts_played`，且 `played > 0`（`dry_run=true` 不算） |
| B5 | 见过 `tts_finished`，`stop_reason=done`，未被 `tts_cancelled` 掐断 |
| B6 | stderr 无 `Terminating app` |
| B7 | 播报窗口内 `speech_state` / `aec_echo_probe` 持续更新（≥3 次且覆盖窗口 ≥50%） |
| C0 | `bridge_ready` **没有** `test_harness: true`（必须是默认生产构建） |

**故意失败**（同一脚本证明 B4 真的会红）：把文本设为空串。桥回 `E_TTS_EMPTY`，
没有 `tts_started` / `tts_played`，B2/B3/B4/B5/B7 必须 FAIL：

```sh
SMOKE_VOICE_TEXT="" bash eval/aec3/smoke_voice.sh
```

**离线验证断言**（不需要设备；固定 fixture 在 `eval/aec3/fixtures/`）：

```sh
# 直接跑断言层：成功 fixture → PASS
python3 eval/aec3/voice_smoke.py \
  --events eval/aec3/fixtures/smoke_voice_pass.ndjson \
  --stderr eval/aec3/fixtures/smoke_voice_pass.stderr --response-id smoke-voice

# 全部离线判据（含「played 改成 0 / 删掉 tts_played 必须变红」的反向用例）
(cd robotd && uv run --locked python -m pytest tests/unit/test_smoke_voice.py -q)
```

退出码：0 = PASS；1 = FAIL；2 = 参数或前置缺失；**77 = SKIP**。非 Darwin、
`E_MIC_PERM`（TCC 未授权）、`E_MIC_OPEN`（无输入设备/被占用）或
`engine_started=false` 时明确打印 `SKIP: <原因>` 并退出 77；**SKIP 不是 PASS**，
真实设备缺失不会被写成绿。

> 注意：跑过 `aec_ab2.sh` / `collect_pair.sh` 的 harness 构建后，要先
> `sh scripts/build_audio_bridge.sh` 重建默认桥再跑 `smoke_voice.sh`，
> 否则 C0 会因 `test_harness=true` 判 FAIL。

## 桥的构建身份判据（GH-65）

`aec_ab2.sh` / `collect_pair.sh` 不再用 `grep` 字面量匹配 `bridge_ready`：桥输出的是
紧凑 JSON（`"test_harness":true`，冒号后**没有**空格），带空格的 grep 会把已经启动
并校准好的 harness 实验误判成「未用测试构建」。两者改调共用断言层
`aec_assert.sh`，它复用 `voice_smoke.py` 的 `bridge_ready()` /
`check_harness_or_production()` / `check_aec_mode()`，**解析 JSON 读字段**，与排版无关。

```sh
# 声明的构建身份：必须是 JSON true（不是字符串 "true"）
sh eval/aec3/aec_assert.sh bridge work/verify/ab2/1-aec.out --require-harness

# ABAB 的证伪锚点：桥必须真的进了 aec3，`--aec3` 被忽略时这里变红
sh eval/aec3/aec_assert.sh bridge work/verify/ab2/1-aec3.out --require-harness --expect-aec-mode aec3

# 这一轮真的播完了（缺 play_finished 即失败）
sh eval/aec3/aec_assert.sh play work/verify/ab2/1-aec.out
```

输出每个判据一行 `PASS`/`FAIL`（`C0` 构建身份、`C0b` AEC 模式、`P1` 播完），
最后一行是总结论。退出码：`0` = 断言通过；`1` = 断言失败；`2` = 输入/参数错误。

`aec_ab2.sh` **汇总每组的退出码**：任一组失败即非零退出，只有全部通过才打印
`OK`。以前末行是无条件 `echo OK`，六组全崩也会显示 OK——那正是 GH-65 的另一半。
离线副本：`(cd robotd && python3 -m unittest tests.unit.test_aec_assert -v)`。

换路径/离线复跑时可用 `AEC_AB2_APP` / `AEC_AB2_WAV` / `AEC_AB2_OUT` 覆盖桥、
测试音和输出目录（一般不用改）。

## 测试专用 WAV 通道（GH-55）

`play` / `record` 已从正式桥的命令面删除，正式命令只有
`listen / stop / mute / unmute / speak / stop_speak / status / quit`。
`eval/aec3` 用**独立编译开关**打开的测试通道，而不是把生产命令加回来：

| 命令 | 作用 | 事件 |
| --- | --- | --- |
| `harness_play_wav` | 把固定 WAV 送上**生产同一条** `ServeBridgeV2` → `playerNode` → 扬声器链路 | `play_started` / `play_finished` |
| `harness_record_pair` | 播同一份 WAV，同时录 `<dir>/ref.wav`（走 playerNode 的测试音 PCM，降到 16k 单声道）与 `<dir>/mic.wav`（采集链路 16k 单声道） | `record_read` / `record_started` / `record_scheduled` / `record_finished` |

两条命令只在 `WALLY_AUDIO_TEST_HARNESS=1` 构建里存在；默认构建不认识它们，
回 `E_CMD_UNKNOWN`（`robotd/tests` 与 `scripts/apple/Tests` 双重锁住）。
开启时 `bridge_ready` 会多一个字段：

```json
{"ev": "bridge_ready", "test_harness": true, ...}
```

（真实输出是紧凑 JSON，冒号后没有空格；文档这里加空格只为可读。）
脚本把 `test_harness=true` 当作**证伪锚点**：没回报就判实验作废。
默认构建里命令被忽略时只会得到 `FAIL`，不会产出「没有回声数据却看起来跑完」的假实验。

harness 播报期间仍会按生产的 100ms 节奏发 `aec_echo_probe`，所以 ABAB 的
`.out` 里数据口径与真实播报一致。

## 脚本与顺序

| 脚本 | 作用 | 产出 |
| --- | --- | --- |
| `smoke_voice.sh` | 正式播报冒烟（默认生产桥 + `speak`，B1–B7） | `work/verify/smoke_voice/{events.ndjson,stderr.log}` |
| `aec_assert.sh` | 实验桥断言层（`bridge` / `play`，解析 JSON，不 grep 字面量） | 终端 + 退出码 |
| `make_probe.py` | 生成固定测试音（带限噪声 300–3400Hz + 4Hz 音节包络，纯标准库） | `work/verify/aec_probe.wav` |
| `aec_ab2.sh` | ABAB 对照：`--aec` / `--no-aec` 各 3 轮，100ms 采样（走 `harness_play_wav`） | `work/verify/ab2/*.out` |
| `collect_pair.sh` | 录一对真实的「参考信号 + 麦克风信号」WAV（走 `harness_record_pair`） | `work/verify/pairs/rN/{ref,mic}.wav` |
| `build_aec3.sh` | 用 clang 编译 AEC3 静态库（本机无 cmake/ninja） | `work/verify/build/libwebrtc_aec3.a` |
| `aec3_eval.cc` | 离线跑 AEC3，输出逐窗 ERLE 统计 | 终端 + 可选残差 WAV |

典型流程：

```sh
python3 eval/aec3/make_probe.py

# 0) 用测试专用 harness 构桥（默认构建不含 harness 命令）
WALLY_AUDIO_TEST_HARNESS=1 sh scripts/build_audio_bridge.sh

# 1) VPIO 基线（约 2 分钟，需安静）
sh eval/aec3/aec_ab2.sh 3

# AEC3 对照（需要桥实现 --aec3；桥必须回报 aec_mode=aec3，否则实验作废）
sh eval/aec3/aec_ab2.sh 3 aec3

# 步骤 1 的逐样本验收：包装层输出必须与 aec3_eval 逐字节一致
python3 eval/aec3/compare_wav.py work/verify/eval.wav work/verify/wrapper.wav

# 2) 真实录音 + AEC3 离线对照
sh eval/aec3/collect_pair.sh work/verify/pairs/r1
sh eval/aec3/build_aec3.sh
clang++ -std=c++20 -O2 -m64 -DWEBRTC_MAC -DWEBRTC_POSIX \
  $(for d in src src/api src/base/rtc_base src/base src/base/system_wrappers/include \
     src/audio_processing src/absl src/base/jsoncpp/include src/audio_processing/aec3 \
     src/audio_processing/resampler src/audio_processing/logging src/audio_processing/include \
     src/audio_processing/utility src/rtc_base/experiments src/common_audio \
     src/common_audio/third_party/ooura/fft_size_128; do echo -n "-Iwork/refs/webrtc-aec3/$d "; done) \
  eval/aec3/aec3_eval.cc work/verify/build/libwebrtc_aec3.a -o work/verify/build/aec3_eval
./work/verify/build/aec3_eval \
  --render work/verify/pairs/r1/ref.wav --capture work/verify/pairs/r1/mic.wav --delay-ms 25
```

> 脚本里的相对路径按「在项目根目录执行」写的。直接 `sh eval/aec3/<脚本名>` 即可，
> 脚本内部会自己 `cd` 到项目根。

## 四条纪律（都是踩出来的，见 eval §5.8）

1. **实验必须能证伪**：ABAB 先断言 `bridge_ready.test_harness` 是 JSON `true`（否则实验作废），
   再断言 `play_finished` 存在、探针数够、进程无 `Terminating app`，录制的 WAV 非空。
   `smoke_voice.sh` 反过来要求 `bridge_ready` **没有** `test_harness`，并断言
   `tts_played.played > 0`。只断言「产出了文件/跑完了」会让崩溃或被忽略的命令伪装成成功。
2. **对照必须 ABAB 交替**，不能 AA BB——环境漂移会单向污染一组。
3. **测试音用固定 WAV**，不用 TTS：合成结果不保证逐字节一致，且走系统另一套音频图。
4. **统计只算有回声的窗**：静音窗的 ERLE 天然是 0 dB，计入会把 P10 拉成 0。

## 环境要求

- 默认输入 `HDI Webcam USB`，默认输出 Mac mini 内置。换设备用桥的 `--mic-uid`。
- 实验期间**保持安静、不要调音量**：本底变化会直接改变相对电平。
- 同一时刻只能有一个桥进程占麦克风。
