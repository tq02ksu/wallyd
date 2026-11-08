---
title: GH-6 实时 AEC3、speech_abort 与 barge-in 门限
type: design
description: 新增 POST /v1/speech/abort，把「停止播报」与「取消任务」分开；用 AEC3 离线证据重定 barge-in 的 ERLE 底线与残余余量；给出实时 AEC3 的入库与验证方案。
tags: [design, voice, audio, barge-in, aec, aec3, contract]
domain: robot
project: wallyd
status: draft
---

# GH-6 实时 AEC3、speech_abort 与 barge-in 门限

## 1. 目标与边界

落实 issue #6（V03）。经过 #5（`main@e46d453`）之后，本 issue 的真实工作量已经变化：

- `suppressAuto` **已删除**（`test_voice_bridge_architecture.py::test_bridge_does_not_suppress_vad_during_playback`
  守着），不再有「解开它」这一步；
- 播报期 VAD 已经能走到 `AudioRuntime`，并产 `speech.gate`、按判定 `abort_response("barge_in")`；
- 本 issue 剩下的是：**对外停止播报能力**、**按 AEC3 证据重定门限**、**打断计数自洽**、
  以及**实时 AEC3 的入库与集成**（第 6 节）。

不做的事（与 issue 一致）：

- 不改 #5 的判定结构（`_barge_in_verdict()` 四条分支与「缺证据 → suppressed」方向）；
- 不把 AEC3 塞进 robotd：AEC3 属桥侧（Swift/C++），robotd 只消费 `aec_erle_db` 事实；
- 不引入多通道麦 / 声源定位；
- 不新增 `speech.interrupted` / `speech.aborted` / `tts_chunk_dropped` 事件类型；
- 不重排 #16 的出话管道（split → synth → BoundedQueue → render）。

## 2. 契约：`POST /v1/speech/abort`

`contracts/openapi.yaml` 新增 `speech_abort`：

```yaml
POST /v1/speech/abort      # operationId: speech_abort, tags: [speech]
body: { response_id?: string }   # 省略 = 停掉当前所有播报
200 -> TaskAccepted
```

语义要点：

1. **这是正常结束，不是失败**。`DELETE /v1/tasks/{id}` 是「取消任务」，上层会把没说完的
   回答当成失败；barge-in / 用户说「停」是正常结束。
2. **幂等**：无活动播报时同样 200，不报 404。用户可能连说两次「停」。
3. `response_id` 给了但当前不是那一轮：不误伤别的播报，仍返回 200。
4. 中止事实以事件为准：`speech.tts_cancelled {reason:"user_cancel" | "barge_in", played, dropped?}`。

事件侧**不新增类型**：

- `speech.tts_cancelled.reason` 增加显式枚举，`barge_in` 与 `user_cancel` 可区分；
- `speech.tts_cancelled` 增加可选 `dropped`（合成完成但因中止未播出 = `finished_n − played`）
  与 `queue_dropped`（桥的有界队列因满丢弃，背压事实，单列），只在真有时出现；
- `speech.interrupted` 保留登记但继续零 emit；它不表达「谁打断的」。

生成物由 `npm run contract:generate` 产生，不手改。

## 3. 实现落点

| 层 | 变更 |
| --- | --- |
| `contracts/openapi.yaml` | `speech_abort` 路径 + `SpeechAbortRequest` |
| `contracts/events.json` | `tts_cancelled.reason` 枚举 + `dropped` |
| `robotd/capabilities.py` | `speech.abort` 能力（public `speech_abort`） |
| `robotd/api/http.py` | `_h_speech_abort` + 路由 |
| `robotd/config.py` | `barge_in_erle_margin_db` / `barge_in_erle_floor_db` + JSON 配置文件层 |
| `robotd/core/audio_runtime.py` | `abort_speaking()`、`finished/played/queue_dropped` 计数、门限来自配置并回显 |
| agentd | 不改代码；`normCancelReason()` 已放行 `barge_in` 与 `user_cancel`（映射名 `speech.speak_cancelled`） |

`abort_speaking(response_id=None, reason="user_cancel")` 与 `abort_response()` 的分工：
前者是用户显式「停止播报」，后者仍被 `robot_stop` / barge-in 复用。两者都走同一条
「本地立即发 `tts_cancelled` + 通知桥 `stop_speak`」路径。

