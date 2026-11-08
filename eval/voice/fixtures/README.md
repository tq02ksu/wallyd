# 语音基线夹具

这里**只提交标注 JSON**。音频由 `eval/voice/run_baseline.sh` 在缺失时现场合成
（`scripts/speech_fixture.swift`），`.caf`/`.wav` 与 `.generated.json` 都不入库。

## 现有场景

| 夹具 | 场景 | source | 守什么 |
| --- | --- | --- | --- |
| `a_single_zh_5s` / `15s` / `60s` | 单人中文短/中/长句 | synthesized | 首字延迟与句长无关；ASR 最终延迟 |
| `b_two_speakers` | 两人轮流（两个中文音色，A→B→A→B） | synthesized | 多人轮流下的首字/最终延迟稳定性；**不是真人，不测说话人归属** |
| `d_silence_10min` | 纯静音 10 分钟 | synthesized | 不产语音 final（`speech_finals=0`、`partials=0`） |
| `c_barge_in/barge_in.json` | 机器人播放 + 用户插话 | **pending-hardware** | 打断/AEC 的真机场景登记；本轮无音频，#41 落地 |

## 加一个夹具

在 `fixtures/`（可建子目录）放一个 JSON 即可，不用改脚本。字段与示例见
[`../README.md`](../README.md#4-怎么新增一个夹具不改脚本)。

校验规则（fail closed）：

- 必填 `fixture / kind / duration_ms / source / expected / notes`，`notes` 不能空；
- `source=synthesized` 必须有 `generate`；`source=recorded` 不许有 `generate`；
- `source=pending-hardware` 不许有 `generate`、`expected.utterances` 必须为 0，
  且旁边出现任何 `.caf/.wav` 都判红；
- `expected.texts` 长度必须等于 `expected.utterances`。

## 关于合成音

合成音经 ASR 回来的文本与台词有差异是正常的。`expected.texts` 是**大致台词**，
任何 CER 类断言都不许拿它当真值——否则会得到一个虚假的 CER。
