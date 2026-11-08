# 语音回归基线（GH-14）

一条命令量出 [voice-architecture §11](../../docs/voice-architecture.md#11-验收指标含是否真流式的判据) 里的 6 项门槛，
输出 `baseline-YYYYMMDD.json` + 人类可读摘要。**需要麦克风/喇叭的项只会在真机上 measured；
缺硬件时逐项标 `SKIP: <原因>`，绝不把 SKIP 写成 PASS。**

```sh
sh eval/voice/run_baseline.sh                 # 一条命令：自动补夹具 → 连跑两次 → 判定
sh eval/voice/run_baseline.sh --repeat 1      # 只跑一次（不判两次波动）
sh eval/voice/run_baseline.sh --seed-baseline # 首次播种 eval/voice/baseline.json
sh eval/voice/run_baseline.sh --no-playback   # 不出声：TTS 首包标 SKIP
sh eval/voice/run_baseline.sh --with-long-run # 额外跑 30 分钟麦克风长采集

# 同一天要留两次完整运行（判据 3 的证据）时，用 --out 各存一份：
sh eval/voice/run_baseline.sh --out eval/voice/runs/run1.json
sh eval/voice/run_baseline.sh --out eval/voice/runs/run2.json
```

也可以 `make voice-baseline` / `npm run test:voice`（不进 push CI：需要硬件）。

退出码：

| 码 | 含义 |
| --- | --- |
| 0 | 6 项全部 `measured` 且全部 PASS |
| 1 | 至少一项 FAIL（绝对值超门槛，或相对基线退步 > 20%） |
| 2 | 参数/夹具/工具链错误（报告不完整，属于脚本或标注的问题） |
| 3 | 不完整：有指标 `SKIP`（缺硬件/权限），但报告本身完整可用 |

## 1. 六项指标与可测性

| 指标 | §11 门槛 | 离线（`--file` 喂夹具） | 真机（麦/喇叭） | 本轮的 basis |
| --- | --- | --- | --- | --- |
| 首字延迟 | P95 ≤ 800ms | ✅ | ✅ | 音频时间轴：首个 partial 的 `audio_end_ms` − VAD 判开口的 `audio_ms` |
| ASR 最终延迟 | P95 ≤ 1500ms | ✅ | ✅ | file：`endpoint.silence_ms` + finalize 尾巴；mic：墙钟「静音起点 → final」 |
| TTS 首包 | P95 ≤ 800ms | ❌ 无播放器 | ✅ | `tts_chunk_started[0]` − `tts_started` |
| 打断响应 | P95 ≤ 300ms | ❌ 需回声 | ✅ | 用户开口 → 停止播放（同一进程两侧事件） |
| 自听误触发率 | 播放期 = 0 | ❌ 需回声 | ✅ | 播放期 VAD 判开口次数 |
| 采集连续性 | 30 分钟无断流 | ❌ 无设备 | ✅ | `--trace` 的 feed 心跳最大间隔（代理阈值 2s） |

**只覆盖这 6 项。** §11 的另外 5 项（中文 CER、端点检测误切/漏切、说话人归属、人物跟踪、运动安全）
**不在本基线内**：CER 需要人工标注真值语料，说话人归属/人物跟踪需要带标签的真人录音与轨迹，
运动安全是固件看门狗判据。不要让读者以为这条链路覆盖了 §11 全部。

### 为什么首字/最终用音频时间轴

`mac_speech.swift stream --file` 灌文件比实时快得多（脚本注释原话：「文件模式灌数据比实时快得多」）。
如果直接用墙钟，首字延迟会变成「ASR 算多快」而不是「说多久才出字」，5s 与 60s 夹具也不可比。
所以这两项的基准点取事件自带的音频轴：`speech_state.audio_ms`、`partial.audio_end_ms`、
`endpoint.silence_ms`。只有「端点之后 finalize 的尾巴」和真机麦克风模式才用墙钟。

## 2. 采集层：逐行流式读 + 同时落盘（GH-45）

采集器（`run_stream_file` / `run_tts_playback` / `run_stream_mic`）统一走 `run_streaming()`：
`subprocess.Popen(..., bufsize=0)` 起进程拿裸管道，再用
`io.TextIOWrapper(..., encoding="utf-8", errors="replace", newline="")` 自己包一层读侧。
`read(8192)` 是一次 `read(2)`，有多少读多少，不会攒满 8 KiB 或等到 EOF 才把行交出来：
每读到一行就 ① 解析成事件 ② 原样追加写盘 ③ 交给回调（`on_event` 因此在子进程还在跑时就能拿到行）。
stderr 同样逐行写 `*.stderr.log`（`--trace` 心跳靠它）。`speak-stream` 的 `text\nend\n`
喂法由 `stdin_lines` 参数负责。

每次运行一个目录 `eval/voice/runs/<UTC 时间戳>/`（gitignore），里面是
`<fixture>.<clip>.run<N>.ndjson`（逐行原样落盘的事件）+ 同名 `*.stderr.log`。
要固定目录（例如把两次运行并排比较）用 `--runs-dir <dir>`；默认按 UTC 时间戳新建。
报告 JSON 的 `runs_dir` 指向这个目录，`fixtures[].clips` / `runs[]` 与 `failed_runs[]`
里带着每条运行的 `events_path`。以前只有聚合结果，现在能拿着报告回去看「哪条事件的哪一段变慢了」。

**超时/崩溃不再丢事件。** 到时间先 `terminate()`（5s 内不退再 `kill()`），然后照常返回
已经读到的事件：`error.code = "E_TIMEOUT"`，`events` 保留。非零退出同理，
`error.code = "E_EXIT_<code>"`。`ok` 仍然是 `error is None and bool(events)` ——
有 error 就是 `False`，半截数据不会被当成完整样本；这些运行会记进报告的 `failed_runs`，
能看到「跑到第几个事件才停」以及原始文件路径。

**读线程卡住也会说出来，而不是悄悄少一截。** 如果子进程把 stdout 写端交给了孙进程，
EOF 永远不来，`proc.wait()` 能返回但读线程还活着。`run_streaming()` 在
`terminate_grace` 后检查 `is_alive()`：活着就给结果加 `truncated` / `dropped_tail`、
`error.code = "E_TAIL_LOST"`，并在落盘 `.ndjson` 尾部追加一行
`{"truncated": true, "reason": "reader_alive_after_join"}`（**只进文件，不进 `events`**，
逐字段比较不受影响）。这条样本会被标成不完整，而不是 `ok: true`。

流式读**只改变「什么时候拿到事件」**，不改变「事件里自带的时间戳」：首字仍用
`partial.audio_end_ms − speech_state.audio_ms`，final 仍用 `endpoint.silence_ms` + finalize 尾巴，
TTS 首包仍用进程内 `ts_mono_ns` 差。落盘的 `.ndjson` 是桥输出的原样行，
`ts_mono_ns` / `audio_ms` / `audio_end_ms` 与改前逐字段一致。

## 3. 已知限制（都写进 JSON，不藏）

- **`--file` 仍要求麦克风授权。** `scripts/mac_speech.swift` 的 `stream` 在解析 `--file` 之前就检查
  `micAuth()`，所以「没授权」时离线车道同样起不来。脚本会如实标
  `SKIP — needs-mic-permission`，不会假装测到。是否要给 `--file` 单独放行，见本轮 handoff 的 Q1。
- **纯静音也会吐 final 信封。** `--file` 到 EOF 总会发一个 `final`（可能空文本）。D 类判据是
  「空文本 final 不算语音 final」，即 `speech_finals == 0`。
- **TTS 首包含进程启动。** 桥的 `tts_started` 在进程启动时发出，比脚本写入文本早几毫秒；
  这个常数对所有运行一致，用于回归比较没问题，但不要拿它和外部工具的数字硬比。
- **`replay` 模式不是硬件证据。** `--replay-dir` 只用于单测和演示：报告里 `host.replay=true`、
  `device.source=replay`，摘要会写「合成事件，不是硬件证据」。验收要贴的数字必须来自真机。
- **环境噪声没有量化。** issue 明确不做实验室级标定；报告里 `environment.ambient_db=null` 并注明原因。
- **签名信息记为 `unknown`。** TCC 身份属于执行基线的宿主 App，本轮没有 `--mic-uid`；报告
  `device.signature` 如实写 `unknown` 并说明原因，不编造。
- 桥目前不吐帧序号。采集连续性用 `stream --trace` 的 `feed #N … t=…ms` 心跳（每 ~1s 一行）
  判「采集还在走」，并检查 feed 序号单调；这是存活/节奏代理，不是逐帧序号。长采集会把
  `--idle-timeout` 拉到运行时长以上，否则安静房间会在 20s 空闲超时处提前收尾。

## 4. 基线与回归判据

- `eval/voice/baseline.json` 入库；首次由真机跑出来，用 `--seed-baseline` 写入。**播种后的基线与
  运行报告同构**（同一份 JSON，`seeded: true`），逐字段可比；SKIP 的指标保留但 `p95` 为 `null`，
  不参与相对回归。
- **replay 不允许播种**：`--replay-dir --seed-baseline` 直接以退出码 2 拒绝，否则等于把合成事件
  洗成硬件基线。
- 每次判定同时生效两条，**取严**：
  1. §11 绝对值：首字 800ms、final 1500ms、TTS 首包 800ms、打断 300ms、自听 0 次；
  2. 相对退步：`(本次 p95 − 基线 p95) / 基线 p95 > 20%` → FAIL。
- 基线未播种时只判绝对值，摘要会明确写「未播种」。**播种后**两次运行的波动还会单独检查
  （`--repeat`，默认 2）：同一台机、同一次会话内连跑，波动 > 20% → FAIL。
- `capture_continuity` 的 2s 是**本仓库代理阈值**，§11 没有给数字；报告里
  `threshold_source` 会写明，别把它当官方门槛。

## 5. 怎么新增一个夹具（不改脚本）

新增场景 = **加一个 JSON**。放哪里：`eval/voice/fixtures/` 下任意层级（子目录按场景分组）。脚本递归发现
`*.json`，字段校验失败会列出全部问题并以退出码 2 结束（fail closed，不猜）。

必填字段（`notes` 必须说明来源与限制，不能留空）：

```json
{
  "fixture": "a_single_zh_8s",
  "kind": "single_utterance",
  "duration_ms": 8000,
  "source": "synthesized",
  "voice": "zh-CN",
  "expected": {"utterances": 1, "texts": ["大致台词，不是 CER 真值"]},
  "notes": "为什么加这个夹具、它守哪条判据",
  "generate": {
    "segments": [
      {"name": "a_single_zh_8s", "text": "……", "lead_ms": 900, "tail_ms": 1400, "rate": 0.5}
    ]
  }
}
```

可选扩展字段（本仓库定义）：

- `generate.segments[]`：每一段是一段独立音频，按声明顺序跑完就是「轮流」；`voice_slot: "A"|"B"`
  表示从 `mac_speech list` 的中文音色里取第 1/2 个（解析结果写进 `.generated.json`，不进 git）；
- `generate.segments[].voice`：直接指定音色 identifier；
- 静音夹具用 `kind: "silence"` + `generate.silence_ms`（脚本用标准库写 16bit 单声道 WAV，
  不走 `speech_fixture.swift`——它对空文本会 `E_TTS_EMPTY`）。
- 真人录音用 `source: "recorded"` + 顶层 `audio`（字符串或字符串数组，路径相对标注文件），
  例如 `"audio": ["rec_a.caf", "rec_b.wav"]`；`expected.texts` 按下标对应每一段。

音频文件**不入库**：`.caf`/`.wav` 由 `run_baseline.sh` 在缺失时用
`scripts/speech_fixture.swift` 现场合成（幂等；已存在就不动），`.gitignore` 已排除。
生成结果旁边会写 `<audio>.generated.json`（生成参数 + sha256），同样不入库。

### source 必须诚实

| source | 含义 | 脚本行为 |
| --- | --- | --- |
| `synthesized` | TTS 合成（`speech_fixture.swift`） | 缺文件时自动合成；`expected.texts` 只是大致台词，**不能**当 CER 真值 |
| `recorded` | 真人录音 | **绝不自动生成**；缺文件标 `needs-recording`，必须人工放到位 |
| `pending-hardware` | 现在造不出来（C 类） | 不参与测量；如果旁边出现 `.caf/.wav`，校验直接判红（防「拿假 CAF 冒充真机」） |

`source=pending-hardware` 的夹具还要求 `expected.utterances = 0`、不许带 `generate`。

## 6. C 类（机器人播放 + 用户插话）为什么只有目录

它需要真扬声器输出、真实房间回声、真实人声插入，合成不出来。所以
`fixtures/c_barge_in/` 里只有 `barge_in.json`（`source: pending-hardware`），
**没有音频**。打断响应/自听误触发率两项在真机 harness（#41 AEC harness）落地前一律
`SKIP: needs-hardware`——这是 #41 的验收对象，不是本链路能测的。

## 7. 文件清单

| 文件 | 作用 |
| --- | --- |
| `run_baseline.sh` | 薄壳；`sh` 兼容，可在任意目录调用 |
| `voice_baseline.py` | 全部逻辑：夹具校验/生成、驱动桥（`run_streaming` 逐行读）、解析 NDJSON、p50/p95、判定、摘要（仅标准库） |
| `baseline.json` | 入库基线（未播种时 `seeded: false`，只判绝对值） |
| `fixtures/*.json` | 夹具标注（唯一需要提交的夹具文件） |
| `tests/test_voice_baseline.py` | 纯逻辑单测（`python3 -m unittest discover -s eval/voice/tests`） |
| `tests/data/*.ndjson` | 回放用事件样本（单测/演示，不是硬件证据） |
| `runs/` | 每次运行的报告 JSON + `runs/<UTC 时间戳>/` 下的原始事件 `*.ndjson` / `*.stderr.log`（gitignore） |

## 8. 贴证据的最低要求（PR）

1. 同一台机、同一次会话连跑两次的**完整 JSON**（不是摘要）；
2. 一次「故意注入退步」的 FAIL 输出（例如把某次采样翻倍）；
3. 无权限/无硬件机器上的一次运行，必须看到 4 项 `SKIP`、其余 `measured`、退出码 3。
