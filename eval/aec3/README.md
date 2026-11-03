# AEC 实验脚本（R14）

这里的脚本用来**量化**回声消除效果，不靠听感。结论见
[`../r14-voice-bringup-2026-10-24.md`](../r14-voice-bringup-2026-10-24.md) §5.6–§5.8。

## 依赖

- 桥二进制：`sh scripts/build_audio_bridge.sh` → `work/bin/AudioBridge.app`
- 麦克风授权：稳定签名已生效时无需反复授权（见 eval §5.5）
- AEC3 源码（仅 `build_aec3.sh` 需要）：
  ```sh
  git clone --depth 1 <Enaium/webrtc-aec3 镜像地址> work/refs/webrtc-aec3
  ```
  该库为 MIT 许可。**源码与编译产物都不入库**，放在 gitignore 的 `work/` 下。

## 脚本与顺序

| 脚本 | 作用 | 产出 |
| --- | --- | --- |
| `make_probe.py` | 生成固定测试音（带限噪声 300–3400Hz + 4Hz 音节包络，纯标准库） | `work/verify/aec_probe.wav` |
| `smoke_play.sh` | **单次播放冒烟**：断言播放真的完成、探针够数、进程没崩 | 终端 PASS/FAIL |
| `aec_ab2.sh` | ABAB 对照：`--aec` / `--no-aec` 各 3 轮，100ms 采样 | `work/verify/ab2/*.out` |
| `collect_pair.sh` | 录一对真实的「参考信号 + 麦克风信号」WAV | `work/verify/pairs/rN/{ref,mic}.wav` |
| `build_aec3.sh` | 用 clang 编译 AEC3 静态库（本机无 cmake/ninja） | `work/verify/build/libwebrtc_aec3.a` |
| `aec3_eval.cc` | 离线跑 AEC3，输出逐窗 ERLE 统计 | 终端 + 可选残差 WAV |

典型流程：

```sh
python3 eval/aec3/make_probe.py

# 1) 先冒烟，确认播放链路没坏（这一步能挡住绝大多数"假实验"）
sh eval/aec3/smoke_play.sh --no-aec
sh eval/aec3/smoke_play.sh --aec

# 2) VPIO 基线（约 2 分钟，需安静）
sh eval/aec3/aec_ab2.sh 3

# 3) 真实录音 + AEC3 离线对照
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

> 脚本里的相对路径按「在项目根目录执行」写的。直接 `sh eval/aec3/xxx.sh` 即可，
> 脚本内部会自己 `cd` 到项目根。

## 四条纪律（都是踩出来的，见 eval §5.8）

1. **实验必须能证伪**：断言 `play_finished` 存在、探针数够、进程无 `Terminating app`。
   只断言「产出了文件」会让崩溃伪装成成功。
2. **对照必须 ABAB 交替**，不能 AA BB——环境漂移会单向污染一组。
3. **测试音用固定 WAV**，不用 TTS：合成结果不保证逐字节一致，且走系统另一套音频图。
4. **统计只算有回声的窗**：静音窗的 ERLE 天然是 0 dB，计入会把 P10 拉成 0。

## 环境要求

- 默认输入 `HDI Webcam USB`，默认输出 Mac mini 内置。换设备用桥的 `--mic-uid`。
- 实验期间**保持安静、不要调音量**：本底变化会直接改变相对电平。
- 同一时刻只能有一个桥进程占麦克风。