## 4. 门限取值：旧值 → 新值 → 依据

| 常量 | 旧值 | 新值 | 依据 |
| --- | --- | --- | --- |
| `BARGE_IN_ERLE_FLOOR_DB` | `6.0` | **`20.0`** | AEC3 两次真实录音 P10 为 +31.2 / +32.0 dB（`eval/r14-voice-bringup-2026-10-24.md` §5.7）。20 dB 比 P10 低约 11 dB，仍接纳实时较差帧；6 dB 会把「几乎没压」的帧当成可用判据。 |
| `DEFAULT_BARGE_IN_ERLE_MARGIN_DB` | `30.0` | **`15.0`** | 无 AEC 回声 P90 +38.5 dB 相对本底，AEC3 P10 ERLE +31.2 dB → 差侧残余约 +7.3 dB；加约 8 dB 安全余量 ≈ 15 dB。旧值 30 来自 VPIO 最坏 +26.9 dB + 3 dB。 |

推导表（相对本底，dB）：

| 量 | 数值 | 来源 |
| --- | --- | --- |
| 无 AEC 回声中位 / P90 / 最大 | +33.4 / +38.5 / +39.3 | §5.6（ABAB，3 轮） |
| VPIO 回声中位 / 最大 | +19.2 / +26.9 | §5.6 |
| AEC3 ERLE 中位 | +45.2（r1）/ +43.3（r2） | §5.7 |
| AEC3 ERLE P10 | +31.2（r1）/ +32.0（r2） | §5.7 |
| 差侧残余 ≈ 无 AEC P90 − AEC3 P10 | **+7.3** | 38.5 − 31.2 |
| 加安全余量 8 dB | **15.3 → 15** | 本设计取值 |

**这是离线证据支持的暂定值，不是真机结论。** r2 的最坏单窗 ERLE 只有 +9.7 dB，
对应残余约 +28.8 dB；那一类极端窗仍可能需要 30 dB。因此：

- 判据 3（播报中静默 30 分钟 0 误触发）**未验证**；
- 若真机出现自听误触发，**回退 margin 到 30 dB**，而不是继续压门限；
- `speech.gate` 每次 VAD 上升仍然必发，`reason` 分布（`echo` / `barge_in` / `no_erle`）
  是观察门限是否合适的唯一时间线证据。

### 4.1 运行时可覆盖且可观测（2026-11-08 裁决 D2）

`margin` 与 `floor` 都从 `Config` 读，默认仍是 **15.0 / 20.0**，可用配置文件
（`--config <path>` 或 `ROBOTD_CONFIG`，扁平 JSON，键为配置字段名）或环境变量
`ROBOTD_BARGE_IN_ERLE_MARGIN_DB` / `ROBOTD_BARGE_IN_ERLE_FLOOR_DB` 覆盖。
**默认值不许改大**；配置文件里的未知键直接报错（拼错键静默沿用默认值会让「配置里写了 30」
变成假话）。

`GET /v1/audio/state` 回显**实际生效**的 `barge_in_erle_margin_db` /
`barge_in_erle_floor_db`，以及 `barge_in_erle_overridden`（`["margin"]` / `["floor"]` /
两项 / 空数组）。真机上不必翻代码就知道判据跑在什么门限下。

自愈判据：真机若**播报中静默**也刷出 `barge_in`，就是 margin 偏小 → **回退到 30**；
若 `echo` 远多于 `barge_in`，就是 margin 偏大 → 用户喊破嗓子也不打断。

## 5. 打断计数与对账

`Response` 现在分别记录：

- `chunks`：`speech.tts_started.chunks`（计划句数）；
- `started_chunks`：`tts_chunk_started` 的去重索引集合（`started_n`）；
- `finished_chunks`：`tts_chunk_finished` 计数（`finished_n`）；
- `played_chunks`：桥 `tts_played` 事实里的块索引（真的播完了的块）。老桥没有
  `tts_played` 时退回「finished 即 played」的兼容口径；
- `queue_dropped`：桥的有界队列因满丢弃的块数（**背压事实**，只经
  `speech.tts_cancelled.queue_dropped` 单列）。

`dropped` 不再来自桥的丢弃事件，而是在结算时算出（2026-11-08 裁决 D3）：

```text
played  = min(桥候选值, finished_n)            # 桥终态回报优先，其次 tts_played 计数
dropped = finished_n − played                  # 合成完成但因中止未播出
```

对账式因此是 **`played + dropped == finished_n`**（不是 `== chunks`，`chunks` 里含还没合成的）。
队列满丢弃（桥侧 `tts_chunk_dropped{reason:"queue_full"}`）**不并入** `dropped`，
否则打断计数会被背压污染；取消时清队列的丢弃也不重复计——它已经体现在
`finished_n − played` 里。

必须成立（实现与测试锁定）：

1. `played ≤ chunks`；
2. `finished_n ≤ started_n ≤ chunks`，且 `played ≤ finished_n`；
3. `played + dropped == finished_n`。

不把 `started − finished ≤ 1` 写成判据：有界队列允许多块同时在飞。
单测：`test_barge_in_reconciles_played_dropped_against_finished`（播完 1 块、第 2 块已合成未播
→ `played=1, dropped=1, finished_n=2`）、`test_queue_full_drops_are_reported_separately_from_dropped`。

## 6. 实时 AEC3（步骤 1/2）：方案与当前阻塞

目标结构与 issue 一致：

1. `third_party/webrtc-aec3/` 入库（MIT 许可声明），`build_aec3.sh` 从该路径编译。
   本轮已加 `scripts/vendor-aec3.sh`（只接受固定 commit/tag、校验 MIT `LICENSE` 与
   `src/`）并让 `build_aec3.sh` 优先认入库路径；源码本身仍未入库。
2. Swift 包装层 `AEC3Wrapper`：固定 10 ms / 16 kHz 单声道帧；`analyzeRender(pcm)`、
   `analyzeCapture(pcm)`、`process()` 三个入口；
3. 桥新增 `--aec3`：`playerNode` 的 PCM **显式分叉**进 `AnalyzeRender()`，麦克风帧进
   `AnalyzeCapture()`；`--aec` 继续走 VPIO；
4. 逐样本对齐测试：同一份固定 PCM，包装层输出与 `eval/aec3/aec3_eval.cc` 逐字节一致；
5. `eval/aec3/aec_ab2.sh` 增 `--aec3` 分支，跑同一 ABAB 对照。

本轮已落地其中**可离线判定**的部分：

- `eval/aec3/compare_wav.py`：PCM16 逐字节比较器（`--tolerance` 默认 0），
  第一个不同样本的索引与最大差都会报出来；单测覆盖一致/单点差异/容差/长度不符。
- `eval/aec3/aec_ab2.sh` 的 `aec3` 模式：桥必须在 `bridge_ready` 里回报
  `"aec_mode": "aec3"`，否则实验直接 FAIL——防止桥忽略未知 `--aec3` 后，
  把 VPIO 数据冒充成 AEC3。
- `eval/aec3/build_aec3.sh` **fail-closed**（裁决 D1）：`third_party/webrtc-aec3/src`
  不存在时以非 0 退出并在 stderr 指向 `scripts/vendor-aec3.sh`；不再读 `work/refs`
  的本地副本，避免 fresh clone 静默构建出坏库。门禁用例
  `test_aec3_build_fails_closed_without_vendored_source` 真跑脚本并断言退出码。

桥侧的 `--aec3` 与包装层仍未实现：它们依赖第 6 节开头缺失的源码。

**入库归属（2026-11-08 裁决 D1，已定，不再是待决项）**：

- `third_party/webrtc-aec3/` 由**维护者在本地**用 `scripts/vendor-aec3.sh <commit-or-tag>`
  填入并推独立 PR；本轮不 clone、不写 Swift 包装层。
- 留痕写在 `third_party/README.md`：谁入库、哪个 ref、谁跑的许可证校验。
- 桥是 macOS/AVFoundation，Linux CI 不能编译，逐样本测试与实时 ABAB 只能在 macOS 真机跑。
  `AEC3Wrapper.swift` / `mac_speech_pipeline.swift` 等源码入库后**单开一条 issue**再做。

因此本轮**没有**伪造「已接入实时 AEC3」。第 6 节是待执行方案，不是完成声明。

## 7. 验收判据 → 证据矩阵

| # | 判据 | 证据 | 状态 |
| --- | --- | --- | --- |
| 1 | 打断响应 P95 ≤ 300 ms | 需 macOS 真机 `capture_timing` / `status.tap_p99_ms` 采样（见 §7.1） | `pending-hardware` |
| 2 | 播报中说话能打断 + `played` 自洽 | `test_barge_in_counting_is_self_consistent`、`test_barge_in_reconciles_played_dropped_against_finished`；真机 `speech.gate` 时间线 | 单测通过；真机 `pending-hardware` |
| 3 | 播报中静默 30 分钟 0 误触发，`aec_echo_probe` 本底 +3 dB 内 | 需 macOS 真机 30 分钟实验（见 §7.1） | `pending-hardware` |
| 4 | 实时 AEC3 CPU < 单核 10% | 需 macOS 真机 `top -pid`（见 §7.1） | `pending-hardware` |
| 5 | 无活动播报时 `speech_abort` 200 且幂等 | `test_speech_abort_route.py` + `test_speech_abort_is_idempotent...` | 通过（handler 级；HTTP 级在 CI） |
| 6 | 门限取值有据（旧→新→依据） | 第 4 节 | 完成 |
| 7 | `speech.gate` 每次 VAD 上升都发 | `test_every_vad_rise_emits_a_gate` | 通过 |
| 8 | agentd `barge_in` 不被归一化吞掉 | `normCancelReason()` 白名单含 `barge_in` / `user_cancel` | 通过（代码已保留） |
| 9 | 门限可从配置覆盖并经 `/v1/audio/state` 回显 | `test_config_file_layer_sets_barge_in_thresholds`、`test_state_echo_matches_the_threshold_the_gate_uses`、`test_config_file_values_are_echoed_by_audio_state`、`test_echoed_margin_is_the_value_used_by_the_gate_formula` | 通过（handler 级单测；HTTP 级用例在 CI） |
| 10 | `played + dropped == finished_n` | `test_barge_in_reconciles_played_dropped_against_finished` | 通过（单测） |

### 7.1 `pending-hardware` 三项：需要什么、跑多久、怎么记数

这三项**没有**在本轮验证，也不得用离线数据顶替。真机（Mac mini + 单麦 + 真实扬声器）执行：

| 判据 | 设备/条件 | 时长与样本 | 记数方式 |
| --- | --- | --- | --- |
| 1 P95 ≤ 300 ms | 真机、AEC3 已接入桥、播报进行中由人开口 | 至少 30 次打断 | 每次取 `speech.gate`（`decision=pass`，`ts`）到 `speech.tts_cancelled(reason=barge_in)` 的时差；同时看 `capture_timing` 的 tap/worker p99 与 `status.tap_p99_ms`。P95 取 30 次的分位数 |
| 3 30 分钟 0 误触发 | 真机、播报循环播放、房间无人说话 | 连续 30 分钟 | 统计 `speech.gate{reason:"barge_in"}` 次数必须为 0；`aec_echo_probe.aec_erle_db` 的残余（相对本底）在本底 +3 dB 以内。出现 1 次即失败，按 §4 回退 margin 到 30 |
| 4 CPU < 单核 10% | 真机、AEC3 开启 vs 关闭各跑同一段播报 | 各 60 s 采样 | `top -pid <bridge-pid> -l 0 -s 1`，取 AEC3 开启减关闭的 CPU% 中位数；结论写回 eval 笔记并链接到 PR |

## 8. 风险与待决

1. **AEC3 源码入库**：由维护者按 D1 入库（见第 6 节与 `third_party/README.md`）；在此之前
   `build_aec3.sh` 明确失败，不静默退回 VPIO。
2. **margin=15 的暂定性**：只由离线 P10 推导，真机 30 分钟误触发率未测；回退策略见第 4 节。
3. **`dropped` 口径已定（D3）**：`dropped = finished_n − played`；队列满丢弃单列
   `queue_dropped`，取消清队列不重复计。风险在于当前桥在渲染完成后才发
   `tts_chunk_finished`，`finished_n` 与 `played` 在真实链路上通常相等（`dropped≈0`）；
   若桥将来把「合成完成」与「播出完成」拆开，本对账式已经按拆开后的语义实现。
4. **Swift 不可在 Linux CI 验证**：凡 Swift 改动只能靠源码断言（`test_voice_bridge_architecture.py`）
   与 macOS 真机实验，不得写成「已通过」。
